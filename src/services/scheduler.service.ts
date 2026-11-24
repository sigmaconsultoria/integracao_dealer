import { Cron } from 'croner';
import { env } from '../config/env.js';
import { logger as defaultLogger, type AppLogger } from '../config/logger.js';
import { AppError } from '../errors/app-error.js';
import { syncService, type SyncResult } from './sync.service.js';

export interface SyncSchedulerDeps {
  enabled?: boolean;
  schedules?: string[];
  timezone?: string;
  runSync?: () => Promise<SyncResult>;
  logger?: AppLogger;
}

export interface SyncSchedulerStatus {
  enabled: boolean;
  active: boolean;
  timezone: string;
  schedules: string[];
  next_runs: string[];
  last_run_at: string | null;
  last_status: 'idle' | 'running' | 'success' | 'skipped' | 'error';
  last_trigger: string | null;
  last_result: SyncResult | null;
  last_error: string | null;
}

export class SyncScheduler {
  private readonly enabled: boolean;
  private readonly schedules: string[];
  private readonly timezone: string;
  private readonly runSync: () => Promise<SyncResult>;
  private readonly logger: AppLogger;

  private jobs: Cron[] = [];
  private lastRunAt: string | null = null;
  private lastStatus: 'idle' | 'running' | 'success' | 'skipped' | 'error' = 'idle';
  private lastTrigger: string | null = null;
  private lastResult: SyncResult | null = null;
  private lastError: string | null = null;

  constructor(deps: SyncSchedulerDeps = {}) {
    this.enabled = deps.enabled ?? env.SYNC_CRON_ENABLED;
    this.schedules = deps.schedules ?? env.SYNC_CRON_SCHEDULES;
    this.timezone = deps.timezone ?? env.SYNC_CRON_TIMEZONE;
    this.runSync = deps.runSync ?? (() => syncService.syncLeads());
    this.logger = deps.logger ?? defaultLogger;
  }

  private getNextRuns(): string[] {
    return this.jobs
      .map((job) => job.nextRun())
      .filter((dt): dt is Date => dt instanceof Date)
      .map((dt) => dt.toISOString());
  }

  start(): void {
    if (!this.enabled) {
      this.logger.info({ enabled: false }, 'Agendador cron de sincronização desativado');
      return;
    }

    if (this.jobs.length > 0) {
      return;
    }

    for (const expression of this.schedules) {
      const job = new Cron(
        expression,
        {
          timezone: this.timezone,
          protect: true,
          catch: (err) => {
            this.logger.error(
              { err: err instanceof Error ? err.message : String(err), expression },
              'Erro inesperado no agendador cron'
            );
          },
        },
        () => void this.executeScheduledRun(expression)
      );
      this.jobs.push(job);
    }

    this.logger.info(
      {
        schedules: this.schedules,
        timezone: this.timezone,
        nextRuns: this.getNextRuns(),
      },
      'Agendador cron de sincronização iniciado'
    );
  }

  async executeScheduledRun(triggerExpression: string): Promise<void> {
    this.lastRunAt = new Date().toISOString();
    this.lastTrigger = triggerExpression;
    this.lastStatus = 'running';

    try {
      const result = await this.runSync();
      this.lastStatus = 'success';
      this.lastResult = result;
      this.lastError = null;
      this.logger.info(
        {
          triggerExpression,
          totalSynced: result.totalSynced,
          pagesProcessed: result.pagesProcessed,
          durationSeconds: result.durationSeconds,
        },
        'Sincronização agendada concluída'
      );
    } catch (err) {
      if (err instanceof AppError && err.code === 'SYNC_IN_PROGRESS') {
        this.lastStatus = 'skipped';
        this.logger.info(
          { triggerExpression },
          'Sincronização agendada ignorada porque já há outra em andamento'
        );
        return;
      }

      this.lastStatus = 'error';
      this.lastError =
        err instanceof Error ? err.message : 'Erro desconhecido na sincronização agendada';
      this.logger.error(
        { triggerExpression, err: this.lastError },
        'Falha na sincronização agendada'
      );
    }
  }

  stop(): void {
    for (const job of this.jobs) {
      job.stop();
    }
    this.jobs = [];
  }

  getStatus(): SyncSchedulerStatus {
    return {
      enabled: this.enabled,
      active: this.jobs.length > 0,
      timezone: this.timezone,
      schedules: [...this.schedules],
      next_runs: this.getNextRuns(),
      last_run_at: this.lastRunAt,
      last_status: this.lastStatus,
      last_trigger: this.lastTrigger,
      last_result: this.lastResult,
      last_error: this.lastError,
    };
  }
}

export const syncScheduler = new SyncScheduler();
