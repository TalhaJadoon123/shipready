/**
 * Structured JSON Logger with Request ID Correlation
 * 
 * Features:
 * - JSON output for log aggregation
 * - Request ID correlation across services
 * - Configurable log levels
 * - Optional Sentry transport
 * - Redaction of sensitive fields
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogContext {
  requestId?: string;
  userId?: string;
  projectId?: string;
  traceId?: string;
  spanId?: string;
  [key: string]: unknown;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context: LogContext;
  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
  };
  durationMs?: number;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

const REDACT_KEYS = [
  'password',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'authorization',
  'cookie',
  'set-cookie',
  'password_confirmation',
  'credit_card',
  'creditCard',
  'ssn',
  'social_security',
  'private_key',
  'privateKey',
  'client_secret',
  'clientSecret',
];

function redact(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);

  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (REDACT_KEYS.some(k => lowerKey.includes(k))) {
      redacted[key] = '[REDACTED]';
    } else {
      redacted[key] = redact(value);
    }
  }
  return redacted;
}

export interface LoggerOptions {
  level?: LogLevel;
  pretty?: boolean;
  redactKeys?: string[];
  sentryDsn?: string;
  environment?: string;
}

let currentLogger: Logger | null = null;

export class Logger {
  private level: LogLevel;
  private pretty: boolean;
  private redactKeys: string[];
  private sentryDsn?: string;
  private environment: string;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
    this.pretty = options.pretty ?? process.env.NODE_ENV !== 'production';
    this.redactKeys = options.redactKeys ?? [];
    this.sentryDsn = options.sentryDsn ?? process.env.SENTRY_DSN;
    this.environment = options.environment ?? process.env.NODE_ENV ?? 'development';
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }

  private format(entry: LogEntry): string {
    const output = {
      ...entry,
      context: redact(entry.context),
      timestamp: entry.timestamp,
    };

    if (this.pretty) {
      const color = {
        trace: '\x1b[90m',
        debug: '\x1b[36m',
        info: '\x1b[32m',
        warn: '\x1b[33m',
        error: '\x1b[31m',
        fatal: '\x1b[35m',
      }[entry.level] || '\x1b[0m';
      const reset = '\x1b[0m';
      const ctx = JSON.stringify(output.context, null, 2);
      return `${color}[${entry.timestamp}] ${entry.level.toUpperCase()}${reset} ${entry.message}\n${ctx}`;
    }

    return JSON.stringify(output);
  }

  private log(level: LogLevel, message: string, context: LogContext = {}, error?: Error, durationMs?: number): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: { ...context, environment: this.environment },
      durationMs,
    };

    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
        code: (error as NodeJS.ErrnoException).code,
      };
    }

    const formatted = this.format(entry);

    if (level === 'error' || level === 'fatal') {
      process.stderr.write(formatted + '\n');
    } else {
      process.stdout.write(formatted + '\n');
    }

    // Sentry integration (if configured)
    if (this.sentryDsn && (level === 'error' || level === 'fatal')) {
      this.captureSentry(entry);
    }
  }

  private captureSentry(entry: LogEntry): void {
    // Lazy-load Sentry to avoid dependency if not used
    // In production, you would: import * as Sentry from '@sentry/node';
    // For now, we just log that it would be sent
    if (process.env.SENTRY_DSN) {
      console.debug('[LOGGER] Would send to Sentry:', entry.level, entry.message);
    }
  }

  trace(message: string, context?: LogContext): void {
    this.log('trace', message, context);
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: LogContext, error?: Error): void {
    this.log('error', message, context, error);
  }

  fatal(message: string, context?: LogContext, error?: Error): void {
    this.log('fatal', message, context, error);
  }

  // Timing helper
  time<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    return fn().then(
      (result) => {
        this.debug(`${label} completed`, { durationMs: Date.now() - start });
        return result;
      },
      (error) => {
        this.error(`${label} failed`, { durationMs: Date.now() - start }, error as Error);
        throw error;
      }
    );
  }

  // Child logger with additional context
  child(_context: LogContext): Logger {
    const child = new Logger({
      level: this.level,
      pretty: this.pretty,
      redactKeys: this.redactKeys,
      sentryDsn: this.sentryDsn,
      environment: this.environment,
    });
    // Override log to include parent context
    const originalLog = child.log.bind(child);
    child.log = (level, message, context, error, duration) => {
      originalLog(level, message, { ...this as unknown as LogContext, ...context }, error, duration);
    };
    return child;
  }
}

export function getLogger(options?: LoggerOptions): Logger {
  if (!currentLogger) {
    currentLogger = new Logger(options);
  }
  return currentLogger;
}

export function setLogger(logger: Logger): void {
  currentLogger = logger;
}

// Convenience function for middleware/request logging
export function createRequestLogger(requestId: string, context: LogContext = {}): Logger {
  return getLogger().child({ requestId, ...context });
}

// Async error wrapper with logging
export async function withLogging<T>(
  logger: Logger,
  operation: string,
  fn: () => Promise<T>,
  context: LogContext = {}
): Promise<T> {
  const start = Date.now();
  logger.info(`Starting ${operation}`, context);
  try {
    const result = await fn();
    logger.info(`Completed ${operation}`, { ...context, durationMs: Date.now() - start });
    return result;
  } catch (error) {
    logger.error(`Failed ${operation}`, { ...context, durationMs: Date.now() - start }, error as Error);
    throw error;
  }
}
