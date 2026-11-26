import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { afterEach, describe, it, mock } from 'node:test';
import { buildApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { createLogger } from '../src/config/logger.js';
import { AppError } from '../src/errors/app-error.js';
import { leadsService } from '../src/modules/leads/leads.service.js';
import { extractApiKey, verifyApiKey } from '../src/plugins/auth.js';
import { createReadinessCheck } from '../src/routes.js';
import { authManager, AuthService } from '../src/services/auth.service.js';
import { syncScheduler } from '../src/services/scheduler.service.js';
import { syncService } from '../src/services/sync.service.js';

const VALID_TEST_API_KEY = 'a'.repeat(64);
const VALID_PREV_API_KEY = 'b'.repeat(64);

function createValidEnvInput(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'development',
    LOG_LEVEL: 'silent',
    HOST: '127.0.0.1',
    PORT: '3333',
    TRUST_PROXY: 'false',
    API_KEY: VALID_TEST_API_KEY,
    API_KEY_PREVIOUS: '',
    CORS_ORIGIN: '',
    RATE_LIMIT_MAX: '60',
    RATE_LIMIT_WINDOW_MS: '60000',
    DB_HOST: '127.0.0.1',
    DB_PORT: '5432',
    DB_NAME: 'leads_test',
    DB_USER: 'postgres',
    DB_PASSWORD: 'strong-test-password',
    DB_SSL: 'false',
    FOLLOWIZE_CLIENT_ID: '1234',
    FOLLOWIZE_CLIENT_SECRET: 'secret-value',
    FOLLOWIZE_REFRESH_TOKEN: 'refresh-token-value',
    FOLLOWIZE_TOKEN_CACHE_PATH: '.runtime/followize-token.json',
    FOLLOWIZE_TIMEOUT_MS: '15000',
    ...overrides,
  };
}

describe('Environment validation (parseEnv Opção A + MT fallback)', () => {
  it('parses valid legacy single-unit config and handles DB_SSL="false" and TRUST_PROXY', () => {
    const parsed = parseEnv(
      createValidEnvInput({
        API_KEY_PREVIOUS: VALID_PREV_API_KEY,
        CORS_ORIGIN: 'https://a.example.com, https://b.example.com ',
        DB_SSL: 'false',
        TRUST_PROXY: '127.0.0.1',
      })
    );

    assert.equal(parsed.DB_SSL, false);
    assert.equal(parsed.TRUST_PROXY, '127.0.0.1');
    assert.deepEqual(parsed.CORS_ORIGINS, ['https://a.example.com', 'https://b.example.com']);
    assert.deepEqual(parsed.VALID_API_KEYS, [VALID_TEST_API_KEY, VALID_PREV_API_KEY]);
    assert.equal(parsed.SYNC_CRON_ENABLED, false);
    assert.deepEqual(parsed.SYNC_CRON_SCHEDULES, ['0 8,12,15,18 * * 1-5']);
    assert.deepEqual(parsed.FOLLOWIZE_UNITS, ['MT']);
    assert.deepEqual(parsed.FOLLOWIZE_CLIENTS.MT, {
      unidade: 'MT',
      clientId: '1234',
      clientSecret: 'secret-value',
      seedRefreshToken: 'refresh-token-value',
    });
  });

  it('parses multi-unit FOLLOWIZE_UNITS, deduplicates, prioritizes FOLLOWIZE_MT_*, and falls back to legacy MT', () => {
    const parsed = parseEnv(
      createValidEnvInput({
        FOLLOWIZE_UNITS: ' mt , pa, ap, MT ',
        FOLLOWIZE_MT_CLIENT_ID: 'mt-id-new',
        FOLLOWIZE_MT_CLIENT_SECRET: 'mt-sec-new',
        FOLLOWIZE_MT_REFRESH_TOKEN: '',
        FOLLOWIZE_PA_CLIENT_ID: 'pa-id',
        FOLLOWIZE_PA_CLIENT_SECRET: 'pa-sec',
        FOLLOWIZE_PA_REFRESH_TOKEN: 'pa-seed',
        FOLLOWIZE_AP_CLIENT_ID: 'ap-id',
        FOLLOWIZE_AP_CLIENT_SECRET: 'ap-sec',
      })
    );

    assert.deepEqual(parsed.FOLLOWIZE_UNITS, ['MT', 'PA', 'AP']);
    // FOLLOWIZE_MT_CLIENT_ID tem precedência sobre FOLLOWIZE_CLIENT_ID; REFRESH_TOKEN vazio cai para fallback legado
    assert.equal(parsed.FOLLOWIZE_CLIENTS.MT?.clientId, 'mt-id-new');
    assert.equal(parsed.FOLLOWIZE_CLIENTS.MT?.clientSecret, 'mt-sec-new');
    assert.equal(parsed.FOLLOWIZE_CLIENTS.MT?.seedRefreshToken, 'refresh-token-value');
    assert.deepEqual(parsed.FOLLOWIZE_CLIENTS.PA, {
      unidade: 'PA',
      clientId: 'pa-id',
      clientSecret: 'pa-sec',
      seedRefreshToken: 'pa-seed',
    });
    assert.deepEqual(parsed.FOLLOWIZE_CLIENTS.AP, {
      unidade: 'AP',
      clientId: 'ap-id',
      clientSecret: 'ap-sec',
    });
  });

  it('allows empty FOLLOWIZE_REFRESH_TOKEN and validates SYNC_CRON_* settings', () => {
    const withoutSeed = parseEnv(
      createValidEnvInput({
        FOLLOWIZE_REFRESH_TOKEN: '',
        SYNC_CRON_ENABLED: 'true',
        SYNC_CRON_SCHEDULE: '0 8,12 * * 1-5; 30 9 * * 6',
        SYNC_CRON_TIMEZONE: 'America/Sao_Paulo',
      })
    );
    assert.equal(withoutSeed.FOLLOWIZE_CLIENTS.MT?.seedRefreshToken, undefined);
    assert.equal(withoutSeed.SYNC_CRON_ENABLED, true);
    assert.deepEqual(withoutSeed.SYNC_CRON_SCHEDULES, ['0 8,12 * * 1-5', '30 9 * * 6']);

    assert.throws(() =>
      parseEnv(createValidEnvInput({ SYNC_CRON_SCHEDULE: 'expressao-invalida' }))
    );
    assert.throws(() =>
      parseEnv(createValidEnvInput({ SYNC_CRON_TIMEZONE: 'Invalid/Timezone_XYZ' }))
    );
    assert.throws(() =>
      parseEnv(createValidEnvInput({ SYNC_CRON_ENABLED: 'true', SYNC_CRON_SCHEDULE: '' }))
    );
  });

  it('rejects missing unit credentials, invalid unit names, missing secrets, and short API_KEY', () => {
    assert.throws(() => parseEnv(createValidEnvInput({ API_KEY: 'too-short' })));
    assert.throws(() => parseEnv(createValidEnvInput({ DB_PASSWORD: '' })));
    assert.throws(() => parseEnv(createValidEnvInput({ FOLLOWIZE_CLIENT_ID: '' })));
    assert.throws(() =>
      parseEnv(
        createValidEnvInput({
          FOLLOWIZE_UNITS: 'MT,PA',
          FOLLOWIZE_PA_CLIENT_ID: '',
          FOLLOWIZE_PA_CLIENT_SECRET: 'pa-sec',
        })
      )
    );
    assert.throws(() =>
      parseEnv(
        createValidEnvInput({
          FOLLOWIZE_UNITS: 'MT,INVALID UNIT!',
        })
      )
    );
    assert.throws(() =>
      parseEnv(
        createValidEnvInput({
          FOLLOWIZE_UNITS: ',,,',
        })
      )
    );
  });

  it('rejects CORS_ORIGIN="*" in production', () => {
    assert.throws(() =>
      parseEnv(
        createValidEnvInput({
          NODE_ENV: 'production',
          CORS_ORIGIN: '*',
        })
      )
    );
  });
});

describe('API key extraction and verification', () => {
  it('extracts key from X-API-Key or Bearer Authorization header', () => {
    assert.equal(extractApiKey({ 'x-api-key': '  my-key  ' }), 'my-key');
    assert.equal(extractApiKey({ authorization: 'Bearer my-bearer-key' }), 'my-bearer-key');
    assert.equal(extractApiKey({ authorization: 'Basic abc' }), null);
    assert.equal(extractApiKey({}), null);
  });

  it('verifies primary and previous keys in constant-time manner', () => {
    const keys = [VALID_TEST_API_KEY, VALID_PREV_API_KEY];
    assert.equal(verifyApiKey(VALID_TEST_API_KEY, keys), true);
    assert.equal(verifyApiKey(VALID_PREV_API_KEY, keys), true);
    assert.equal(verifyApiKey('wrong-key', keys), false);
    assert.equal(verifyApiKey('', keys), false);
  });
});

describe('Logger redaction', () => {
  it('redacts token, *.token, access_token, refresh_token, and client_secret', () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });

    const log = createLogger('info', stream);
    log.info(
      {
        token: 'top-secret-token',
        row: {
          token: 'nested-secret-token',
          access_token: 'secret-at',
          refresh_token: 'secret-rt',
          client_secret: 'secret-cs',
        },
        unidade: 'PA',
      },
      'teste redact'
    );

    const serialized = chunks.join('');
    assert.equal(serialized.includes('top-secret-token'), false);
    assert.equal(serialized.includes('nested-secret-token'), false);
    assert.equal(serialized.includes('secret-at'), false);
    assert.equal(serialized.includes('secret-rt'), false);
    assert.equal(serialized.includes('secret-cs'), false);
    assert.equal(serialized.includes('[REDACTED]'), true);
    assert.equal(serialized.includes('PA'), true);
  });
});

describe('Security middleware, Zod validation, /ready degraded, and multi-unit routes', () => {
  const appsToClose: Array<ReturnType<typeof buildApp>> = [];

  afterEach(async () => {
    mock.restoreAll();
    while (appsToClose.length > 0) {
      const app = appsToClose.pop();
      if (app) {
        await app.close();
      }
    }
  });

  function createTestApp(overrides: Parameters<typeof buildApp>[0] = {}) {
    const app = buildApp({
      logger: false,
      nodeEnv: 'test',
      apiKeys: [VALID_TEST_API_KEY, VALID_PREV_API_KEY],
      corsOrigins: ['https://allowed.example.com'],
      rateLimitMax: 100,
      rateLimitWindowMs: 60000,
      trustProxy: false,
      ...overrides,
    });
    appsToClose.push(app);
    return app;
  }

  it('exposes public /health and /ready across ready (200), degraded (200), and not_ready (503)', async () => {
    const readyCheckFn = createReadinessCheck({
      db: { query: async () => ({ rows: [{ '?column?': 1 }] }) },
      authManager: {
        getTokenStatus: async (u: string) => ({
          unidade: u,
          has_refresh_token: true,
          has_valid_access_token: u === 'MT',
          access_token_expires_at: null,
          source: 'api',
          updated_at: null,
          storage: 'postgres',
        }),
      },
      clients: {
        MT: { unidade: 'MT', clientId: '1', clientSecret: 's1' },
        PA: { unidade: 'PA', clientId: '2', clientSecret: 's2' },
      },
    });

    const appReady = createTestApp({ readinessCheck: readyCheckFn });
    const healthRes = await appReady.inject({ method: 'GET', url: '/health' });
    assert.equal(healthRes.statusCode, 200);
    assert.equal(healthRes.headers['x-content-type-options'], 'nosniff');

    const readyRes = await appReady.inject({ method: 'GET', url: '/ready' });
    assert.equal(readyRes.statusCode, 200);
    assert.deepEqual(readyRes.json(), {
      status: 'ready',
      checks: {
        database: 'ok',
        followize_config: 'ok',
        followize_units: {
          MT: { status: 'ok', has_refresh_token: true, has_valid_access_token: true },
          PA: { status: 'ok', has_refresh_token: true, has_valid_access_token: false },
        },
      },
    });

    // Degraded: DB ok, MT ok, PA sem refresh_token -> HTTP 200 status='degraded'
    const degradedCheckFn = createReadinessCheck({
      db: { query: async () => ({ rows: [{ '?column?': 1 }] }) },
      authManager: {
        getTokenStatus: async (u: string) => ({
          unidade: u,
          has_refresh_token: u === 'MT',
          has_valid_access_token: u === 'MT',
          access_token_expires_at: null,
          source: u === 'MT' ? 'api' : 'none',
          updated_at: null,
          storage: 'postgres',
        }),
      },
      clients: {
        MT: { unidade: 'MT', clientId: '1', clientSecret: 's1' },
        PA: { unidade: 'PA', clientId: '2', clientSecret: 's2' },
      },
    });
    const appDegraded = createTestApp({ readinessCheck: degradedCheckFn });
    const degradedRes = await appDegraded.inject({ method: 'GET', url: '/ready' });
    assert.equal(degradedRes.statusCode, 200);
    assert.equal(degradedRes.json().status, 'degraded');
    assert.equal(degradedRes.json().checks.followize_config, 'degraded');
    assert.equal(degradedRes.json().checks.followize_units.MT.status, 'ok');
    assert.equal(degradedRes.json().checks.followize_units.PA.status, 'error');

    // Not ready: 0 unidades ok -> HTTP 503
    const zeroUnitsCheckFn = createReadinessCheck({
      db: { query: async () => ({ rows: [{ '?column?': 1 }] }) },
      authManager: {
        getTokenStatus: async (u: string) => ({
          unidade: u,
          has_refresh_token: false,
          has_valid_access_token: false,
          access_token_expires_at: null,
          source: 'none',
          updated_at: null,
          storage: 'postgres',
        }),
      },
      clients: {
        MT: { unidade: 'MT', clientId: '1', clientSecret: 's1' },
      },
    });
    const appZeroUnits = createTestApp({ readinessCheck: zeroUnitsCheckFn });
    const zeroUnitsRes = await appZeroUnits.inject({ method: 'GET', url: '/ready' });
    assert.equal(zeroUnitsRes.statusCode, 503);
    assert.equal(zeroUnitsRes.json().status, 'not_ready');

    // Not ready: DB error -> HTTP 503 mesmo com unidades ok
    const dbDownCheckFn = createReadinessCheck({
      db: {
        query: async () => {
          throw new Error('db down');
        },
      },
      authManager: {
        getTokenStatus: async (u: string) => ({
          unidade: u,
          has_refresh_token: true,
          has_valid_access_token: true,
          access_token_expires_at: null,
          source: 'api',
          updated_at: null,
          storage: 'postgres',
        }),
      },
      clients: {
        MT: { unidade: 'MT', clientId: '1', clientSecret: 's1' },
      },
    });
    const appDbDown = createTestApp({ readinessCheck: dbDownCheckFn });
    const dbDownRes = await appDbDown.inject({ method: 'GET', url: '/ready' });
    assert.equal(dbDownRes.statusCode, 503);
    assert.equal(dbDownRes.json().status, 'not_ready');
    assert.equal(dbDownRes.json().checks.database, 'error');
  });

  it('returns standardized 404 for unknown routes and removed /leads/com-contrato-checado', async () => {
    const app = createTestApp();

    const unknownRes = await app.inject({ method: 'GET', url: '/nao-existe' });
    assert.equal(unknownRes.statusCode, 404);
    assert.deepEqual(unknownRes.json(), {
      success: false,
      error: 'Rota não encontrada',
    });

    const removedRes = await app.inject({
      method: 'GET',
      url: '/leads/com-contrato-checado',
      headers: { 'x-api-key': VALID_TEST_API_KEY },
    });
    assert.equal(removedRes.statusCode, 404);
    assert.deepEqual(removedRes.json(), {
      success: false,
      error: 'Rota não encontrada',
    });
  });

  it('rejects unauthenticated or invalid-key requests to /leads/* and /auth/* with 401', async () => {
    const app = createTestApp();
    const routes = [
      { method: 'GET' as const, url: '/leads/permitidos' },
      { method: 'POST' as const, url: '/leads/sync' },
      { method: 'GET' as const, url: '/leads/sync/status' },
      { method: 'GET' as const, url: '/leads/123/finalize' },
      { method: 'POST' as const, url: '/leads/123/finalize' },
      { method: 'GET' as const, url: '/auth/followize/status' },
      { method: 'GET' as const, url: '/auth/followize/authorize-url' },
      { method: 'POST' as const, url: '/auth/followize/refresh-token' },
      { method: 'POST' as const, url: '/auth/followize/exchange' },
      { method: 'GET' as const, url: '/auth/followize/verify' },
    ];

    for (const route of routes) {
      const missingRes = await app.inject({ method: route.method, url: route.url });
      assert.equal(missingRes.statusCode, 401, `${route.method} ${route.url} should require auth`);
      assert.ok(missingRes.headers['www-authenticate']);

      const invalidRes = await app.inject({
        method: route.method,
        url: route.url,
        headers: { authorization: 'Bearer wrong-token' },
      });
      assert.equal(invalidRes.statusCode, 401);
    }
  });

  it('GET /leads/:id/finalize previews payload with unidade and NEVER calls executeFinalization or cancelSchedule', async () => {
    const app = createTestApp();

    mock.method(leadsService, 'buildFinalizationPayload', async () => ({
      billed: true,
      order_number: '999',
      amount: 1500,
      sale_id_number: '12345678901',
      invoice_number: '999',
      invoice_date: '2026-11-20',
      type_of_sale: 'consortium' as const,
      message: 'Nro Proposta: 999',
    }));
    mock.method(leadsService, 'getPendingSchedule', async () => null);
    mock.method(leadsService, 'getFinalizationStatus', async () => ({
      exists: true,
      alreadyFinalized: false,
      status: 'pending',
      unidade: 'PA',
      finalizationId: null,
    }));
    const execMock = mock.method(leadsService, 'executeFinalization', async () => {
      throw new Error('executeFinalization MUST NOT be called on GET');
    });
    const cancelMock = mock.method(leadsService, 'cancelSchedule', async () => {
      throw new Error('cancelSchedule MUST NOT be called on GET');
    });

    const res = await app.inject({
      method: 'GET',
      url: '/leads/123/finalize',
      headers: { 'x-api-key': VALID_TEST_API_KEY },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.simulated, true);
    assert.equal(body.lead_id, 123);
    assert.equal(body.unidade, 'PA');
    assert.equal(body.already_finalized, false);
    assert.equal(body.has_pending_schedule, false);
    assert.equal(body.payload_ready.order_number, '999');
    assert.equal(execMock.mock.callCount(), 0);
    assert.equal(cancelMock.mock.callCount(), 0);
  });

  it('rejects invalid lead id params on GET and POST /leads/:id/finalize with 400', async () => {
    const app = createTestApp();

    for (const badId of ['abc', '-1', '0', '1.5']) {
      const getRes = await app.inject({
        method: 'GET',
        url: `/leads/${badId}/finalize`,
        headers: { authorization: `Bearer ${VALID_TEST_API_KEY}` },
      });
      assert.equal(getRes.statusCode, 400, `GET ${badId} should be 400`);

      const postRes = await app.inject({
        method: 'POST',
        url: `/leads/${badId}/finalize`,
        headers: { authorization: `Bearer ${VALID_TEST_API_KEY}` },
        payload: { simulate: true },
      });
      assert.equal(postRes.statusCode, 400, `POST ${badId} should be 400`);
    }
  });

  it('validates POST /leads/:id/finalize payload rules, unit availability (422), and propagates upstream HTTP error', async () => {
    const app = createTestApp();

    mock.method(leadsService, 'buildFinalizationPayload', async () => ({
      billed: true,
      order_number: '999',
      amount: 1500,
      sale_id_number: '12345678901',
      invoice_number: '999',
      invoice_date: '2026-11-20',
      type_of_sale: 'consortium' as const,
      message: 'Nro Proposta: 999',
    }));
    mock.method(leadsService, 'getFinalizationStatus', async () => ({
      exists: true,
      alreadyFinalized: false,
      status: 'pending',
      unidade: 'MT',
      finalizationId: null,
    }));
    mock.method(leadsService, 'assertUnitAvailable', (_id, unit) => String(unit || 'MT'));

    const unknownFieldRes = await app.inject({
      method: 'POST',
      url: '/leads/123/finalize',
      headers: { 'x-api-key': VALID_TEST_API_KEY },
      payload: {
        simulate: true,
        payload: { unexpected_field: 'nope' },
      },
    });
    assert.equal(unknownFieldRes.statusCode, 400);

    const missingBilledAtRes = await app.inject({
      method: 'POST',
      url: '/leads/123/finalize',
      headers: { 'x-api-key': VALID_TEST_API_KEY },
      payload: {
        simulate: true,
        payload: { billed: false },
      },
    });
    assert.equal(missingBilledAtRes.statusCode, 400);

    let lastSimulateFlag: boolean | undefined;
    mock.method(leadsService, 'executeFinalization', async (_id, payload, simulate = false) => {
      lastSimulateFlag = simulate;
      return {
        simulated: true,
        message: 'Simulado',
        target_endpoint: 'https://api.followize.com.br/v3/leads/123/finalization/realized_sale',
        payload_ready: payload,
      };
    });

    const simRes = await app.inject({
      method: 'POST',
      url: '/leads/123/finalize',
      headers: { authorization: `Bearer ${VALID_PREV_API_KEY}` },
      payload: { simulate: true },
    });
    assert.equal(simRes.statusCode, 200);
    assert.equal(lastSimulateFlag, true);
    assert.equal(simRes.json().simulated, true);

    mock.restoreAll();
    mock.method(leadsService, 'getFinalizationStatus', async () => ({
      exists: true,
      alreadyFinalized: false,
      status: 'pending',
      unidade: 'PA',
      finalizationId: null,
    }));
    mock.method(leadsService, 'assertUnitAvailable', () => {
      throw new AppError(422, 'Unidade indisponível', 'LEAD_UNIT_UNAVAILABLE');
    });

    const unavailableRes = await app.inject({
      method: 'POST',
      url: '/leads/123/finalize',
      headers: { 'x-api-key': VALID_TEST_API_KEY },
      payload: {},
    });
    assert.equal(unavailableRes.statusCode, 422);
    assert.equal(unavailableRes.json().code, 'LEAD_UNIT_UNAVAILABLE');

    mock.restoreAll();
    mock.method(leadsService, 'getFinalizationStatus', async () => ({
      exists: true,
      alreadyFinalized: false,
      status: 'pending',
      unidade: 'MT',
      finalizationId: null,
    }));
    mock.method(leadsService, 'assertUnitAvailable', () => 'MT');
    mock.method(leadsService, 'buildFinalizationPayload', async () => ({
      billed: true,
      order_number: '999',
      amount: 1500,
      sale_id_number: '12345678901',
      invoice_number: '999',
      invoice_date: '2026-11-20',
      type_of_sale: 'consortium' as const,
      message: 'Nro Proposta: 999',
    }));
    mock.method(leadsService, 'executeFinalization', async () => ({
      simulated: false,
      status_code: 422,
      success: false,
      local_db_synced: false,
      response_api: { message: 'Lead já finalizado' },
    }));

    const upstreamErrRes = await app.inject({
      method: 'POST',
      url: '/leads/123/finalize',
      headers: { 'x-api-key': VALID_TEST_API_KEY },
      payload: {},
    });
    assert.equal(upstreamErrRes.statusCode, 422);
    assert.equal(upstreamErrRes.json().success, false);
  });

  it('validates query params (including unidade) on GET /leads/permitidos and POST /leads/sync', async () => {
    const app = createTestApp();

    for (const qs of ['days=abc', 'days=999', 'days=0', 'only_actionable=maybe', 'unidade=A']) {
      const res = await app.inject({
        method: 'GET',
        url: `/leads/permitidos?${qs}`,
        headers: { 'x-api-key': VALID_TEST_API_KEY },
      });
      assert.equal(res.statusCode, 400, `/leads/permitidos?${qs} should be 400`);
    }

    let capturedPermittedOpts: Record<string, unknown> | undefined;
    mock.method(leadsService, 'getPermittedLeads', async (opts) => {
      capturedPermittedOpts = opts as Record<string, unknown>;
      return {
        allowed_teams_count: 1,
        allowed_locations_count: 1,
        total: 0,
        aptos_para_finalizar: 0,
        live_check_errors: 0,
        by_unit: {},
        leads: [],
      };
    });
    const okPermitted = await app.inject({
      method: 'GET',
      url: '/leads/permitidos?only_actionable=false&live_check=false&days=15&unidade=pa',
      headers: { 'x-api-key': VALID_TEST_API_KEY },
    });
    assert.equal(okPermitted.statusCode, 200);
    assert.deepEqual(capturedPermittedOpts, {
      days: 15,
      onlyActionable: false,
      liveCheck: false,
      unidade: 'PA',
    });

    let syncArgs: Array<unknown> = [];
    mock.method(
      syncService,
      'startSyncInBackground',
      (customDate?: string, fullSync = false, unidade?: string) => {
        syncArgs = [customDate, fullSync, unidade];
      }
    );
    mock.method(syncService, 'getSyncStatus', async () => ({
      in_progress: true,
      progress: null,
      last_completed_at: null,
      last_start_date: null,
      last_result: null,
      last_error: null,
      units: {},
    }));

    const syncFalse = await app.inject({
      method: 'POST',
      url: '/leads/sync?full=false',
      headers: { 'x-api-key': VALID_TEST_API_KEY },
    });
    assert.equal(syncFalse.statusCode, 202);
    assert.equal(syncFalse.json().accepted, true);
    assert.deepEqual(syncArgs, [undefined, false, undefined]);

    const syncUnit = await app.inject({
      method: 'POST',
      url: '/leads/sync?custom_date=2026-11-10T14:30:00&unidade=ap',
      headers: { 'x-api-key': VALID_TEST_API_KEY },
    });
    assert.equal(syncUnit.statusCode, 202);
    assert.deepEqual(syncArgs, ['2026-11-10 14:30:00', false, 'AP']);

    for (const badQs of ['custom_date=2026-02-31', 'custom_date=lixo', 'full=maybe', 'unidade=invalid!']) {
      const badSync = await app.inject({
        method: 'POST',
        url: `/leads/sync?${badQs}`,
        headers: { 'x-api-key': VALID_PREV_API_KEY },
      });
      assert.equal(badSync.statusCode, 400, `/leads/sync?${badQs} should be 400`);
    }
  });

  it('sanitizes internal 500 errors and propagates AppError status', async () => {
    const app = createTestApp({ nodeEnv: 'development' });

    mock.method(leadsService, 'getPermittedLeads', async () => {
      throw new Error('relation "leads" violates unique constraint "leads_pkey1"');
    });

    const errRes = await app.inject({
      method: 'GET',
      url: '/leads/permitidos',
      headers: { 'x-api-key': VALID_TEST_API_KEY },
    });
    assert.equal(errRes.statusCode, 500);
    const body = errRes.json();
    assert.deepEqual(body, {
      success: false,
      error: 'Erro interno do servidor',
    });
    assert.equal(JSON.stringify(body).includes('leads_pkey1'), false);

    mock.restoreAll();
    mock.method(leadsService, 'getFinalizationStatus', async () => {
      throw new AppError(409, 'O lead já está finalizado', 'ALREADY_FINALIZED');
    });
    const appErrRes = await app.inject({
      method: 'POST',
      url: '/leads/123/finalize',
      headers: { 'x-api-key': VALID_TEST_API_KEY },
      payload: {},
    });
    assert.equal(appErrRes.statusCode, 409);
    assert.deepEqual(appErrRes.json(), {
      success: false,
      error: 'O lead já está finalizado',
      code: 'ALREADY_FINALIZED',
    });
  });

  it('enforces allowed CORS origins and rate limiting with 429', async () => {
    const app = createTestApp({
      corsOrigins: ['https://allowed.example.com'],
      rateLimitMax: 2,
      rateLimitWindowMs: 60000,
    });

    const allowedRes = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://allowed.example.com' },
    });
    assert.equal(allowedRes.headers['access-control-allow-origin'], 'https://allowed.example.com');

    const blockedRes = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example.com' },
    });
    assert.equal(blockedRes.headers['access-control-allow-origin'], undefined);

    const r3 = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(r3.statusCode, 429);
    assert.equal(r3.json().success, false);
  });

  it('validates and serves /auth/followize/* (with /verify & unidade) and /leads/sync/status safely', async () => {
    const app = createTestApp();

    const badRefresh = await app.inject({
      method: 'POST',
      url: '/auth/followize/refresh-token',
      headers: { 'x-api-key': VALID_TEST_API_KEY },
      payload: { refresh_token: 'short', extra: 'nope' },
    });
    assert.equal(badRefresh.statusCode, 400);

    const mockClient = new AuthService({
      unidade: 'PA',
      clientId: 'pa-id',
      clientSecret: 'pa-sec',
      timeoutMs: 2000,
    });

    mock.method(authManager, 'resolveUnit', (u?: string, opts?: { allowSingleDefault?: boolean }) => {
      if (!u) {
        if (opts?.allowSingleDefault) {
          throw new AppError(400, 'Parâmetro unidade é obrigatório (MT, PA, AP)', 'UNIT_REQUIRED');
        }
        throw new AppError(400, 'Parâmetro unidade é obrigatório', 'UNIT_REQUIRED');
      }
      const norm = u.trim().toUpperCase();
      if (!['MT', 'PA', 'AP'].includes(norm)) {
        throw new AppError(400, `Unidade "${norm}" não configurada`, 'INVALID_UNIT');
      }
      return norm;
    });
    mock.method(authManager, 'getClient', () => mockClient);

    // Omissão de unidade em modo multi-unidade -> 400 UNIT_REQUIRED
    const missingUnitRes = await app.inject({
      method: 'GET',
      url: '/auth/followize/authorize-url?redirect_uri=http://localhost',
      headers: { 'x-api-key': VALID_TEST_API_KEY },
    });
    assert.equal(missingUnitRes.statusCode, 400);
    assert.equal(missingUnitRes.json().code, 'UNIT_REQUIRED');

    let capturedUpdateArgs: Record<string, unknown> | undefined;
    mock.method(mockClient, 'updateRefreshToken', async (args) => {
      capturedUpdateArgs = args as Record<string, unknown>;
      return {
        unidade: 'PA',
        has_refresh_token: true,
        has_valid_access_token: false,
        access_token_expires_at: null,
        source: 'api' as const,
        updated_at: '2026-11-24T13:00:00.000Z',
        storage: 'postgres' as const,
      };
    });

    const okRefresh = await app.inject({
      method: 'POST',
      url: '/auth/followize/refresh-token',
      headers: { 'x-api-key': VALID_TEST_API_KEY },
      payload: {
        unidade: 'pa',
        refresh_token: 'super-secret-new-refresh-token-value',
        validate_now: true,
      },
    });
    assert.equal(okRefresh.statusCode, 200);
    assert.deepEqual(capturedUpdateArgs, {
      refreshToken: 'super-secret-new-refresh-token-value',
      accessToken: undefined,
      expiresIn: undefined,
      validateNow: true,
    });
    const refreshJson = okRefresh.json();
    assert.equal(refreshJson.success, true);
    assert.equal(refreshJson.unidade, 'PA');
    assert.equal(refreshJson.source, 'api');
    assert.equal(JSON.stringify(refreshJson).includes('super-secret-new-refresh-token-value'), false);

    mock.method(mockClient, 'getAuthorizeUrl', (redirectUri: string) => {
      return `https://auth.followize.com.br/oauth/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`;
    });
    const authUrlRes = await app.inject({
      method: 'GET',
      url: '/auth/followize/authorize-url?unidade=PA&redirect_uri=https://meudominio.com/callback',
      headers: { 'x-api-key': VALID_TEST_API_KEY },
    });
    assert.equal(authUrlRes.statusCode, 200);
    assert.equal(authUrlRes.json().unidade, 'PA');
    assert.equal(authUrlRes.json().redirect_uri, 'https://meudominio.com/callback');

    let shouldThrowMismatch = false;
    mock.method(mockClient, 'exchangeAuthorizationCode', async () => {
      if (shouldThrowMismatch) {
        throw new AppError(
          409,
          'Trava de segurança: o token informado para a unidade PA pertence a MT.',
          'TOKEN_UNIT_MISMATCH'
        );
      }
      return {
        unidade: 'PA',
        has_refresh_token: true,
        has_valid_access_token: true,
        access_token_expires_at: '2026-11-25T00:00:00.000Z',
        source: 'api' as const,
        updated_at: '2026-11-24T13:00:00.000Z',
        storage: 'postgres' as const,
      };
    });
    const exchangeRes = await app.inject({
      method: 'POST',
      url: '/auth/followize/exchange',
      headers: { 'x-api-key': VALID_TEST_API_KEY },
      payload: { unidade: 'PA', code: 'http://localhost/?code=xyz123' },
    });
    assert.equal(exchangeRes.statusCode, 200);
    assert.equal(exchangeRes.json().has_valid_access_token, true);
    assert.equal(exchangeRes.json().unidade, 'PA');

    shouldThrowMismatch = true;
    const mismatchExchangeRes = await app.inject({
      method: 'POST',
      url: '/auth/followize/exchange',
      headers: { 'x-api-key': VALID_TEST_API_KEY },
      payload: { unidade: 'PA', code: 'http://localhost/?code=xyz123' },
    });
    assert.equal(mismatchExchangeRes.statusCode, 409);
    assert.equal(mismatchExchangeRes.json().code, 'TOKEN_UNIT_MISMATCH');
    shouldThrowMismatch = false;

    mock.method(mockClient, 'verifyAccount', async () => ({
      unidade: 'PA',
      locations: [{ id: 10, name: 'Belém' }],
      teams: [{ id: 20, name: 'Consórcio Pará' }],
    }));
    const verifyRes = await app.inject({
      method: 'GET',
      url: '/auth/followize/verify?unidade=pa',
      headers: { 'x-api-key': VALID_TEST_API_KEY },
    });
    assert.equal(verifyRes.statusCode, 200);
    assert.deepEqual(verifyRes.json(), {
      success: true,
      unidade: 'PA',
      locations: [{ id: 10, name: 'Belém' }],
      teams: [{ id: 20, name: 'Consórcio Pará' }],
    });

    mock.method(authManager, 'getAllTokenStatuses', async () => ({
      MT: {
        unidade: 'MT',
        has_refresh_token: true,
        has_valid_access_token: true,
        access_token_expires_at: '2026-11-25T00:00:00.000Z',
        source: 'api' as const,
        updated_at: '2026-11-24T13:00:00.000Z',
        storage: 'postgres' as const,
      },
    }));
    const statusAllRes = await app.inject({
      method: 'GET',
      url: '/auth/followize/status',
      headers: { 'x-api-key': VALID_TEST_API_KEY },
    });
    assert.equal(statusAllRes.statusCode, 200);
    assert.equal(statusAllRes.json().units.MT.has_refresh_token, true);

    mock.method(authManager, 'getTokenStatus', async (u: string) => ({
      unidade: u,
      has_refresh_token: true,
      has_valid_access_token: true,
      access_token_expires_at: '2026-11-25T00:00:00.000Z',
      source: 'api' as const,
      updated_at: '2026-11-24T13:00:00.000Z',
      storage: 'postgres' as const,
    }));
    const statusUnitRes = await app.inject({
      method: 'GET',
      url: '/auth/followize/status?unidade=pa',
      headers: { 'x-api-key': VALID_TEST_API_KEY },
    });
    assert.equal(statusUnitRes.statusCode, 200);
    assert.equal(statusUnitRes.json().unidade, 'PA');
    assert.equal(statusUnitRes.json().has_refresh_token, true);

    mock.method(syncScheduler, 'getStatus', () => ({
      enabled: true,
      active: true,
      timezone: 'America/Sao_Paulo',
      schedules: ['0 8,12,18 * * 1-5'],
      next_runs: ['2026-11-24T15:00:00.000Z'],
      last_run_at: null,
      last_status: 'idle' as const,
      last_trigger: null,
      last_result: null,
      last_error: null,
    }));
    mock.method(syncService, 'getSyncStatus', async () => ({
      in_progress: false,
      progress: null,
      last_completed_at: '2026-11-24T14:00:00.000Z',
      last_start_date: '2026-11-24 08:00:00',
      last_result: null,
      last_error: null,
      units: {
        MT: {
          unidade: 'MT',
          in_progress: false,
          progress: null,
          pending_start_date: null,
          last_completed_at: '2026-11-24T14:00:00.000Z',
          last_start_date: '2026-11-24 08:00:00',
          last_result: null,
          last_error: null,
        },
      },
    }));
    const schedRes = await app.inject({
      method: 'GET',
      url: '/leads/sync/status',
      headers: { 'x-api-key': VALID_TEST_API_KEY },
    });
    assert.equal(schedRes.statusCode, 200);
    assert.equal(schedRes.json().scheduler.active, true);
    assert.deepEqual(schedRes.json().scheduler.next_runs, ['2026-11-24T15:00:00.000Z']);
    assert.equal(schedRes.json().sync.last_completed_at, '2026-11-24T14:00:00.000Z');
    assert.equal(schedRes.json().sync.units.MT.unidade, 'MT');
  });
});
