import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../src/errors/app-error.js';
import {
  formatDateOnly,
  LeadsService,
  type AuthClientLike,
  type DbClientLike,
  type DbPoolLike,
} from '../src/modules/leads/leads.service.js';

const silentLogger = {
  warn: () => undefined,
  error: () => undefined,
};

function createMockDb(
  queryHandler: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>,
  connectClient?: DbClientLike
): DbPoolLike {
  return {
    query: queryHandler as any,
    connect: async () =>
      connectClient ?? {
        query: queryHandler as any,
        release: () => undefined,
      },
  };
}

describe('LeadsService (concurrency limits, pagination, dedupe, and idempotency)', () => {
  it('paginates /v3/teams across multiple pages and throws AppError(502) if upstream metadata fails', async () => {
    const seenUrls: string[] = [];
    const authOk: AuthClientLike = {
      authenticatedFetch: async (rawUrl) => {
        seenUrls.push(rawUrl);
        const parsed = new URL(rawUrl);
        const page = parsed.searchParams.get('page');
        if (parsed.pathname.endsWith('/v3/teams') && page === '1') {
          return new Response(
            JSON.stringify({ data: [{ id: 10 }], meta: { last_page: 2 } }),
            { status: 200 }
          );
        }
        if (parsed.pathname.endsWith('/v3/teams') && page === '2') {
          return new Response(
            JSON.stringify({ data: [{ id: 20 }], meta: { last_page: 2 } }),
            { status: 200 }
          );
        }
        if (parsed.pathname.endsWith('/v3/locations')) {
          return new Response(
            JSON.stringify({ data: [{ id: 1 }], meta: { last_page: 1 } }),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 404 });
      },
    };

    let capturedParams: any[] | undefined;
    const db = createMockDb(async (_sql, params) => {
      capturedParams = params;
      return { rows: [] };
    });

    const service = new LeadsService({ db, auth: authOk, logger: silentLogger });
    const res = await service.getPermittedLeads({ days: 10 });

    assert.equal(res.allowed_teams_count, 2);
    assert.equal(res.allowed_locations_count, 1);
    assert.deepEqual(capturedParams?.[1], [10, 20]);
    assert.equal(seenUrls.some((u) => u.includes('/v3/teams') && u.includes('page=2')), true);

    const authFail: AuthClientLike = {
      authenticatedFetch: async (url) => {
        if (url.includes('/v3/teams')) {
          return new Response('upstream failure', { status: 500 });
        }
        return new Response(JSON.stringify({ data: [{ id: 1 }] }), { status: 200 });
      },
    };
    const failingService = new LeadsService({ db, auth: authFail, logger: silentLogger });
    await assert.rejects(
      () => failingService.getPermittedLeads(),
      (err) => err instanceof AppError && err.statusCode === 502 && err.code === 'UPSTREAM_ERROR'
    );
  });

  it('bounds live checks to liveCheckConcurrency and filters onlyActionable post-live-check', async () => {
    const dbQueries: Array<{ sql: string; params?: any[] }> = [];
    const sampleRows = Array.from({ length: 8 }, (_, idx) => ({
      lead_id: 100 + idx,
      lead_name: `Lead ${idx}`,
      lead_status: 'pending',
      team_name: 'Equipe A',
      location_name: 'Loja 1',
      cpf: '12345678901',
      proposta: `P-${idx}`,
      data_contrato: '2026-11-10',
      valorprimeiraparcela: 500,
      plano: 'Standard',
      prazo: 60,
      modelo: 'Moto',
      schedule_status: null,
      finalization_id: null,
    }));

    const db = createMockDb(async (sql, params) => {
      dbQueries.push({ sql, params });
      if (sql.includes('FROM leads l')) {
        return { rows: sampleRows };
      }
      return { rows: [], rowCount: 1 };
    });

    let inFlight = 0;
    let maxInFlight = 0;

    const auth: AuthClientLike = {
      authenticatedFetch: async (url) => {
        if (url.includes('/v3/teams')) {
          return new Response(JSON.stringify({ data: [{ id: 1 }], meta: { last_page: 1 } }), {
            status: 200,
          });
        }
        if (url.includes('/v3/locations')) {
          return new Response(JSON.stringify({ data: [{ id: 2 }], meta: { last_page: 1 } }), {
            status: 200,
          });
        }

        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight--;

        // Lead 100 discovered finalized in Followize
        if (url.endsWith('/v3/leads/100')) {
          return new Response(
            JSON.stringify({
              data: {
                id: 100,
                status: 'sale_performed',
                finalization: {
                  id: 9001,
                  amount: 0,
                  type_of_sale: 'consortium',
                  invoice_date: '2026-11-10',
                  order_number: 'P-0',
                  invoice_number: 'P-0',
                  sale_id_number: '12345678901',
                },
              },
            }),
            { status: 200 }
          );
        }

        // Lead 101 discovered with pending schedule in Followize
        if (url.endsWith('/v3/leads/101')) {
          return new Response(
            JSON.stringify({
              data: {
                id: 101,
                status: 'pending',
                last_schedule: {
                  id: 777,
                  date: '2026-11-25 10:00:00',
                  status: 'pending',
                  reason: { id: 5, name: 'Visita' },
                },
              },
            }),
            { status: 200 }
          );
        }

        // Lead 102 transient upstream failure
        if (url.endsWith('/v3/leads/102')) {
          return new Response('unavailable', { status: 503 });
        }

        return new Response(JSON.stringify({ data: { id: 999, status: 'pending' } }), {
          status: 200,
        });
      },
    };

    const service = new LeadsService({
      db,
      auth,
      liveCheckConcurrency: 2,
      logger: silentLogger,
    });

    const result = await service.getPermittedLeads({ days: 30, onlyActionable: true });

    assert.equal(maxInFlight, 2);
    assert.equal(result.live_check_errors, 1);
    // Leads 100 (finalized) and 101 (pending schedule) were filtered out post-live-check!
    assert.equal(result.total, 6);
    assert.equal(
      result.leads.some((l) => l.lead_id === 100 || l.lead_id === 101),
      false
    );
    const failedLiveItem = result.leads.find((l) => l.lead_id === 102);
    assert.equal(failedLiveItem?.live_check_ok, false);

    // Verify ON CONFLICT (lead_id) was used for finalization sync
    const finUpsert = dbQueries.find((q) => q.sql.includes('INSERT INTO finalization'));
    assert.ok(finUpsert);
    assert.equal(finUpsert.sql.includes('ON CONFLICT (lead_id) DO UPDATE'), true);
    assert.equal(finUpsert.params?.[2], 0); // preserves amount 0
  });

  it('formatDateOnly and buildFinalizationPayload avoid timezone drift and "null" strings', async () => {
    assert.equal(formatDateOnly(null), undefined);
    assert.equal(formatDateOnly('2026-11-20T15:30:00Z'), '2026-11-20');
    assert.equal(formatDateOnly(new Date(2026, 10, 5)), '2026-11-05');

    const db = createMockDb(async () => ({
      rows: [
        {
          lead_id: 55,
          cpf: '123.456.789-01',
          proposta: '9001',
          datavenda: null,
          valorprimeiraparcela: 0,
          plano: 'Plano X',
          prazo: 72,
          modelo: 'CG 160',
        },
      ],
    }));

    const service = new LeadsService({
      db,
      auth: { authenticatedFetch: async () => new Response() },
      logger: silentLogger,
    });

    const payload = await service.buildFinalizationPayload(55);
    assert.ok(payload);
    assert.equal(payload.sale_id_number, '12345678901');
    assert.equal(payload.amount, 0);
    assert.equal('invoice_date' in payload, false);
  });

  it('executeFinalization enforces concurrency lock, idempotency, and syncs local DB on success', async () => {
    const executedQueries: Array<{ sql: string; params?: any[] }> = [];
    let alreadyFinalized = false;

    const txClient: DbClientLike = {
      query: async (sql, params) => {
        executedQueries.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    };

    const db = createMockDb(async (sql, params) => {
      executedQueries.push({ sql, params });
      if (sql.includes('LEFT JOIN finalization')) {
        return {
          rows: [
            {
              status: alreadyFinalized ? 'sale_performed' : 'pending',
              finalization_id: alreadyFinalized ? 888 : null,
            },
          ],
        };
      }
      return { rows: [] };
    }, txClient);

    let releaseUpstream!: () => void;
    const upstreamBarrier = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });

    const auth: AuthClientLike = {
      authenticatedFetch: async () => {
        await upstreamBarrier;
        return new Response(
          JSON.stringify({
            data: {
              id: 7770,
              amount: 1200,
              type_of_sale: 'consortium',
              invoice_date: '2026-11-20',
              order_number: '999',
              invoice_number: '999',
            },
          }),
          { status: 200 }
        );
      },
    };

    const service = new LeadsService({ db, auth, logger: silentLogger });
    const samplePayload = {
      billed: true,
      order_number: '999',
      amount: 1200,
      invoice_number: '999',
      invoice_date: '2026-11-20',
      type_of_sale: 'consortium' as const,
    };

    // Start first finalization (waits on upstreamBarrier)
    const firstPromise = service.executeFinalization(42, samplePayload, false);

    // Wait a microtask so first call acquires the per-lead lock
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Concurrent call for same leadId -> 409 FINALIZATION_IN_PROGRESS
    await assert.rejects(
      () => service.executeFinalization(42, samplePayload, false),
      (err) =>
        err instanceof AppError &&
        err.statusCode === 409 &&
        err.code === 'FINALIZATION_IN_PROGRESS'
    );

    releaseUpstream();
    const firstRes = await firstPromise;
    assert.equal(firstRes.success, true);
    assert.equal(firstRes.local_db_synced, true);
    assert.equal(
      executedQueries.some((q) => q.sql.includes("UPDATE leads SET status = 'sale_performed'")),
      true
    );
    assert.equal(
      executedQueries.some((q) => q.sql.includes('INSERT INTO finalization')),
      true
    );

    // Subsequent call after already finalized -> 409 ALREADY_FINALIZED
    alreadyFinalized = true;
    await assert.rejects(
      () => service.executeFinalization(42, samplePayload, false),
      (err) =>
        err instanceof AppError && err.statusCode === 409 && err.code === 'ALREADY_FINALIZED'
    );
  });

  it('executeFinalization degrades safely (local_db_synced: false) if local DB fails after Followize 200', async () => {
    const failingTxClient: DbClientLike = {
      query: async (sql) => {
        if (sql.includes('UPDATE leads')) {
          throw new Error('connection dropped');
        }
        return { rows: [] };
      },
      release: () => undefined,
    };

    const db = createMockDb(async () => ({
      rows: [{ status: 'pending', finalization_id: null }],
    }), failingTxClient);

    const auth: AuthClientLike = {
      authenticatedFetch: async () =>
        new Response(JSON.stringify({ data: { id: 555 } }), { status: 200 }),
    };

    const service = new LeadsService({ db, auth, logger: silentLogger });
    const res = await service.executeFinalization(
      99,
      {
        billed: true,
        order_number: '123',
        amount: 500,
        invoice_number: '123',
        invoice_date: '2026-11-20',
      },
      false
    );

    assert.equal(res.success, true);
    assert.equal(res.status_code, 200);
    assert.equal(res.local_db_synced, false);
  });
});
