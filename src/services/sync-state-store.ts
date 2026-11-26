import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger as defaultLogger, type AppLogger } from '../config/logger.js';
import type { DbPoolLike } from '../modules/leads/leads.service.js';

export interface SyncStateRecord {
  pending_start_date: string | null;
  last_completed_at: string | null;
  last_start_date: string | null;
}

export interface SyncStateStore {
  read(unidade: string): Promise<SyncStateRecord | null>;
  write(unidade: string, state: SyncStateRecord): Promise<void>;
}

function normalizeStringField(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeIsoField(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return normalizeStringField(value);
}

function normalizeRecord(raw: unknown): SyncStateRecord | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  return {
    pending_start_date: normalizeStringField(obj.pending_start_date),
    last_completed_at: normalizeIsoField(obj.last_completed_at),
    last_start_date: normalizeStringField(obj.last_start_date),
  };
}

export class PostgresSyncStateStore implements SyncStateStore {
  constructor(private readonly db: Pick<DbPoolLike, 'query'>) {}

  async read(unidade: string): Promise<SyncStateRecord | null> {
    const { rows } = await this.db.query(
      `SELECT pending_start_date, last_completed_at, last_start_date
       FROM sync_state
       WHERE unidade = $1
       LIMIT 1;`,
      [unidade]
    );

    if (rows.length === 0) {
      return null;
    }

    return normalizeRecord(rows[0]);
  }

  async write(unidade: string, state: SyncStateRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO sync_state (unidade, pending_start_date, last_completed_at, last_start_date, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (unidade) DO UPDATE SET
         pending_start_date = EXCLUDED.pending_start_date,
         last_completed_at = EXCLUDED.last_completed_at,
         last_start_date = EXCLUDED.last_start_date,
         updated_at = NOW();`,
      [
        unidade,
        state.pending_start_date,
        state.last_completed_at,
        state.last_start_date,
      ]
    );
  }
}

export class FileSyncStateStore implements SyncStateStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly logger: Pick<AppLogger, 'warn'> = defaultLogger
  ) {}

  private async readAllRaw(): Promise<Record<string, SyncStateRecord>> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') {
        return {};
      }

      // Compatibilidade com formato legado plano (sem chave por unidade)
      if (
        'pending_start_date' in parsed ||
        'last_completed_at' in parsed ||
        'last_start_date' in parsed
      ) {
        const legacyRecord = normalizeRecord(parsed);
        return legacyRecord ? { MT: legacyRecord } : {};
      }

      const result: Record<string, SyncStateRecord> = {};
      for (const [key, val] of Object.entries(parsed)) {
        const rec = normalizeRecord(val);
        if (rec) {
          result[key.trim().toUpperCase()] = rec;
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  async read(unidade: string): Promise<SyncStateRecord | null> {
    const all = await this.readAllRaw();
    return all[unidade.trim().toUpperCase()] ?? null;
  }

  async write(unidade: string, state: SyncStateRecord): Promise<void> {
    const normalizedUnit = unidade.trim().toUpperCase();
    const run = this.writeQueue.then(async () => {
      const all = await this.readAllRaw();
      all[normalizedUnit] = { ...state };

      const dir = path.dirname(this.filePath);
      const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(tmpPath, JSON.stringify(all, null, 2), {
          encoding: 'utf-8',
          mode: 0o600,
        });
        await fs.rename(tmpPath, this.filePath);
      } catch (err) {
        await fs.unlink(tmpPath).catch(() => undefined);
        this.logger.warn(
          {
            unidade: normalizedUnit,
            err: err instanceof Error ? err.message : String(err),
          },
          'Falha ao persistir estado de watermark em disco'
        );
      }
    });

    this.writeQueue = run.catch(() => undefined);
    await run;
  }
}

export class MemorySyncStateStore implements SyncStateStore {
  private readonly store = new Map<string, SyncStateRecord>();

  constructor(initial?: Record<string, SyncStateRecord>) {
    if (initial) {
      for (const [unidade, rec] of Object.entries(initial)) {
        this.store.set(unidade.trim().toUpperCase(), { ...rec });
      }
    }
  }

  async read(unidade: string): Promise<SyncStateRecord | null> {
    const rec = this.store.get(unidade.trim().toUpperCase());
    return rec ? { ...rec } : null;
  }

  async write(unidade: string, state: SyncStateRecord): Promise<void> {
    this.store.set(unidade.trim().toUpperCase(), { ...state });
  }
}
