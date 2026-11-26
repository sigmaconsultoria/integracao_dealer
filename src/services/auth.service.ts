import { createHash } from 'node:crypto';
import path from 'node:path';
import { pool } from '../config/database.js';
import { env, type FollowizeUnitConfig } from '../config/env.js';
import { logger as defaultLogger, type AppLogger } from '../config/logger.js';
import { AppError } from '../errors/app-error.js';
import type { DbPoolLike } from '../modules/leads/leads.service.js';
import {
  FileTokenStore,
  MemoryTokenStore,
  PostgresTokenStore,
  type TokenCacheState,
  type TokenStore,
  type TokenStoreKind,
} from './token-store.js';

export type AccountOwnershipValidator = (
  unidade: string,
  account: AccountVerificationResult
) => Promise<void>;

export interface AuthServiceConfig {
  unidade?: string;
  clientId: string;
  clientSecret: string;
  seedRefreshToken?: string;
  tokenStore?: TokenStore;
  cachePath?: string;
  timeoutMs: number;
  tokenUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  refreshCooldownMs?: number;
  expirySkewMs?: number;
  validateAccountOwnership?: AccountOwnershipValidator;
  logger?: Pick<AppLogger, 'warn' | 'error'>;
}

export interface TokenStatusSummary {
  unidade: string;
  has_refresh_token: boolean;
  has_valid_access_token: boolean;
  access_token_expires_at: string | null;
  source: 'env' | 'api' | 'none';
  updated_at: string | null;
  storage: TokenStoreKind;
}

export interface AccountVerificationResult {
  unidade: string;
  locations: Array<{ id: number; name: string }>;
  teams: Array<{ id: number; name: string }>;
}

export interface AuthClientWithVerify {
  authenticatedFetch(url: string, options?: RequestInit): Promise<Response>;
  getAuthorizeUrl(redirectUri: string): string;
  getTokenStatus(): Promise<TokenStatusSummary>;
  updateRefreshToken(params: {
    refreshToken: string;
    accessToken?: string;
    expiresIn?: number;
    validateNow?: boolean;
  }): Promise<TokenStatusSummary>;
  exchangeAuthorizationCode(codeOrUrl: string, redirectUri: string): Promise<TokenStatusSummary>;
  verifyAccount(): Promise<AccountVerificationResult>;
}

export interface AuthManagerLike {
  getUnits(): string[];
  hasUnit(unidade: string): boolean;
  resolveUnit(unidade?: string, options?: { allowSingleDefault?: boolean }): string;
  getClient(unidade: string): AuthClientWithVerify;
  getTokenStatus(unidade: string): Promise<TokenStatusSummary>;
  getAllTokenStatuses(): Promise<Record<string, TokenStatusSummary>>;
}

interface TokenApiResponse {
  token_type?: string;
  expires_in?: number;
  access_token: string;
  refresh_token?: string;
}

const DEFAULT_TOKEN_URL = 'https://auth.followize.com.br/oauth/token';
const DEFAULT_AUTHORIZE_URL = 'https://auth.followize.com.br/oauth/authorize';
const DEFAULT_API_BASE_URL = 'https://api.followize.com.br/v3';
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

function parseAccountItems(json: unknown): Array<{ id: number; name: string }> {
  const items = Array.isArray((json as { data?: unknown })?.data)
    ? (json as { data: Array<{ id?: unknown; name?: unknown }> }).data
    : [];

  const seen = new Set<number>();
  const result: Array<{ id: number; name: string }> = [];

  for (const item of items) {
    const id = Number(item?.id);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const name = typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : String(id);
    result.push({ id, name });
  }

  return result;
}

interface OwnershipConflictRow {
  id: number | string;
  name: string | null;
  unidade: string;
}

/**
 * Valida se as lojas e equipes retornadas por um token OAuth2 não pertencem a outra unidade
 * já cadastrada no PostgreSQL, evitando sobrescrita acidental entre estados.
 */
export function createDbAccountOwnershipValidator(
  db: Pick<DbPoolLike, 'query'>
): AccountOwnershipValidator {
  return async (unidade: string, account: AccountVerificationResult) => {
    const normalizedUnit = unidade.trim().toUpperCase();
    const locationIds = Array.from(
      new Set(account.locations.map((l) => l.id).filter((id) => Number.isInteger(id) && id > 0))
    );
    const teamIds = Array.from(
      new Set(account.teams.map((t) => t.id).filter((id) => Number.isInteger(id) && id > 0))
    );

    const [locRes, teamRes] = await Promise.all([
      locationIds.length > 0
        ? db.query<OwnershipConflictRow>(
            `SELECT id, name, unidade FROM locations WHERE id = ANY($1::bigint[]) AND unidade <> $2 LIMIT 5;`,
            [locationIds, normalizedUnit]
          )
        : Promise.resolve({ rows: [] as OwnershipConflictRow[] }),
      teamIds.length > 0
        ? db.query<OwnershipConflictRow>(
            `SELECT id, name, unidade FROM teams WHERE id = ANY($1::bigint[]) AND unidade <> $2 LIMIT 5;`,
            [teamIds, normalizedUnit]
          )
        : Promise.resolve({ rows: [] as OwnershipConflictRow[] }),
    ]);

    const locRows = Array.isArray(locRes?.rows) ? locRes.rows : [];
    const teamRows = Array.isArray(teamRes?.rows) ? teamRes.rows : [];
    if (locRows.length === 0 && teamRows.length === 0) {
      return;
    }

    const conflictUnits = Array.from(
      new Set(
        [...locRows, ...teamRows]
          .map((r) => String(r.unidade || '').trim().toUpperCase())
          .filter(Boolean)
      )
    );

    const detailsParts: string[] = [];
    if (locRows.length > 0) {
      detailsParts.push(
        `lojas: ${locRows.map((r) => `[${r.id}] ${r.name ?? r.id} (${r.unidade})`).join(', ')}`
      );
    }
    if (teamRows.length > 0) {
      detailsParts.push(
        `equipes: ${teamRows.map((r) => `[${r.id}] ${r.name ?? r.id} (${r.unidade})`).join(', ')}`
      );
    }

    throw new AppError(
      409,
      `Trava de segurança: o token informado para a unidade ${normalizedUnit} pertence a outra unidade já cadastrada no banco (${conflictUnits.join(', ')}). Conflitos detectados: ${detailsParts.join('; ')}. Nenhum token foi alterado.`,
      'TOKEN_UNIT_MISMATCH'
    );
  };
}

export class AuthService implements AuthClientWithVerify {
  public readonly unidade: string;
  private readonly tokenUrl: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly refreshCooldownMs: number;
  private readonly expirySkewMs: number;
  private readonly seedRefreshToken: string;
  private readonly seedHash: string;
  private readonly tokenStore: TokenStore;
  private readonly logger: Pick<AppLogger, 'warn' | 'error'>;

  private state: TokenCacheState | null = null;
  private loadStatePromise: Promise<TokenCacheState> | null = null;
  private refreshPromise: Promise<string> | null = null;
  private lastRefreshedAt = 0;

  constructor(private readonly config: AuthServiceConfig) {
    this.unidade = (config.unidade?.trim() || 'MT').toUpperCase();
    this.tokenUrl = config.tokenUrl ?? DEFAULT_TOKEN_URL;
    this.apiBaseUrl = (config.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.refreshCooldownMs = config.refreshCooldownMs ?? DEFAULT_REFRESH_COOLDOWN_MS;
    this.expirySkewMs = config.expirySkewMs ?? DEFAULT_EXPIRY_SKEW_MS;
    this.seedRefreshToken = config.seedRefreshToken?.trim() ?? '';
    this.seedHash = sha256Hex(this.seedRefreshToken);
    this.logger = config.logger ?? defaultLogger;
    this.tokenStore =
      config.tokenStore ??
      (config.cachePath
        ? new FileTokenStore(config.cachePath, this.logger)
        : new MemoryTokenStore());
  }

  private createSeedState(): TokenCacheState {
    return {
      seed_hash: this.seedHash,
      access_token: '',
      refresh_token: this.seedRefreshToken,
      expires_at: 0,
      source: this.seedRefreshToken ? 'env' : 'none',
      updated_at: null,
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
   * Carrega o estado do TokenStore respeitando o seed do .env.
   * Quando forceReload=true, relê do store para detectar tokens rotacionados por outra instância.
   */
  private async loadState(forceReload = false): Promise<TokenCacheState> {
    if (!forceReload && this.state) {
      return this.state;
    }

    if (!forceReload && this.loadStatePromise) {
      return this.loadStatePromise;
    }

    const executeLoad = async (): Promise<TokenCacheState> => {
      try {
        const expectedSeedHash = this.seedRefreshToken ? this.seedHash : undefined;
        const stored = await this.tokenStore.load(this.unidade, expectedSeedHash);

        if (
          stored &&
          stored.refresh_token.trim().length > 0 &&
          (!this.seedRefreshToken || stored.seed_hash === this.seedHash)
        ) {
          this.state = {
            seed_hash: this.seedHash || stored.seed_hash,
            access_token: stored.access_token,
            refresh_token: stored.refresh_token.trim(),
            expires_at: stored.expires_at,
            source: stored.source === 'api' || stored.source === 'env' ? stored.source : 'env',
            updated_at: stored.updated_at,
          };
          return this.state;
        }
      } catch (err) {
        this.logger.warn(
          {
            unidade: this.unidade,
            err: err instanceof Error ? err.message : String(err),
          },
          'Falha ao carregar estado de token do TokenStore'
        );
        if (this.state) {
          return this.state;
        }
      }

      if (forceReload && this.state) {
        return this.state;
      }

      this.state = this.createSeedState();
      return this.state;
    };

    if (forceReload) {
      return executeLoad();
    }

    this.loadStatePromise = executeLoad().finally(() => {
      this.loadStatePromise = null;
    });

    return this.loadStatePromise;
  }

  private async persistState(state: TokenCacheState): Promise<void> {
    try {
      await this.tokenStore.save(this.unidade, state);
    } catch (err) {
      this.logger.warn(
        {
          unidade: this.unidade,
          err: err instanceof Error ? err.message : String(err),
        },
        'Falha ao persistir token no TokenStore; operando apenas em memória'
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
    const state = await this.loadState(this.tokenStore.storageKind === 'postgres');
    const hasRefresh = Boolean(state.refresh_token);
    const hasValidAccess = this.isAccessTokenFresh(state);
    const expiresAt =
      state.access_token && state.expires_at > 0
        ? new Date(state.expires_at).toISOString()
        : null;
    const source: 'env' | 'api' | 'none' = !hasRefresh
      ? 'none'
      : state.source === 'none'
        ? 'env'
        : state.source;

    return {
      unidade: this.unidade,
      has_refresh_token: hasRefresh,
      has_valid_access_token: hasValidAccess,
      access_token_expires_at: expiresAt,
      source,
      updated_at: state.updated_at ?? null,
      storage: this.tokenStore.storageKind,
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
          `Falha ao validar o novo refresh_token da unidade ${this.unidade} na Followize (HTTP ${response.status})`,
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

      if (this.config.validateAccountOwnership) {
        const account = await this.verifyAccountWithToken(accessToken);
        await this.config.validateAccountOwnership(this.unidade, account);
      }

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
      await this.persistState(nextState);
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
    await this.persistState(nextState);

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
        `Falha ao trocar authorization code da unidade ${this.unidade} na Followize (HTTP ${response.status})`,
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

    if (this.config.validateAccountOwnership) {
      const account = await this.verifyAccountWithToken(accessToken);
      await this.config.validateAccountOwnership(this.unidade, account);
    }

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
    await this.persistState(nextState);

    return this.getTokenStatus();
  }

  /**
   * Renova o access_token usando o refresh_token atual com lock single-flight.
   * Recarrega o TokenStore antes de disparar o refresh OAuth2 para evitar sobrescrever tokens
   * recém-rotacionados por outra instância.
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
      const currentState = await this.loadState(true);

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
          `Refresh token da unidade ${this.unidade} não configurado. Envie um novo token via POST /auth/followize/refresh-token.`,
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
        throw new Error(
          `Falha ao renovar token Followize da unidade ${this.unidade} (${response.status}): ${errText}`
        );
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
        source: currentState.source === 'none' ? 'env' : currentState.source,
        updated_at: new Date().toISOString(),
      };

      this.state = nextState;
      this.lastRefreshedAt = Date.now();
      await this.persistState(nextState);

      return nextState.access_token;
    })().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  /**
   * Retorna um access_token válido da memória/store ou renova proativamente antes da expiração.
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

  private async fetchAccountVerification(
    fetcher: (url: string) => Promise<Response>
  ): Promise<AccountVerificationResult> {
    const [locRes, teamRes] = await Promise.all([
      fetcher(`${this.apiBaseUrl}/locations?page=1&per_page=100`),
      fetcher(`${this.apiBaseUrl}/teams?page=1&per_page=100`),
    ]);

    if (!locRes.ok) {
      throw new AppError(
        502,
        `Falha ao consultar lojas da unidade ${this.unidade} na Followize (HTTP ${locRes.status})`,
        'UPSTREAM_ERROR'
      );
    }

    if (!teamRes.ok) {
      throw new AppError(
        502,
        `Falha ao consultar equipes da unidade ${this.unidade} na Followize (HTTP ${teamRes.status})`,
        'UPSTREAM_ERROR'
      );
    }

    const [locJson, teamJson] = await Promise.all([
      locRes.json().catch(() => null),
      teamRes.json().catch(() => null),
    ]);

    return {
      unidade: this.unidade,
      locations: parseAccountItems(locJson),
      teams: parseAccountItems(teamJson),
    };
  }

  private async verifyAccountWithToken(accessToken: string): Promise<AccountVerificationResult> {
    return this.fetchAccountVerification((url) =>
      this.fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
        signal: this.buildRequestSignal(),
      })
    );
  }

  /**
   * Consulta lojas (/v3/locations) e equipes (/v3/teams) desta credencial
   * para confirmar visualmente qual conta regional está vinculada à unidade.
   */
  async verifyAccount(): Promise<AccountVerificationResult> {
    return this.fetchAccountVerification((url) => this.authenticatedFetch(url));
  }
}

export class AuthManager implements AuthManagerLike {
  private readonly clients = new Map<string, AuthService>();
  private readonly orderedUnits: string[] = [];

  constructor(
    unitConfigs: Record<string, FollowizeUnitConfig>,
    options: {
      tokenStore?: TokenStore;
      timeoutMs?: number;
      tokenUrl?: string;
      apiBaseUrl?: string;
      fetchImpl?: typeof fetch;
      refreshCooldownMs?: number;
      expirySkewMs?: number;
      validateAccountOwnership?: AccountOwnershipValidator;
      logger?: Pick<AppLogger, 'warn' | 'error'>;
    } = {}
  ) {
    const sharedStore = options.tokenStore ?? new MemoryTokenStore();
    const timeoutMs = options.timeoutMs ?? env.FOLLOWIZE_TIMEOUT_MS;

    for (const [rawKey, unitConfig] of Object.entries(unitConfigs)) {
      const unidade = (unitConfig.unidade || rawKey).trim().toUpperCase();
      if (!unidade || this.clients.has(unidade)) {
        continue;
      }

      this.orderedUnits.push(unidade);
      this.clients.set(
        unidade,
        new AuthService({
          unidade,
          clientId: unitConfig.clientId,
          clientSecret: unitConfig.clientSecret,
          seedRefreshToken: unitConfig.seedRefreshToken,
          tokenStore: sharedStore,
          timeoutMs,
          tokenUrl: options.tokenUrl,
          apiBaseUrl: options.apiBaseUrl,
          fetchImpl: options.fetchImpl,
          refreshCooldownMs: options.refreshCooldownMs,
          expirySkewMs: options.expirySkewMs,
          validateAccountOwnership: options.validateAccountOwnership,
          logger: options.logger,
        })
      );
    }
  }

  getUnits(): string[] {
    return [...this.orderedUnits];
  }

  hasUnit(unidade: string): boolean {
    return this.clients.has(unidade.trim().toUpperCase());
  }

  resolveUnit(unidade?: string, options: { allowSingleDefault?: boolean } = {}): string {
    const allowSingleDefault = options.allowSingleDefault ?? false;
    const normalized = typeof unidade === 'string' ? unidade.trim().toUpperCase() : '';

    if (!normalized) {
      if (allowSingleDefault && this.orderedUnits.length === 1) {
        return this.orderedUnits[0]!;
      }

      throw new AppError(
        400,
        `Parâmetro unidade é obrigatório (${this.orderedUnits.join(', ')})`,
        'UNIT_REQUIRED'
      );
    }

    if (!this.clients.has(normalized)) {
      throw new AppError(
        400,
        `Unidade "${normalized}" não configurada. Unidades disponíveis: ${this.orderedUnits.join(', ')}`,
        'INVALID_UNIT'
      );
    }

    return normalized;
  }

  getClient(unidade: string): AuthService {
    const resolved = this.resolveUnit(unidade, { allowSingleDefault: false });
    return this.clients.get(resolved)!;
  }

  async getTokenStatus(unidade: string): Promise<TokenStatusSummary> {
    return this.getClient(unidade).getTokenStatus();
  }

  async getAllTokenStatuses(): Promise<Record<string, TokenStatusSummary>> {
    const entries = await Promise.all(
      this.orderedUnits.map(async (unidade) => [unidade, await this.getTokenStatus(unidade)] as const)
    );
    return Object.fromEntries(entries);
  }
}

export const authManager = new AuthManager(env.FOLLOWIZE_CLIENTS, {
  tokenStore: new PostgresTokenStore(pool, {
    legacyCachePath: path.resolve(process.cwd(), env.FOLLOWIZE_TOKEN_CACHE_PATH),
  }),
  timeoutMs: env.FOLLOWIZE_TIMEOUT_MS,
  validateAccountOwnership: createDbAccountOwnershipValidator(pool),
});
