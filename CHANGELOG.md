# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- Spec Kit adoption: constitution.md, spec.md, plan.md, tasks.md, checklist.md
- Spec Kit agent and prompt templates (clarify, checklist, analyze)
- OpenAPI 3.1 specification for all dashboard APIs
- Redoc UI at `/api/docs/redoc`
- Structured JSON logger with request ID correlation
- Retry with exponential backoff and circuit breaker
- Zod-validated environment configuration
- CSP nonce support + CSP violation reporting endpoint
- Dependabot configuration for automated dependency updates

### Changed
- Updated CSP to use nonces (`experimental.cspNonce: true` in next.config.mjs)
- Added CSP report-uri endpoint (`/api/csp-report`)
- All web API routes now import `NextRequest` type
- Dashboard auth middleware uses `SHIPREADY_CORS_ORIGIN` env var
- Health endpoint now includes rate limiting

### Fixed
- Path traversal guard in `/api/scan` (was always returning false)
- Health endpoint CORS preflight handling
- Observer tests now pass with rebuilt better-sqlite3

---

## [0.1.0] - 2025-10-11

### Added
- Production readiness scanner (82 rules, 10 categories)
- Agent observability (cost, tokens, tools, decisions, replay)
- Compliance documentation generator (EU AI Act, GDPR, CSRD, NIS2, SOC2)
- E-invoice validator (Brazil NFS-e/NF-e)
- GitHub Action for CI integration
- Next.js 15 dashboard with charts and trends
- Desktop launcher script
- 90 rules across 10 categories + 8 AI-security rules
- 615 tests passing
- CI/CD with matrix testing (Node 20.10, 22)
- SARIF upload to GitHub Code Scanning
- CodeQL security-extended analysis
- Self-verifying claims verification (`verify-claims.mjs`)

---

## Template for Future Releases

## [X.Y.Z] - YYYY-MM-DD

### Added
- Feature description

### Changed
- Change description

### Fixed
- Bug fix description

### Removed
- Removal description

### Security
- Security fix description

### Deprecated
- Deprecation description