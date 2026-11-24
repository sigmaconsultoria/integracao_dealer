import type { FastifyPluginAsync } from 'fastify';
import { pool } from './config/database.js';
import { env } from './config/env.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { leadsRoutes } from './modules/leads/leads.routes.js';
import { createApiKeyAuthHook } from './plugins/auth.js';
import { authService } from './services/auth.service.js';

export interface ReadinessCheckResult {
  ready: boolean;
  checks: {
    database: 'ok' | 'error';
    followize_config: 'ok' | 'error';
  };
}

export interface AppRoutesOptions {
  apiKeys?: string[];
  rateLimitMax?: number;
  readinessCheck?: () => Promise<ReadinessCheckResult>;
}

export async function defaultReadinessCheck(): Promise<ReadinessCheckResult> {
  let dbStatus: 'ok' | 'error' = 'error';
  try {
    await pool.query('SELECT 1');
    dbStatus = 'ok';
  } catch {
    dbStatus = 'error';
  }

  let hasRefreshToken = false;
  try {
    hasRefreshToken = (await authService.getTokenStatus()).has_refresh_token;
  } catch {
    hasRefreshToken = false;
  }

  const followizeConfigured =
    Boolean(env.FOLLOWIZE_CLIENT_ID) &&
    Boolean(env.FOLLOWIZE_CLIENT_SECRET) &&
    hasRefreshToken;

  const followizeConfigStatus: 'ok' | 'error' = followizeConfigured ? 'ok' : 'error';

  return {
    ready: dbStatus === 'ok' && followizeConfigStatus === 'ok',
    checks: {
      database: dbStatus,
      followize_config: followizeConfigStatus,
    },
  };
}

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

  // Readiness check (público — verifica conectividade DB e config Followize sem vazar detalhes)
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
      if (!result.ready) {
        request.log.warn({ checks: result.checks }, 'Readiness check failed');
        return reply.status(503).send({
          status: 'not_ready',
          checks: result.checks,
        });
      }

      return {
        status: 'ready',
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
