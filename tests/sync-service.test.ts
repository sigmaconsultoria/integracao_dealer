import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { AppError } from '../src/errors/app-error.js';
import type { AuthClientLike, DbClientLike, DbPoolLike } from '../src/modules/leads/leads.service.js';
import type { SyncAuthManagerLike } from '../src/services/sync.service.js';
import { SyncService } from '../src/services/sync.service.js';
import { MemorySyncStateStore, PostgresSyncStateStore } from '../src/services/sync-state-store.js';

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

function createMockMultiUnitAuthManager(
  clients: Record<string, AuthClientLike>
): SyncAuthManagerLike {
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
      return clients[norm] as ReturnType<SyncAuthManagerLike['getClient']>;
    },
  };
}

describe('SyncService (17 tables UNNEST, multi-unit watermark, isolation, and status)', () => {
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

  it('upserts all 17 tables via UNNEST, sets unidade ONLY on 4 tables, deduplicates entities, and preserves zero values', async () => {
    const statePath = await createTempStatePath();
    const recordedQueries: Array<{ sql: string; params?: any[] }> = [];

    const txClient: DbClientLike = {
      query: async (sql, params) => {
        recordedQueries.push({ sql, params });
        if (sql.includes('SELECT id, updated_at, unidade FROM leads')) {
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
    assert.equal(res.units.MT?.success, true);

    const tablesWithUnidade = new Set(['leads_raw', 'teams', 'locations', 'leads']);
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

      if (tablesWithUnidade.has(table)) {
        assert.equal(found.sql.includes('unidade'), true, `${table} must include unidade`);
        assert.equal(
          found.sql.includes(`WHERE ${table}.unidade = EXCLUDED.unidade`),
          true,
          `${table} must guard ON CONFLICT UPDATE with WHERE ${table}.unidade = EXCLUDED.unidade`
        );
        const withoutWhereGuard = found.sql.replace(
          `WHERE ${table}.unidade = EXCLUDED.unidade`,
          ''
        );
        assert.equal(
          withoutWhereGuard.includes('unidade = EXCLUDED.unidade'),
          false,
          `${table} MUST NOT reassign unidade on conflict`
        );
      } else {
        assert.equal(found.sql.includes('unidade'), false, `${table} MUST NOT include unidade`);
      }
    }

    // Watermark fallback query filtered by WHERE unidade = $1
    const maxUpdatedQuery = recordedQueries.find((q) => q.sql.includes('MAX(updated_at)'));
    assert.equal(maxUpdatedQuery?.sql.includes('WHERE unidade = $1'), true);
    assert.deepEqual(maxUpdatedQuery?.params, ['MT']);

    // Deduplication check
    const attendantsInsert = recordedQueries.find((q) =>
      q.sql.includes('INSERT INTO attendants (')
    );
    assert.deepEqual(attendantsInsert?.params?.[0], [10]);

    // Zero values preserved + unidade appended at $23
    const leadsInsert = recordedQueries.find((q) => q.sql.includes('INSERT INTO leads ('));
    assert.equal(leadsInsert?.params?.[12]?.[0], '0');
    assert.deepEqual(leadsInsert?.params?.[22], ['MT', 'MT']);

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

    await assert.rejects(() => sync.syncLeads());

    const stateAfterFailure = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    assert.equal(stateAfterFailure.MT.pending_start_date, '2026-11-10 08:00:00');

    shouldFailPage2 = false;
    const resumedRes = await sync.syncLeads();
    assert.equal(resumedRes.resumedFromPending, true);
    assert.equal(resumedRes.startDate, '2026-11-10 08:00:00');
    assert.equal(resumedRes.pagesProcessed, 2);

    const stateAfterSuccess = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    assert.equal(stateAfterSuccess.MT.pending_start_date, null);
    assert.ok(stateAfterSuccess.MT.last_completed_at);
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

  it('skips unchanged leads on incremental sync and forces upsert on customDate backfill for same unit', async () => {
    const statePath = await createTempStatePath();
    const lead = makeSampleLead(1, { updated_at: '2026-11-10T14:00:00.000Z' });

    const db: DbPoolLike = {
      query: async () => ({ rows: [{ start_date: '2026-11-10 08:00:00' }] }),
      connect: async () => ({
        query: async (sql) => {
          if (sql.includes('SELECT id, updated_at, unidade FROM leads')) {
            return {
              rows: [
                {
                  id: 1,
                  updated_at: new Date('2026-11-10T14:00:00.000Z'),
                  unidade: 'MT',
                },
              ],
            };
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

    const sync = new SyncService({
      db,
      auth,
      statePath,
      pageDelayMs: 0,
      logger: silentLogger,
    });

    const incRes = await sync.syncLeads();
    assert.equal(incRes.totalSynced, 0);

    const backfillRes = await sync.syncLeads('2026-11-09 00:00:00', false);
    assert.equal(backfillRes.totalSynced, 1);
  });

  it('blocks batch with 409 UNIT_OWNERSHIP_CONFLICT and rolls back without INSERTs on lead, location, or team conflict (even on forceUpsert)', async () => {
    // 1) Lead pertencente a PA ao tentar sincronizar MT (incremental e forceUpsert)
    for (const forceMode of [false, true]) {
      const stateStore = new MemorySyncStateStore();
      const txQueries: string[] = [];
      const errors: Array<{ obj: Record<string, unknown>; msg?: string }> = [];

      const db: DbPoolLike = {
        query: async () => ({ rows: [{ start_date: '2026-11-10 08:00:00' }] }),
        connect: async () => ({
          query: async (sql) => {
            txQueries.push(sql);
            if (sql.includes('SELECT id, updated_at, unidade FROM leads')) {
              return {
                rows: [
                  {
                    id: 1,
                    updated_at: new Date('2026-11-10T14:00:00.000Z'),
                    unidade: 'PA',
                  },
                ],
              };
            }
            return { rows: [] };
          },
          release: () => undefined,
        }),
      };

      const sync = new SyncService({
        db,
        auth: {
          authenticatedFetch: async () =>
            new Response(
              JSON.stringify({
                data: [makeSampleLead(1)],
                meta: { current_page: 1, last_page: 1, total: 1 },
              }),
              { status: 200 }
            ),
        },
        stateStore,
        pageDelayMs: 0,
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: (obj: any, msg?: string) => errors.push({ obj, msg }),
        },
      });

      await assert.rejects(
        () => sync.syncLeads(forceMode ? '2026-11-09 00:00:00' : undefined, forceMode),
        (err) =>
          err instanceof AppError &&
          err.statusCode === 409 &&
          err.code === 'UNIT_OWNERSHIP_CONFLICT'
      );
      assert.equal(txQueries.includes('ROLLBACK'), true);
      assert.equal(txQueries.some((q) => q.includes('INSERT INTO ')), false);
      assert.equal(errors.length > 0, true);
    }

    // 2) Lead inédito, mas location.id já pertence a MT ao sincronizar AP
    {
      const txQueries: string[] = [];
      const db: DbPoolLike = {
        query: async () => ({ rows: [{ start_date: '2026-11-10 08:00:00' }] }),
        connect: async () => ({
          query: async (sql) => {
            txQueries.push(sql);
            if (sql.includes('FROM locations WHERE id = ANY')) {
              return { rows: [{ id: 20, name: 'Loja Cuiabá', unidade: 'MT' }] };
            }
            return { rows: [] };
          },
          release: () => undefined,
        }),
      };

      const authManager = createMockMultiUnitAuthManager({
        AP: {
          authenticatedFetch: async () =>
            new Response(
              JSON.stringify({
                data: [makeSampleLead(999, { location: { id: 20, name: 'Loja Cuiabá' } })],
                meta: { current_page: 1, last_page: 1, total: 1 },
              }),
              { status: 200 }
            ),
        },
      });

      const sync = new SyncService({
        db,
        authManager,
        stateStore: new MemorySyncStateStore(),
        pageDelayMs: 0,
        logger: silentLogger,
      });

      await assert.rejects(
        () => sync.syncLeads(undefined, false, 'AP'),
        (err) =>
          err instanceof AppError &&
          err.statusCode === 409 &&
          err.code === 'UNIT_OWNERSHIP_CONFLICT'
      );
      assert.equal(txQueries.includes('ROLLBACK'), true);
      assert.equal(txQueries.some((q) => q.includes('INSERT INTO ')), false);
    }

    // 3) Lead inédito e loja inédita, mas team.id já pertence a MT ao sincronizar PA
    {
      const txQueries: string[] = [];
      const db: DbPoolLike = {
        query: async () => ({ rows: [{ start_date: '2026-11-10 08:00:00' }] }),
        connect: async () => ({
          query: async (sql) => {
            txQueries.push(sql);
            if (sql.includes('FROM teams WHERE id = ANY')) {
              return { rows: [{ id: 40, name: 'Comercial Cuiabá', unidade: 'MT' }] };
            }
            return { rows: [] };
          },
          release: () => undefined,
        }),
      };

      const authManager = createMockMultiUnitAuthManager({
        PA: {
          authenticatedFetch: async () =>
            new Response(
              JSON.stringify({
                data: [
                  makeSampleLead(888, {
                    location: { id: 9999, name: 'Loja PA' },
                    team: { id: 40, name: 'Comercial Cuiabá' },
                  }),
                ],
                meta: { current_page: 1, last_page: 1, total: 1 },
              }),
              { status: 200 }
            ),
        },
      });

      const sync = new SyncService({
        db,
        authManager,
        stateStore: new MemorySyncStateStore(),
        pageDelayMs: 0,
        logger: silentLogger,
      });

      await assert.rejects(
        () => sync.syncLeads(undefined, false, 'PA'),
        (err) =>
          err instanceof AppError &&
          err.statusCode === 409 &&
          err.code === 'UNIT_OWNERSHIP_CONFLICT'
      );
      assert.equal(txQueries.includes('ROLLBACK'), true);
      assert.equal(txQueries.some((q) => q.includes('INSERT INTO ')), false);
    }

    // 4) No sync multi-unidade (MT, PA, AP), se AP cair em UNIT_OWNERSHIP_CONFLICT, MT e PA continuam com sucesso
    {
      const insertedByUnit: string[] = [];
      const db: DbPoolLike = {
        query: async () => ({ rows: [{ start_date: '2026-11-10 08:00:00' }] }),
        connect: async () => ({
          query: async (sql, params) => {
            if (sql.includes('FROM locations WHERE id = ANY') && params?.[1] === 'AP') {
              return { rows: [{ id: 3939, name: 'MÔNACO MOTOCENTER MATRIZ', unidade: 'PA' }] };
            }
            if (sql.includes('INSERT INTO leads (')) {
              insertedByUnit.push(...(params?.[22] ?? []));
            }
            return { rows: [] };
          },
          release: () => undefined,
        }),
      };

      const authManager = createMockMultiUnitAuthManager({
        MT: {
          authenticatedFetch: async () =>
            new Response(
              JSON.stringify({
                data: [makeSampleLead(101, { location: { id: 658, name: 'Cuiabá' } })],
                meta: { current_page: 1, last_page: 1, total: 1 },
              }),
              { status: 200 }
            ),
        },
        PA: {
          authenticatedFetch: async () =>
            new Response(
              JSON.stringify({
                data: [makeSampleLead(202, { location: { id: 3939, name: 'Belém Matriz' } })],
                meta: { current_page: 1, last_page: 1, total: 1 },
              }),
              { status: 200 }
            ),
        },
        AP: {
          authenticatedFetch: async () =>
            new Response(
              JSON.stringify({
                data: [makeSampleLead(303, { location: { id: 3939, name: 'Belém Matriz' } })],
                meta: { current_page: 1, last_page: 1, total: 1 },
              }),
              { status: 200 }
            ),
        },
      });

      const sync = new SyncService({
        db,
        authManager,
        stateStore: new MemorySyncStateStore(),
        pageDelayMs: 0,
        logger: silentLogger,
      });

      const res = await sync.syncLeads();
      assert.equal(res.success, true);
      assert.equal(res.partial_failure, true);
      assert.equal(res.totalSynced, 2);
      assert.equal(res.units.MT?.success, true);
      assert.equal(res.units.PA?.success, true);
      assert.equal(res.units.AP?.success, false);
      assert.ok(res.units.AP?.error?.includes('Bloqueio de segurança'));
      assert.deepEqual(insertedByUnit, ['MT', 'PA']);
    }
  });

  it('reports live sync progress, persisted last_completed_at, and last_error via getSyncStatus', async () => {
    const statePath = await createTempStatePath();
    let statusDuringRun: Awaited<ReturnType<SyncService['getSyncStatus']>> | null = null;
    let shouldFail = false;

    const db: DbPoolLike = {
      query: async () => ({ rows: [{ start_date: '2026-11-10 08:00:00' }] }),
      connect: async () => ({
        query: async (sql) => {
          if (sql.includes('SELECT id, updated_at, unidade FROM leads')) {
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
    assert.equal(initialStatus.units.MT?.in_progress, false);

    await sync.syncLeads();
    assert.ok(statusDuringRun);
    assert.equal(statusDuringRun.in_progress, true);
    assert.equal(statusDuringRun.progress?.current_unit, 'MT');
    assert.equal(statusDuringRun.progress?.pages_processed, 1);
    assert.equal(statusDuringRun.progress?.last_page, 2);
    assert.equal(statusDuringRun.progress?.total_synced, 1);
    assert.equal(statusDuringRun.units.MT?.in_progress, true);

    const statusAfterSuccess = await sync.getSyncStatus();
    assert.equal(statusAfterSuccess.in_progress, false);
    assert.equal(statusAfterSuccess.progress, null);
    assert.ok(statusAfterSuccess.last_completed_at);
    assert.equal(statusAfterSuccess.last_result?.totalSynced, 2);
    assert.equal(statusAfterSuccess.last_error, null);
    assert.equal(statusAfterSuccess.units.MT?.last_result?.totalSynced, 2);

    shouldFail = true;
    await assert.rejects(() => sync.syncLeads());
    const statusAfterError = await sync.getSyncStatus();
    assert.equal(statusAfterError.in_progress, false);
    assert.ok(statusAfterError.last_error?.includes('HTTP 400'));
    assert.ok(statusAfterError.units.MT?.last_error?.includes('HTTP 400'));
  });

  it('PostgresSyncStateStore reads/writes per-unit watermark in public.sync_state', async () => {
    const table = new Map<string, Record<string, unknown>>();
    const mockDb = {
      query: async (sql: string, params: any[] = []) => {
        if (sql.includes('FROM sync_state')) {
          const row = table.get(String(params[0]));
          return { rows: row ? [row] : [] };
        }
        if (sql.includes('INSERT INTO sync_state')) {
          table.set(String(params[0]), {
            pending_start_date: params[1],
            last_completed_at: params[2],
            last_start_date: params[3],
          });
          return { rows: [], rowCount: 1 };
        }
        return { rows: [] };
      },
    };

    const store = new PostgresSyncStateStore(mockDb);
    assert.equal(await store.read('PA'), null);

    await store.write('PA', {
      pending_start_date: '2026-11-26 08:00:00',
      last_completed_at: null,
      last_start_date: null,
    });

    const loadedPa = await store.read('PA');
    assert.deepEqual(loadedPa, {
      pending_start_date: '2026-11-26 08:00:00',
      last_completed_at: null,
      last_start_date: null,
    });
    assert.equal(await store.read('AP'), null);
  });

  it('isolates errors across MT/PA/AP, supports ?unidade= filtering, and rejects only when all units fail', async () => {
    const stateStore = new MemorySyncStateStore();
    const maxQueryUnits: string[] = [];
    const insertedLeadUnits: string[] = [];

    const db: DbPoolLike = {
      query: async (sql, params) => {
        if (sql.includes('MAX(updated_at)')) {
          const unit = String(params?.[0]);
          maxQueryUnits.push(unit);
          const dateByUnit: Record<string, string> = {
            MT: '2026-11-25 08:00:00',
            PA: '2026-11-20 08:00:00',
            AP: '2026-11-22 08:00:00',
          };
          return { rows: [{ start_date: dateByUnit[unit] }] };
        }
        return { rows: [] };
      },
      connect: async () => ({
        query: async (sql, params) => {
          if (sql.includes('INSERT INTO leads (')) {
            insertedLeadUnits.push(...(params?.[22] ?? []));
          }
          return { rows: [] };
        },
        release: () => undefined,
      }),
    };

    let paShouldFail = true;
    let mtShouldFail = false;
    let apShouldFail = false;

    const authManager = createMockMultiUnitAuthManager({
      MT: {
        authenticatedFetch: async () =>
          mtShouldFail
            ? new Response('mt down', { status: 500 })
            : new Response(
                JSON.stringify({
                  data: [makeSampleLead(10)],
                  meta: { current_page: 1, last_page: 1, total: 1 },
                }),
                { status: 200 }
              ),
      },
      PA: {
        authenticatedFetch: async () =>
          paShouldFail
            ? Promise.reject(
                new AppError(503, 'PA sem refresh token', 'MISSING_REFRESH_TOKEN')
              )
            : new Response(
                JSON.stringify({
                  data: [makeSampleLead(20)],
                  meta: { current_page: 1, last_page: 1, total: 1 },
                }),
                { status: 200 }
              ),
      },
      AP: {
        authenticatedFetch: async () =>
          apShouldFail
            ? new Response('ap down', { status: 500 })
            : new Response(
                JSON.stringify({
                  data: [makeSampleLead(30)],
                  meta: { current_page: 1, last_page: 1, total: 1 },
                }),
                { status: 200 }
              ),
      },
    });

    const sync = new SyncService({
      db,
      authManager,
      stateStore,
      pageDelayMs: 0,
      maxRetries: 0,
      logger: silentLogger,
    });

    // PA falha, mas MT e AP concluem -> partial_failure = true
    const partialRes = await sync.syncLeads();
    assert.equal(partialRes.success, true);
    assert.equal(partialRes.partial_failure, true);
    assert.equal(partialRes.totalSynced, 2);
    assert.equal(partialRes.units.MT?.success, true);
    assert.equal(partialRes.units.PA?.success, false);
    assert.equal(partialRes.units.AP?.success, true);
    assert.deepEqual(maxQueryUnits, ['MT', 'PA', 'AP']);
    assert.deepEqual(insertedLeadUnits, ['MT', 'AP']);

    // Watermark de PA preservado em pending_start_date enquanto MT e AP avançaram
    const paState = await stateStore.read('PA');
    const mtState = await stateStore.read('MT');
    const apState = await stateStore.read('AP');
    assert.equal(paState?.pending_start_date, '2026-11-20 08:00:00');
    assert.equal(mtState?.pending_start_date, null);
    assert.equal(apState?.pending_start_date, null);

    // ?unidade=PA roda apenas PA e retoma do pending_start_date
    paShouldFail = false;
    const paOnlyRes = await sync.syncLeads(undefined, false, 'PA');
    assert.equal(paOnlyRes.success, true);
    assert.equal(paOnlyRes.partial_failure, undefined);
    assert.equal(paOnlyRes.totalSynced, 1);
    assert.equal(paOnlyRes.resumedFromPending, true);
    assert.deepEqual(Object.keys(paOnlyRes.units), ['PA']);

    // Todas falham -> lança SYNC_ALL_UNITS_FAILED
    mtShouldFail = true;
    paShouldFail = true;
    apShouldFail = true;
    await assert.rejects(
      () => sync.syncLeads(),
      (err) => err instanceof AppError && err.statusCode === 502 && err.code === 'SYNC_ALL_UNITS_FAILED'
    );
  });
});
