import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { AppError } from '../src/errors/app-error.js';
import type { AuthClientLike, DbClientLike, DbPoolLike } from '../src/modules/leads/leads.service.js';
import { SyncService } from '../src/services/sync.service.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function makeSampleLead(id: number, overrides: Record<string, any> = {}) {
  return {
    id,
    name: `Lead ${id}`,
    perception: null,
    status: 'pending',
    conversion_goal: 'API',
    flow: 'web',
    message: 'Msg',
    integration_third_party_id: null,
    custom_key: null,
    fbclid: null,
    gclid: null,
    dsv_id: null,
    vehicle_price: 0,
    attendant: { id: 10, name: 'Atendente 10' },
    location: { id: 20, name: 'Loja 20' },
    salesman: { id: 30, name: 'Vendedor 30' },
    contact: {
      id: 100 + id,
      email: `lead${id}@example.test`,
      phone: '6533330000',
      cellphone: '65999990000',
      id_number: '12345678901',
      birthdate: '1990-05-15',
      attendant: { id: 10, name: 'Atendente 10' },
      team: { id: 40, name: 'Equipe 40' },
      address: {
        address_line1: 'Rua A',
        city: 'Cuiabá',
        state: 'MT',
        country: 'BR',
      },
      company: {
        name: 'Empresa Teste',
      },
    },
    interests: {
      dsv_id: 'dsv-99',
      vehicle_price: '45000',
      interest_1: { id: 0, name: 'Consórcio', required: false },
      interest_2: { id: 2, name: 'Honda', required: true },
    },
    last_schedule: {
      id: 500 + id,
      date: '2026-11-25 10:00:00',
      status: 'pending',
      reason: { id: 60, name: 'Visita' },
    },
    last_proposal: {
      id: 600 + id,
      amount: 0,
    },
    finalization: {
      id: 700 + id,
      amount: 0,
      type_of_sale: 'consortium',
      invoice_date: '2026-11-20',
      order_number: 0,
      invoice_number: 123,
      sale_id_number: '12345678901',
      card_number: null,
      message: 'Fechado',
      unrealized_sale_reason: { id: 70, name: 'N/A' },
    },
    tracking: {
      oem: 'Honda',
      source: 'google',
      medium: 'cpc',
      campaign: 'black-friday',
      format: 'search',
    },
    legal_bases: {
      processing: { id: 1, name: 'Execução de contrato', opt_in: true },
      communication: { id: 2, name: 'Marketing', opt_in: false },
    },
    first_interaction_at: '2026-11-10T12:00:00Z',
    last_interaction_at: '2026-11-10T13:00:00Z',
    created_at: '2026-11-10T12:00:00Z',
    updated_at: '2026-11-10T14:00:00Z',
    ...overrides,
  };
}

describe('SyncService (17 tables UNNEST, concurrency lock, watermark, and retry)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  async function createTempStatePath(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leads-sync-test-'));
    tempDirs.push(dir);
    return path.join(dir, '.runtime', 'sync-state.json');
  }

  it('upserts all 17 tables via UNNEST, deduplicates entities, and preserves zero values', async () => {
    const statePath = await createTempStatePath();
    const recordedQueries: Array<{ sql: string; params?: any[] }> = [];

    const txClient: DbClientLike = {
      query: async (sql, params) => {
        recordedQueries.push({ sql, params });
        if (sql.includes('SELECT id, updated_at FROM leads')) {
          return { rows: [] };
        }
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    };

    const db: DbPoolLike = {
      query: async (sql, params) => {
        recordedQueries.push({ sql, params });
        if (sql.includes('MAX(updated_at)')) {
          return { rows: [{ start_date: '2026-11-09 00:00:00' }] };
        }
        return { rows: [] };
      },
      connect: async () => txClient,
    };

    // Two leads sharing attendant.id=10 and contact.id=101 -> must deduplicate in UNNEST!
    const lead1 = makeSampleLead(1);
    const lead2 = makeSampleLead(2, {
      contact: { ...makeSampleLead(1).contact, id: 101 },
    });

    const auth: AuthClientLike = {
      authenticatedFetch: async () =>
        new Response(
          JSON.stringify({
            data: [lead1, lead2],
            meta: { current_page: 1, last_page: 1, total: 2 },
          }),
          { status: 200 }
        ),
    };

    const sync = new SyncService({
      db,
      auth,
      statePath,
      pageDelayMs: 0,
      logger: silentLogger,
    });

    const res = await sync.syncLeads();
    assert.equal(res.success, true);
    assert.equal(res.totalSynced, 2);
    assert.equal(res.pagesProcessed, 1);

    const expectedTables = [
      'leads_raw',
      'attendants',
      'teams',
      'locations',
      'salesmen',
      'contacts',
      'addresses',
      'companies',
      'leads',
      'lead_interests',
      'schedule_reasons',
      'last_schedule',
      'last_proposal',
      'unrealized_sale_reasons',
      'finalization',
      'tracking',
      'legal_bases',
    ];

    for (const table of expectedTables) {
      const found = recordedQueries.find((q) => q.sql.includes(`INSERT INTO ${table} (`));
      assert.ok(found, `Expected UNNEST INSERT into ${table}`);
      assert.equal(found.sql.includes('UNNEST('), true, `${table} must use UNNEST`);
    }

    // Deduplication check: attendants had id=10 on both leads -> only 1 entry
    const attendantsInsert = recordedQueries.find((q) =>
      q.sql.includes('INSERT INTO attendants (')
    );
    assert.deepEqual(attendantsInsert?.params?.[0], [10]);

    // Zero values preserved: leads.vehicle_price='0', last_proposal.amount=0, finalization.amount=0, finalization.order_number='0'
    const leadsInsert = recordedQueries.find((q) => q.sql.includes('INSERT INTO leads ('));
    assert.equal(leadsInsert?.params?.[12]?.[0], '0');
    const proposalInsert = recordedQueries.find((q) =>
      q.sql.includes('INSERT INTO last_proposal (')
    );
    assert.equal(proposalInsert?.params?.[2]?.[0], 0);
    const finInsert = recordedQueries.find((q) => q.sql.includes('INSERT INTO finalization ('));
    assert.equal(finInsert?.params?.[2]?.[0], 0);
    assert.equal(finInsert?.params?.[5]?.[0], '0');
  });

  it('prevents concurrent sync executions with 409 SYNC_IN_PROGRESS', async () => {
    const statePath = await createTempStatePath();
    let releasePage!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releasePage = resolve;
    });

    const db: DbPoolLike = {
      query: async () => ({ rows: [{ start_date: '2026-11-09 00:00:00' }] }),
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => undefined }),
    };

    const auth: AuthClientLike = {
      authenticatedFetch: async () => {
        await barrier;
        return new Response(
          JSON.stringify({ data: [], meta: { current_page: 1, last_page: 1, total: 0 } }),
          { status: 200 }
        );
      },
    };

    const sync = new SyncService({ db, auth, statePath, pageDelayMs: 0, logger: silentLogger });
    const firstRun = sync.syncLeads();
    await new Promise((resolve) => setTimeout(resolve, 10));

    await assert.rejects(
      () => sync.syncLeads(),
      (err) => err instanceof AppError && err.statusCode === 409 && err.code === 'SYNC_IN_PROGRESS'
    );

    releasePage();
    await firstRun;
  });

  it('persists pending watermark on mid-sync failure and resumes from pending_start_date on next run', async () => {
    const statePath = await createTempStatePath();
    const requestedDateFroms: string[] = [];
    let shouldFailPage2 = true;

    const db: DbPoolLike = {
      query: async (sql) => {
        if (sql.includes('MAX(updated_at)')) {
          return { rows: [{ start_date: '2026-11-10 08:00:00' }] };
        }
        return { rows: [] };
      },
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => undefined,
      }),
    };

    const auth: AuthClientLike = {
      authenticatedFetch: async (rawUrl) => {
        const url = new URL(rawUrl);
        const page = Number(url.searchParams.get('page'));
        requestedDateFroms.push(url.searchParams.get('date_from') || '');

        if (page === 1) {
          return new Response(
            JSON.stringify({
              data: [makeSampleLead(1)],
              meta: { current_page: 1, last_page: 2, total: 2 },
            }),
            { status: 200 }
          );
        }

        if (page === 2 && shouldFailPage2) {
          return new Response('bad request', { status: 400 });
        }

        return new Response(
          JSON.stringify({
            data: [makeSampleLead(2)],
            meta: { current_page: 2, last_page: 2, total: 2 },
          }),
          { status: 200 }
        );
      },
    };

    const sync = new SyncService({
      db,
      auth,
      statePath,
      pageDelayMs: 0,
      maxRetries: 0,
      logger: silentLogger,
    });

    // Run 1 fails on page 2 after committing page 1
    await assert.rejects(() => sync.syncLeads());

    const stateAfterFailure = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    assert.equal(stateAfterFailure.pending_start_date, '2026-11-10 08:00:00');

    // Even if DB MAX(updated_at) advanced meanwhile, Run 2 must resume from pending_start_date
    shouldFailPage2 = false;
    const resumedRes = await sync.syncLeads();
    assert.equal(resumedRes.resumedFromPending, true);
    assert.equal(resumedRes.startDate, '2026-11-10 08:00:00');
    assert.equal(resumedRes.pagesProcessed, 2);

    const stateAfterSuccess = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    assert.equal(stateAfterSuccess.pending_start_date, null);
    assert.ok(stateAfterSuccess.last_completed_at);
  });

  it('retries transient 429/503 responses with backoff before succeeding', async () => {
    const statePath = await createTempStatePath();
    let attempts = 0;

    const db: DbPoolLike = {
      query: async () => ({ rows: [{ start_date: '2026-11-10 08:00:00' }] }),
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => undefined }),
    };

    const auth: AuthClientLike = {
      authenticatedFetch: async () => {
        attempts++;
        if (attempts === 1) {
          return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
        }
        if (attempts === 2) {
          return new Response('unavailable', { status: 503 });
        }
        return new Response(
          JSON.stringify({
            data: [makeSampleLead(1)],
            meta: { current_page: 1, last_page: 1, total: 1 },
          }),
          { status: 200 }
        );
      },
    };

    const sync = new SyncService({
      db,
      auth,
      statePath,
      pageDelayMs: 0,
      maxRetries: 2,
      retryBaseDelayMs: 1,
      logger: silentLogger,
    });

    const res = await sync.syncLeads();
    assert.equal(attempts, 3);
    assert.equal(res.totalSynced, 1);
  });

  it('skips unchanged leads on incremental sync but forces upsert on customDate backfill', async () => {
    const statePath = await createTempStatePath();
    const lead = makeSampleLead(1, { updated_at: '2026-11-10T14:00:00.000Z' });

    const db: DbPoolLike = {
      query: async () => ({ rows: [{ start_date: '2026-11-10 08:00:00' }] }),
      connect: async () => ({
        query: async (sql) => {
          if (sql.includes('SELECT id, updated_at FROM leads')) {
            return { rows: [{ id: 1, updated_at: new Date('2026-11-10T14:00:00.000Z') }] };
          }
          return { rows: [] };
        },
        release: () => undefined,
      }),
    };

    const auth: AuthClientLike = {
      authenticatedFetch: async () =>
        new Response(
          JSON.stringify({
            data: [lead],
            meta: { current_page: 1, last_page: 1, total: 1 },
          }),
          { status: 200 }
        ),
    };

    const sync = new SyncService({ db, auth, statePath, pageDelayMs: 0, logger: silentLogger });

    // Incremental sync skips matching updated_at
    const incRes = await sync.syncLeads();
    assert.equal(incRes.totalSynced, 0);

    // customDate backfill forces upsert into all 17 tables
    const backfillRes = await sync.syncLeads('2026-11-09 00:00:00', false);
    assert.equal(backfillRes.totalSynced, 1);
  });

  it('reports live sync progress, persisted last_completed_at, and last_error via getSyncStatus', async () => {
    const statePath = await createTempStatePath();
    let statusDuringRun: Awaited<ReturnType<SyncService['getSyncStatus']>> | null = null;
    let shouldFail = false;

    const db: DbPoolLike = {
      query: async () => ({ rows: [{ start_date: '2026-11-10 08:00:00' }] }),
      connect: async () => ({
        query: async (sql) => {
          if (sql.includes('SELECT id, updated_at FROM leads')) {
            return { rows: [] };
          }
          return { rows: [] };
        },
        release: () => undefined,
      }),
    };

    const sync = new SyncService({
      db,
      auth: {
        authenticatedFetch: async (url) => {
          if (shouldFail) {
            return new Response('upstream boom', { status: 400 });
          }
          const page = new URL(url).searchParams.get('page');
          if (page === '2') {
            statusDuringRun = await sync.getSyncStatus();
            return new Response(
              JSON.stringify({
                data: [makeSampleLead(2)],
                meta: { current_page: 2, last_page: 2, total: 2 },
              }),
              { status: 200 }
            );
          }
          return new Response(
            JSON.stringify({
              data: [makeSampleLead(1)],
              meta: { current_page: 1, last_page: 2, total: 2 },
            }),
            { status: 200 }
          );
        },
      },
      statePath,
      pageDelayMs: 0,
      maxRetries: 0,
      logger: silentLogger,
    });

    const initialStatus = await sync.getSyncStatus();
    assert.equal(initialStatus.in_progress, false);
    assert.equal(initialStatus.progress, null);
    assert.equal(initialStatus.last_completed_at, null);

    await sync.syncLeads();
    assert.ok(statusDuringRun);
    assert.equal(statusDuringRun.in_progress, true);
    assert.equal(statusDuringRun.progress?.pages_processed, 1);
    assert.equal(statusDuringRun.progress?.last_page, 2);
    assert.equal(statusDuringRun.progress?.total_synced, 1);

    const statusAfterSuccess = await sync.getSyncStatus();
    assert.equal(statusAfterSuccess.in_progress, false);
    assert.equal(statusAfterSuccess.progress, null);
    assert.ok(statusAfterSuccess.last_completed_at);
    assert.equal(statusAfterSuccess.last_result?.totalSynced, 2);
    assert.equal(statusAfterSuccess.last_error, null);

    shouldFail = true;
    await assert.rejects(() => sync.syncLeads());
    const statusAfterError = await sync.getSyncStatus();
    assert.equal(statusAfterError.in_progress, false);
    assert.ok(statusAfterError.last_error?.includes('HTTP 400'));
  });
});
