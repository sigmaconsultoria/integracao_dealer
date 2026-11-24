import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { AppError } from '../src/errors/app-error.js';
import { SyncScheduler } from '../src/services/scheduler.service.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('SyncScheduler (cron scheduling and lifecycle)', () => {
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
      }),
      logger: silentLogger,
    });
    schedulersToStop.push(scheduler);

    scheduler.start();
    // Calling start() twice is idempotent
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

  it('records success, skipped (SYNC_IN_PROGRESS), and error states safely in executeScheduledRun', async () => {
    let mode: 'success' | 'skip' | 'error' = 'success';

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
        return {
          success: true,
          startDate: '2026-11-24 08:00:00',
          totalSynced: 12,
          pagesProcessed: 1,
          resumedFromPending: false,
          durationSeconds: 2,
          message: 'ok',
        };
      },
      logger: silentLogger,
    });

    await scheduler.executeScheduledRun('0 8 * * *');
    let status = scheduler.getStatus();
    assert.equal(status.last_status, 'success');
    assert.equal(status.last_result?.totalSynced, 12);
    assert.equal(status.last_error, null);

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
  });
});
