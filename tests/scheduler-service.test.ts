import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { AppError } from '../src/errors/app-error.js';
import { SyncScheduler } from '../src/services/scheduler.service.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('SyncScheduler (cron scheduling, multi-unit summary, and lifecycle)', () => {
  const schedulersToStop: SyncScheduler[] = [];

  afterEach(() => {
    while (schedulersToStop.length > 0) {
      schedulersToStop.pop()?.stop();
    }
  });

  it('does not create jobs when disabled', () => {
    const scheduler = new SyncScheduler({
      enabled: false,
      schedules: ['0 8,12,18 * * 1-5'],
      timezone: 'America/Sao_Paulo',
      runSync: async () => {
        throw new Error('should not run');
      },
      logger: silentLogger,
    });
    schedulersToStop.push(scheduler);

    scheduler.start();
    const status = scheduler.getStatus();

    assert.equal(status.enabled, false);
    assert.equal(status.active, false);
    assert.deepEqual(status.next_runs, []);
    assert.equal(status.last_status, 'idle');
  });

  it('registers multiple cron schedules with timezone and stops cleanly', () => {
    const scheduler = new SyncScheduler({
      enabled: true,
      schedules: ['0 8,12,18 * * 1-5', '30 20 * * *'],
      timezone: 'America/Sao_Paulo',
      runSync: async () => ({
        success: true,
        startDate: '2026-11-24 00:00:00',
        totalSynced: 0,
        pagesProcessed: 0,
        resumedFromPending: false,
        durationSeconds: 0,
        message: 'ok',
        units: {
          MT: {
            unidade: 'MT',
            success: true,
            startDate: '2026-11-24 00:00:00',
            totalSynced: 0,
            pagesProcessed: 0,
            resumedFromPending: false,
            durationSeconds: 0,
            message: 'ok',
          },
        },
      }),
      logger: silentLogger,
    });
    schedulersToStop.push(scheduler);

    scheduler.start();
    scheduler.start();

    const activeStatus = scheduler.getStatus();
    assert.equal(activeStatus.enabled, true);
    assert.equal(activeStatus.active, true);
    assert.equal(activeStatus.timezone, 'America/Sao_Paulo');
    assert.equal(activeStatus.next_runs.length, 2);
    for (const iso of activeStatus.next_runs) {
      assert.equal(Number.isNaN(Date.parse(iso)), false);
    }

    scheduler.stop();
    const stoppedStatus = scheduler.getStatus();
    assert.equal(stoppedStatus.active, false);
    assert.deepEqual(stoppedStatus.next_runs, []);
  });

  it('records success, partial_failure, skipped (SYNC_IN_PROGRESS), and error states safely across multi-unit runs', async () => {
    let mode: 'success' | 'partial' | 'skip' | 'error' = 'success';
    const loggedWarnings: Array<Record<string, unknown>> = [];
    const loggedInfos: Array<Record<string, unknown>> = [];

    const scheduler = new SyncScheduler({
      enabled: false,
      schedules: ['0 8 * * *'],
      timezone: 'America/Sao_Paulo',
      runSync: async () => {
        if (mode === 'skip') {
          throw new AppError(409, 'Sincronização já está em andamento', 'SYNC_IN_PROGRESS');
        }
        if (mode === 'error') {
          throw new Error('Erro simulado de rede');
        }
        if (mode === 'partial') {
          return {
            success: true,
            partial_failure: true,
            startDate: '2026-11-24 08:00:00',
            totalSynced: 7,
            pagesProcessed: 2,
            resumedFromPending: false,
            durationSeconds: 3,
            message: 'Falha parcial em PA',
            units: {
              MT: {
                unidade: 'MT',
                success: true,
                startDate: '2026-11-24 08:00:00',
                totalSynced: 5,
                pagesProcessed: 1,
                resumedFromPending: false,
                durationSeconds: 1,
                message: 'ok',
              },
              PA: {
                unidade: 'PA',
                success: false,
                startDate: '2026-11-24 08:00:00',
                totalSynced: 0,
                pagesProcessed: 0,
                resumedFromPending: false,
                durationSeconds: 1,
                message: 'falha',
                error: 'HTTP 401',
              },
              AP: {
                unidade: 'AP',
                success: true,
                startDate: '2026-11-24 08:00:00',
                totalSynced: 2,
                pagesProcessed: 1,
                resumedFromPending: false,
                durationSeconds: 1,
                message: 'ok',
              },
            },
          };
        }

        return {
          success: true,
          startDate: '2026-11-24 08:00:00',
          totalSynced: 12,
          pagesProcessed: 2,
          resumedFromPending: false,
          durationSeconds: 2,
          message: 'ok',
          units: {
            MT: {
              unidade: 'MT',
              success: true,
              startDate: '2026-11-24 08:00:00',
              totalSynced: 8,
              pagesProcessed: 1,
              resumedFromPending: false,
              durationSeconds: 1,
              message: 'ok',
            },
            PA: {
              unidade: 'PA',
              success: true,
              startDate: '2026-11-24 08:00:00',
              totalSynced: 4,
              pagesProcessed: 1,
              resumedFromPending: false,
              durationSeconds: 1,
              message: 'ok',
            },
          },
        };
      },
      logger: {
        info: (obj: any) => {
          if (obj && typeof obj === 'object') loggedInfos.push(obj);
        },
        warn: (obj: any) => {
          if (obj && typeof obj === 'object') loggedWarnings.push(obj);
        },
        error: () => undefined,
      },
    });

    await scheduler.executeScheduledRun('0 8 * * *');
    let status = scheduler.getStatus();
    assert.equal(status.last_status, 'success');
    assert.equal(status.last_result?.totalSynced, 12);
    assert.equal(status.last_error, null);
    assert.ok((loggedInfos[0]?.units as Record<string, unknown>)?.MT);

    mode = 'partial';
    await scheduler.executeScheduledRun('0 10 * * *');
    status = scheduler.getStatus();
    assert.equal(status.last_status, 'partial_failure');
    assert.equal(status.last_result?.totalSynced, 7);
    assert.ok(status.last_error?.includes('PA: HTTP 401'));
    assert.equal(loggedWarnings.length, 1);

    mode = 'skip';
    await scheduler.executeScheduledRun('0 12 * * *');
    status = scheduler.getStatus();
    assert.equal(status.last_status, 'skipped');
    assert.equal(status.last_trigger, '0 12 * * *');

    mode = 'error';
    await scheduler.executeScheduledRun('0 18 * * *');
    status = scheduler.getStatus();
    assert.equal(status.last_status, 'error');
    assert.equal(status.last_error, 'Erro simulado de rede');

    // Próximo agendamento após erro continua funcionando normalmente
    mode = 'success';
    await scheduler.executeScheduledRun('0 20 * * *');
    status = scheduler.getStatus();
    assert.equal(status.last_status, 'success');
    assert.equal(status.last_error, null);
  });
});
