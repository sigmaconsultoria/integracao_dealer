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

export function createLogger(
  level: string = env.LOG_LEVEL,
  destination?: pino.DestinationStream
) {
  const options: pino.LoggerOptions = {
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'req.headers.cookie',
        'token',
        '*.token',
        '*.password',
        '*.refresh_token',
        '*.access_token',
        '*.client_secret',
      ],
      censor: '[REDACTED]',
    },
  };

  return destination ? pino(options, destination) : pino(options);
}

export const logger = createLogger();
