/**
 * Retry with Exponential Backoff and Circuit Breaker
 * 
 * Features:
 * - Exponential backoff with jitter
 * - Configurable retry conditions
 * - Circuit breaker pattern
 * - Timeout support
 * - Context-aware retries
 */

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  retryCondition?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  successThreshold?: number;
  timeoutMs?: number;
  name?: string;
}

export class CircuitBreakerError extends Error {
  public readonly circuitName: string;
  public readonly failures: number;
  
  constructor(
    circuitName: string,
    failures: number,
    message: string = `Circuit breaker "${circuitName}" is OPEN`
  ) {
    super(message);
    this.circuitName = circuitName;
    this.failures = failures;
  }

  override get name(): string {
    return 'CircuitBreakerError';
  }
}

export class RetryExhaustedError extends Error {
  public readonly attempts: number;
  public readonly lastError: Error;
  
  constructor(
    attempts: number,
    lastError: Error,
    message: string = `Retry exhausted after ${attempts} attempts`
  ) {
    super(message);
    this.attempts = attempts;
    this.lastError = lastError;
  }

  override get name(): string {
    return 'RetryExhaustedError';
  }
}

export class TimeoutError extends Error {
  public readonly timeoutMs: number;
  
  constructor(timeoutMs: number) {
    super(`Operation timed out after ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
  }

  override get name(): string {
    return 'TimeoutError';
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  retryCondition?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  successThreshold?: number;
  timeoutMs?: number;
  name?: string;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitter: true,
  retryCondition: (error: unknown) => {
    // Retry on network errors, timeouts, 5xx errors
    if (error instanceof TypeError && error.message.includes('fetch')) return true;
    if (error instanceof Error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
      if ('status' in error && typeof (error as any).status === 'number') {
        const status = (error as any).status;
        return status >= 500 || status === 429;
      }
      if ('code' in error && typeof (error as any).code === 'string') {
        const code = (error as any).code;
        return ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(code);
      }
    }
    return false;
  },
  onRetry: () => {},
  timeoutMs: 30000,
  signal: new AbortSignal() as any, // Will be replaced by caller's signal
};

/**
 * Calculate delay with exponential backoff and optional jitter
 */
function calculateDelay(attempt: number, options: Required<RetryOptions>): number {
  const delay = Math.min(
    options.baseDelayMs * Math.pow(2, attempt - 1),
    options.maxDelayMs
  );

  if (options.jitter) {
    // Full jitter: random value between 0 and delay
    return Math.floor(Math.random() * delay);
  }

  return delay;
}

/**
 * Execute a function with retry logic and exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options } as Required<RetryOptions>;
  let lastError: Error | unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      // Wrap in timeout if specified
      let result: T;
      if (opts.timeoutMs) {
        result = await Promise.race([
          fn(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new TimeoutError(opts.timeoutMs ?? 30000)), opts.timeoutMs!)
          )
        ]);
      } else {
        result = await fn();
      }
      return result;
    } catch (error) {
      lastError = error;

      // Check if we should retry
      const shouldRetry = attempt < opts.maxAttempts &&
        (!opts.signal?.aborted) &&
        opts.retryCondition(error, attempt);

      if (!shouldRetry) {
        throw error;
      }

      const delay = calculateDelay(attempt, opts);

      opts.onRetry(error, attempt, delay);

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new RetryExhaustedError(opts.maxAttempts, lastError as Error);
}

/**
 * Circuit Breaker States
 */
enum CircuitState {
  CLOSED = 'CLOSED',   // Normal operation, requests go through
  OPEN = 'OPEN',       // Failing, requests blocked
  HALF_OPEN = 'HALF_OPEN', // Testing if service recovered
}

/**
 * Circuit Breaker implementation
 */
export class CircuitBreaker {
  private _state: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private successes = 0;
  private lastFailureTime = 0;
  private readonly options: Required<CircuitBreakerOptions>;

  constructor(options: CircuitBreakerOptions = {}) {
    this.options = {
      failureThreshold: options.failureThreshold ?? 5,
      successThreshold: options.successThreshold ?? 2,
      timeoutMs: options.timeoutMs ?? 60000,
      name: options.name ?? 'default',
    };
  }

  get state(): CircuitState {
    // Auto-transition from OPEN to HALF_OPEN after timeout
    if (this._state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime >= this.options.timeoutMs) {
        this._state = CircuitState.HALF_OPEN;
      }
    }
    return this._state;
  }

  get name(): string {
    return this.options.name;
  }

  get failureCount(): number {
    return this.failures;
  }

  /**
   * Execute a function through the circuit breaker
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.state;

    if (currentState === CircuitState.OPEN) {
      throw new CircuitBreakerError(this.options.name, this.failures);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;

    if (this._state === CircuitState.HALF_OPEN) {
      this.successes++;
      if (this.successes >= this.options.successThreshold) {
        this._state = CircuitState.CLOSED;
        this.successes = 0;
      }
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    this.successes = 0;

    if (this._state === CircuitState.HALF_OPEN) {
      // Any failure in HALF_OPEN goes back to OPEN
      this._state = CircuitState.OPEN;
    } else if (this.failures >= this.options.failureThreshold) {
      this._state = CircuitState.OPEN;
    }
  }

  /**
   * Manually reset the circuit breaker
   */
  reset(): void {
    this._state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = 0;
  }

  /**
   * Force open the circuit (for testing/maintenance)
   */
  forceOpen(): void {
    this._state = CircuitState.OPEN;
    this.lastFailureTime = Date.now();
  }

  /**
   * Get current status for monitoring
   */
  getStatus(): {
    name: string;
    state: CircuitState;
    failures: number;
    successes: number;
    nextAttemptAt?: number;
  } {
    let nextAttemptAt: number | undefined;
    if (this._state === CircuitState.OPEN) {
      nextAttemptAt = this.lastFailureTime + this.options.timeoutMs;
    }
    return {
      name: this.options.name,
      state: this._state,
      failures: this.failures,
      successes: this.successes,
      nextAttemptAt,
    };
  }
}

/**
 * Registry for managing multiple circuit breakers
 */
export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  getOrCreate(name: string, options?: CircuitBreakerOptions): CircuitBreaker {
    if (!this.breakers.has(name)) {
      this.breakers.set(name, new CircuitBreaker({ ...options, name }));
    }
    return this.breakers.get(name)!;
  }

  get(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  getAllStatus(): Record<string, ReturnType<CircuitBreaker['getStatus']>> {
    const status: Record<string, ReturnType<CircuitBreaker['getStatus']>> = {};
    for (const [name, breaker] of this.breakers) {
      status[name] = breaker.getStatus();
    }
    return status;
  }

  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}

/**
 * Default registry instance
 */
export const circuitBreakerRegistry = new CircuitBreakerRegistry();

/**
 * Helper to execute with both retry and circuit breaker
 */
export async function withResilience<T>(
  fn: () => Promise<T>,
  options: RetryOptions & { circuitBreaker?: CircuitBreaker } = {}
): Promise<T> {
  const { circuitBreaker, ...retryOptions } = options;

  if (circuitBreaker) {
    return circuitBreaker.execute(() => withRetry(fn, retryOptions));
  }

  return withRetry(fn, retryOptions);
}

/**
 * Preset configurations for common external services
 */
export const resiliencePresets = {
  github: {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
    retryCondition: (error: unknown) => {
      if (error instanceof Error) {
        if ('status' in error) return (error as any).status >= 500 || (error as any).status === 403;
        if (error.message.includes('rate limit')) return true;
      }
      return DEFAULT_RETRY_OPTIONS.retryCondition(error, 1);
    },
    circuitBreaker: circuitBreakerRegistry.getOrCreate('github', {
      failureThreshold: 5,
      timeoutMs: 60000,
    }),
  },

  openai: {
    maxAttempts: 3,
    baseDelayMs: 2000,
    maxDelayMs: 30000,
    retryCondition: (error: unknown) => {
      if (error instanceof Error) {
        if ('status' in error) {
          const status = (error as any).status;
          return status >= 500 || status === 429;
        }
        if (error.message.includes('rate_limit') || error.message.includes('timeout')) return true;
      }
      return DEFAULT_RETRY_OPTIONS.retryCondition(error, 1);
    },
    circuitBreaker: circuitBreakerRegistry.getOrCreate('openai', {
      failureThreshold: 3,
      timeoutMs: 120000,
    }),
  },

  anthropic: {
    maxAttempts: 3,
    baseDelayMs: 2000,
    maxDelayMs: 30000,
    retryCondition: (error: unknown) => {
      if (error instanceof Error) {
        if ('status' in error) {
          const status = (error as any).status;
          return status >= 500 || status === 429;
        }
      }
      return DEFAULT_RETRY_OPTIONS.retryCondition(error, 1);
    },
    circuitBreaker: circuitBreakerRegistry.getOrCreate('anthropic', {
      failureThreshold: 3,
      timeoutMs: 120000,
    }),
  },

  database: {
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 5000,
    retryCondition: (error: unknown) => {
      if (error instanceof Error) {
        const code = (error as any).code;
        return ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND'].includes(code);
      }
      return false;
    },
    circuitBreaker: circuitBreakerRegistry.getOrCreate('database', {
      failureThreshold: 5,
      timeoutMs: 30000,
    }),
  },
} as const;