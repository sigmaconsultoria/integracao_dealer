import pino from 'pino';
import { env } from './env.js';

export interface AppLoggerFn {
  (obj: Record<string, unknown>, msg?: string): void;
  (msg: string): void;
}

export interface AppLogger {
  info: AppLoggerFn;
  warn: AppLoggerFn;
  error: AppLoggerFn;
}

export function createLogger(level: string = env.LOG_LEVEL) {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'req.headers.cookie',
        '*.password',
        '*.refresh_token',
        '*.access_token',
        '*.client_secret',
      ],
      censor: '[REDACTED]',
    },
  });
}

export const logger = createLogger();
