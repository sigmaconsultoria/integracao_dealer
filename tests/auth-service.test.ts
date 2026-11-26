import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { AppError } from '../src/errors/app-error.js';
import {
  AuthManager,
  AuthService,
  createDbAccountOwnershipValidator,
} from '../src/services/auth.service.js';
import {
  MemoryTokenStore,
  PostgresTokenStore,
  type TokenCacheState,
} from '../src/services/token-store.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function makeJwt(expSecondsFromNow: number, sub = 'user'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow;
  const payload = Buffer.from(JSON.stringify({ sub, exp })).toString('base64url');
  return `${header}.${payload}.signature`;
}

function sha256(val: string): string {
  return createHash('sha256').update(val, 'utf8').digest('hex');
}

describe('AuthService & AuthManager (multi-unit OAuth2, PostgresTokenStore, single-flight)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  async function createTempCachePath(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leads-auth-test-'));
    tempDirs.push(dir);
    return path.join(dir, '.runtime', 'followize-token.json');
  }

  it('bootstraps from seedRefreshToken without cache and persists rotated refresh token atomically', async () => {
    const cachePath = await createTempCachePath();
    const tokenRequests: Array<Record<string, string>> = [];
    const accessToken1 = makeJwt(3600, 't1');

    const mockFetch: typeof fetch = async (input, init) => {
      assert.equal(String(input), 'https://auth.example.test/oauth/token');
      const params = new URLSearchParams(String(init?.body || ''));
      tokenRequests.push(Object.fromEntries(params.entries()));
      return new Response(
        JSON.stringify({
          token_type: 'Bearer',
          expires_in: 3600,
          access_token: accessToken1,
          refresh_token: 'rotated-rt-1',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const auth1 = new AuthService({
      unidade: 'MT',
      clientId: 'client-1',
      clientSecret: 'secret-1',
      seedRefreshToken: 'seed-rt-1',
      cachePath,
      timeoutMs: 2000,
      tokenUrl: 'https://auth.example.test/oauth/token',
      fetchImpl: mockFetch,
    });

    const token = await auth1.getValidToken();
    assert.equal(token, accessToken1);
    assert.equal(tokenRequests.length, 1);
    assert.equal(tokenRequests[0]!.refresh_token, 'seed-rt-1');

    const status = await auth1.getTokenStatus();
    assert.equal(status.unidade, 'MT');
    assert.equal(status.storage, 'file');

    // New instance with the same seed reuses cached access_token and rotated refresh_token
    const auth2 = new AuthService({
      unidade: 'MT',
      clientId: 'client-1',
      clientSecret: 'secret-1',
      seedRefreshToken: 'seed-rt-1',
      cachePath,
      timeoutMs: 2000,
      tokenUrl: 'https://auth.example.test/oauth/token',
      fetchImpl: mockFetch,
    });

    const cachedToken = await auth2.getValidToken();
    assert.equal(cachedToken, accessToken1);
    assert.equal(tokenRequests.length, 1);

    // Forced refresh uses rotated-rt-1 instead of seed-rt-1
    await auth2.getValidToken(true);
    assert.equal(tokenRequests.length, 2);
    assert.equal(tokenRequests[1]!.refresh_token, 'rotated-rt-1');
  });

  it('ignores stale cache when FOLLOWIZE_REFRESH_TOKEN changes in .env', async () => {
    const cachePath = await createTempCachePath();
    const seenRefreshTokens: string[] = [];

    const mockFetch: typeof fetch = async (_input, init) => {
      const params = new URLSearchParams(String(init?.body || ''));
      const rt = params.get('refresh_token') || '';
      seenRefreshTokens.push(rt);
      return new Response(
        JSON.stringify({
          access_token: makeJwt(3600, rt),
          refresh_token: `rotated-${rt}`,
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const authOld = new AuthService({
      clientId: 'c1',
      clientSecret: 's1',
      seedRefreshToken: 'seed-old',
      cachePath,
      timeoutMs: 2000,
      tokenUrl: 'https://auth.example.test/oauth/token',
      fetchImpl: mockFetch,
    });
    await authOld.getValidToken();

    // Operator updates FOLLOWIZE_REFRESH_TOKEN in .env
    const authNew = new AuthService({
      clientId: 'c1',
      clientSecret: 's1',
      seedRefreshToken: 'seed-new',
      cachePath,
      timeoutMs: 2000,
      tokenUrl: 'https://auth.example.test/oauth/token',
      fetchImpl: mockFetch,
    });
    await authNew.getValidToken();

    assert.deepEqual(seenRefreshTokens, ['seed-old', 'seed-new']);
  });

  it('deduplicates concurrent 401 refreshes with single-flight lock', async () => {
    const cachePath = await createTempCachePath();
    const expiredOrRejectedToken = makeJwt(3600, 'stale');
    const refreshedToken = makeJwt(3600, 'fresh');

    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    const seedToken = 'seed-concurrent';
    await fs.writeFile(
      cachePath,
      JSON.stringify({
        seed_hash: sha256(seedToken),
        access_token: expiredOrRejectedToken,
        refresh_token: 'rt-initial',
        expires_at: Date.now() + 3_600_000,
      }),
      'utf-8'
    );

    let oauthCallCount = 0;
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/oauth/token')) {
        oauthCallCount++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return new Response(
          JSON.stringify({
            access_token: refreshedToken,
            refresh_token: 'rt-next',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const headers = new Headers(init?.headers);
      const authHeader = headers.get('Authorization');
      if (authHeader === `Bearer ${expiredOrRejectedToken}`) {
        return new Response(JSON.stringify({ error: 'expired' }), { status: 401 });
      }
      if (authHeader === `Bearer ${refreshedToken}`) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    };

    const auth = new AuthService({
      clientId: 'c1',
      clientSecret: 's1',
      seedRefreshToken: seedToken,
      cachePath,
      timeoutMs: 2000,
      tokenUrl: 'https://auth.example.test/oauth/token',
      fetchImpl: mockFetch,
    });

    const responses = await Promise.all(
      Array.from({ length: 15 }, (_, idx) =>
        auth.authenticatedFetch(`https://api.example.test/v3/leads/${idx}`)
      )
    );

    assert.equal(oauthCallCount, 1);
    for (const res of responses) {
      assert.equal(res.status, 200);
    }
  });

  it('respects cooldown on repeated 401 responses for freshly minted tokens', async () => {
    const cachePath = await createTempCachePath();
    const freshToken = makeJwt(3600, 'fresh-but-unauthorized-store');
    let oauthCallCount = 0;
    let apiCallCount = 0;

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/oauth/token')) {
        oauthCallCount++;
        return new Response(
          JSON.stringify({
            access_token: freshToken,
            refresh_token: 'rt-2',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      apiCallCount++;
      return new Response(JSON.stringify({ error: 'forbidden store' }), { status: 401 });
    };

    const auth = new AuthService({
      clientId: 'c1',
      clientSecret: 's1',
      seedRefreshToken: 'seed-1',
      cachePath,
      timeoutMs: 2000,
      refreshCooldownMs: 15_000,
      tokenUrl: 'https://auth.example.test/oauth/token',
      fetchImpl: mockFetch,
    });

    const res = await auth.authenticatedFetch('https://api.example.test/v3/leads/999');
    assert.equal(res.status, 401);
    assert.equal(oauthCallCount, 1);
    assert.equal(apiCallCount, 1);
  });

  it('aborts slow upstream requests when timeoutMs expires', async () => {
    const cachePath = await createTempCachePath();
    const validToken = makeJwt(3600, 'valid');
    const seedToken = 'seed-timeout';

    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(
      cachePath,
      JSON.stringify({
        seed_hash: sha256(seedToken),
        access_token: validToken,
        refresh_token: seedToken,
        expires_at: Date.now() + 3_600_000,
      }),
      'utf-8'
    );

    const slowFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new Error('Aborted'));
        });
      });

    const auth = new AuthService({
      clientId: 'c1',
      clientSecret: 's1',
      seedRefreshToken: seedToken,
      cachePath,
      timeoutMs: 50,
      tokenUrl: 'https://auth.example.test/oauth/token',
      fetchImpl: slowFetch,
    });

    await assert.rejects(
      () => auth.authenticatedFetch('https://api.example.test/v3/leads'),
      /TimeoutError|abort/i
    );
  });

  it('updateRefreshToken (validateNow: false) persists new token across restarts without changing .env', async () => {
    const cachePath = await createTempCachePath();
    const seenRefreshTokens: string[] = [];
    const freshAccess = makeJwt(3600, 'from-api-rt');

    const mockFetch: typeof fetch = async (_input, init) => {
      const params = new URLSearchParams(String(init?.body || ''));
      seenRefreshTokens.push(params.get('refresh_token') || '');
      return new Response(
        JSON.stringify({
          access_token: freshAccess,
          refresh_token: 'rotated-after-api-rt',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const auth1 = new AuthService({
      clientId: 'c1',
      clientSecret: 's1',
      seedRefreshToken: 'old-env-seed',
      cachePath,
      timeoutMs: 2000,
      tokenUrl: 'https://auth.example.test/oauth/token',
      fetchImpl: mockFetch,
      logger: silentLogger,
    });

    const status1 = await auth1.updateRefreshToken({
      refreshToken: 'new-api-refresh-token',
      validateNow: false,
    });

    assert.equal(status1.has_refresh_token, true);
    assert.equal(status1.has_valid_access_token, false);
    assert.equal(status1.source, 'api');
    assert.equal(JSON.stringify(status1).includes('new-api-refresh-token'), false);

    const authAfterRestart = new AuthService({
      clientId: 'c1',
      clientSecret: 's1',
      seedRefreshToken: 'old-env-seed',
      cachePath,
      timeoutMs: 2000,
      tokenUrl: 'https://auth.example.test/oauth/token',
      fetchImpl: mockFetch,
      logger: silentLogger,
    });

    const token = await authAfterRestart.getValidToken();
    assert.equal(token, freshAccess);
    assert.deepEqual(seenRefreshTokens, ['new-api-refresh-token']);
  });

  it('updateRefreshToken (validateNow: true) preserves prior state on failure and saves on success', async () => {
    const cachePath = await createTempCachePath();
    let shouldFailValidation = true;
    const validJwt = makeJwt(3600, 'validated-now');

    const mockFetch: typeof fetch = async () => {
      if (shouldFailValidation) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 401 });
      }
      return new Response(
        JSON.stringify({
          access_token: validJwt,
          refresh_token: 'validated-rt-2',
          expires_in: 3600,
        }),
        { status: 200 }
      );
    };

    const auth = new AuthService({
      clientId: 'c1',
      clientSecret: 's1',
      seedRefreshToken: 'existing-seed-rt',
      cachePath,
      timeoutMs: 2000,
      tokenUrl: 'https://auth.example.test/oauth/token',
      fetchImpl: mockFetch,
      logger: silentLogger,
    });

    await assert.rejects(
      () =>
        auth.updateRefreshToken({
          refreshToken: 'bad-refresh-token',
          validateNow: true,
        }),
      (err) => err instanceof AppError && err.statusCode === 400 && err.code === 'OAUTH_REFRESH_FAILED'
    );

    const statusAfterFail = await auth.getTokenStatus();
    assert.equal(statusAfterFail.source, 'env');
    assert.equal(statusAfterFail.has_refresh_token, true);

    shouldFailValidation = false;
    const statusAfterSuccess = await auth.updateRefreshToken({
      refreshToken: 'good-refresh-token',
      validateNow: true,
    });
    assert.equal(statusAfterSuccess.source, 'api');
    assert.equal(statusAfterSuccess.has_valid_access_token, true);
    assert.equal(await auth.getValidToken(), validJwt);
  });

  it('exchangeAuthorizationCode extracts code from callback URL and works without seedRefreshToken', async () => {
    const cachePath = await createTempCachePath();
    let capturedBody: Record<string, string> = {};
    const accessToken = makeJwt(3600, 'oauth-code');

    const mockFetch: typeof fetch = async (_input, init) => {
      const params = new URLSearchParams(String(init?.body || ''));
      capturedBody = Object.fromEntries(params.entries());
      return new Response(
        JSON.stringify({
          access_token: accessToken,
          refresh_token: 'fresh-rt-from-code',
          expires_in: 3600,
        }),
        { status: 200 }
      );
    };

    const auth = new AuthService({
      unidade: 'PA',
      clientId: '5310',
      clientSecret: 'sec',
      cachePath,
      timeoutMs: 2000,
      tokenUrl: 'https://auth.example.test/oauth/token',
      fetchImpl: mockFetch,
      logger: silentLogger,
    });

    const initialStatus = await auth.getTokenStatus();
    assert.equal(initialStatus.unidade, 'PA');
    assert.equal(initialStatus.has_refresh_token, false);
    assert.equal(initialStatus.source, 'none');

    const afterExchange = await auth.exchangeAuthorizationCode(
      'http://localhost/?code=auth-code-xyz&state=123',
      'http://localhost'
    );

    assert.equal(capturedBody.grant_type, 'authorization_code');
    assert.equal(capturedBody.code, 'auth-code-xyz');
    assert.equal(capturedBody.redirect_uri, 'http://localhost');
    assert.equal(afterExchange.unidade, 'PA');
    assert.equal(afterExchange.has_refresh_token, true);
    assert.equal(afterExchange.has_valid_access_token, true);
    assert.equal(afterExchange.source, 'api');
  });

  it('PostgresTokenStore persists/reads tokens and performs one-time legacy cutover only for MT', async () => {
    const legacyCachePath = await createTempCachePath();
    const seedHash = sha256('mt-seed');
    const legacyExpiresAt = Date.now() + 3_600_000;

    await fs.mkdir(path.dirname(legacyCachePath), { recursive: true });
    await fs.writeFile(
      legacyCachePath,
      JSON.stringify({
        seed_hash: seedHash,
        access_token: 'legacy-access-mt',
        refresh_token: 'legacy-refresh-mt',
        expires_at: legacyExpiresAt,
        source: 'api',
        updated_at: '2026-11-20T10:00:00.000Z',
      }),
      'utf-8'
    );

    const dbRows = new Map<string, Record<string, unknown>>();
    const queries: Array<{ sql: string; params?: any[] }> = [];

    const mockDb = {
      query: async (sql: string, params: any[] = []) => {
        queries.push({ sql, params });
        if (sql.includes('FROM tokens')) {
          const row = dbRows.get(String(params[0]));
          return { rows: row ? [row] : [] };
        }
        if (sql.includes('INSERT INTO tokens')) {
          dbRows.set(String(params[0]), {
            unidade: params[0],
            token: params[1],
            refresh_token: params[2],
            expires_at: params[3],
            seed_hash: params[4],
            source: params[5],
            updated_at: params[6],
          });
          return { rows: [], rowCount: 1 };
        }
        return { rows: [] };
      },
    };

    const store = new PostgresTokenStore(mockDb, { legacyCachePath, logger: silentLogger });

    // PA não tem linha no banco e NÃO deve importar o arquivo legado de MT
    const paBefore = await store.load('PA', seedHash);
    assert.equal(paBefore, null);

    // MT com seed_hash divergente NÃO importa
    const mtMismatch = await store.load('MT', sha256('other-seed'));
    assert.equal(mtMismatch, null);

    // Nova instância com seed_hash correto importa uma única vez para public.tokens
    const store2 = new PostgresTokenStore(mockDb, { legacyCachePath, logger: silentLogger });
    const mtMigrated = await store2.load('MT', seedHash);
    assert.ok(mtMigrated);
    assert.equal(mtMigrated.access_token, 'legacy-access-mt');
    assert.equal(mtMigrated.refresh_token, 'legacy-refresh-mt');
    assert.equal(mtMigrated.source, 'api');
    assert.equal(dbRows.has('MT'), true);
    assert.equal(queries.some((q) => q.sql.includes('INSERT INTO tokens')), true);

    // Segunda leitura já vem diretamente de public.tokens
    const mtFromDb = await store2.load('MT', seedHash);
    assert.equal(mtFromDb?.refresh_token, 'legacy-refresh-mt');
  });

  it('reloads TokenStore before OAuth2 refresh on 401 to avoid overwriting tokens rotated by another instance', async () => {
    const staleAccess = makeJwt(3600, 'stale');
    const rotatedAccessByPeer = makeJwt(3600, 'peer-rotated');
    const rotatedAccessAfterPeerRt = makeJwt(3600, 'after-peer-rt');

    // Cenário A: outra instância já renovou access_token e refresh_token no store
    const storeA = new MemoryTokenStore({
      PA: {
        seed_hash: '',
        access_token: staleAccess,
        refresh_token: 'rt-old',
        expires_at: Date.now() + 3_600_000,
        source: 'api',
        updated_at: '2026-11-26T10:00:00.000Z',
      },
    });

    let oauthCallsA = 0;
    const authA = new AuthService({
      unidade: 'PA',
      clientId: 'pa-id',
      clientSecret: 'pa-sec',
      tokenStore: storeA,
      timeoutMs: 2000,
      tokenUrl: 'https://auth.example.test/oauth/token',
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/oauth/token')) {
          oauthCallsA++;
          return new Response('{}', { status: 500 });
        }
        const authHeader = new Headers(init?.headers).get('Authorization');
        if (authHeader === `Bearer ${staleAccess}`) {
          // Simula peer gravando token novo no banco antes do refresh desta instância
          await storeA.save('PA', {
            seed_hash: '',
            access_token: rotatedAccessByPeer,
            refresh_token: 'rt-peer-fresh',
            expires_at: Date.now() + 3_600_000,
            source: 'api',
            updated_at: '2026-11-26T10:01:00.000Z',
          });
          return new Response('expired', { status: 401 });
        }
        if (authHeader === `Bearer ${rotatedAccessByPeer}`) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response('unexpected', { status: 500 });
      },
      logger: silentLogger,
    });

    const resA = await authA.authenticatedFetch('https://api.example.test/v3/leads');
    assert.equal(resA.status, 200);
    assert.equal(oauthCallsA, 0);

    // Cenário B: outra instância gravou novo refresh_token (sem access_token válido) -> usa novo refresh_token
    const storeB = new MemoryTokenStore({
      AP: {
        seed_hash: '',
        access_token: staleAccess,
        refresh_token: 'rt-stale',
        expires_at: Date.now() + 3_600_000,
        source: 'api',
        updated_at: '2026-11-26T10:00:00.000Z',
      },
    });
    const usedRefreshTokens: string[] = [];

    const authB = new AuthService({
      unidade: 'AP',
      clientId: 'ap-id',
      clientSecret: 'ap-sec',
      tokenStore: storeB,
      timeoutMs: 2000,
      tokenUrl: 'https://auth.example.test/oauth/token',
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/oauth/token')) {
          const params = new URLSearchParams(String(init?.body || ''));
          usedRefreshTokens.push(params.get('refresh_token') || '');
          return new Response(
            JSON.stringify({
              access_token: rotatedAccessAfterPeerRt,
              refresh_token: 'rt-final',
              expires_in: 3600,
            }),
            { status: 200 }
          );
        }
        const authHeader = new Headers(init?.headers).get('Authorization');
        if (authHeader === `Bearer ${staleAccess}`) {
          await storeB.save('AP', {
            seed_hash: '',
            access_token: '',
            refresh_token: 'rt-reloaded-from-peer',
            expires_at: 0,
            source: 'api',
            updated_at: '2026-11-26T10:02:00.000Z',
          });
          return new Response('expired', { status: 401 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      logger: silentLogger,
    });

    const resB = await authB.authenticatedFetch('https://api.example.test/v3/leads');
    assert.equal(resB.status, 200);
    assert.deepEqual(usedRefreshTokens, ['rt-reloaded-from-peer']);
  });

  it('AuthManager resolves units, isolates single-flight locks per unit, and verifies accounts', async () => {
    const store = new MemoryTokenStore();
    const oauthCallsByClient: Record<string, number> = {
      'id-mt': 0,
      'id-pa': 0,
      'id-ap': 0,
    };

    const mtJwt = makeJwt(3600, 'mt');
    const paJwt = makeJwt(3600, 'pa');
    const apJwt = makeJwt(3600, 'ap');

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/oauth/token')) {
        const params = new URLSearchParams(String(init?.body || ''));
        const cid = params.get('client_id') || '';
        oauthCallsByClient[cid] = (oauthCallsByClient[cid] ?? 0) + 1;
        await new Promise((r) => setTimeout(r, 20));
        const jwt = cid === 'id-mt' ? mtJwt : cid === 'id-pa' ? paJwt : apJwt;
        return new Response(
          JSON.stringify({
            access_token: jwt,
            refresh_token: `rt-${cid}`,
            expires_in: 3600,
          }),
          { status: 200 }
        );
      }

      const authHeader = new Headers(init?.headers).get('Authorization');
      if (url.includes('/locations')) {
        if (authHeader === `Bearer ${paJwt}`) {
          return new Response(
            JSON.stringify({ data: [{ id: 701, name: 'Belém Matriz' }] }),
            { status: 200 }
          );
        }
        return new Response('upstream error', { status: 500 });
      }
      if (url.includes('/teams')) {
        return new Response(
          JSON.stringify({ data: [{ id: 801, name: 'Equipe Pará' }] }),
          { status: 200 }
        );
      }

      return new Response('{}', { status: 404 });
    };

    const manager = new AuthManager(
      {
        MT: { unidade: 'MT', clientId: 'id-mt', clientSecret: 'sec-mt', seedRefreshToken: 'seed-mt' },
        PA: { unidade: 'PA', clientId: 'id-pa', clientSecret: 'sec-pa', seedRefreshToken: 'seed-pa' },
        AP: { unidade: 'AP', clientId: 'id-ap', clientSecret: 'sec-ap' },
      },
      {
        tokenStore: store,
        timeoutMs: 2000,
        tokenUrl: 'https://auth.example.test/oauth/token',
        apiBaseUrl: 'https://api.example.test/v3',
        fetchImpl: mockFetch,
        logger: silentLogger,
      }
    );

    assert.deepEqual(manager.getUnits(), ['MT', 'PA', 'AP']);
    assert.equal(manager.hasUnit('pa'), true);
    assert.equal(manager.hasUnit('SP'), false);
    assert.equal(manager.resolveUnit('pa'), 'PA');

    assert.throws(
      () => manager.resolveUnit(undefined, { allowSingleDefault: true }),
      (err) => err instanceof AppError && err.statusCode === 400 && err.code === 'UNIT_REQUIRED'
    );
    assert.throws(
      () => manager.resolveUnit('SP'),
      (err) => err instanceof AppError && err.statusCode === 400 && err.code === 'INVALID_UNIT'
    );

    // Refresh concorrente independente em MT e PA
    const [mtTokens, paTokens] = await Promise.all([
      Promise.all([
        manager.getClient('MT').getValidToken(),
        manager.getClient('MT').getValidToken(),
      ]),
      Promise.all([
        manager.getClient('PA').getValidToken(),
        manager.getClient('PA').getValidToken(),
      ]),
    ]);

    assert.deepEqual(mtTokens, [mtJwt, mtJwt]);
    assert.deepEqual(paTokens, [paJwt, paJwt]);
    assert.equal(oauthCallsByClient['id-mt'], 1);
    assert.equal(oauthCallsByClient['id-pa'], 1);

    // AP sem refresh token falha isoladamente com 503 MISSING_REFRESH_TOKEN
    await assert.rejects(
      () => manager.getClient('AP').getValidToken(),
      (err) => err instanceof AppError && err.statusCode === 503 && err.code === 'MISSING_REFRESH_TOKEN'
    );

    // verifyAccount retorna lojas e equipes da unidade PA
    const verification = await manager.getClient('PA').verifyAccount();
    assert.deepEqual(verification, {
      unidade: 'PA',
      locations: [{ id: 701, name: 'Belém Matriz' }],
      teams: [{ id: 801, name: 'Equipe Pará' }],
    });

    // verifyAccount propaga 502 se /locations falhar
    await assert.rejects(
      () => manager.getClient('MT').verifyAccount(),
      (err) => err instanceof AppError && err.statusCode === 502 && err.code === 'UPSTREAM_ERROR'
    );

    const allStatuses = await manager.getAllTokenStatuses();
    assert.equal(allStatuses.MT?.storage, 'memory');
    assert.equal(allStatuses.MT?.has_valid_access_token, true);
    assert.equal(allStatuses.PA?.has_valid_access_token, true);
    assert.equal(allStatuses.AP?.has_refresh_token, false);
    assert.equal(allStatuses.AP?.source, 'none');
  });

  it('validateAccountOwnership blocks TOKEN_UNIT_MISMATCH on exchange and validateNow without overwriting prior token', async () => {
    const existingApJwt = makeJwt(3600, 'ap-original');
    const swappedPaJwt = makeJwt(3600, 'pa-swapped');
    const validApJwt = makeJwt(3600, 'ap-renewed');

    const store = new MemoryTokenStore({
      AP: {
        seed_hash: '',
        access_token: existingApJwt,
        refresh_token: 'rt-ap-original',
        expires_at: Date.now() + 3_600_000,
        source: 'api',
        updated_at: '2026-11-26T10:00:00.000Z',
      },
    });

    const mockDb = {
      query: async (sql: string, params: any[] = []) => {
        const ids = Array.isArray(params[0]) ? params[0] : [];
        const unit = String(params[1]);
        if (sql.includes('FROM locations') && ids.includes(3939) && unit !== 'PA') {
          return {
            rows: [{ id: 3939, name: 'MÔNACO MOTOCENTER MATRIZ', unidade: 'PA' }],
          };
        }
        if (sql.includes('FROM teams') && ids.includes(9669) && unit !== 'PA') {
          return {
            rows: [{ id: 9669, name: 'Comercial CRM- Região Belém', unidade: 'PA' }],
          };
        }
        return { rows: [] };
      },
    };

    const verifyAuthHeaders: string[] = [];
    let returnSwappedAccount = true;

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/oauth/token')) {
        const params = new URLSearchParams(String(init?.body || ''));
        const isSwapped = returnSwappedAccount;
        return new Response(
          JSON.stringify({
            access_token: isSwapped ? swappedPaJwt : validApJwt,
            refresh_token: isSwapped ? 'rt-pa-swapped' : 'rt-ap-renewed',
            expires_in: 3600,
          }),
          { status: 200 }
        );
      }

      const authHeader = new Headers(init?.headers).get('Authorization') || '';
      verifyAuthHeaders.push(authHeader);

      if (url.includes('/locations')) {
        return new Response(
          JSON.stringify({
            data: returnSwappedAccount
              ? [{ id: 3939, name: 'MÔNACO MOTOCENTER MATRIZ' }]
              : [{ id: 13771, name: 'Monaco Motocenter Amapá' }],
          }),
          { status: 200 }
        );
      }

      if (url.includes('/teams')) {
        return new Response(
          JSON.stringify({
            data: returnSwappedAccount
              ? [{ id: 9669, name: 'Comercial CRM- Região Belém' }]
              : [{ id: 45354, name: 'Comercial AP - LAGOA' }],
          }),
          { status: 200 }
        );
      }

      return new Response('{}', { status: 404 });
    };

    const manager = new AuthManager(
      {
        AP: { unidade: 'AP', clientId: 'id-ap', clientSecret: 'sec-ap' },
      },
      {
        tokenStore: store,
        timeoutMs: 2000,
        tokenUrl: 'https://auth.example.test/oauth/token',
        apiBaseUrl: 'https://api.example.test/v3',
        fetchImpl: mockFetch,
        validateAccountOwnership: createDbAccountOwnershipValidator(mockDb),
        logger: silentLogger,
      }
    );

    const apClient = manager.getClient('AP');

    // 1) exchangeAuthorizationCode com login errado (PA) é rejeitado com 409 e preserva token anterior
    await assert.rejects(
      () => apClient.exchangeAuthorizationCode('http://localhost/?code=wrong-pa', 'http://localhost'),
      (err) =>
        err instanceof AppError &&
        err.statusCode === 409 &&
        err.code === 'TOKEN_UNIT_MISMATCH' &&
        err.message.includes('PA')
    );

    assert.equal(verifyAuthHeaders.includes(`Bearer ${swappedPaJwt}`), true);
    assert.equal(verifyAuthHeaders.includes(`Bearer ${existingApJwt}`), false);
    assert.equal(await apClient.getValidToken(), existingApJwt);
    assert.equal((await store.load('AP'))?.refresh_token, 'rt-ap-original');

    // 2) updateRefreshToken (validateNow: true) com token errado (PA) também é rejeitado
    await assert.rejects(
      () =>
        apClient.updateRefreshToken({
          refreshToken: 'rt-wrong-pa',
          validateNow: true,
        }),
      (err) =>
        err instanceof AppError && err.statusCode === 409 && err.code === 'TOKEN_UNIT_MISMATCH'
    );
    assert.equal(await apClient.getValidToken(), existingApJwt);
    assert.equal((await store.load('AP'))?.refresh_token, 'rt-ap-original');

    // 3) Com conta correta do AP (lojas/equipes sem conflito), salva normalmente
    returnSwappedAccount = false;
    const okStatus = await apClient.exchangeAuthorizationCode(
      'http://localhost/?code=good-ap',
      'http://localhost'
    );
    assert.equal(okStatus.unidade, 'AP');
    assert.equal(okStatus.has_valid_access_token, true);
    assert.equal(await apClient.getValidToken(), validApJwt);
    assert.equal((await store.load('AP'))?.refresh_token, 'rt-ap-renewed');
  });
});
