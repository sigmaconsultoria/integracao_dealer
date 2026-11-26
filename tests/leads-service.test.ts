import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../src/errors/app-error.js';
import {
  formatDateOnly,
  LeadsService,
  type AuthClientLike,
  type DbClientLike,
  type DbPoolLike,
  type LeadsAuthManagerLike,
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

function createMockAuthManager(clients: Record<string, AuthClientLike>): LeadsAuthManagerLike {
  const units = Object.keys(clients);
  return {
    getUnits: () => [...units],
    hasUnit: (u: string) => units.includes(u.trim().toUpperCase()),
    resolveUnit: (u?: string, opts?: { allowSingleDefault?: boolean }) => {
      const norm = typeof u === 'string' ? u.trim().toUpperCase() : '';
      if (!norm) {
        if (opts?.allowSingleDefault && units.length === 1) {
          return units[0]!;
        }
        throw new AppError(400, 'Unidade obrigatória', 'UNIT_REQUIRED');
      }
      if (!clients[norm]) {
        throw new AppError(400, `Unidade inválida: ${norm}`, 'INVALID_UNIT');
      }
      return norm;
    },
    getClient: (u: string) => {
      const norm = u.trim().toUpperCase();
      if (!clients[norm]) {
        throw new AppError(400, `Unidade inválida: ${norm}`, 'INVALID_UNIT');
      }
      return clients[norm] as ReturnType<LeadsAuthManagerLike['getClient']>;
    },
  };
}

describe('LeadsService (multi-unit permitted leads, filial regional matching, and token routing)', () => {
  it('paginates /v3/teams across multiple pages and throws AppError(502) if single-unit metadata fails', async () => {
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
    assert.equal(res.by_unit.MT?.status, 'ok');
    assert.deepEqual(capturedParams?.slice(0, 4), [10, 'MT', [10, 20], [1]]);
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
      unidade: 'MT',
      lead_created_at: new Date(2026, 10, 10 + idx).toISOString(),
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
    assert.equal(result.total, 6);
    assert.equal(
      result.leads.some((l) => l.lead_id === 100 || l.lead_id === 101),
      false
    );
    const failedLiveItem = result.leads.find((l) => l.lead_id === 102);
    assert.equal(failedLiveItem?.live_check_ok, false);
    assert.equal(failedLiveItem?.unidade, 'MT');

    const finUpsert = dbQueries.find((q) => q.sql.includes('INSERT INTO finalization'));
    assert.ok(finUpsert);
    assert.equal(finUpsert.sql.includes('ON CONFLICT (lead_id) DO UPDATE'), true);
    assert.equal(finUpsert.params?.[2], 0);
  });

  it('handles multi-unit getPermittedLeads with error isolation, ?unidade= filter, and regional filial join', async () => {
    const capturedSqls: Array<{ sql: string; params?: any[] }> = [];
    const tokenCalls: Record<string, string[]> = { MT: [], PA: [], AP: [] };

    const db = createMockDb(async (sql, params) => {
      capturedSqls.push({ sql, params });
      if (sql.includes('FROM leads l')) {
        const unit = String(params?.[1]);
        if (unit === 'MT') {
          return {
            rows: [
              {
                lead_id: 1,
                lead_name: 'Lead MT',
                lead_status: 'pending',
                unidade: 'MT',
                lead_created_at: '2026-11-24T10:00:00Z',
                team_name: 'Equipe MT',
                location_name: 'Loja Cuiabá',
                cpf: '11111111111',
                proposta: 'MT-100',
                data_contrato: '2026-11-24',
                valorprimeiraparcela: 400,
                plano: 'A',
                prazo: 60,
                modelo: 'Biz',
                schedule_status: null,
                finalization_id: null,
              },
            ],
          };
        }
        if (unit === 'AP') {
          return {
            rows: [
              {
                lead_id: 3,
                lead_name: 'Lead AP',
                lead_status: 'pending',
                unidade: 'AP',
                lead_created_at: '2026-11-25T10:00:00Z',
                team_name: 'Equipe AP',
                location_name: 'Loja Macapá',
                cpf: '33333333333',
                proposta: 'AP-300',
                data_contrato: '2026-11-25',
                valorprimeiraparcela: 600,
                plano: 'B',
                prazo: 72,
                modelo: 'Bros',
                schedule_status: null,
                finalization_id: null,
              },
            ],
          };
        }
      }
      return { rows: [] };
    });

    const authManager = createMockAuthManager({
      MT: {
        authenticatedFetch: async (url) => {
          tokenCalls.MT!.push(url);
          if (url.includes('/v3/teams')) {
            return new Response(JSON.stringify({ data: [{ id: 11 }] }), { status: 200 });
          }
          if (url.includes('/v3/locations')) {
            return new Response(JSON.stringify({ data: [{ id: 21 }] }), { status: 200 });
          }
          if (url.endsWith('/v3/leads/1')) {
            return new Response(JSON.stringify({ data: { id: 1, status: 'pending' } }), {
              status: 200,
            });
          }
          return new Response('{}', { status: 404 });
        },
      },
      PA: {
        authenticatedFetch: async (url) => {
          tokenCalls.PA!.push(url);
          return new Response('unauthorized', { status: 500 });
        },
      },
      AP: {
        authenticatedFetch: async (url) => {
          tokenCalls.AP!.push(url);
          if (url.includes('/v3/teams')) {
            return new Response(JSON.stringify({ data: [{ id: 31 }, { id: 32 }] }), {
              status: 200,
            });
          }
          if (url.includes('/v3/locations')) {
            return new Response(JSON.stringify({ data: [{ id: 41 }] }), { status: 200 });
          }
          if (url.endsWith('/v3/leads/3')) {
            return new Response(JSON.stringify({ data: { id: 3, status: 'pending' } }), {
              status: 200,
            });
          }
          return new Response('{}', { status: 404 });
        },
      },
    });

    const service = new LeadsService({ db, authManager, logger: silentLogger });
    const multiRes = await service.getPermittedLeads({ days: 30, liveCheck: true });

    assert.equal(multiRes.by_unit.MT?.status, 'ok');
    assert.equal(multiRes.by_unit.PA?.status, 'error');
    assert.equal(multiRes.by_unit.AP?.status, 'ok');
    assert.equal(multiRes.total, 2);
    // Ordenado do mais recente (AP 2026-11-25) para o mais antigo (MT 2026-11-24)
    assert.deepEqual(
      multiRes.leads.map((l) => `${l.unidade}:${l.lead_id}`),
      ['AP:3', 'MT:1']
    );
    // Live check de MT usou token MT, e de AP usou token AP
    assert.equal(tokenCalls.MT!.some((u) => u.endsWith('/v3/leads/1')), true);
    assert.equal(tokenCalls.AP!.some((u) => u.endsWith('/v3/leads/3')), true);
    assert.equal(tokenCalls.MT!.some((u) => u.endsWith('/v3/leads/3')), false);

    // SQL deve filtrar checagemcontrato via filial.regional
    const leadsSql = capturedSqls.find((q) => q.sql.includes('FROM leads l'))?.sql || '';
    assert.equal(leadsSql.includes('LEFT JOIN filial fil'), true);
    assert.equal(leadsSql.includes("WHEN 7 THEN 'PA'"), true);
    assert.equal(leadsSql.includes("WHEN 8 THEN 'AP'"), true);

    // Filtro explícito ?unidade=AP
    const apOnly = await service.getPermittedLeads({ unidade: 'ap', liveCheck: false });
    assert.equal(apOnly.total, 1);
    assert.equal(apOnly.leads[0]?.unidade, 'AP');
    assert.deepEqual(Object.keys(apOnly.by_unit), ['AP']);

    // Filtro explícito ?unidade=PA (que está falhando) propaga erro 502
    await assert.rejects(
      () => service.getPermittedLeads({ unidade: 'PA' }),
      (err) => err instanceof AppError && err.statusCode === 502
    );
  });

  it('formatDateOnly and buildFinalizationPayload enforce filial.regional cross-check', async () => {
    assert.equal(formatDateOnly(null), undefined);
    assert.equal(formatDateOnly('2026-11-20T15:30:00Z'), '2026-11-20');
    assert.equal(formatDateOnly(new Date(2026, 10, 5)), '2026-11-05');

    // Simula banco com lead MT e contrato na filial BEL (regional=7 -> PA)
    const leadsTable = [
      { id: 55, contact_id: 500, unidade: 'MT' },
      { id: 56, contact_id: 500, unidade: 'PA' },
    ];
    const contratos = [
      {
        cpf: '12345678901',
        empresa: 'BEL',
        regional: 7,
        proposta: '9001',
        datavenda: null,
        valorprimeiraparcela: 0,
        plano: 'Plano X',
        prazo: 72,
        modelo: 'CG 160',
      },
    ];

    let capturedSql = '';
    const db = createMockDb(async (sql, params) => {
      capturedSql = sql;
      const leadId = Number(params?.[0]);
      const lead = leadsTable.find((l) => l.id === leadId);
      if (!lead) return { rows: [] };

      const regionalMap: Record<number, string> = { 1: 'MT', 7: 'PA', 8: 'AP' };
      const match = contratos.find((c) => regionalMap[c.regional] === lead.unidade);
      if (!match) return { rows: [] };

      return {
        rows: [
          {
            lead_id: lead.id,
            cpf: '123.456.789-01',
            proposta: match.proposta,
            datavenda: match.datavenda,
            valorprimeiraparcela: match.valorprimeiraparcela,
            plano: match.plano,
            prazo: match.prazo,
            modelo: match.modelo,
          },
        ],
      };
    });

    const service = new LeadsService({
      db,
      auth: { authenticatedFetch: async () => new Response() },
      logger: silentLogger,
    });

    // Lead MT (55) NÃO cruza com contrato de Belém/PA
    const payloadMt = await service.buildFinalizationPayload(55);
    assert.equal(payloadMt, null);
    assert.equal(capturedSql.includes('LEFT JOIN filial fil'), true);
    assert.equal(capturedSql.includes('CASE fil.regional'), true);

    // Lead PA (56) cruza com contrato de Belém/PA
    const payloadPa = await service.buildFinalizationPayload(56);
    assert.ok(payloadPa);
    assert.equal(payloadPa.sale_id_number, '12345678901');
    assert.equal(payloadPa.amount, 0);
    assert.equal('invoice_date' in payloadPa, false);
  });

  it('routes executeFinalization and cancelSchedule using leads.unidade and rejects 404/422', async () => {
    const executedQueries: Array<{ sql: string; params?: any[] }> = [];
    const callsByUnit: Record<string, string[]> = { MT: [], PA: [], AP: [] };

    const leadRows: Record<number, { status: string; unidade: string | null; finalization_id: number | null }> = {
      42: { status: 'pending', unidade: 'PA', finalization_id: null },
      43: { status: 'pending', unidade: 'AP', finalization_id: null },
      44: { status: 'sale_performed', unidade: 'MT', finalization_id: 888 },
      45: { status: 'pending', unidade: 'RO', finalization_id: null },
    };

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
        const row = leadRows[Number(params?.[0])];
        return { rows: row ? [row] : [] };
      }
      return { rows: [] };
    }, txClient);

    let releaseUpstream!: () => void;
    const upstreamBarrier = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });

    const authManager = createMockAuthManager({
      MT: {
        authenticatedFetch: async (url) => {
          callsByUnit.MT!.push(url);
          return new Response(JSON.stringify({ data: { id: 1 } }), { status: 200 });
        },
      },
      PA: {
        authenticatedFetch: async (url) => {
          callsByUnit.PA!.push(url);
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
      },
      AP: {
        authenticatedFetch: async (url) => {
          callsByUnit.AP!.push(url);
          return new Response(JSON.stringify({ canceled: true }), { status: 200 });
        },
      },
    });

    const service = new LeadsService({ db, authManager, logger: silentLogger });
    const samplePayload = {
      billed: true,
      order_number: '999',
      amount: 1200,
      invoice_number: '999',
      invoice_date: '2026-11-20',
      type_of_sale: 'consortium' as const,
    };

    // Cancelamento de agendamento em AP usa token de AP
    await service.cancelSchedule(43, 901, 'Cancelando para fechar');
    assert.equal(callsByUnit.AP!.length, 1);
    assert.equal(callsByUnit.MT!.length, 0);

    // Finalização concorrente para o mesmo lead PA -> 409 FINALIZATION_IN_PROGRESS
    const firstPromise = service.executeFinalization(42, samplePayload, false);
    await new Promise((resolve) => setTimeout(resolve, 10));

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
    // Finalização do lead 42 (PA) usou token de PA e nunca de MT
    assert.equal(callsByUnit.PA!.length, 1);
    assert.equal(callsByUnit.MT!.length, 0);

    // Lead já finalizado -> 409 ALREADY_FINALIZED
    await assert.rejects(
      () => service.executeFinalization(44, samplePayload, false),
      (err) =>
        err instanceof AppError && err.statusCode === 409 && err.code === 'ALREADY_FINALIZED'
    );

    // Lead inexistente -> 404 LEAD_NOT_FOUND
    await assert.rejects(
      () => service.executeFinalization(999999, samplePayload, false),
      (err) => err instanceof AppError && err.statusCode === 404 && err.code === 'LEAD_NOT_FOUND'
    );

    // Lead com unidade não configurada -> 422 LEAD_UNIT_UNAVAILABLE
    await assert.rejects(
      () => service.executeFinalization(45, samplePayload, false),
      (err) =>
        err instanceof AppError &&
        err.statusCode === 422 &&
        err.code === 'LEAD_UNIT_UNAVAILABLE'
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
      rows: [{ status: 'pending', unidade: 'MT', finalization_id: null }],
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
