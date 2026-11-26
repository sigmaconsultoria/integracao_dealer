import { pool } from '../config/database.js';
import { logger as defaultLogger, type AppLogger } from '../config/logger.js';
import { AppError } from '../errors/app-error.js';
import type { AuthClientLike, DbClientLike, DbPoolLike } from '../modules/leads/leads.service.js';
import { authManager as defaultAuthManager, type AuthManagerLike } from './auth.service.js';
import {
  FileSyncStateStore,
  PostgresSyncStateStore,
  type SyncStateRecord,
  type SyncStateStore,
} from './sync-state-store.js';

const API_URL = 'https://api.followize.com.br/v3/leads';
const DEFAULT_FALLBACK_DATE = '2026-09-01 00:00:00';
const PER_PAGE = 50;

export type SyncAuthManagerLike = Pick<
  AuthManagerLike,
  'getUnits' | 'hasUnit' | 'resolveUnit' | 'getClient'
>;

export interface UnitSyncResult {
  unidade: string;
  success: boolean;
  startDate: string | null;
  totalSynced: number;
  pagesProcessed: number;
  resumedFromPending: boolean;
  durationSeconds: number;
  message: string;
  error?: string;
}

export interface SyncResult {
  success: boolean;
  partial_failure?: boolean;
  startDate: string;
  totalSynced: number;
  pagesProcessed: number;
  resumedFromPending: boolean;
  durationSeconds: number;
  message: string;
  units: Record<string, UnitSyncResult>;
}

export interface SyncProgress {
  started_at: string;
  current_unit: string | null;
  current_page: number;
  last_page: number | null;
  pages_processed: number;
  total_synced: number;
  total_records: number | null;
}

export interface UnitSyncStatusSnapshot {
  unidade: string;
  in_progress: boolean;
  progress: SyncProgress | null;
  pending_start_date: string | null;
  last_completed_at: string | null;
  last_start_date: string | null;
  last_result: UnitSyncResult | null;
  last_error: string | null;
}

export interface SyncStatusSnapshot {
  in_progress: boolean;
  progress: SyncProgress | null;
  last_completed_at: string | null;
  last_start_date: string | null;
  last_result: SyncResult | null;
  last_error: string | null;
  units: Record<string, UnitSyncStatusSnapshot>;
}

export interface SyncServiceDeps {
  db?: DbPoolLike;
  authManager?: SyncAuthManagerLike;
  auth?: AuthClientLike;
  stateStore?: SyncStateStore;
  statePath?: string;
  maxPages?: number;
  pageDelayMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  logger?: AppLogger;
}

function createSingleUnitAuthManager(authClient: AuthClientLike): SyncAuthManagerLike {
  return {
    getUnits: () => ['MT'],
    hasUnit: (unidade: string) => unidade.trim().toUpperCase() === 'MT',
    resolveUnit: (unidade?: string) => {
      const normalized = typeof unidade === 'string' ? unidade.trim().toUpperCase() : '';
      if (!normalized || normalized === 'MT') {
        return 'MT';
      }
      throw new AppError(
        400,
        `Unidade "${normalized}" não configurada. Unidades disponíveis: MT`,
        'INVALID_UNIT'
      );
    },
    getClient: (unidade: string) => {
      const normalized = unidade.trim().toUpperCase();
      if (normalized !== 'MT') {
        throw new AppError(
          400,
          `Unidade "${normalized}" não configurada. Unidades disponíveis: MT`,
          'INVALID_UNIT'
        );
      }
      return authClient as ReturnType<AuthManagerLike['getClient']>;
    },
  };
}

function toNullableString(val: unknown): string | null {
  if (val === null || val === undefined || val === '') {
    return null;
  }
  return String(val);
}

function toNullableNumber(val: unknown): number | null {
  if (val === null || val === undefined || val === '') {
    return null;
  }
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

function toNullableBigInt(val: unknown, allowZero = true): number | null {
  if (val === null || val === undefined || val === '') {
    return null;
  }
  const num = Number(val);
  if (!Number.isInteger(num)) {
    return null;
  }
  return allowZero ? (num >= 0 ? num : null) : num > 0 ? num : null;
}

function toNullableDate(val: unknown): string | null {
  if (typeof val !== 'string') {
    return null;
  }
  const match = val.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match?.[1]) {
    return null;
  }
  const [y, m, d] = match[1].split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m! - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return match[1];
}

function toNullableTimestamp(val: unknown): string | null {
  if (val instanceof Date) {
    return Number.isNaN(val.getTime()) ? null : val.toISOString();
  }
  if (typeof val !== 'string') {
    return null;
  }
  const trimmed = val.trim();
  if (!trimmed) {
    return null;
  }
  const normalized =
    trimmed.includes(' ') && !trimmed.includes('T') ? trimmed.replace(' ', 'T') : trimmed;
  return Number.isNaN(Date.parse(normalized)) ? null : trimmed;
}

export function normalizeTimestampMs(val: unknown): number | null {
  if (val instanceof Date) {
    return Number.isNaN(val.getTime()) ? null : val.getTime();
  }
  if (typeof val !== 'string') {
    return null;
  }
  const trimmed = val.trim();
  if (!trimmed) {
    return null;
  }
  let iso = trimmed.includes(' ') && !trimmed.includes('T') ? trimmed.replace(' ', 'T') : trimmed;
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso)) {
    iso += '-03:00';
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SyncService {
  private readonly db: DbPoolLike;
  private readonly authManager: SyncAuthManagerLike;
  private readonly stateStore: SyncStateStore;
  private readonly maxPages: number;
  private readonly pageDelayMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly logger: AppLogger;

  private readonly activeUnits = new Map<string, string>();
  private readonly unitProgress = new Map<string, SyncProgress>();
  private readonly unitLastResult = new Map<string, UnitSyncResult>();
  private readonly unitLastError = new Map<string, string | null>();
  private activeProgress: SyncProgress | null = null;
  private lastResult: SyncResult | null = null;
  private lastError: string | null = null;

  constructor(deps: SyncServiceDeps = {}) {
    this.db = deps.db ?? pool;
    this.authManager =
      deps.authManager ??
      (deps.auth ? createSingleUnitAuthManager(deps.auth) : defaultAuthManager);
    this.logger = deps.logger ?? defaultLogger;
    this.stateStore =
      deps.stateStore ??
      (deps.statePath
        ? new FileSyncStateStore(deps.statePath, this.logger)
        : new PostgresSyncStateStore(this.db));
    this.maxPages = deps.maxPages ?? 1000;
    this.pageDelayMs = deps.pageDelayMs ?? 150;
    this.maxRetries = deps.maxRetries ?? 3;
    this.retryBaseDelayMs = deps.retryBaseDelayMs ?? 500;
  }

  private resolveTargetUnits(unidade?: string): string[] {
    if (typeof unidade === 'string' && unidade.trim().length > 0) {
      return [this.authManager.resolveUnit(unidade, { allowSingleDefault: false })];
    }
    return this.authManager.getUnits();
  }

  private assertUnitsAvailable(targetUnits: string[]): void {
    for (const unit of targetUnits) {
      const startedAt = this.activeUnits.get(unit);
      if (startedAt) {
        throw new AppError(
          409,
          `Sincronização já está em andamento para a unidade ${unit} desde ${startedAt}`,
          'SYNC_IN_PROGRESS'
        );
      }
    }
  }

  private async safeReadSyncState(unidade: string): Promise<SyncStateRecord | null> {
    try {
      return await this.stateStore.read(unidade);
    } catch (err) {
      this.logger.warn(
        {
          unidade,
          err: err instanceof Error ? err.message : String(err),
        },
        'Falha ao ler estado de watermark da unidade'
      );
      return null;
    }
  }

  private async safeWriteSyncState(unidade: string, nextState: SyncStateRecord): Promise<void> {
    try {
      await this.stateStore.write(unidade, nextState);
    } catch (err) {
      this.logger.warn(
        {
          unidade,
          err: err instanceof Error ? err.message : String(err),
        },
        'Falha ao persistir estado de watermark da unidade'
      );
    }
  }

  /**
   * Obtém a data/hora inicial de sincronização de uma unidade no fuso 'America/Sao_Paulo'.
   * Se houver sync incremental anterior interrompido, retoma do pending_start_date.
   */
  async getIncrementalStartDate(
    customDate?: string,
    fullSync = false,
    unidade = this.authManager.getUnits()[0] ?? 'MT'
  ): Promise<string> {
    const resolvedUnit = this.authManager.resolveUnit(unidade, { allowSingleDefault: true });
    const resolved = await this.resolveStartDate(resolvedUnit, customDate, fullSync);
    return resolved.startDate;
  }

  private async resolveStartDate(
    unidade: string,
    customDate?: string,
    fullSync = false
  ): Promise<{
    startDate: string;
    resumedFromPending: boolean;
    prevState: SyncStateRecord | null;
  }> {
    const prevState = await this.safeReadSyncState(unidade);

    if (fullSync) {
      return { startDate: DEFAULT_FALLBACK_DATE, resumedFromPending: false, prevState };
    }

    if (customDate) {
      return {
        startDate: customDate.replace('T', ' ').substring(0, 19),
        resumedFromPending: false,
        prevState,
      };
    }

    if (prevState?.pending_start_date) {
      return {
        startDate: prevState.pending_start_date,
        resumedFromPending: true,
        prevState,
      };
    }

    const { rows } = await this.db.query(
      `SELECT TO_CHAR(
         (COALESCE(MAX(updated_at), '2026-09-01 00:00:00+00'::timestamptz) AT TIME ZONE 'America/Sao_Paulo') - INTERVAL '3 minutes',
         'YYYY-MM-DD HH24:MI:SS'
       ) AS start_date
       FROM leads
       WHERE unidade = $1;`,
      [unidade]
    );

    return {
      startDate: rows[0]?.start_date || DEFAULT_FALLBACK_DATE,
      resumedFromPending: false,
      prevState,
    };
  }

  private async fetchPageWithRetry(
    authClient: AuthClientLike,
    unidade: string,
    startDate: string,
    page: number
  ): Promise<any> {
    const url = new URL(API_URL);
    url.searchParams.set('date_from', startDate);
    url.searchParams.set('date_field', 'updated_at');
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(PER_PAGE));

    let lastStatus: number | null = null;
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await authClient.authenticatedFetch(url.toString(), {
          headers: {
            'User-Agent': 'FollowizeFastifySync/2.0',
          },
        });

        if (res.ok) {
          return await res.json();
        }

        lastStatus = res.status;
        const isRetryable = res.status === 429 || res.status >= 500;
        if (!isRetryable || attempt === this.maxRetries) {
          throw new AppError(
            502,
            `Erro na API Followize (HTTP ${res.status}) na página ${page} [${unidade}]`,
            'UPSTREAM_ERROR'
          );
        }

        const retryAfterRaw = res.headers.get('retry-after');
        const retryAfterSec =
          retryAfterRaw && /^\d+$/.test(retryAfterRaw.trim()) ? Number(retryAfterRaw.trim()) : null;
        const delayMs =
          retryAfterSec !== null
            ? Math.min(retryAfterSec * 1000, 30_000)
            : this.retryBaseDelayMs * 2 ** attempt;

        this.logger.warn(
          {
            unidade,
            status: res.status,
            page,
            delayMs,
            attempt: attempt + 1,
            maxRetries: this.maxRetries,
          },
          'Erro HTTP transitório ao buscar página na Followize; aguardando retry'
        );
        await sleep(delayMs);
      } catch (err) {
        if (err instanceof AppError) {
          throw err;
        }
        lastError = err;
        const isTransient =
          err instanceof Error &&
          (err.name === 'AbortError' ||
            err.name === 'TimeoutError' ||
            err.name === 'TypeError' ||
            /fetch failed|network|timeout|ECONNRESET|ETIMEDOUT/i.test(err.message));

        if (!isTransient || attempt === this.maxRetries) {
          throw err;
        }

        const delayMs = this.retryBaseDelayMs * 2 ** attempt;
        this.logger.warn(
          {
            unidade,
            err: err instanceof Error ? err.message : String(err),
            page,
            delayMs,
            attempt: attempt + 1,
            maxRetries: this.maxRetries,
          },
          'Erro de rede ao buscar página na Followize; aguardando retry'
        );
        await sleep(delayMs);
      }
    }

    throw new AppError(
      502,
      `Falha ao consultar página ${page} da Followize [${unidade}]${lastStatus ? ` (HTTP ${lastStatus})` : ''}${lastError instanceof Error ? `: ${lastError.message}` : ''}`,
      'UPSTREAM_ERROR'
    );
  }

  private async syncSingleUnit(
    unidade: string,
    startedAt: string,
    customDate?: string,
    fullSync = false
  ): Promise<UnitSyncResult> {
    const unitStartTime = Date.now();
    const progress: SyncProgress = {
      started_at: startedAt,
      current_unit: unidade,
      current_page: 0,
      last_page: null,
      pages_processed: 0,
      total_synced: 0,
      total_records: null,
    };
    this.unitProgress.set(unidade, progress);
    this.activeProgress = progress;

    let resolvedStartDate: string | null = null;
    let resumedFromPending = false;
    let totalSynced = 0;
    let pagesProcessed = 0;

    try {
      const authClient = this.authManager.getClient(unidade);
      const startInfo = await this.resolveStartDate(unidade, customDate, fullSync);
      resolvedStartDate = startInfo.startDate;
      resumedFromPending = startInfo.resumedFromPending;
      const prevState = startInfo.prevState;

      const isIncremental = !customDate && !fullSync;
      const forceUpsert = Boolean(customDate) || fullSync || resumedFromPending;

      if (isIncremental) {
        await this.safeWriteSyncState(unidade, {
          pending_start_date: resolvedStartDate,
          last_completed_at: prevState?.last_completed_at ?? null,
          last_start_date: prevState?.last_start_date ?? null,
        });
      }

      let currentPage = 1;
      let lastPage = 1;

      this.logger.info(
        { unidade, startDate: resolvedStartDate, resumedFromPending },
        'Iniciando sincronização incremental de leads da unidade'
      );

      while (currentPage <= lastPage) {
        const json = await this.fetchPageWithRetry(
          authClient,
          unidade,
          resolvedStartDate,
          currentPage
        );
        const leadsBatch = Array.isArray(json?.data) ? json.data : [];
        const meta = json?.meta || {};
        const parsedLastPage = Number(meta.last_page);
        lastPage =
          Number.isInteger(parsedLastPage) && parsedLastPage >= currentPage
            ? Math.min(parsedLastPage, this.maxPages)
            : currentPage;
        const totalRecords = Number(meta.total ?? leadsBatch.length);

        progress.current_page = currentPage;
        progress.last_page = lastPage;
        progress.total_records = Number.isFinite(totalRecords) ? totalRecords : null;

        if (!leadsBatch.length || totalRecords === 0) {
          break;
        }

        const client = await this.db.connect();
        try {
          await client.query('BEGIN');
          const savedCount = await this.saveBatch(client, unidade, leadsBatch, forceUpsert);
          await client.query('COMMIT');
          totalSynced += savedCount;
          pagesProcessed++;
          progress.pages_processed = pagesProcessed;
          progress.total_synced = totalSynced;
          this.logger.info(
            {
              unidade,
              page: currentPage,
              lastPage,
              savedCount,
              totalSynced,
              totalRecords,
            },
            'Página de leads sincronizada'
          );
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          client.release?.();
        }

        currentPage++;
        if (currentPage <= lastPage) {
          await sleep(this.pageDelayMs);
        }
      }

      if (isIncremental || fullSync) {
        await this.safeWriteSyncState(unidade, {
          pending_start_date: null,
          last_completed_at: new Date().toISOString(),
          last_start_date: resolvedStartDate,
        });
      }

      const durationSeconds = Math.round((Date.now() - unitStartTime) / 1000);
      return {
        unidade,
        success: true,
        startDate: resolvedStartDate,
        totalSynced,
        pagesProcessed,
        resumedFromPending,
        durationSeconds,
        message: `Unidade ${unidade} sincronizada com sucesso. ${totalSynced} leads processados em ${durationSeconds}s.`,
      };
    } catch (err) {
      const durationSeconds = Math.round((Date.now() - unitStartTime) / 1000);
      const errMsg = err instanceof Error ? err.message : String(err);
      const wrappedError = err instanceof Error ? err : new Error(errMsg);
      Object.assign(wrappedError, {
        _unitFailureContext: {
          unidade,
          startDate: resolvedStartDate,
          totalSynced,
          pagesProcessed,
          resumedFromPending,
          durationSeconds,
          error: errMsg,
        },
      });
      throw wrappedError;
    }
  }

  /**
   * Executa a sincronização incremental nas 17 tabelas para uma unidade específica ou para todas
   * as unidades configuradas em sequência, com isolamento total de falhas por unidade.
   */
  async syncLeads(
    customDate?: string,
    fullSync = false,
    unidade?: string
  ): Promise<SyncResult> {
    const targetUnits = this.resolveTargetUnits(unidade);
    this.assertUnitsAvailable(targetUnits);

    const startedAt = new Date().toISOString();
    for (const unit of targetUnits) {
      this.activeUnits.set(unit, startedAt);
    }

    const overallStartTime = Date.now();
    const initialProgress: SyncProgress = {
      started_at: startedAt,
      current_unit: targetUnits[0] ?? null,
      current_page: 0,
      last_page: null,
      pages_processed: 0,
      total_synced: 0,
      total_records: null,
    };
    this.activeProgress = initialProgress;
    this.lastError = null;

    const unitResults: Record<string, UnitSyncResult> = {};
    const unitErrors: Array<{ unidade: string; error: unknown; message: string }> = [];

    try {
      for (const unit of targetUnits) {
        try {
          const res = await this.syncSingleUnit(unit, startedAt, customDate, fullSync);
          unitResults[unit] = res;
          this.unitLastResult.set(unit, res);
          this.unitLastError.set(unit, null);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const ctx = (
            err as {
              _unitFailureContext?: {
                startDate: string | null;
                totalSynced: number;
                pagesProcessed: number;
                resumedFromPending: boolean;
                durationSeconds: number;
              };
            }
          )?._unitFailureContext;

          const failedResult: UnitSyncResult = {
            unidade: unit,
            success: false,
            startDate: ctx?.startDate ?? null,
            totalSynced: ctx?.totalSynced ?? 0,
            pagesProcessed: ctx?.pagesProcessed ?? 0,
            resumedFromPending: ctx?.resumedFromPending ?? false,
            durationSeconds: ctx?.durationSeconds ?? 0,
            message: `Falha ao sincronizar unidade ${unit}: ${errMsg}`,
            error: errMsg,
          };

          unitResults[unit] = failedResult;
          this.unitLastResult.set(unit, failedResult);
          this.unitLastError.set(unit, errMsg);
          unitErrors.push({ unidade: unit, error: err, message: errMsg });

          this.logger.error(
            { unidade: unit, err: errMsg },
            'Falha na sincronização da unidade; isolando erro'
          );
        } finally {
          this.activeUnits.delete(unit);
          this.unitProgress.delete(unit);
          this.activeProgress = this.unitProgress.values().next().value ?? null;
        }
      }

      const succeededUnits = Object.values(unitResults).filter((r) => r.success);

      if (succeededUnits.length === 0) {
        const aggregatedMsg =
          targetUnits.length === 1
            ? unitErrors[0]!.message
            : `Falha ao sincronizar todas as unidades: ${unitErrors
                .map((e) => `${e.unidade}: ${e.message}`)
                .join('; ')}`;
        this.lastError = aggregatedMsg;

        if (targetUnits.length === 1) {
          throw unitErrors[0]!.error;
        }
        throw new AppError(502, aggregatedMsg, 'SYNC_ALL_UNITS_FAILED');
      }

      const totalSynced = Object.values(unitResults).reduce((acc, r) => acc + r.totalSynced, 0);
      const pagesProcessed = Object.values(unitResults).reduce(
        (acc, r) => acc + r.pagesProcessed,
        0
      );
      const resumedFromPending = Object.values(unitResults).some((r) => r.resumedFromPending);
      const durationSeconds = Math.round((Date.now() - overallStartTime) / 1000);
      const partialFailure = unitErrors.length > 0;
      const firstSuccess = succeededUnits[0]!;
      const failureSummary = partialFailure
        ? unitErrors.map((e) => `${e.unidade}: ${e.message}`).join('; ')
        : null;

      const message = partialFailure
        ? `Sincronização concluída com falha parcial (${succeededUnits.length}/${targetUnits.length} unidades). ${totalSynced} leads processados em ${durationSeconds}s. Erros: ${failureSummary}`
        : `Sincronização concluída com sucesso. ${totalSynced} leads processados em ${durationSeconds}s.`;

      const result: SyncResult = {
        success: true,
        ...(partialFailure ? { partial_failure: true } : {}),
        startDate: firstSuccess.startDate ?? DEFAULT_FALLBACK_DATE,
        totalSynced,
        pagesProcessed,
        resumedFromPending,
        durationSeconds,
        message,
        units: unitResults,
      };

      this.lastResult = result;
      this.lastError = failureSummary;
      return result;
    } finally {
      for (const unit of targetUnits) {
        this.activeUnits.delete(unit);
        this.unitProgress.delete(unit);
      }
      if (this.activeUnits.size === 0) {
        this.activeProgress = null;
      }
    }
  }

  /**
   * Retorna o estado atual da sincronização (retrocompatível no topo + detalhamento por unidade).
   */
  async getSyncStatus(): Promise<SyncStatusSnapshot> {
    const configuredUnits = this.authManager.getUnits();
    const allUnitNames = Array.from(
      new Set([
        ...configuredUnits,
        ...this.activeUnits.keys(),
        ...this.unitLastResult.keys(),
        ...this.unitLastError.keys(),
      ])
    );

    const stateEntries = await Promise.all(
      allUnitNames.map(async (unit) => [unit, await this.safeReadSyncState(unit)] as const)
    );

    const units: Record<string, UnitSyncStatusSnapshot> = {};
    let latestCompletedAt: string | null = null;
    let latestCompletedMs = -Infinity;
    let latestStartDate: string | null = null;

    for (const [unit, state] of stateEntries) {
      const unitProg = this.unitProgress.get(unit);
      units[unit] = {
        unidade: unit,
        in_progress: this.activeUnits.has(unit),
        progress: unitProg ? { ...unitProg } : null,
        pending_start_date: state?.pending_start_date ?? null,
        last_completed_at: state?.last_completed_at ?? null,
        last_start_date: state?.last_start_date ?? null,
        last_result: this.unitLastResult.get(unit) ?? null,
        last_error: this.unitLastError.get(unit) ?? null,
      };

      if (state?.last_completed_at) {
        const ms = Date.parse(state.last_completed_at);
        if (!Number.isNaN(ms) && ms >= latestCompletedMs) {
          latestCompletedMs = ms;
          latestCompletedAt = state.last_completed_at;
          latestStartDate = state.last_start_date;
        } else if (latestCompletedAt === null) {
          latestCompletedAt = state.last_completed_at;
          latestStartDate = state.last_start_date;
        }
      } else if (latestStartDate === null && state?.last_start_date) {
        latestStartDate = state.last_start_date;
      }
    }

    return {
      in_progress: this.activeUnits.size > 0,
      progress: this.activeProgress ? { ...this.activeProgress } : null,
      last_completed_at: latestCompletedAt,
      last_start_date: latestStartDate,
      last_result: this.lastResult,
      last_error: this.lastError,
      units,
    };
  }

  /**
   * Dispara a sincronização em segundo plano sem bloquear a resposta HTTP.
   */
  startSyncInBackground(customDate?: string, fullSync = false, unidade?: string): void {
    const targetUnits = this.resolveTargetUnits(unidade);
    this.assertUnitsAvailable(targetUnits);

    void this.syncLeads(customDate, fullSync, unidade).catch((err) => {
      this.logger.error(
        {
          unidade: unidade ?? 'ALL',
          err: err instanceof Error ? err.message : String(err),
        },
        'Falha na sincronização assíncrona de leads'
      );
    });
  }

  private async assertMetadataOwnership(
    client: DbClientLike,
    table: 'locations' | 'teams',
    resourceLabel: string,
    ids: number[],
    unidade: string
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const res = await client.query(
      `SELECT id, name, unidade FROM ${table} WHERE id = ANY($1::bigint[]) AND unidade <> $2 LIMIT 5;`,
      [ids, unidade]
    );
    const rows = Array.isArray(res?.rows) ? res.rows : [];
    if (rows.length === 0) {
      return;
    }

    const conflictUnits = Array.from(
      new Set(
        rows
          .map((r) => (typeof r.unidade === 'string' ? r.unidade.trim().toUpperCase() : ''))
          .filter(Boolean)
      )
    );
    const details = rows
      .map(
        (r) =>
          `[${r.id}] ${r.name ?? r.id} (${String(r.unidade || '')
            .trim()
            .toUpperCase()})`
      )
      .join(', ');

    this.logger.error(
      { unidade, table, conflicts: rows },
      `Bloqueio de segurança: tentativa de sobrescrever ${resourceLabel} de outra unidade`
    );
    throw new AppError(
      409,
      `Bloqueio de segurança: o lote da unidade ${unidade} referencia ${resourceLabel} pertencente(s) a outra unidade (${conflictUnits.join(', ')}: ${details}). Sincronização abortada sem alterar dados.`,
      'UNIT_OWNERSHIP_CONFLICT'
    );
  }

  /**
   * Salva o lote de leads nas 17 tabelas com UPSERT em lote via UNNEST.
   * Apenas leads, leads_raw, locations e teams possuem a coluna unidade.
   */
  private async saveBatch(
    client: DbClientLike,
    unidade: string,
    batch: any[],
    forceUpsert = false
  ): Promise<number> {
    if (!batch.length) return 0;

    const leadIds = Array.from(
      new Set(
        batch
          .map((l) => toNullableBigInt(l?.id, false))
          .filter((id): id is number => id !== null)
      )
    );
    const batchLocationIds = Array.from(
      new Set(
        batch
          .map((l) => toNullableBigInt(l?.location?.id, false))
          .filter((id): id is number => id !== null)
      )
    );
    const batchTeamIds = Array.from(
      new Set(
        batch
          .flatMap((l) => [
            toNullableBigInt(l?.team?.id, false),
            toNullableBigInt(l?.contact?.team?.id, false),
          ])
          .filter((id): id is number => id !== null)
      )
    );

    const existingMap = new Map<number, number>();
    if (leadIds.length > 0) {
      const existingRes = await client.query(
        `SELECT id, updated_at, unidade FROM leads WHERE id = ANY($1::bigint[]);`,
        [leadIds]
      );
      const existingRows = Array.isArray(existingRes?.rows) ? existingRes.rows : [];
      const conflictingLeads: Array<{ id: number; existingUnidade: string }> = [];

      for (const row of existingRows) {
        const existingUnidade =
          typeof row.unidade === 'string' ? row.unidade.trim().toUpperCase() : null;
        if (existingUnidade && existingUnidade !== unidade) {
          conflictingLeads.push({ id: Number(row.id), existingUnidade });
          continue;
        }

        if (!forceUpsert) {
          const ms = normalizeTimestampMs(row.updated_at);
          if (ms !== null) {
            existingMap.set(Number(row.id), ms);
          }
        }
      }

      if (conflictingLeads.length > 0) {
        const conflictUnits = Array.from(new Set(conflictingLeads.map((c) => c.existingUnidade)));
        const sampleIds = conflictingLeads.slice(0, 5).map((c) => c.id);
        this.logger.error(
          { unidade, conflictingLeads: conflictingLeads.slice(0, 5) },
          'Bloqueio de segurança: tentativa de sobrescrever leads de outra unidade'
        );
        throw new AppError(
          409,
          `Bloqueio de segurança: o lote da unidade ${unidade} contém lead(s) pertencente(s) a outra unidade (${conflictUnits.join(', ')} — ex.: lead_id ${sampleIds.join(', ')}). Sincronização abortada sem alterar dados.`,
          'UNIT_OWNERSHIP_CONFLICT'
        );
      }
    }

    await this.assertMetadataOwnership(client, 'locations', 'loja(s)', batchLocationIds, unidade);
    await this.assertMetadataOwnership(client, 'teams', 'equipe(s)', batchTeamIds, unidade);

    const rawMap = new Map<number, { leadId: number; payloadJson: string }>();
    const attendantsMap = new Map<number, string | null>();
    const teamsMap = new Map<number, string | null>();
    const locationsMap = new Map<number, string | null>();
    const salesmenMap = new Map<number, string | null>();
    const contactsMap = new Map<
      number,
      {
        id: number;
        email: string | null;
        phone: string | null;
        cellphone: string | null;
        id_number: string | null;
        birthdate: string | null;
        attendant_id: number | null;
        team_id: number | null;
      }
    >();
    const addressesMap = new Map<
      number,
      {
        contact_id: number;
        address_line1: string | null;
        address_line2: string | null;
        address_number: string | null;
        neighborhood: string | null;
        city: string | null;
        state: string | null;
        country: string | null;
        zipcode: string | null;
      }
    >();
    const companiesMap = new Map<
      number,
      {
        contact_id: number;
        name: string | null;
        id_number: string | null;
        position: string | null;
        phone: string | null;
        email: string | null;
        website: string | null;
      }
    >();
    const leadsMap = new Map<
      number,
      {
        id: number;
        name: string | null;
        perception: string | null;
        status: string | null;
        conversion_goal: string | null;
        flow: string | null;
        message: string | null;
        integration_third_party_id: string | null;
        custom_key: string | null;
        fbclid: string | null;
        gclid: string | null;
        dsv_id: string | null;
        vehicle_price: string | null;
        contact_id: number | null;
        attendant_id: number | null;
        location_id: number | null;
        team_id: number | null;
        salesman_id: number | null;
        first_interaction_at: string | null;
        last_interaction_at: string | null;
        created_at: string | null;
        updated_at: string | null;
      }
    >();
    const interestsMap = new Map<
      string,
      {
        lead_id: number;
        level: string;
        item_id: number | null;
        name: string | null;
        required: string | null;
      }
    >();
    const scheduleReasonsMap = new Map<number, string | null>();
    const schedulesMap = new Map<
      number,
      {
        id: number;
        lead_id: number;
        date: string | null;
        status: string | null;
        reason_id: number | null;
      }
    >();
    const proposalsMap = new Map<
      number,
      {
        id: number;
        lead_id: number;
        amount: number | null;
      }
    >();
    const unrealizedReasonsMap = new Map<number, string | null>();
    const finalizationsMap = new Map<
      number,
      {
        id: number;
        lead_id: number;
        amount: number | null;
        type_of_sale: string | null;
        invoice_date: string | null;
        order_number: string | null;
        invoice_number: string | null;
        sale_id_number: string | null;
        card_number: string | null;
        message: string | null;
        unrealized_sale_reason_id: number | null;
      }
    >();
    const trackingMap = new Map<
      number,
      {
        lead_id: number;
        oem: string | null;
        source: string | null;
        medium: string | null;
        campaign: string | null;
        format: string | null;
      }
    >();
    const legalBasesMap = new Map<
      number,
      {
        lead_id: number;
        processing_id: number | null;
        processing_name: string | null;
        processing_opt_in: string | null;
        communication_id: number | null;
        communication_name: string | null;
        communication_opt_in: string | null;
      }
    >();

    let processedCount = 0;

    for (const lead of batch) {
      const leadId = toNullableBigInt(lead?.id, false);
      if (leadId === null) continue;

      if (!forceUpsert) {
        const currentDbMs = existingMap.get(leadId);
        const incomingMs = normalizeTimestampMs(lead.updated_at);
        if (currentDbMs !== undefined && incomingMs !== null && currentDbMs === incomingMs) {
          continue;
        }
      }

      processedCount++;

      // 1. Raw Payload
      rawMap.set(leadId, { leadId, payloadJson: JSON.stringify(lead) });

      // 2. Atendentes
      const att = lead.attendant;
      const attId = toNullableBigInt(att?.id, false);
      if (attId !== null) {
        attendantsMap.set(attId, toNullableString(att.name));
      }

      const contact = lead.contact || {};
      const cAtt = contact.attendant;
      const cAttId = toNullableBigInt(cAtt?.id, false);
      if (cAttId !== null) {
        attendantsMap.set(cAttId, toNullableString(cAtt.name));
      }

      // 3. Equipes
      const cTeam = contact.team;
      const cTeamId = toNullableBigInt(cTeam?.id, false);
      if (cTeamId !== null) {
        teamsMap.set(cTeamId, toNullableString(cTeam.name));
      }
      const lTeam = lead.team;
      const lTeamId = toNullableBigInt(lTeam?.id, false);
      if (lTeamId !== null) {
        teamsMap.set(lTeamId, toNullableString(lTeam.name));
      }

      // 4. Lojas / Unidades
      const loc = lead.location;
      const locId = toNullableBigInt(loc?.id, false);
      if (locId !== null) {
        locationsMap.set(locId, toNullableString(loc.name));
      }

      // 5. Vendedores
      const salesman = lead.salesman;
      const salesmanId = toNullableBigInt(salesman?.id, false);
      if (salesmanId !== null) {
        salesmenMap.set(salesmanId, toNullableString(salesman.name));
      }

      // 6. Contato, Endereço e Empresa
      const cId = toNullableBigInt(contact.id, false);
      if (cId !== null) {
        contactsMap.set(cId, {
          id: cId,
          email: toNullableString(contact.email),
          phone: toNullableString(contact.phone),
          cellphone: toNullableString(contact.cellphone),
          id_number: toNullableString(contact.id_number),
          birthdate: toNullableDate(contact.birthdate),
          attendant_id: cAttId,
          team_id: cTeamId,
        });

        const addr = contact.address || {};
        if (
          [
            addr.address_line1,
            addr.address_line2,
            addr.address_number,
            addr.neighborhood,
            addr.city,
            addr.state,
            addr.country,
            addr.zipcode,
          ].some(Boolean)
        ) {
          addressesMap.set(cId, {
            contact_id: cId,
            address_line1: toNullableString(addr.address_line1),
            address_line2: toNullableString(addr.address_line2),
            address_number: toNullableString(addr.address_number),
            neighborhood: toNullableString(addr.neighborhood),
            city: toNullableString(addr.city),
            state: toNullableString(addr.state),
            country: toNullableString(addr.country),
            zipcode: toNullableString(addr.zipcode),
          });
        }

        const comp = contact.company || {};
        if (
          [comp.name, comp.id_number, comp.position, comp.phone, comp.email, comp.website].some(
            Boolean
          )
        ) {
          companiesMap.set(cId, {
            contact_id: cId,
            name: toNullableString(comp.name),
            id_number: toNullableString(comp.id_number),
            position: toNullableString(comp.position),
            phone: toNullableString(comp.phone),
            email: toNullableString(comp.email),
            website: toNullableString(comp.website),
          });
        }
      }

      // 7. Lead Principal
      const ints = lead.interests && typeof lead.interests === 'object' ? lead.interests : null;
      const leadTeamId = toNullableBigInt(lead.team_id, false) ?? lTeamId ?? cTeamId;
      leadsMap.set(leadId, {
        id: leadId,
        name: toNullableString(lead.name),
        perception: toNullableString(lead.perception),
        status: toNullableString(lead.status),
        conversion_goal: toNullableString(lead.conversion_goal),
        flow: toNullableString(lead.flow),
        message: toNullableString(lead.message),
        integration_third_party_id: toNullableString(lead.integration_third_party_id),
        custom_key: toNullableString(lead.custom_key),
        fbclid: toNullableString(lead.fbclid),
        gclid: toNullableString(lead.gclid),
        dsv_id: toNullableString(lead.dsv_id ?? ints?.dsv_id),
        vehicle_price: toNullableString(lead.vehicle_price ?? ints?.vehicle_price),
        contact_id: cId,
        attendant_id: attId,
        location_id: locId,
        team_id: leadTeamId,
        salesman_id: salesmanId,
        first_interaction_at: toNullableTimestamp(lead.first_interaction_at),
        last_interaction_at: toNullableTimestamp(lead.last_interaction_at),
        created_at: toNullableTimestamp(lead.created_at),
        updated_at: toNullableTimestamp(lead.updated_at),
      });

      // 8. Interesses do Lead
      if (ints && !Array.isArray(ints)) {
        for (const key of Object.keys(ints).sort()) {
          if (!key.startsWith('interest_')) continue;
          const item = ints[key];
          if (item && typeof item === 'object' && (item.name || item.id !== undefined)) {
            const itemId = toNullableBigInt(item.id, true);
            const itemName = toNullableString(item.name);
            if (itemName !== null || itemId !== null) {
              interestsMap.set(`${leadId}:${key}`, {
                lead_id: leadId,
                level: key,
                item_id: itemId,
                name: itemName,
                required: toNullableString(item.required),
              });
            }
          }
        }
      }

      // 9. Agendamento
      const sched = lead.last_schedule;
      const schedId = toNullableBigInt(sched?.id, false);
      if (schedId !== null) {
        const reason = sched.reason;
        const reasonId = toNullableBigInt(reason?.id, false);
        if (reasonId !== null) {
          scheduleReasonsMap.set(reasonId, toNullableString(reason.name));
        }

        for (const [existingLeadId, existingSched] of schedulesMap.entries()) {
          if (existingSched.id === schedId && existingLeadId !== leadId) {
            schedulesMap.delete(existingLeadId);
          }
        }
        schedulesMap.set(leadId, {
          id: schedId,
          lead_id: leadId,
          date: toNullableTimestamp(sched.date),
          status: toNullableString(sched.status),
          reason_id: reasonId,
        });
      }

      // 10. Proposta
      const prop = lead.last_proposal;
      const propId = toNullableBigInt(prop?.id, false);
      if (propId !== null) {
        for (const [existingLeadId, existingProp] of proposalsMap.entries()) {
          if (existingProp.id === propId && existingLeadId !== leadId) {
            proposalsMap.delete(existingLeadId);
          }
        }
        proposalsMap.set(leadId, {
          id: propId,
          lead_id: leadId,
          amount: toNullableNumber(prop.amount),
        });
      }

      // 11. Finalização
      const fin = lead.finalization;
      const finId = toNullableBigInt(fin?.id, false);
      if (finId !== null) {
        const uReason = fin.unrealized_sale_reason;
        const uReasonId = toNullableBigInt(uReason?.id, false);
        if (uReasonId !== null) {
          unrealizedReasonsMap.set(uReasonId, toNullableString(uReason.name));
        }

        for (const [existingLeadId, existingFin] of finalizationsMap.entries()) {
          if (existingFin.id === finId && existingLeadId !== leadId) {
            finalizationsMap.delete(existingLeadId);
          }
        }
        finalizationsMap.set(leadId, {
          id: finId,
          lead_id: leadId,
          amount: toNullableNumber(fin.amount),
          type_of_sale: toNullableString(fin.type_of_sale),
          invoice_date: toNullableTimestamp(fin.invoice_date),
          order_number: toNullableString(fin.order_number),
          invoice_number: toNullableString(fin.invoice_number),
          sale_id_number: toNullableString(fin.sale_id_number),
          card_number: toNullableString(fin.card_number),
          message: toNullableString(fin.message),
          unrealized_sale_reason_id: uReasonId,
        });
      }

      // 12. Marketing Tracking
      const track = lead.tracking;
      if (track && typeof track === 'object' && !Array.isArray(track)) {
        trackingMap.set(leadId, {
          lead_id: leadId,
          oem: toNullableString(track.oem),
          source: toNullableString(track.source),
          medium: toNullableString(track.medium),
          campaign: toNullableString(track.campaign),
          format: toNullableString(track.format),
        });
      }

      // 13. Bases Legais LGPD
      const lb = lead.legal_bases;
      if (lb && typeof lb === 'object' && !Array.isArray(lb)) {
        const proc = lb.processing && typeof lb.processing === 'object' ? lb.processing : {};
        const comm =
          lb.communication && typeof lb.communication === 'object' ? lb.communication : {};
        legalBasesMap.set(leadId, {
          lead_id: leadId,
          processing_id: toNullableBigInt(proc.id, true),
          processing_name: toNullableString(proc.name),
          processing_opt_in:
            proc.opt_in !== null && proc.opt_in !== undefined
              ? String(proc.opt_in).toLowerCase()
              : null,
          communication_id: toNullableBigInt(comm.id, true),
          communication_name: toNullableString(comm.name),
          communication_opt_in:
            comm.opt_in !== null && comm.opt_in !== undefined
              ? String(comm.opt_in).toLowerCase()
              : null,
        });
      }
    }

    if (processedCount === 0) {
      return 0;
    }

    // Execução em Lote (UNNEST) respeitando ordem das chaves estrangeiras
    if (rawMap.size > 0) {
      const items = [...rawMap.values()];
      await client.query(
        `INSERT INTO leads_raw (lead_id, payload, unidade, synced_at)
         SELECT lead_id, payload, unidade, NOW()
         FROM UNNEST($1::bigint[], $2::jsonb[], $3::varchar[]) AS t(lead_id, payload, unidade)
         ON CONFLICT (lead_id) DO UPDATE SET
           payload = EXCLUDED.payload,
           synced_at = EXCLUDED.synced_at
         WHERE leads_raw.unidade = EXCLUDED.unidade;`,
        [
          items.map((i) => i.leadId),
          items.map((i) => i.payloadJson),
          items.map(() => unidade),
        ]
      );
    }

    if (attendantsMap.size > 0) {
      const entries = [...attendantsMap.entries()];
      await client.query(
        `INSERT INTO attendants (id, name)
         SELECT * FROM UNNEST($1::bigint[], $2::text[])
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;`,
        [entries.map(([id]) => id), entries.map(([, name]) => name)]
      );
    }

    if (teamsMap.size > 0) {
      const entries = [...teamsMap.entries()];
      await client.query(
        `INSERT INTO teams (id, name, unidade)
         SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::varchar[])
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name
         WHERE teams.unidade = EXCLUDED.unidade;`,
        [
          entries.map(([id]) => id),
          entries.map(([, name]) => name),
          entries.map(() => unidade),
        ]
      );
    }

    if (locationsMap.size > 0) {
      const entries = [...locationsMap.entries()];
      await client.query(
        `INSERT INTO locations (id, name, unidade)
         SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::varchar[])
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name
         WHERE locations.unidade = EXCLUDED.unidade;`,
        [
          entries.map(([id]) => id),
          entries.map(([, name]) => name),
          entries.map(() => unidade),
        ]
      );
    }

    if (salesmenMap.size > 0) {
      const entries = [...salesmenMap.entries()];
      await client.query(
        `INSERT INTO salesmen (id, name)
         SELECT * FROM UNNEST($1::bigint[], $2::text[])
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;`,
        [entries.map(([id]) => id), entries.map(([, name]) => name)]
      );
    }

    if (contactsMap.size > 0) {
      const items = [...contactsMap.values()];
      await client.query(
        `INSERT INTO contacts (id, email, phone, cellphone, id_number, birthdate, attendant_id, team_id)
         SELECT * FROM UNNEST(
           $1::bigint[], $2::text[], $3::text[], $4::text[],
           $5::text[], $6::date[], $7::bigint[], $8::bigint[]
         )
         ON CONFLICT (id) DO UPDATE SET
           email = EXCLUDED.email,
           phone = EXCLUDED.phone,
           cellphone = EXCLUDED.cellphone,
           id_number = EXCLUDED.id_number,
           birthdate = EXCLUDED.birthdate,
           attendant_id = EXCLUDED.attendant_id,
           team_id = EXCLUDED.team_id;`,
        [
          items.map((i) => i.id),
          items.map((i) => i.email),
          items.map((i) => i.phone),
          items.map((i) => i.cellphone),
          items.map((i) => i.id_number),
          items.map((i) => i.birthdate),
          items.map((i) => i.attendant_id),
          items.map((i) => i.team_id),
        ]
      );
    }

    if (addressesMap.size > 0) {
      const items = [...addressesMap.values()];
      await client.query(
        `INSERT INTO addresses (
           contact_id, address_line1, address_line2, address_number,
           neighborhood, city, state, country, zipcode
         )
         SELECT * FROM UNNEST(
           $1::bigint[], $2::text[], $3::text[], $4::text[],
           $5::text[], $6::text[], $7::text[], $8::text[], $9::text[]
         )
         ON CONFLICT (contact_id) DO UPDATE SET
           address_line1 = EXCLUDED.address_line1,
           address_line2 = EXCLUDED.address_line2,
           address_number = EXCLUDED.address_number,
           neighborhood = EXCLUDED.neighborhood,
           city = EXCLUDED.city,
           state = EXCLUDED.state,
           country = EXCLUDED.country,
           zipcode = EXCLUDED.zipcode;`,
        [
          items.map((i) => i.contact_id),
          items.map((i) => i.address_line1),
          items.map((i) => i.address_line2),
          items.map((i) => i.address_number),
          items.map((i) => i.neighborhood),
          items.map((i) => i.city),
          items.map((i) => i.state),
          items.map((i) => i.country),
          items.map((i) => i.zipcode),
        ]
      );
    }

    if (companiesMap.size > 0) {
      const items = [...companiesMap.values()];
      await client.query(
        `INSERT INTO companies (contact_id, name, id_number, position, phone, email, website)
         SELECT * FROM UNNEST(
           $1::bigint[], $2::text[], $3::text[], $4::text[],
           $5::text[], $6::text[], $7::text[]
         )
         ON CONFLICT (contact_id) DO UPDATE SET
           name = EXCLUDED.name,
           id_number = EXCLUDED.id_number,
           position = EXCLUDED.position,
           phone = EXCLUDED.phone,
           email = EXCLUDED.email,
           website = EXCLUDED.website;`,
        [
          items.map((i) => i.contact_id),
          items.map((i) => i.name),
          items.map((i) => i.id_number),
          items.map((i) => i.position),
          items.map((i) => i.phone),
          items.map((i) => i.email),
          items.map((i) => i.website),
        ]
      );
    }

    if (leadsMap.size > 0) {
      const items = [...leadsMap.values()];
      await client.query(
        `INSERT INTO leads (
           id, name, perception, status, conversion_goal, flow, message,
           integration_third_party_id, custom_key, fbclid, gclid, dsv_id,
           vehicle_price, contact_id, attendant_id, location_id, team_id,
           salesman_id, first_interaction_at, last_interaction_at, created_at, updated_at, unidade
         )
         SELECT * FROM UNNEST(
           $1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
           $8::text[], $9::text[], $10::text[], $11::text[], $12::text[],
           $13::text[], $14::bigint[], $15::bigint[], $16::bigint[], $17::bigint[],
           $18::bigint[], $19::timestamptz[], $20::timestamptz[], $21::timestamptz[], $22::timestamptz[], $23::varchar[]
         )
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           perception = EXCLUDED.perception,
           status = EXCLUDED.status,
           conversion_goal = EXCLUDED.conversion_goal,
           flow = EXCLUDED.flow,
           message = EXCLUDED.message,
           integration_third_party_id = EXCLUDED.integration_third_party_id,
           custom_key = EXCLUDED.custom_key,
           fbclid = EXCLUDED.fbclid,
           gclid = EXCLUDED.gclid,
           dsv_id = EXCLUDED.dsv_id,
           vehicle_price = EXCLUDED.vehicle_price,
           contact_id = EXCLUDED.contact_id,
           attendant_id = EXCLUDED.attendant_id,
           location_id = EXCLUDED.location_id,
           team_id = EXCLUDED.team_id,
           salesman_id = EXCLUDED.salesman_id,
           first_interaction_at = EXCLUDED.first_interaction_at,
           last_interaction_at = EXCLUDED.last_interaction_at,
           created_at = COALESCE(EXCLUDED.created_at, leads.created_at),
           updated_at = EXCLUDED.updated_at
         WHERE leads.unidade = EXCLUDED.unidade;`,
        [
          items.map((i) => i.id),
          items.map((i) => i.name),
          items.map((i) => i.perception),
          items.map((i) => i.status),
          items.map((i) => i.conversion_goal),
          items.map((i) => i.flow),
          items.map((i) => i.message),
          items.map((i) => i.integration_third_party_id),
          items.map((i) => i.custom_key),
          items.map((i) => i.fbclid),
          items.map((i) => i.gclid),
          items.map((i) => i.dsv_id),
          items.map((i) => i.vehicle_price),
          items.map((i) => i.contact_id),
          items.map((i) => i.attendant_id),
          items.map((i) => i.location_id),
          items.map((i) => i.team_id),
          items.map((i) => i.salesman_id),
          items.map((i) => i.first_interaction_at),
          items.map((i) => i.last_interaction_at),
          items.map((i) => i.created_at),
          items.map((i) => i.updated_at),
          items.map(() => unidade),
        ]
      );
    }

    if (interestsMap.size > 0) {
      const items = [...interestsMap.values()];
      await client.query(
        `INSERT INTO lead_interests (lead_id, level, item_id, name, required)
         SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::bigint[], $4::text[], $5::text[])
         ON CONFLICT (lead_id, level) DO UPDATE SET
           item_id = EXCLUDED.item_id,
           name = EXCLUDED.name,
           required = EXCLUDED.required;`,
        [
          items.map((i) => i.lead_id),
          items.map((i) => i.level),
          items.map((i) => i.item_id),
          items.map((i) => i.name),
          items.map((i) => i.required),
        ]
      );
    }

    if (scheduleReasonsMap.size > 0) {
      const entries = [...scheduleReasonsMap.entries()];
      await client.query(
        `INSERT INTO schedule_reasons (id, name)
         SELECT * FROM UNNEST($1::bigint[], $2::text[])
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;`,
        [entries.map(([id]) => id), entries.map(([, name]) => name)]
      );
    }

    if (schedulesMap.size > 0) {
      const items = [...schedulesMap.values()];
      await client.query(
        `INSERT INTO last_schedule (id, lead_id, date, status, reason_id)
         SELECT * FROM UNNEST($1::bigint[], $2::bigint[], $3::timestamptz[], $4::text[], $5::bigint[])
         ON CONFLICT (lead_id) DO UPDATE SET
           id = EXCLUDED.id,
           date = EXCLUDED.date,
           status = EXCLUDED.status,
           reason_id = EXCLUDED.reason_id;`,
        [
          items.map((i) => i.id),
          items.map((i) => i.lead_id),
          items.map((i) => i.date),
          items.map((i) => i.status),
          items.map((i) => i.reason_id),
        ]
      );
    }

    if (proposalsMap.size > 0) {
      const items = [...proposalsMap.values()];
      await client.query(
        `INSERT INTO last_proposal (id, lead_id, amount)
         SELECT * FROM UNNEST($1::bigint[], $2::bigint[], $3::numeric[])
         ON CONFLICT (lead_id) DO UPDATE SET
           id = EXCLUDED.id,
           amount = EXCLUDED.amount;`,
        [items.map((i) => i.id), items.map((i) => i.lead_id), items.map((i) => i.amount)]
      );
    }

    if (unrealizedReasonsMap.size > 0) {
      const entries = [...unrealizedReasonsMap.entries()];
      await client.query(
        `INSERT INTO unrealized_sale_reasons (id, name)
         SELECT * FROM UNNEST($1::bigint[], $2::text[])
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;`,
        [entries.map(([id]) => id), entries.map(([, name]) => name)]
      );
    }

    if (finalizationsMap.size > 0) {
      const items = [...finalizationsMap.values()];
      await client.query(
        `INSERT INTO finalization (
           id, lead_id, amount, type_of_sale, invoice_date, order_number,
           invoice_number, sale_id_number, card_number, message, unrealized_sale_reason_id
         )
         SELECT * FROM UNNEST(
           $1::bigint[], $2::bigint[], $3::numeric[], $4::text[], $5::timestamptz[],
           $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::bigint[]
         )
         ON CONFLICT (lead_id) DO UPDATE SET
           id = EXCLUDED.id,
           amount = EXCLUDED.amount,
           type_of_sale = EXCLUDED.type_of_sale,
           invoice_date = EXCLUDED.invoice_date,
           order_number = EXCLUDED.order_number,
           invoice_number = EXCLUDED.invoice_number,
           sale_id_number = EXCLUDED.sale_id_number,
           card_number = EXCLUDED.card_number,
           message = EXCLUDED.message,
           unrealized_sale_reason_id = EXCLUDED.unrealized_sale_reason_id;`,
        [
          items.map((i) => i.id),
          items.map((i) => i.lead_id),
          items.map((i) => i.amount),
          items.map((i) => i.type_of_sale),
          items.map((i) => i.invoice_date),
          items.map((i) => i.order_number),
          items.map((i) => i.invoice_number),
          items.map((i) => i.sale_id_number),
          items.map((i) => i.card_number),
          items.map((i) => i.message),
          items.map((i) => i.unrealized_sale_reason_id),
        ]
      );
    }

    if (trackingMap.size > 0) {
      const items = [...trackingMap.values()];
      await client.query(
        `INSERT INTO tracking (lead_id, oem, source, medium, campaign, format)
         SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
         ON CONFLICT (lead_id) DO UPDATE SET
           oem = EXCLUDED.oem,
           source = EXCLUDED.source,
           medium = EXCLUDED.medium,
           campaign = EXCLUDED.campaign,
           format = EXCLUDED.format;`,
        [
          items.map((i) => i.lead_id),
          items.map((i) => i.oem),
          items.map((i) => i.source),
          items.map((i) => i.medium),
          items.map((i) => i.campaign),
          items.map((i) => i.format),
        ]
      );
    }

    if (legalBasesMap.size > 0) {
      const items = [...legalBasesMap.values()];
      await client.query(
        `INSERT INTO legal_bases (
           lead_id, processing_id, processing_name, processing_opt_in,
           communication_id, communication_name, communication_opt_in
         )
         SELECT * FROM UNNEST(
           $1::bigint[], $2::bigint[], $3::text[], $4::text[],
           $5::bigint[], $6::text[], $7::text[]
         )
         ON CONFLICT (lead_id) DO UPDATE SET
           processing_id = EXCLUDED.processing_id,
           processing_name = EXCLUDED.processing_name,
           processing_opt_in = EXCLUDED.processing_opt_in,
           communication_id = EXCLUDED.communication_id,
           communication_name = EXCLUDED.communication_name,
           communication_opt_in = EXCLUDED.communication_opt_in;`,
        [
          items.map((i) => i.lead_id),
          items.map((i) => i.processing_id),
          items.map((i) => i.processing_name),
          items.map((i) => i.processing_opt_in),
          items.map((i) => i.communication_id),
          items.map((i) => i.communication_name),
          items.map((i) => i.communication_opt_in),
        ]
      );
    }

    return processedCount;
  }
}

export const syncService = new SyncService();
