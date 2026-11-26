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

export const UNIT_CODE_REGEX = /^[A-Z0-9_-]{2,10}$/;

export interface FollowizeUnitConfig {
  unidade: string;
  clientId: string;
  clientSecret: string;
  seedRefreshToken?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalEnvString() {
  return z.preprocess(
    (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
    z.string().trim().min(1).optional()
  );
}

export function parseFollowizeUnits(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') {
    return ['MT'];
  }
  return Array.from(
    new Set(
      raw
        .split(',')
        .map((unit) => unit.trim().toUpperCase())
        .filter(Boolean)
    )
  );
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

    FOLLOWIZE_UNITS: z.string().optional(),
    FOLLOWIZE_CLIENT_ID: optionalEnvString(),
    FOLLOWIZE_CLIENT_SECRET: optionalEnvString(),
    FOLLOWIZE_REFRESH_TOKEN: optionalEnvString(),
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
  const fieldErrors: Record<string, string[]> = {};

  if (!parsed.success) {
    const flattened = z.flattenError(parsed.error).fieldErrors;
    for (const [key, messages] of Object.entries(flattened)) {
      if (Array.isArray(messages) && messages.length > 0) {
        fieldErrors[key] = [...messages];
      }
    }
  }

  const rawUnits = source.FOLLOWIZE_UNITS;
  const units = parseFollowizeUnits(rawUnits);
  if (rawUnits !== undefined && rawUnits.trim() !== '' && units.length === 0) {
    fieldErrors.FOLLOWIZE_UNITS = [
      'FOLLOWIZE_UNITS deve conter ao menos uma unidade válida (ex: MT,PA,AP)',
    ];
  }

  const validUnits: string[] = [];
  for (const unit of units) {
    if (!UNIT_CODE_REGEX.test(unit)) {
      fieldErrors.FOLLOWIZE_UNITS = [
        ...(fieldErrors.FOLLOWIZE_UNITS ?? []),
        `Unidade inválida em FOLLOWIZE_UNITS: "${unit}" (use 2-10 caracteres [A-Z0-9_-])`,
      ];
    } else {
      validUnits.push(unit);
    }
  }

  const FOLLOWIZE_CLIENTS: Record<string, FollowizeUnitConfig> = {};
  for (const unit of validUnits) {
    const clientIdKey = `FOLLOWIZE_${unit}_CLIENT_ID`;
    const clientSecretKey = `FOLLOWIZE_${unit}_CLIENT_SECRET`;
    const refreshTokenKey = `FOLLOWIZE_${unit}_REFRESH_TOKEN`;

    const clientId =
      nonEmpty(source[clientIdKey]) ??
      (unit === 'MT' ? nonEmpty(source.FOLLOWIZE_CLIENT_ID) : undefined);
    const clientSecret =
      nonEmpty(source[clientSecretKey]) ??
      (unit === 'MT' ? nonEmpty(source.FOLLOWIZE_CLIENT_SECRET) : undefined);
    const seedRefreshToken =
      nonEmpty(source[refreshTokenKey]) ??
      (unit === 'MT' ? nonEmpty(source.FOLLOWIZE_REFRESH_TOKEN) : undefined);

    if (!clientId) {
      fieldErrors[clientIdKey] = [
        unit === 'MT'
          ? `${clientIdKey} (ou fallback FOLLOWIZE_CLIENT_ID) é obrigatório`
          : `${clientIdKey} é obrigatório`,
      ];
    }

    if (!clientSecret) {
      fieldErrors[clientSecretKey] = [
        unit === 'MT'
          ? `${clientSecretKey} (ou fallback FOLLOWIZE_CLIENT_SECRET) é obrigatório`
          : `${clientSecretKey} é obrigatório`,
      ];
    }

    if (clientId && clientSecret) {
      FOLLOWIZE_CLIENTS[unit] = {
        unidade: unit,
        clientId,
        clientSecret,
        ...(seedRefreshToken ? { seedRefreshToken } : {}),
      };
    }
  }

  if (!parsed.success || Object.keys(fieldErrors).length > 0) {
    console.error('❌ Variáveis de ambiente inválidas:', fieldErrors);
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
    FOLLOWIZE_UNITS: validUnits,
    FOLLOWIZE_CLIENTS,
  };
}

export type AppEnv = ReturnType<typeof parseEnv>;

export const env = parseEnv(process.env);
