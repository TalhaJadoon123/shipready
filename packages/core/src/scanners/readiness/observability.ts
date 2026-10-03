import { defineRule, type Rule } from '../../rules/scanner-helper.js';
import { COMPLIANCE } from '../../rules/rule.js';
import {
  allFiles,
  filesWithExts,
  findServerEntry,
  JS_EXTS,
  SERVER_EXTS,
  stackLabel,
} from './helpers.js';
import type { ScanContext } from '../../types.js';

const LOG_LIBS = ['pino', 'winston', 'bunyan', 'log4js', 'logbook', 'morgan', 'tracing', 'opentelemetry', 'consola', 'tslog', 'loglevel', 'structlog', 'loguru'];

const PII_FIELD =
  /\b(email|e[-_]?mail[_-]?address|phone|mobile|msisdn|cpf|cnpj|ssn|social[_-]?security|passport|national[_-]?id|tax[_-]?id|iban|bank[_-]?account|card[_-]?number|credit[_-]?card|cvv|full[_-]?name|first[_-]?name|last[_-]?name|date[_-]?of[_-]?birth|dob|address|postcode|zip[_-]?code|password|api[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|authorization|ip[_-]?address|latitude|longitude)\b/i;

export const observabilityRules: Rule[] = [
  defineRule(
    {
      id: 'readiness/observability/no-structured-logging',
      name: 'Logging is unstructured',
      category: 'observability',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.8,
      effortMinutes: 45,
      fixable: true,
      description:
        'The app logs with interpolated strings rather than structured key/value fields. Structured logs are queryable: you can ask "show me every request from this user that took over 3 seconds". With string concatenation you can only grep, and grep will not save you at 3am during an incident.',
      remediation:
        'Adopt pino (fast, structured, low overhead) or winston for Node, structlog or loguru for Python. Log objects, not strings: `logger.info({ userId, durationMs }, "request complete")`. Add `requestId` to every log line via a middleware.',
      compliance: [COMPLIANCE.owaspA09, COMPLIANCE.euAiActArticle12, COMPLIANCE.soc2CC7, COMPLIANCE.nis2Art21],
      owasp: 'A09:2021',
      tags: ['logging', 'debuggability'],
      references: ['https://opentelemetry.io/docs/concepts/signals/logs/'],
    },
    function* (ctx, emit) {
      if (ctx.project.totalLines < 50) return;
      const files = filesWithExts(ctx, ...SERVER_EXTS, '.py', '.go', '.rb');
      if (files.length === 0) return;
      if (LOG_LIBS.some((l) => ctx.project.dependencyNames.has(l))) return;
      if (allFiles(ctx).some((f) => /logger\.\w+\(\s*\{|logging\.\w+\(\s*[a-z_]+=|logger\.\w+\(\s*[a-z_]+=/.test(f.content))) return;

      let interpolated = 0;
      let sample: { path: string; line: number; text: string } | null = null;
      for (const file of files) {
        for (let line = 1; line <= file.lineCount; line++) {
          const code = file.lineNoComments(line);
          const isLog = /console\.(log|info|warn|error|debug)\s*\(|(^|\s)(logger|log|logging)\.\w+\s*\(/.test(code);
          if (!isLog) continue;
          if (/console\.(log|info|debug)\s*\(\s*["'`]/.test(code) && !/\$\{|%\s*\w|\+\s*\w|\.format\(|,\s*\w+\.?(toString)?/.test(code)) continue;
          interpolated++;
          if (!sample) sample = { path: file.path, line, text: code };
        }
      }
      if (interpolated < 3) return;
      yield emit({
        path: sample?.path ?? findServerEntry(ctx),
        line: sample?.line ?? 1,
        snippet: sample?.text,
        evidence: `${interpolated} log call(s) build their message by interpolation instead of structured fields`,
        data: { interpolatedCalls: interpolated },
      });
    },
  ),

  defineRule(
    {
      id: 'readiness/observability/no-health-check',
      name: 'No health check endpoint',
      category: 'observability',
      severity: 'high',
      impact: 'blocker',
      confidence: 0.85,
      effortMinutes: 30,
      fixable: true,
      description:
        'There is no health check endpoint. Your orchestrator cannot tell the difference between "process is up but the database is unreachable" and "process is healthy". Result: rolling deploys hang on pods that will never serve traffic, and load balancers keep sending users to an instance that cannot answer.',
      remediation:
        'Add `GET /health` returning 200 when the process is serving, and `GET /health/ready` that additionally pings the database. Kubernetes: configure `readinessProbe` and `livenessProbe` separately -- a liveness probe that checks the database will restart a pod because a dependency blipped.',
      compliance: [COMPLIANCE.soc2CC7, COMPLIANCE.euAiActArticle72, COMPLIANCE.nis2Art21],
      tags: ['kubernetes', 'deploy', 'launch-blocker', 'reliability'],
      references: ['https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/'],
    },
    function* (ctx, emit) {
      if (!hasServer(ctx)) return;
      if (hasHealthCheck(ctx)) return;
      yield emit({
        path: findServerEntry(ctx),
        evidence: `${stackLabel(ctx)} service with no /health, /healthz, /ready or /live endpoint`,
      });
    },
    (ctx) => hasServer(ctx),
  ),

  defineRule(
    {
      id: 'readiness/observability/no-metrics',
      name: 'No metrics endpoint',
      category: 'observability',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.8,
      effortMinutes: 60,
      fixable: true,
      description:
        'Nothing exports metrics. You have logs (retention-limited, unaggregated) but no request rate, error rate, latency histogram or saturation. You find out you are down because users tell you.',
      remediation:
        'Expose Prometheus metrics with `prom-client` for Node or `prometheus-fastapi-instrumentator` for FastAPI. At minimum instrument: request count, error count, latency percentiles, and LLM token usage and cost per model.',
      compliance: [COMPLIANCE.euAiActArticle12, COMPLIANCE.euAiActArticle72, COMPLIANCE.soc2CC7],
      tags: ['metrics', 'prometheus', 'observability'],
      references: ['https://prometheus.io/docs/instrumenting/exposition_formats/'],
    },
    function* (ctx, emit) {
      if (!hasServer(ctx)) return;
      if (hasMetrics(ctx)) return;
      yield emit({
        path: findServerEntry(ctx),
        evidence: 'no Prometheus metrics, OpenTelemetry meter, or /metrics endpoint',
      });
    },
    (ctx) => hasServer(ctx),
  ),

  defineRule(
    {
      id: 'readiness/observability/no-request-tracing',
      name: 'No distributed request tracing',
      category: 'observability',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.75,
      effortMinutes: 75,
      fixable: true,
      description:
        'No trace or request id is generated and propagated. When a request touches the API, the database, a payment provider and an LLM, you cannot reconstruct its path. A single `requestId` in your logs and an `x-request-id` header gets you most of the value for an hour of work.',
      remediation:
        'Start cheap: generate a request id in middleware, put it in a response header, and include it in every log line. Then add OpenTelemetry when you need spans. Trace the LLM calls separately with the observer, which already does this.',
      compliance: [COMPLIANCE.euAiActArticle12],
      tags: ['tracing', 'opentelemetry'],
      references: ['https://opentelemetry.io/docs/concepts/signals/traces/'],
    },
    function* (ctx, emit) {
      if (!hasServer(ctx)) return;
      if (hasTracing(ctx)) return;
      yield emit({
        path: findServerEntry(ctx),
        evidence: 'no request id, correlation id or OpenTelemetry instrumentation found',
      });
    },
    (ctx) => hasServer(ctx),
  ),

  defineRule(
    {
      id: 'readiness/observability/potential-pii-in-logs',
      name: 'Personal data logged without redaction',
      category: 'observability',
      severity: 'high',
      impact: 'degradation',
      confidence: 0.6,
      effortMinutes: 40,
      fixable: false,
      description:
        'A log statement appears to include a personal data field. Log aggregators are copies of your production database: they replicate, are indexed by search engines you did not choose, and are usually covered by a different retention policy than your database. Logging an email address or an auth token moves it into a system nobody threat-modelled.',
      remediation:
        'Log identifiers, not people: `userId` rather than `email`, `orderId` rather than a card number. Never log authorization headers, tokens, passwords or full request bodies. Add a redaction helper and an automated check in CI that fails on known-sensitive keys.',
      compliance: [COMPLIANCE.gdprArticle5, COMPLIANCE.gdprArticle32, COMPLIANCE.owaspA09],
      cwe: 'CWE-532',
      owasp: 'A09:2021',
      tags: ['gdpr', 'pii', 'logging'],
      references: ['https://owasp.org/www-project-top-ten/2021/A09_2021-Security_Logging_and_Monitoring_Failures/'],
    },
    function* (ctx, emit) {
      for (const file of filesWithExts(ctx, ...JS_EXTS, '.py', '.go', '.rb')) {
        for (let line = 1; line <= file.lineCount; line++) {
          const code = file.lineNoComments(line);
          const isLog = /console\.(log|info|warn|error|debug)\s*\(|(^|\s)(logger|log|logging|print)\.\w*\s*\(|\bprint\s*\(/.test(code);
          if (!isLog) continue;
          if (file.hasExplanatoryCommentNear(line, ['redact', 'hashed', 'anonymis', 'anonymiz', 'gdpr', 'pseudonymis'])) continue;
          const field = PII_FIELD.exec(code);
          if (!field?.[1]) continue;
          // Hashing a field is the correct pattern; do not flag it.
          if (/hash|redact|mask|anonymi|pseudonymi/i.test(code)) continue;
          yield emit({
            path: file.path,
            line,
            snippet: code,
            evidence: `log statement includes \`${field[1]}\`, which is personal data under GDPR`,
            data: { field: field[1] },
          });
        }
      }
    },
  ),

  defineRule(
    {
      id: 'readiness/observability/no-alerting',
      name: 'Monitoring exists but nothing alerts',
      category: 'observability',
      severity: 'low',
      impact: 'cosmetic',
      confidence: 0.7,
      effortMinutes: 45,
      fixable: false,
      description:
        'Error tracking and/or metrics are configured but no alerting is defined. A dashboard nobody is paged for is a screenshot, not a monitoring system.',
      remediation:
        'Define alerts on the things that page you: error rate above 2%, p95 latency above target, LLM spend above budget, health check failures. Route them to a channel someone actually reads.',
      compliance: [COMPLIANCE.soc2CC7, COMPLIANCE.euAiActArticle72],
      tags: ['alerting', 'observability'],
      references: ['https://sre.google/sre-book/monitoring-distributed-systems/'],
    },
    function* (ctx, emit) {
      const hasTracker = ['@sentry/node', '@sentry/nextjs', '@sentry/python', 'rollbar', 'bugsnag'].some((d) => ctx.project.dependencyNames.has(d));
      if (!hasTracker) return;
      const alerting = /alertmanager|Alertmanager|prometheus\/alert|alert-rules|\.pagerduty|PagerDuty|opsgenie|alert-webhook|PAGERDUTY|DISCORD_WEBHOOK_URL|SLACK_WEBHOOK/i.test(
        allFiles(ctx).map((f) => f.content).join('\n'),
      );
      if (alerting) return;
      yield emit({
        path: findServerEntry(ctx),
        evidence: 'Sentry/error tracking installed but no alerting rules or on-call routing found',
        severity: 'low',
        impact: 'cosmetic',
        effortMinutes: 45,
      });
    },
    (ctx) => ['@sentry/node', '@sentry/nextjs', '@sentry/python', 'rollbar', 'bugsnag'].some((d) => ctx.project.dependencyNames.has(d)),
  ),
];

// ---------------------------------------------------------------------------

function hasServer(ctx: ScanContext): boolean {
  return (
    ['nextjs', 'express', 'fastapi', 'django', 'go', 'rust', 'node'].includes(ctx.project.type) ||
    ctx.project.apiRoutes.length > 0 ||
    ctx.project.frameworks.some((f) => ['express', 'node-server', 'fastapi', 'django', 'go', 'rust'].includes(f))
  );
}

/**
 * True when the project serves a liveness or readiness endpoint.
 *
 * A route *file* named health/route.ts counts: in Next.js the path is derived
 * from the file, so a string search for '/health' would miss it entirely.
 */
/**
 * True when the project serves a liveness or readiness endpoint.
 *
 * Two shapes count:
 *  - a route *file* named health/route.ts, because in Next.js the path is
 *    derived from the file, so a string search for '/health' would miss it;
 *  - a route registered at one of the conventional paths.
 *
 * For Next.js the matcher must also confirm the file is actually inside an app
 * or pages directory: a random `lib/status.ts` helper is not an endpoint.
 */
function hasHealthCheck(ctx: ScanContext): boolean {
  // A module named `health` is the handler, wherever it lives. In Next.js the
  // route file itself is named health/route.ts; elsewhere it is a helper that
  // the server registers, and that registration is matched below.
  const healthRoute = ctx.files().some((f) =>
    /(^|\/)(health|healthz|healthcheck|ready|readiness|live|liveness|ping|status|up)(\/route)?\.(ts|js|tsx|jsx|py|go|rb)$/.test(f),
  );
  if (healthRoute) return true;

  return allFiles(ctx).some((f) =>
    /['"`]\/(health|healthz|healthcheck|ready|readiness|live|liveness|status|ping|up)\b['"`]|def health\b|func health\b|app\.get\(\s*['"`]\/(health|status)|router\.(get|head)\(\s*['"`]\/(health|healthz|ready)|@(?:app|router)\.(get|head)\(\s*['"`]\/(health|healthz|ready)/i.test(
      f.content,
    ),
  );
}

function hasMetrics(ctx: ScanContext): boolean {
  if (['prom-client', '@opentelemetry/api', 'opentelemetry-sdk-node', 'metrics', 'prometheus-fastapi-instrumentator', 'prometheus_client'].some((d) => ctx.project.dependencyNames.has(d))) return true;
  return allFiles(ctx).some((f) => /['"`]\/metrics\b|registry\.(prometheus|metrics)|Counter\(|Histogram\(|Gauge\(|prometheus_client/.test(f.content));
}

function hasTracing(ctx: ScanContext): boolean {
  if (['@opentelemetry\/sdk-node', '@opentelemetry\/api', 'dd-trace', 'newrelic', 'elastic-apm-node', 'tracing'].some((d) => ctx.project.dependencyNames.has(d))) return true;
  return allFiles(ctx).some((f) =>
    /traceparent|tracer\.startSpan|startActiveSpan|@opentelemetry|trace\.getTracer|requestId|request_id|x-request-id|correlationId|correlation_id|X-Correlation-Id/i.test(
      f.content,
    ),
  );
}
