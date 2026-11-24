import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { AppError } from '../src/errors/app-error.js';
import { AuthService } from '../src/services/auth.service.js';

const silentLogger = {
  warn: () => undefined,
  error: () => undefined,
};

function makeJwt(expSecondsFromNow: number, sub = 'user'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow;
  const payload = Buffer.from(JSON.stringify({ sub, exp })).toString('base64url');
  return `${header}.${payload}.signature`;
}

describe('AuthService (OAuth2 env seed, atomic cache, single-flight lock)', () => {
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

  it('bootstraps from seedRefreshToken without token.json and persists rotated refresh token atomically', async () => {
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
    assert.equal(tokenRequests[0].refresh_token, 'seed-rt-1');

    // New instance with the same seed reuses cached access_token and rotated refresh_token
    const auth2 = new AuthService({
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
    assert.equal(tokenRequests[1].refresh_token, 'rotated-rt-1');
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

    // Pre-populate valid-looking cache that upstream rejects with 401
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    const seedToken = 'seed-concurrent';
    const seedHash = (await import('node:crypto'))
      .createHash('sha256')
      .update(seedToken, 'utf8')
      .digest('hex');
    await fs.writeFile(
      cachePath,
      JSON.stringify({
        seed_hash: seedHash,
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
    const seedHash = (await import('node:crypto'))
      .createHash('sha256')
      .update(seedToken, 'utf8')
      .digest('hex');

    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(
      cachePath,
      JSON.stringify({
        seed_hash: seedHash,
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

    // Restart with the exact same old .env seed: must keep new-api-refresh-token from cache!
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

    // Prior state preserved
    const statusAfterFail = await auth.getTokenStatus();
    assert.equal(statusAfterFail.source, 'env');
    assert.equal(statusAfterFail.has_refresh_token, true);

    // Valid token succeeds and persists
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
      clientId: '5310',
      clientSecret: 'sec',
      cachePath,
      timeoutMs: 2000,
      tokenUrl: 'https://auth.example.test/oauth/token',
      fetchImpl: mockFetch,
      logger: silentLogger,
    });

    const initialStatus = await auth.getTokenStatus();
    assert.equal(initialStatus.has_refresh_token, false);
    assert.equal(initialStatus.source, 'none');

    const afterExchange = await auth.exchangeAuthorizationCode(
      'http://localhost/?code=auth-code-xyz&state=123',
      'http://localhost'
    );

    assert.equal(capturedBody.grant_type, 'authorization_code');
    assert.equal(capturedBody.code, 'auth-code-xyz');
    assert.equal(capturedBody.redirect_uri, 'http://localhost');
    assert.equal(afterExchange.has_refresh_token, true);
    assert.equal(afterExchange.has_valid_access_token, true);
    assert.equal(afterExchange.source, 'api');
  });
});
