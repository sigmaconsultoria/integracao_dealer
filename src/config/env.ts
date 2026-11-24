import { Cron } from 'croner';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

function envBoolean(defaultValue: boolean) {
  return z.preprocess((val) => {
    if (val === undefined || val === null) return defaultValue;
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') {
      const normalized = val.trim().toLowerCase();
      if (normalized === '') return defaultValue;
      if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
      if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
    }
    return val;
  }, z.boolean());
}

const envTrustProxy = z.preprocess(
  (val) => {
    if (val === undefined || val === null) return false;
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (trimmed === '') return false;
      const lower = trimmed.toLowerCase();
      if (lower === 'true') return true;
      if (lower === 'false') return false;
      return trimmed;
    }
    return val;
  },
  z.union([z.boolean(), z.string().trim().min(1)])
);

function parseCorsOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function parseCronSchedules(raw: string): string[] {
  return raw
    .split(';')
    .map((expr) => expr.trim())
    .filter(Boolean);
}

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    HOST: z.string().trim().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3333),
    TRUST_PROXY: envTrustProxy,

    API_KEY: z.string().trim().min(32, 'API_KEY deve ter no mínimo 32 caracteres'),
    API_KEY_PREVIOUS: z.preprocess(
      (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
      z.string().trim().min(32, 'API_KEY_PREVIOUS deve ter no mínimo 32 caracteres').optional()
    ),
    CORS_ORIGIN: z.string().default(''),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10000).default(60),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(3600000).default(60000),

    DB_HOST: z.string().trim().min(1, 'DB_HOST é obrigatório'),
    DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
    DB_NAME: z.string().trim().min(1, 'DB_NAME é obrigatório'),
    DB_USER: z.string().trim().min(1, 'DB_USER é obrigatório'),
    DB_PASSWORD: z.string().min(1, 'DB_PASSWORD é obrigatório'),
    DB_SSL: envBoolean(false),

    FOLLOWIZE_CLIENT_ID: z.string().trim().min(1, 'FOLLOWIZE_CLIENT_ID é obrigatório'),
    FOLLOWIZE_CLIENT_SECRET: z.string().trim().min(1, 'FOLLOWIZE_CLIENT_SECRET é obrigatório'),
    FOLLOWIZE_REFRESH_TOKEN: z.preprocess(
      (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
      z.string().trim().min(1).optional()
    ),
    FOLLOWIZE_TOKEN_CACHE_PATH: z.string().trim().min(1).default('.runtime/followize-token.json'),
    FOLLOWIZE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),

    SYNC_CRON_ENABLED: envBoolean(false),
    SYNC_CRON_SCHEDULE: z.string().trim().default('0 8,12,15,18 * * 1-5'),
    SYNC_CRON_TIMEZONE: z.string().trim().min(1).default('America/Sao_Paulo'),
  })
  .superRefine((data, ctx) => {
    const origins = parseCorsOrigins(data.CORS_ORIGIN);
    if (data.NODE_ENV === 'production' && origins.includes('*')) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGIN'],
        message: 'CORS_ORIGIN="*" não é permitido quando NODE_ENV=production',
      });
    }

    let timezoneValid = true;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: data.SYNC_CRON_TIMEZONE });
    } catch {
      timezoneValid = false;
      ctx.addIssue({
        code: 'custom',
        path: ['SYNC_CRON_TIMEZONE'],
        message: `Timezone inválida em SYNC_CRON_TIMEZONE: ${data.SYNC_CRON_TIMEZONE}`,
      });
    }

    const schedules = parseCronSchedules(data.SYNC_CRON_SCHEDULE);
    if (data.SYNC_CRON_ENABLED && schedules.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['SYNC_CRON_SCHEDULE'],
        message: 'SYNC_CRON_SCHEDULE não pode ficar vazio quando SYNC_CRON_ENABLED=true',
      });
    }

    if (timezoneValid) {
      for (const expr of schedules) {
        try {
          const testJob = new Cron(expr, { paused: true, timezone: data.SYNC_CRON_TIMEZONE });
          testJob.stop();
        } catch {
          ctx.addIssue({
            code: 'custom',
            path: ['SYNC_CRON_SCHEDULE'],
            message: `Expressão cron inválida em SYNC_CRON_SCHEDULE: "${expr}"`,
          });
        }
      }
    }
  });

export function parseEnv(source: Record<string, string | undefined>) {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    console.error('❌ Variáveis de ambiente inválidas:', z.flattenError(parsed.error).fieldErrors);
    throw new Error('Variáveis de ambiente inválidas');
  }

  const CORS_ORIGINS = parseCorsOrigins(parsed.data.CORS_ORIGIN);
  const VALID_API_KEYS = Array.from(
    new Set([
      parsed.data.API_KEY,
      ...(parsed.data.API_KEY_PREVIOUS ? [parsed.data.API_KEY_PREVIOUS] : []),
    ])
  );
  const SYNC_CRON_SCHEDULES = parseCronSchedules(parsed.data.SYNC_CRON_SCHEDULE);

  return {
    ...parsed.data,
    CORS_ORIGINS,
    VALID_API_KEYS,
    SYNC_CRON_SCHEDULES,
  };
}

export type AppEnv = ReturnType<typeof parseEnv>;

export const env = parseEnv(process.env);
