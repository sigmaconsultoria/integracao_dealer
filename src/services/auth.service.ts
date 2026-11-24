import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { logger as defaultLogger, type AppLogger } from '../config/logger.js';
import { AppError } from '../errors/app-error.js';

export interface AuthServiceConfig {
  clientId: string;
  clientSecret: string;
  seedRefreshToken?: string;
  cachePath: string;
  timeoutMs: number;
  tokenUrl?: string;
  fetchImpl?: typeof fetch;
  refreshCooldownMs?: number;
  expirySkewMs?: number;
  logger?: Pick<AppLogger, 'warn' | 'error'>;
}

export interface TokenStatusSummary {
  has_refresh_token: boolean;
  has_valid_access_token: boolean;
  access_token_expires_at: string | null;
  source: 'env' | 'api' | 'none';
  updated_at: string | null;
  cache_path: string;
}

interface TokenCacheState {
  seed_hash: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  source?: 'env' | 'api';
  updated_at?: string;
}

interface TokenApiResponse {
  token_type?: string;
  expires_in?: number;
  access_token: string;
  refresh_token?: string;
}

const DEFAULT_TOKEN_URL = 'https://auth.followize.com.br/oauth/token';
const DEFAULT_AUTHORIZE_URL = 'https://auth.followize.com.br/oauth/authorize';
const DEFAULT_REFRESH_COOLDOWN_MS = 15_000;
const DEFAULT_EXPIRY_SKEW_MS = 60_000;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function extractJwtExpMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
      return payload.exp * 1000;
    }
  } catch {
    // Token opaco ou payload inválido: usa fallback de expires_in
  }

  return null;
}

function computeExpiresAt(accessToken: string, expiresInSeconds?: number): number {
  const jwtExpMs = extractJwtExpMs(accessToken);
  if (jwtExpMs !== null) {
    return jwtExpMs;
  }

  const expiresInMs =
    typeof expiresInSeconds === 'number' &&
    Number.isFinite(expiresInSeconds) &&
    expiresInSeconds > 0
      ? expiresInSeconds * 1000
      : 3600 * 1000;
  return Date.now() + expiresInMs;
}

function extractAuthorizationCode(codeOrUrl: string): string {
  const trimmed = codeOrUrl.trim();
  if (!trimmed.includes('code=')) {
    return trimmed;
  }

  try {
    const normalizedUrl = trimmed.startsWith('http')
      ? trimmed
      : `http://localhost/?${trimmed.replace(/^\?/, '')}`;
    const parsed = new URL(normalizedUrl);
    const extracted = parsed.searchParams.get('code')?.trim();
    if (extracted) {
      return extracted;
    }
  } catch {
    const match = trimmed.match(/[?&]code=([^&]+)/);
    if (match?.[1]) {
      return decodeURIComponent(match[1]).trim();
    }
  }

  return trimmed;
}

export class AuthService {
  private readonly tokenUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly refreshCooldownMs: number;
  private readonly expirySkewMs: number;
  private readonly seedRefreshToken: string;
  private readonly seedHash: string;
  private readonly logger: Pick<AppLogger, 'warn' | 'error'>;

  private state: TokenCacheState | null = null;
  private loadStatePromise: Promise<TokenCacheState> | null = null;
  private refreshPromise: Promise<string> | null = null;
  private lastRefreshedAt = 0;

  constructor(private readonly config: AuthServiceConfig) {
    this.tokenUrl = config.tokenUrl ?? DEFAULT_TOKEN_URL;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.refreshCooldownMs = config.refreshCooldownMs ?? DEFAULT_REFRESH_COOLDOWN_MS;
    this.expirySkewMs = config.expirySkewMs ?? DEFAULT_EXPIRY_SKEW_MS;
    this.seedRefreshToken = config.seedRefreshToken?.trim() ?? '';
    this.seedHash = sha256Hex(this.seedRefreshToken);
    this.logger = config.logger ?? defaultLogger;
  }

  private createSeedState(): TokenCacheState {
    return {
      seed_hash: this.seedHash,
      access_token: '',
      refresh_token: this.seedRefreshToken,
      expires_at: 0,
      source: this.seedRefreshToken ? 'env' : undefined,
      updated_at: undefined,
    };
  }

  private isAccessTokenFresh(state: TokenCacheState): boolean {
    return Boolean(state.access_token) && Date.now() < state.expires_at - this.expirySkewMs;
  }

  private buildRequestSignal(existingSignal?: AbortSignal | null): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs);
    return existingSignal ? AbortSignal.any([existingSignal, timeoutSignal]) : timeoutSignal;
  }

  /**
   * Carrega o estado em cache se pertencer ao mesmo seedRefreshToken do .env;
   * caso contrário, inicializa a partir do .env.
   */
  private async loadState(): Promise<TokenCacheState> {
    if (this.state) {
      return this.state;
    }

    if (this.loadStatePromise) {
      return this.loadStatePromise;
    }

    this.loadStatePromise = (async () => {
      try {
        const raw = await fs.readFile(this.config.cachePath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<TokenCacheState>;

        if (
          parsed &&
          parsed.seed_hash === this.seedHash &&
          typeof parsed.refresh_token === 'string' &&
          parsed.refresh_token.trim().length > 0 &&
          typeof parsed.access_token === 'string' &&
          typeof parsed.expires_at === 'number' &&
          Number.isFinite(parsed.expires_at)
        ) {
          this.state = {
            seed_hash: this.seedHash,
            access_token: parsed.access_token,
            refresh_token: parsed.refresh_token.trim(),
            expires_at: parsed.expires_at,
            source: parsed.source === 'api' || parsed.source === 'env' ? parsed.source : 'env',
            updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : undefined,
          };
          return this.state;
        }
      } catch {
        // Cache ausente ou corrompido: inicializa limpo a partir do seed do .env
      }

      this.state = this.createSeedState();
      return this.state;
    })().finally(() => {
      this.loadStatePromise = null;
    });

    return this.loadStatePromise;
  }

  /**
   * Persiste o estado atualizado em arquivo temporário + rename atômico (modo 0600).
   * Falhas de escrita em disco não derrubam a operação em memória.
   */
  private async saveStateAtomically(state: TokenCacheState): Promise<void> {
    const dir = path.dirname(this.config.cachePath);
    const tmpPath = `${this.config.cachePath}.${process.pid}.${randomUUID()}.tmp`;

    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      await fs.rename(tmpPath, this.config.cachePath);
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => undefined);
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Falha ao persistir cache de token em disco; operando apenas em memória'
      );
    }
  }

  getAuthorizeUrl(redirectUri: string): string {
    const url = new URL(DEFAULT_AUTHORIZE_URL);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', '*');
    return url.toString();
  }

  async getTokenStatus(): Promise<TokenStatusSummary> {
    const state = await this.loadState();
    const hasRefresh = Boolean(state.refresh_token);
    const hasValidAccess = this.isAccessTokenFresh(state);
    const expiresAt =
      state.access_token && state.expires_at > 0
        ? new Date(state.expires_at).toISOString()
        : null;
    const source: 'env' | 'api' | 'none' = !hasRefresh ? 'none' : (state.source ?? 'env');

    return {
      has_refresh_token: hasRefresh,
      has_valid_access_token: hasValidAccess,
      access_token_expires_at: expiresAt,
      source,
      updated_at: state.updated_at ?? null,
      cache_path: this.config.cachePath,
    };
  }

  async updateRefreshToken(params: {
    refreshToken: string;
    accessToken?: string;
    expiresIn?: number;
    validateNow?: boolean;
  }): Promise<TokenStatusSummary> {
    const cleanedRefresh = params.refreshToken.trim();
    if (!cleanedRefresh) {
      throw new AppError(400, 'refresh_token é obrigatório.', 'INVALID_REFRESH_TOKEN');
    }

    if (params.validateNow) {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: cleanedRefresh,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      });

      const response = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      if (!response.ok) {
        throw new AppError(
          400,
          `Falha ao validar o novo refresh_token na Followize (HTTP ${response.status})`,
          'OAUTH_REFRESH_FAILED'
        );
      }

      const refreshedData = (await response.json().catch(() => null)) as Partial<TokenApiResponse> | null;
      if (!refreshedData?.access_token || typeof refreshedData.access_token !== 'string') {
        throw new AppError(
          502,
          'Resposta OAuth da Followize não retornou access_token válido.',
          'OAUTH_INVALID_RESPONSE'
        );
      }

      const accessToken = refreshedData.access_token.trim();
      const nextState: TokenCacheState = {
        seed_hash: this.seedHash,
        access_token: accessToken,
        refresh_token:
          typeof refreshedData.refresh_token === 'string' && refreshedData.refresh_token.trim()
            ? refreshedData.refresh_token.trim()
            : cleanedRefresh,
        expires_at: computeExpiresAt(accessToken, refreshedData.expires_in),
        source: 'api',
        updated_at: new Date().toISOString(),
      };

      this.state = nextState;
      this.lastRefreshedAt = Date.now();
      await this.saveStateAtomically(nextState);
      return this.getTokenStatus();
    }

    const cleanedAccess = params.accessToken?.trim() ?? '';
    const expiresAt = cleanedAccess ? computeExpiresAt(cleanedAccess, params.expiresIn) : 0;

    const nextState: TokenCacheState = {
      seed_hash: this.seedHash,
      access_token: cleanedAccess,
      refresh_token: cleanedRefresh,
      expires_at: expiresAt,
      source: 'api',
      updated_at: new Date().toISOString(),
    };

    this.state = nextState;
    this.lastRefreshedAt = 0;
    await this.saveStateAtomically(nextState);

    return this.getTokenStatus();
  }

  async exchangeAuthorizationCode(codeOrUrl: string, redirectUri: string): Promise<TokenStatusSummary> {
    const code = extractAuthorizationCode(codeOrUrl);
    if (!code) {
      throw new AppError(400, 'Código de autorização inválido.', 'INVALID_AUTH_CODE');
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: redirectUri,
      code,
    });

    const response = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      throw new AppError(
        400,
        `Falha ao trocar authorization code na Followize (HTTP ${response.status})`,
        'OAUTH_EXCHANGE_FAILED'
      );
    }

    const data = (await response.json().catch(() => null)) as Partial<TokenApiResponse> | null;
    if (
      !data?.access_token ||
      typeof data.access_token !== 'string' ||
      !data?.refresh_token ||
      typeof data.refresh_token !== 'string'
    ) {
      throw new AppError(
        502,
        'Resposta OAuth da Followize não retornou access_token/refresh_token válidos.',
        'OAUTH_INVALID_RESPONSE'
      );
    }

    const accessToken = data.access_token.trim();
    const refreshToken = data.refresh_token.trim();

    const nextState: TokenCacheState = {
      seed_hash: this.seedHash,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: computeExpiresAt(accessToken, data.expires_in),
      source: 'api',
      updated_at: new Date().toISOString(),
    };

    this.state = nextState;
    this.lastRefreshedAt = Date.now();
    await this.saveStateAtomically(nextState);

    return this.getTokenStatus();
  }

  /**
   * Renova o access_token usando o refresh_token atual com lock single-flight.
   * Chamadas concorrentes compartilham a mesma requisição OAuth2.
   */
  async refreshToken(failedAccessToken?: string): Promise<string> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    if (
      failedAccessToken &&
      this.state &&
      this.state.access_token &&
      this.state.access_token !== failedAccessToken &&
      this.isAccessTokenFresh(this.state)
    ) {
      return this.state.access_token;
    }

    this.refreshPromise = (async () => {
      const currentState = await this.loadState();

      if (
        failedAccessToken &&
        currentState.access_token &&
        currentState.access_token !== failedAccessToken &&
        this.isAccessTokenFresh(currentState)
      ) {
        return currentState.access_token;
      }

      if (!currentState.refresh_token) {
        throw new AppError(
          503,
          'FOLLOWIZE_REFRESH_TOKEN não configurado. Envie um novo token via POST /auth/followize/refresh-token.',
          'MISSING_REFRESH_TOKEN'
        );
      }

      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: currentState.refresh_token,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      });

      const response = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Falha ao renovar token Followize (${response.status}): ${errText}`);
      }

      const refreshedData = (await response.json()) as Partial<TokenApiResponse>;
      if (!refreshedData.access_token || typeof refreshedData.access_token !== 'string') {
        throw new Error('Resposta OAuth da Followize não retornou access_token válido.');
      }

      const nextState: TokenCacheState = {
        seed_hash: this.seedHash,
        access_token: refreshedData.access_token,
        refresh_token:
          typeof refreshedData.refresh_token === 'string' && refreshedData.refresh_token.trim()
            ? refreshedData.refresh_token.trim()
            : currentState.refresh_token,
        expires_at: computeExpiresAt(refreshedData.access_token, refreshedData.expires_in),
        source: currentState.source ?? 'env',
        updated_at: new Date().toISOString(),
      };

      this.state = nextState;
      this.lastRefreshedAt = Date.now();
      await this.saveStateAtomically(nextState);

      return nextState.access_token;
    })().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  /**
   * Retorna um access_token válido da memória/cache ou renova proativamente antes da expiração.
   */
  async getValidToken(forceRefresh = false): Promise<string> {
    if (forceRefresh) {
      return this.refreshToken();
    }

    const currentState = await this.loadState();
    if (this.isAccessTokenFresh(currentState)) {
      return currentState.access_token;
    }

    return this.refreshToken();
  }

  /**
   * Wrapper para requisições autenticadas no Followize com timeout e retry único em 401.
   */
  async authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
    let token = await this.getValidToken();

    const doFetch = (authToken: string) => {
      const headers = new Headers(options.headers || {});
      headers.set('Authorization', `Bearer ${authToken}`);
      headers.set('Accept', 'application/json');
      return this.fetchImpl(url, {
        ...options,
        headers,
        signal: this.buildRequestSignal(options.signal),
      });
    };

    let response = await doFetch(token);

    if (response.status === 401) {
      const withinCooldown =
        Date.now() - this.lastRefreshedAt < this.refreshCooldownMs &&
        this.state?.access_token === token;

      if (withinCooldown) {
        return response;
      }

      token = await this.refreshToken(token);
      response = await doFetch(token);
    }

    return response;
  }
}

export const authService = new AuthService({
  clientId: env.FOLLOWIZE_CLIENT_ID,
  clientSecret: env.FOLLOWIZE_CLIENT_SECRET,
  seedRefreshToken: env.FOLLOWIZE_REFRESH_TOKEN,
  cachePath: path.resolve(process.cwd(), env.FOLLOWIZE_TOKEN_CACHE_PATH),
  timeoutMs: env.FOLLOWIZE_TIMEOUT_MS,
});
