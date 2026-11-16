import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger };

export interface CreateLoggerOptions {
  level?: string;
  name?: string;
  /** Override the output stream (e.g. a file or a test sink). */
  destination?: NodeJS.WritableStream;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const config: LoggerOptions = {
    level: options.level ?? 'info',
    name: options.name ?? 'weft',
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return options.destination ? pino(config, options.destination) : pino(config);
}

export const logger = createLogger();
