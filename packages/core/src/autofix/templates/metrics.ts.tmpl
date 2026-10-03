/**
 * Prometheus metrics.
 *
 * The metrics that earn their keep: request count, error count, latency
 * histogram, and -- if you call a model -- tokens and estimated cost per model.
 * Cost is the one nobody thinks to instrument and the one that tells you a
 * week before the invoice does.
 *
 * Mount before authentication so the scraper can reach it, and do not expose
 * it publicly: keep it on an internal port or behind network policy.
 */
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'HTTP requests by method, route and status',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.01, 0.05, 0.1, 0.3, 1, 3, 10],
  registers: [registry],
});

export const llmTokens = new Counter({
  name: 'llm_tokens_total',
  help: 'Tokens consumed, by model and direction',
  labelNames: ['model', 'direction'] as const,
  registers: [registry],
});

export const llmCostUsd = new Counter({
  name: 'llm_cost_usd_total',
  help: 'Estimated spend in USD, by model',
  labelNames: ['model'] as const,
  registers: [registry],
});

export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  userId?: string;
}

/** Call after every model call. */
export function recordModelUsage(usage: ModelUsage): void {
  llmTokens.labels(usage.model, 'input').inc(usage.inputTokens);
  llmTokens.labels(usage.model, 'output').inc(usage.outputTokens);
  llmCostUsd.labels(usage.model).inc(usage.costUsd);
}

// Request middleware:
//   const started = process.hrtime.bigint();
//   res.on('finish', () => {
//     const route = req.route?.path ?? 'unknown';
//     httpRequests.labels(req.method, route, res.statusCode).inc();
//     httpDuration.labels(req.method, route)
//       .observe(Number(process.hrtime.bigint() - started) / 1e9);
//   });
//
// Mount the endpoint:
//   app.get('/metrics', async (_req, res) => {
//     res.setHeader('Content-Type', registry.contentType);
//     res.end(await registry.metrics());
//   });