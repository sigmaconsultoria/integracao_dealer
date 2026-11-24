import { createHash } from 'node:crypto';
import fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError, z } from 'zod';
import { env } from './config/env.js';
import { createLogger } from './config/logger.js';
import { AppError } from './errors/app-error.js';
import { extractApiKey } from './plugins/auth.js';
import { appRoutes, type ReadinessCheckResult } from './routes.js';

export interface BuildAppOptions {
  logger?: boolean;
  apiKeys?: string[];
  corsOrigins?: string[];
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  nodeEnv?: 'development' | 'production' | 'test';
  trustProxy?: boolean | string;
  readinessCheck?: () => Promise<ReadinessCheckResult>;
}

export function buildApp(options: BuildAppOptions = {}) {
  const nodeEnv = options.nodeEnv ?? env.NODE_ENV;
  const corsOrigins = options.corsOrigins ?? env.CORS_ORIGINS;
  const apiKeys = options.apiKeys ?? env.VALID_API_KEYS;
  const rateLimitMax = options.rateLimitMax ?? env.RATE_LIMIT_MAX;
  const rateLimitWindowMs = options.rateLimitWindowMs ?? env.RATE_LIMIT_WINDOW_MS;
  const trustProxy = options.trustProxy ?? env.TRUST_PROXY;
  const loggerEnabled = options.logger ?? true;

  if (nodeEnv === 'production' && corsOrigins.includes('*')) {
    throw new Error('CORS_ORIGIN="*" não é permitido quando NODE_ENV=production');
  }

  const app = fastify({
    trustProxy,
    bodyLimit: 256 * 1024,
    ...(loggerEnabled ? { loggerInstance: createLogger() } : { logger: false }),
  });

  app.register(helmet, {
    global: true,
    contentSecurityPolicy: false,
  });

  app.register(cors, {
    origin:
      corsOrigins.length === 0
        ? false
        : corsOrigins.includes('*')
          ? '*'
          : corsOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  });

  app.register(rateLimit, {
    global: true,
    max: rateLimitMax,
    timeWindow: rateLimitWindowMs,
    keyGenerator: (request) => {
      const apiKey = extractApiKey(request.headers);
      if (apiKey) {
        const keyFingerprint = createHash('sha256')
          .update(apiKey, 'utf8')
          .digest('hex')
          .slice(0, 16);
        return `key:${keyFingerprint}`;
      }
      return `ip:${request.ip}`;
    },
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send({
      success: false,
      error: 'Rota não encontrada',
    });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        success: false,
        error: 'Dados de entrada inválidos',
        details: z.flattenError(error).fieldErrors,
      });
    }

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        success: false,
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
      });
    }

    const fastifyErr = error as FastifyError;
    const statusCode = fastifyErr?.statusCode;
    const message = fastifyErr?.message || 'Requisição inválida';

    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({
        success: false,
        error: message,
      });
    }

    request.log.error(error);
    return reply.status(500).send({
      success: false,
      error: 'Erro interno do servidor',
    });
  });

  app.register(appRoutes, {
    apiKeys,
    rateLimitMax,
    readinessCheck: options.readinessCheck,
  });

  return app;
}
