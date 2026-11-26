import type { FastifyPluginAsync } from 'fastify';
import { pool } from './config/database.js';
import { env, type FollowizeUnitConfig } from './config/env.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import type { DbPoolLike } from './modules/leads/leads.service.js';
import { leadsRoutes } from './modules/leads/leads.routes.js';
import { createApiKeyAuthHook } from './plugins/auth.js';
import { authManager as defaultAuthManager, type AuthManagerLike } from './services/auth.service.js';

export interface UnitReadinessStatus {
  status: 'ok' | 'error';
  has_refresh_token: boolean;
  has_valid_access_token: boolean;
}

export interface ReadinessCheckResult {
  status: 'ready' | 'degraded' | 'not_ready';
  checks: {
    database: 'ok' | 'error';
    followize_config: 'ok' | 'degraded' | 'error';
    followize_units: Record<string, UnitReadinessStatus>;
  };
}

export interface AppRoutesOptions {
  apiKeys?: string[];
  rateLimitMax?: number;
  readinessCheck?: () => Promise<ReadinessCheckResult>;
}

export function createReadinessCheck(deps: {
  db: Pick<DbPoolLike, 'query'>;
  authManager: Pick<AuthManagerLike, 'getTokenStatus'>;
  clients: Record<string, FollowizeUnitConfig>;
}): () => Promise<ReadinessCheckResult> {
  return async (): Promise<ReadinessCheckResult> => {
    let dbStatus: 'ok' | 'error' = 'error';
    try {
      await deps.db.query('SELECT 1');
      dbStatus = 'ok';
    } catch {
      dbStatus = 'error';
    }

    const units = Object.keys(deps.clients);
    const followizeUnits: Record<string, UnitReadinessStatus> = {};

    await Promise.all(
      units.map(async (unit) => {
        const cfg = deps.clients[unit];
        const hasCredentials = Boolean(cfg?.clientId) && Boolean(cfg?.clientSecret);
        let hasRefreshToken = false;
        let hasValidAccessToken = false;

        try {
          const tokenStatus = await deps.authManager.getTokenStatus(unit);
          hasRefreshToken = tokenStatus.has_refresh_token;
          hasValidAccessToken = tokenStatus.has_valid_access_token;
        } catch {
          hasRefreshToken = false;
          hasValidAccessToken = false;
        }

        followizeUnits[unit] = {
          status: hasCredentials && hasRefreshToken ? 'ok' : 'error',
          has_refresh_token: hasRefreshToken,
          has_valid_access_token: hasValidAccessToken,
        };
      })
    );

    const totalUnits = units.length;
    const okUnitsCount = Object.values(followizeUnits).filter((u) => u.status === 'ok').length;

    let followizeConfigStatus: 'ok' | 'degraded' | 'error';
    if (totalUnits > 0 && okUnitsCount === totalUnits) {
      followizeConfigStatus = 'ok';
    } else if (okUnitsCount > 0) {
      followizeConfigStatus = 'degraded';
    } else {
      followizeConfigStatus = 'error';
    }

    let overallStatus: 'ready' | 'degraded' | 'not_ready';
    if (dbStatus === 'error' || okUnitsCount === 0) {
      overallStatus = 'not_ready';
    } else if (okUnitsCount === totalUnits) {
      overallStatus = 'ready';
    } else {
      overallStatus = 'degraded';
    }

    return {
      status: overallStatus,
      checks: {
        database: dbStatus,
        followize_config: followizeConfigStatus,
        followize_units: followizeUnits,
      },
    };
  };
}

export const defaultReadinessCheck = createReadinessCheck({
  db: pool,
  authManager: defaultAuthManager,
  clients: env.FOLLOWIZE_CLIENTS,
});

export const appRoutes: FastifyPluginAsync<AppRoutesOptions> = async (app, options) => {
  const apiKeys = options.apiKeys ?? env.VALID_API_KEYS;
  const globalMax = options.rateLimitMax ?? env.RATE_LIMIT_MAX;
  const runReadinessCheck = options.readinessCheck ?? defaultReadinessCheck;

  // Liveness check básico (público)
  app.get(
    '/health',
    {
      config: {
        rateLimit: {
          max: Math.min(30, globalMax),
          timeWindow: '1 minute',
        },
      },
    },
    async () => {
      return {
        status: 'ok',
        uptime_seconds: Math.floor(process.uptime()),
      };
    }
  );

  // Readiness check (público — verifica conectividade DB e status separado por unidade Followize)
  app.get(
    '/ready',
    {
      config: {
        rateLimit: {
          max: Math.min(15, globalMax),
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const result = await runReadinessCheck();

      if (result.status === 'not_ready') {
        request.log.warn({ checks: result.checks }, 'Readiness check failed');
        return reply.status(503).send({
          status: 'not_ready',
          checks: result.checks,
        });
      }

      if (result.status === 'degraded') {
        request.log.warn({ checks: result.checks }, 'Readiness check degraded');
      }

      return {
        status: result.status,
        checks: result.checks,
      };
    }
  );

  // Módulo de Leads (protegido por API Key antes do parsing de body)
  app.register(
    async (protectedApp) => {
      protectedApp.addHook('onRequest', createApiKeyAuthHook(apiKeys));
      protectedApp.register(leadsRoutes, { rateLimitMax: globalMax });
    },
    { prefix: '/leads' }
  );

  // Módulo de Autenticação Followize (protegido por API Key antes do parsing de body)
  app.register(
    async (protectedApp) => {
      protectedApp.addHook('onRequest', createApiKeyAuthHook(apiKeys));
      protectedApp.register(authRoutes, { rateLimitMax: globalMax });
    },
    { prefix: '/auth' }
  );
};
