import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger as defaultLogger, type AppLogger } from '../config/logger.js';
import type { DbPoolLike } from '../modules/leads/leads.service.js';

export type TokenStoreKind = 'postgres' | 'file' | 'memory';

export interface TokenCacheState {
  seed_hash: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  source: 'env' | 'api' | 'none';
  updated_at: string | null;
}

export interface TokenStore {
  readonly storageKind: TokenStoreKind;
  load(unidade: string, expectedSeedHash?: string): Promise<TokenCacheState | null>;
  save(unidade: string, state: TokenCacheState): Promise<void>;
}

function normalizeSource(value: unknown, fallback: 'env' | 'api' | 'none' = 'env'): 'env' | 'api' | 'none' {
  if (value === 'env' || value === 'api' || value === 'none') {
    return value;
  }
  return fallback;
}

function normalizeTimestampMs(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 0 : value.getTime();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function normalizeIsoTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return null;
}

export class PostgresTokenStore implements TokenStore {
  readonly storageKind = 'postgres' as const;
  private readonly legacyCachePath?: string;
  private readonly logger: Pick<AppLogger, 'info' | 'warn' | 'error'>;
  private legacyCutoverAttempted = false;

  constructor(
    private readonly db: Pick<DbPoolLike, 'query'>,
    options: {
      legacyCachePath?: string;
      logger?: Pick<AppLogger, 'info' | 'warn' | 'error'>;
    } = {}
  ) {
    this.legacyCachePath = options.legacyCachePath;
    this.logger = options.logger ?? defaultLogger;
  }

  async load(unidade: string, expectedSeedHash?: string): Promise<TokenCacheState | null> {
    const { rows } = await this.db.query(
      `SELECT unidade, token, refresh_token, expires_at, seed_hash, source, updated_at
       FROM tokens
       WHERE unidade = $1
       LIMIT 1;`,
      [unidade]
    );

    const row = rows[0];
    if (row && typeof row.refresh_token === 'string' && row.refresh_token.trim().length > 0) {
      return {
        seed_hash: typeof row.seed_hash === 'string' ? row.seed_hash : '',
        access_token: typeof row.token === 'string' ? row.token : '',
        refresh_token: row.refresh_token.trim(),
        expires_at: normalizeTimestampMs(row.expires_at),
        source: normalizeSource(row.source, 'env'),
        updated_at: normalizeIsoTimestamp(row.updated_at),
      };
    }

    // Cutover único do arquivo legado de MT para public.tokens
    if (unidade === 'MT' && this.legacyCachePath && !this.legacyCutoverAttempted) {
      this.legacyCutoverAttempted = true;
      try {
        const raw = await fs.readFile(this.legacyCachePath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<TokenCacheState> | null;

        if (
          parsed &&
          typeof parsed.refresh_token === 'string' &&
          parsed.refresh_token.trim().length > 0 &&
          typeof parsed.access_token === 'string' &&
          typeof parsed.expires_at === 'number' &&
          Number.isFinite(parsed.expires_at) &&
          (expectedSeedHash === undefined || parsed.seed_hash === expectedSeedHash)
        ) {
          const migratedState: TokenCacheState = {
            seed_hash:
              typeof parsed.seed_hash === 'string' ? parsed.seed_hash : (expectedSeedHash ?? ''),
            access_token: parsed.access_token,
            refresh_token: parsed.refresh_token.trim(),
            expires_at: parsed.expires_at,
            source: normalizeSource(parsed.source, 'env'),
            updated_at: normalizeIsoTimestamp(parsed.updated_at) ?? new Date().toISOString(),
          };

          try {
            await this.save('MT', migratedState);
            this.logger.info(
              { unidade: 'MT', source: migratedState.source },
              'Token legado de MT importado para public.tokens'
            );
          } catch (saveErr) {
            this.logger.warn(
              {
                unidade: 'MT',
                err: saveErr instanceof Error ? saveErr.message : String(saveErr),
              },
              'Token legado de MT carregado, mas falhou ao gravar em public.tokens'
            );
          }

          return migratedState;
        }
      } catch {
        // Arquivo legado ausente ou ilegível: segue fluxo normal
      }
    }

    return null;
  }

  async save(unidade: string, state: TokenCacheState): Promise<void> {
    await this.db.query(
      `INSERT INTO tokens (unidade, token, refresh_token, expires_at, seed_hash, source, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()))
       ON CONFLICT (unidade) DO UPDATE SET
         token = EXCLUDED.token,
         refresh_token = EXCLUDED.refresh_token,
         expires_at = EXCLUDED.expires_at,
         seed_hash = EXCLUDED.seed_hash,
         source = EXCLUDED.source,
         updated_at = EXCLUDED.updated_at;`,
      [
        unidade,
        state.access_token || null,
        state.refresh_token || null,
        state.expires_at > 0 ? new Date(state.expires_at).toISOString() : null,
        state.seed_hash || null,
        state.source,
        state.updated_at ?? new Date().toISOString(),
      ]
    );
  }
}

export class FileTokenStore implements TokenStore {
  readonly storageKind = 'file' as const;
  private readonly resolvePath: (unidade: string) => string;
  private readonly logger: Pick<AppLogger, 'warn'>;

  constructor(
    filePathOrResolver: string | ((unidade: string) => string),
    logger: Pick<AppLogger, 'warn'> = defaultLogger
  ) {
    this.resolvePath =
      typeof filePathOrResolver === 'function' ? filePathOrResolver : () => filePathOrResolver;
    this.logger = logger;
  }

  async load(unidade: string): Promise<TokenCacheState | null> {
    const targetPath = this.resolvePath(unidade);
    try {
      const raw = await fs.readFile(targetPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<TokenCacheState> | null;
      if (
        parsed &&
        typeof parsed.refresh_token === 'string' &&
        parsed.refresh_token.trim().length > 0 &&
        typeof parsed.access_token === 'string' &&
        typeof parsed.expires_at === 'number' &&
        Number.isFinite(parsed.expires_at)
      ) {
        return {
          seed_hash: typeof parsed.seed_hash === 'string' ? parsed.seed_hash : '',
          access_token: parsed.access_token,
          refresh_token: parsed.refresh_token.trim(),
          expires_at: parsed.expires_at,
          source: normalizeSource(parsed.source, 'env'),
          updated_at: normalizeIsoTimestamp(parsed.updated_at),
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  async save(unidade: string, state: TokenCacheState): Promise<void> {
    const targetPath = this.resolvePath(unidade);
    const dir = path.dirname(targetPath);
    const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;

    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      await fs.rename(tmpPath, targetPath);
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => undefined);
      this.logger.warn(
        { unidade, err: err instanceof Error ? err.message : String(err) },
        'Falha ao persistir cache de token em disco; operando apenas em memória'
      );
    }
  }
}

export class MemoryTokenStore implements TokenStore {
  readonly storageKind = 'memory' as const;
  private readonly store = new Map<string, TokenCacheState>();

  constructor(initial?: Record<string, TokenCacheState>) {
    if (initial) {
      for (const [unidade, state] of Object.entries(initial)) {
        this.store.set(unidade.trim().toUpperCase(), { ...state });
      }
    }
  }

  async load(unidade: string): Promise<TokenCacheState | null> {
    const item = this.store.get(unidade.trim().toUpperCase());
    return item ? { ...item } : null;
  }

  async save(unidade: string, state: TokenCacheState): Promise<void> {
    this.store.set(unidade.trim().toUpperCase(), { ...state });
  }
}
