/**
 * Zod-validated Environment Configuration
 * 
 * Single source of truth for all environment variables.
 * Fails fast on invalid config at startup.
 */

import { z } from 'zod';

/**
 * Default scan configuration constants.
 * Used by CLI and other consumers as fallback defaults.
 */
export const DEFAULT_CI_THRESHOLD = 50;
export const DEFAULT_FIX_LIMIT = 10;
export const DEFAULT_TOP_BLOCKERS = 5;
export const DEFAULT_COST_BUDGET = 10; // USD
export const DEFAULT_COST_PER_TRACE = 0.01; // USD
export const DEFAULT_SCAN_CONFIG = {
  threshold: DEFAULT_CI_THRESHOLD,
  disable: [] as string[],
  minConfidence: 0.7,
  minSeverity: 'info' as const,
  include: [] as string[],
  exclude: [] as string[],
  maxFiles: 10000,
};

/**
 * Core application config
 */
export const CoreConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: z.coerce.boolean().default(false),
  SHIPREADY_TELEMETRY: z.coerce.boolean().default(false),
});

export type CoreConfig = z.infer<typeof CoreConfigSchema>;

/**
 * Database configuration
 */
export const DatabaseConfigSchema = z.object({
  SHIPREADY_DATABASE: z.enum(['postgres', 'pglite', 'memory']).default('memory'),
  DATABASE_URL: z.string().url().optional(),
  SHIPREADY_PGLITE_PATH: z.string().default('./.shipready/pglite'),
  SHIPREADY_MEMORY_PATH: z.string().default('.shipready/dashboard.json'),
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().max(100).default(10),
  DATABASE_IDLE_TIMEOUT: z.coerce.number().int().positive().default(30000),
  DATABASE_CONNECTION_TIMEOUT: z.coerce.number().int().positive().default(5000),
});

export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

/**
 * Dashboard authentication & CORS
 */
export const DashboardConfigSchema = z.object({
  SHIPREADY_DASHBOARD_TOKEN: z.string().min(32).optional(),
  SHIPREADY_CORS_ORIGIN: z.string().url().optional(),
  SHIPREADY_PORT: z.coerce.number().int().positive().max(65535).default(3001),
  SHIPREADY_DATABASE: z.enum(['postgres', 'pglite', 'memory']).default('memory'),
  SHIPREADY_MEMORY_PATH: z.string().default('.shipready/dashboard.json'),
  SHIPREADY_PGLITE_PATH: z.string().default('./.shipready/pglite'),
  DATABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_API_URL: z.string().url().optional(),
});

export type DashboardConfig = z.infer<typeof DashboardConfigSchema>;

/**
 * AI Provider Configuration
 */
export const AIProviderConfigSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_AI_API_KEY: z.string().optional(),
  AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
  AZURE_OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_DEPLOYMENT: z.string().optional(),
  AZURE_OPENAI_API_VERSION: z.string().default('2024-02-01'),
});

export type AIProviderConfig = z.infer<typeof AIProviderConfigSchema>;

/**
 * GitHub Configuration
 */
export const GitHubConfigSchema = z.object({
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
});

export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;

/**
 * Docker Compose / Local Development
 */
export const DockerConfigSchema = z.object({
  POSTGRES_USER: z.string().default('shipready'),
  POSTGRES_PASSWORD: z.string().min(8).default('changeme'),
  POSTGRES_DB: z.string().default('shipready'),
  REDIS_PASSWORD: z.string().min(8).default('changeme'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
});

export type DockerConfig = z.infer<typeof DockerConfigSchema>;

/**
 * E-Invoice Configuration
 */
export const EInvoiceConfigSchema = z.object({
  EINVOICE_BR_CERT_PATH: z.string().optional(),
  EINVOICE_BR_KEY_PATH: z.string().optional(),
  EINVOICE_BR_CERT_PASSWORD: z.string().optional(),
});

export type EInvoiceConfig = z.infer<typeof EInvoiceConfigSchema>;

/**
 * Sentry / Error Tracking
 */
export const SentryConfigSchema = z.object({
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_RELEASE: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  SENTRY_PROFILES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
});

export type SentryConfig = z.infer<typeof SentryConfigSchema>;

/**
 * All config combined
 */
export const AllConfigSchema = z.object({
  core: CoreConfigSchema,
  database: DatabaseConfigSchema,
  dashboard: DashboardConfigSchema,
  ai: AIProviderConfigSchema,
  github: GitHubConfigSchema,
  docker: DockerConfigSchema,
  einvoice: EInvoiceConfigSchema,
  sentry: SentryConfigSchema,
});

export type AllConfig = z.infer<typeof AllConfigSchema>;

/**
 * Parsed and validated config (cached)
 */
let cachedConfig: AllConfig | null = null;

/**
 * Parse and validate all environment variables
 * Call once at startup
 */
export function parseConfig(): AllConfig {
  if (cachedConfig) return cachedConfig;

  const env = {
    core: {
      NODE_ENV: process.env.NODE_ENV,
      LOG_LEVEL: process.env.LOG_LEVEL,
      LOG_PRETTY: process.env.LOG_PRETTY,
      SHIPREADY_TELEMETRY: process.env.SHIPREADY_TELEMETRY,
    },
    database: {
      SHIPREADY_DATABASE: process.env.SHIPREADY_DATABASE,
      DATABASE_URL: process.env.DATABASE_URL,
      SHIPREADY_PGLITE_PATH: process.env.SHIPREADY_PGLITE_PATH,
      SHIPREADY_MEMORY_PATH: process.env.SHIPREADY_MEMORY_PATH,
      DATABASE_POOL_SIZE: process.env.DATABASE_POOL_SIZE,
      DATABASE_IDLE_TIMEOUT: process.env.DATABASE_IDLE_TIMEOUT,
      DATABASE_CONNECTION_TIMEOUT: process.env.DATABASE_CONNECTION_TIMEOUT,
    },
    dashboard: {
      SHIPREADY_DASHBOARD_TOKEN: process.env.SHIPREADY_DASHBOARD_TOKEN,
      SHIPREADY_CORS_ORIGIN: process.env.SHIPREADY_CORS_ORIGIN,
      SHIPREADY_PORT: process.env.SHIPREADY_PORT,
      SHIPREADY_DATABASE: process.env.SHIPREADY_DATABASE,
      SHIPREADY_MEMORY_PATH: process.env.SHIPREADY_MEMORY_PATH,
      SHIPREADY_PGLITE_PATH: process.env.SHIPREADY_PGLITE_PATH,
      DATABASE_URL: process.env.DATABASE_URL,
      NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    },
    ai: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GOOGLE_AI_API_KEY: process.env.GOOGLE_AI_API_KEY,
      AZURE_OPENAI_ENDPOINT: process.env.AZURE_OPENAI_ENDPOINT,
      AZURE_OPENAI_API_KEY: process.env.AZURE_OPENAI_API_KEY,
      AZURE_OPENAI_DEPLOYMENT: process.env.AZURE_OPENAI_DEPLOYMENT,
      AZURE_OPENAI_API_VERSION: process.env.AZURE_OPENAI_API_VERSION,
    },
    github: {
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      GITHUB_APP_ID: process.env.GITHUB_APP_ID,
      GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
      GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
    },
    docker: {
      POSTGRES_USER: process.env.POSTGRES_USER,
      POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD,
      POSTGRES_DB: process.env.POSTGRES_DB,
      REDIS_PASSWORD: process.env.REDIS_PASSWORD,
      REDIS_PORT: process.env.REDIS_PORT,
      POSTGRES_PORT: process.env.POSTGRES_PORT,
    },
    einvoice: {
      EINVOICE_BR_CERT_PATH: process.env.EINVOICE_BR_CERT_PATH,
      EINVOICE_BR_KEY_PATH: process.env.EINVOICE_BR_KEY_PATH,
      EINVOICE_BR_CERT_PASSWORD: process.env.EINVOICE_BR_CERT_PASSWORD,
    },
    sentry: {
      SENTRY_DSN: process.env.SENTRY_DSN,
      SENTRY_ENVIRONMENT: process.env.SENTRY_ENVIRONMENT,
      SENTRY_RELEASE: process.env.SENTRY_RELEASE,
      SENTRY_TRACES_SAMPLE_RATE: process.env.SENTRY_TRACES_SAMPLE_RATE,
      SENTRY_PROFILES_SAMPLE_RATE: process.env.SENTRY_PROFILES_SAMPLE_RATE,
    },
  };

  const result = AllConfigSchema.safeParse(env);

  if (!result.success) {
    const errors = result.error.flatten();
    const message = [
      'Configuration validation failed:',
      ...Object.entries(errors.fieldErrors).flatMap(([field, messages]) =>
        (messages ?? []).map((msg: string) => `  ${field}: ${msg}`)
      ),
    ].join('\n');
    throw new Error(message);
  }

  cachedConfig = result.data;
  return cachedConfig;
}

/**
 * Get typed config section
 */
export function getCoreConfig(): CoreConfig {
  return parseConfig().core;
}

export function getDatabaseConfig(): DatabaseConfig {
  return parseConfig().database;
}

export function getDashboardConfig(): DashboardConfig {
  return parseConfig().dashboard;
}

export function getAIConfig(): AIProviderConfig {
  return parseConfig().ai;
}

export function getGitHubConfig(): GitHubConfig {
  return parseConfig().github;
}

export function getDockerConfig(): DockerConfig {
  return parseConfig().docker;
}

export function getEInvoiceConfig(): EInvoiceConfig {
  return parseConfig().einvoice;
}

export function getSentryConfig(): SentryConfig {
  return parseConfig().sentry;
}

/**
 * Reset cache (for testing)
 */
export function resetConfigCache(): void {
  cachedConfig = null;
}

/**
 * Validate required production config
 */
export function validateProductionConfig(): void {
  const config = parseConfig();

  if (config.core.NODE_ENV === 'production') {
    const required = [
      { key: 'SHIPREADY_DASHBOARD_TOKEN', value: config.dashboard.SHIPREADY_DASHBOARD_TOKEN },
      { key: 'DATABASE_URL', value: config.database.DATABASE_URL },
      { key: 'SENTRY_DSN', value: config.sentry.SENTRY_DSN },
    ];

    const missing = required.filter(r => !r.value);

    if (missing.length > 0) {
      throw new Error(
        `Missing required production environment variables:\n${missing.map(m => `  ${m.key}`).join('\n')}`
      );
    }

    // Validate password strength
    if (config.docker.POSTGRES_PASSWORD === 'changeme' || config.docker.REDIS_PASSWORD === 'changeme') {
      throw new Error('Production passwords must be changed from defaults');
    }

    // Validate dashboard token length
    if (config.dashboard.SHIPREADY_DASHBOARD_TOKEN && config.dashboard.SHIPREADY_DASHBOARD_TOKEN.length < 32) {
      throw new Error('SHIPREADY_DASHBOARD_TOKEN must be at least 32 characters');
    }
  }
}

/**
 * Get config summary for health endpoint
 */
export function getConfigSummary() {
  const config = parseConfig();
  return {
    environment: config.core.NODE_ENV,
    logLevel: config.core.LOG_LEVEL,
    database: config.database.SHIPREADY_DATABASE,
    dashboardPort: config.dashboard.SHIPREADY_PORT,
    hasDashboardToken: !!config.dashboard.SHIPREADY_DASHBOARD_TOKEN,
    hasCorsOrigin: !!config.dashboard.SHIPREADY_CORS_ORIGIN,
    hasOpenAI: !!config.ai.OPENAI_API_KEY,
    hasAnthropic: !!config.ai.ANTHROPIC_API_KEY,
    hasGitHubToken: !!config.github.GITHUB_TOKEN,
    hasSentry: !!config.sentry.SENTRY_DSN,
    telemetry: config.core.SHIPREADY_TELEMETRY,
  };
}