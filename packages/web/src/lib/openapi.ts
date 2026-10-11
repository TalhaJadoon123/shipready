// OpenAPI 3.1 Specification for ShipReady Dashboard API
// Generated from Zod schemas in api-schema.ts


// Re-export Zod schemas for reference
export {
  postScanSchema,
  findingsQuerySchema,
  trendsQuerySchema,
  postTraceSchema,
  traceQuerySchema,
  validateInvoiceSchema,
  postComplianceSchema,
} from './api-schema.js';

/**
 * Generates the OpenAPI 3.1 specification for all dashboard API routes.
 * This is a static representation - in production, this could be generated
 * from the Zod schemas at build time.
 */
export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'ShipReady Dashboard API',
    version: '0.1.0',
    description: 'Production readiness dashboard API for scanning, observability, compliance, and e-invoicing.',
    contact: {
      name: 'ShipReady',
      url: 'https://shipready.ai',
      email: 'security@shipready.ai',
    },
    license: {
      name: 'MIT',
      url: 'https://opensource.org/licenses/MIT',
    },
  },
  servers: [
    {
      url: 'http://localhost:3001',
      description: 'Development server',
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Dashboard authentication token (SHIPREADY_DASHBOARD_TOKEN)',
      },
      cookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: 'SHIPREADY_DASHBOARD_TOKEN',
        description: 'Dashboard authentication cookie',
      },
    },
    schemas: {
      // --- Scan ---
      ScanRequest: {
        type: 'object',
        required: ['projectId', 'report'],
        properties: {
          projectId: { type: 'string', description: 'Project identifier' },
          report: { type: 'object', description: 'Production readiness report from CLI' },
          commitSha: { type: 'string', description: 'Git commit SHA' },
          branch: { type: 'string', description: 'Git branch name' },
        },
      },
      ScanResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          scanId: { type: 'number' },
          score: { type: 'number' },
          grade: { type: 'string' },
          verdict: { type: 'string' },
          blockers: { type: 'number' },
          fixable: { type: 'number' },
        },
      },
      ScanPutRequest: {
        type: 'object',
        required: ['projectId'],
        properties: {
          path: { type: 'string', description: 'Repository path to scan' },
          projectId: { type: 'string', description: 'Project identifier' },
        },
      },
      // --- Findings ---
      FindingsQuery: {
        type: 'object',
        required: ['projectId'],
        properties: {
          projectId: { type: 'string' },
          scanId: { type: 'number' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          category: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 500 },
        },
      },
      Finding: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          ruleId: { type: 'string' },
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          category: { type: 'string' },
          path: { type: 'string' },
          line: { type: 'number' },
          effortMinutes: { type: 'number' },
          fixable: { type: 'boolean' },
        },
      },
      FindingsResponse: {
        type: 'object',
        properties: {
          findings: { type: 'array', items: { $ref: '#/components/schemas/Finding' } },
          total: { type: 'number' },
          scanId: { type: 'number' },
          scannedAt: { type: 'string', format: 'date-time' },
        },
      },
      // --- Trends ---
      TrendsQuery: {
        type: 'object',
        required: ['projectId'],
        properties: {
          projectId: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 60 },
        },
      },
      TrendPoint: {
        type: 'object',
        properties: {
          at: { type: 'string', format: 'date-time' },
          score: { type: 'number' },
          blockers: { type: 'number' },
        },
      },
      CategoryScore: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          label: { type: 'string' },
          score: { type: 'number' },
          weight: { type: 'number' },
          findings: { type: 'number' },
          blockers: { type: 'number' },
        },
      },
      TrendsResponse: {
        type: 'object',
        properties: {
          points: { type: 'array', items: { $ref: '#/components/schemas/TrendPoint' } },
          categories: { type: 'object', additionalProperties: { $ref: '#/components/schemas/CategoryScore' } },
          delta: { type: 'number' },
          direction: { type: 'string', enum: ['up', 'down', 'flat'] },
          latest: {
            type: 'object',
            properties: {
              score: { type: 'number' },
              grade: { type: 'string' },
              verdict: { type: 'string' },
              blockers: { type: 'number' },
              scannedAt: { type: 'string', format: 'date-time' },
              commitSha: { type: 'string' },
              branch: { type: 'string' },
            },
            nullable: true,
          },
        },
      },
      // --- Observability / Traces ---
      PostTraceRequest: {
        type: 'object',
        required: ['projectId', 'trace'],
        properties: {
          projectId: { type: 'string' },
          trace: {
            type: 'object',
            required: ['id', 'startedAt', 'command'],
            properties: {
              id: { type: 'string' },
              startedAt: { type: 'string', format: 'date-time' },
              command: { type: 'string' },
              durationMs: { type: 'number' },
              exitCode: { type: 'number', nullable: true },
              totalCostUsd: { type: 'number' },
              costComplete: { type: 'boolean' },
              totalInputTokens: { type: 'number' },
              totalOutputTokens: { type: 'number' },
              llmCalls: { type: 'number' },
              toolCalls: { type: 'number' },
              errors: { type: 'number' },
            },
          },
        },
      },
      TraceQuery: {
        type: 'object',
        required: ['projectId'],
        properties: {
          projectId: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 50 },
        },
      },
      TraceRecord: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          projectId: { type: 'string' },
          command: { type: 'string' },
          startedAt: { type: 'string', format: 'date-time' },
          durationMs: { type: 'number' },
          exitCode: { type: 'number', nullable: true },
          totalCostUsd: { type: 'number' },
          costComplete: { type: 'boolean' },
          inputTokens: { type: 'number' },
          outputTokens: { type: 'number' },
          llmCalls: { type: 'number' },
          toolCalls: { type: 'number' },
          errors: { type: 'number' },
        },
      },
      TracesResponse: {
        type: 'object',
        properties: {
          traces: { type: 'array', items: { $ref: '#/components/schemas/TraceRecord' } },
          totals: {
            type: 'object',
            properties: {
              costUsd: { type: 'number' },
              inputTokens: { type: 'number' },
              outputTokens: { type: 'number' },
              llmCalls: { type: 'number' },
              toolCalls: { type: 'number' },
              errors: { type: 'number' },
            },
          },
          costComplete: { type: 'boolean' },
        },
      },
      // --- E-Invoice ---
      ValidateInvoiceRequest: {
        type: 'object',
        required: ['xml'],
        properties: {
          xml: { type: 'string', description: 'Invoice XML content' },
          fix: { type: 'boolean', default: false },
          projectId: { type: 'string' },
        },
      },
      ValidateInvoiceResponse: {
        type: 'object',
        properties: {
          valid: { type: 'boolean' },
          score: { type: 'number' },
          counts: {
            type: 'object',
            properties: {
              errors: { type: 'number' },
              warnings: { type: 'number' },
              info: { type: 'number' },
            },
          },
          issues: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                severity: { type: 'string', enum: ['error', 'warning', 'info'] },
                code: { type: 'string' },
                message: { type: 'string' },
                path: { type: 'string' },
              },
            },
          },
          computed: { type: 'object' },
          invoiceId: { type: 'number' },
        },
      },
      InvoiceRecord: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          projectId: { type: 'string', nullable: true },
          country: { type: 'string' },
          documentType: { type: 'string' },
          number: { type: 'string' },
          issuer: { type: 'string' },
          total: { type: 'number' },
          currency: { type: 'string' },
          valid: { type: 'boolean' },
          score: { type: 'number' },
          errorCount: { type: 'number' },
          issues: { type: 'array' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      InvoicesResponse: {
        type: 'object',
        properties: {
          invoices: { type: 'array', items: { $ref: '#/components/schemas/InvoiceRecord' } },
          supported: { type: 'array', items: { type: 'string' } },
          passRate: { type: 'number', nullable: true },
        },
      },
      // --- Compliance ---
      PostComplianceRequest: {
        type: 'object',
        required: ['answer'],
        properties: {
          projectId: { type: 'string' },
          answer: { type: 'object', description: 'Compliance questionnaire answers' },
          format: { type: 'string', enum: ['md', 'json', 'docx'] },
        },
      },
      PostCompliancePackRequest: {
        type: 'object',
        required: ['projectId', 'pack'],
        properties: {
          projectId: { type: 'string' },
          pack: {
            type: 'object',
            properties: {
              company: { type: 'string' },
              systemName: { type: 'string' },
              jurisdiction: { type: 'string' },
              frameworks: { type: 'array', items: { type: 'string' } },
              score: { type: 'number' },
              gaps: { type: 'array' },
              documentCount: { type: 'number' },
            },
          },
        },
      },
      ComplianceResponse: {
        type: 'object',
        properties: {
          frameworks: { type: 'array', items: { type: 'string' } },
          documents: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                reference: { type: 'string' },
                gapCount: { type: 'number' },
                unresolved: { type: 'boolean' },
                content: { type: 'string' },
                markdown: { type: 'string' },
              },
            },
          },
          gaps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                severity: { type: 'string', enum: ['blocker', 'critical', 'high', 'medium', 'low'] },
                message: { type: 'string' },
                action: { type: 'string' },
              },
            },
          },
          score: { type: 'number' },
          report: { type: 'string' },
        },
      },
      CompliancePackResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          complianceId: { type: 'number' },
        },
      },
      ComplianceListResponse: {
        type: 'object',
        properties: {
          packs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'number' },
                projectId: { type: 'string' },
                company: { type: 'string' },
                systemName: { type: 'string' },
                jurisdiction: { type: 'string' },
                frameworks: { type: 'array', items: { type: 'string' } },
                score: { type: 'number' },
                gaps: { type: 'array' },
                documentCount: { type: 'number' },
                createdAt: { type: 'string', format: 'date-time' },
              },
            },
          },
          latest: {
            type: 'object',
            nullable: true,
          },
        },
      },
      // --- Health ---
      HealthResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          driver: { type: 'string', enum: ['postgres', 'pglite', 'memory'] },
          version: { type: 'string' },
          defaultThreshold: { type: 'number' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
      // --- Error ---
      ErrorResponse: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
    responses: {
      BadRequest: {
        description: 'Invalid request',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ErrorResponse' },
          },
        },
      },
      Unauthorized: {
        description: 'Authentication required',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ErrorResponse' },
          },
        },
      },
      Forbidden: {
        description: 'Path not allowed',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ErrorResponse' },
          },
        },
      },
      TooManyRequests: {
        description: 'Rate limit exceeded',
        headers: {
          'Retry-After': {
            schema: { type: 'string' },
          },
          'X-RateLimit-Limit': {
            schema: { type: 'string' },
          },
          'X-RateLimit-Remaining': {
            schema: { type: 'string' },
          },
          'X-RateLimit-Reset': {
            schema: { type: 'string' },
          },
        },
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ErrorResponse' },
          },
        },
      },
    },
  },
  paths: {
    '/api/scan': {
      post: {
        summary: 'Upload a production readiness report from CLI',
        operationId: 'postScan',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ScanRequest' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Report stored successfully',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ScanResponse' },
              },
            },
          },
          '400': {
            description: 'Invalid request body',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          '429': {
            description: 'Rate limit exceeded',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
      put: {
        summary: 'Scan a repository the dashboard can reach',
        operationId: 'putScan',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        parameters: [
          { name: 'path', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'projectId', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '201': {
            description: 'Scan completed',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ScanResponse' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '429': { $ref: '#/components/responses/TooManyRequests' },
        },
      },
    },
    '/api/findings': {
      get: {
        summary: 'Get findings for a project/scan',
        operationId: 'getFindings',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        parameters: [
          { name: 'projectId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'scanId', in: 'query', schema: { type: 'integer' } },
          { name: 'severity', in: 'query', schema: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] } },
          { name: 'category', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 500 } },
        ],
        responses: {
          '200': {
            description: 'Findings list',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/FindingsResponse' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/TooManyRequests' },
        },
      },
    },
    '/api/trends': {
      get: {
        summary: 'Get readiness trends and radar data',
        operationId: 'getTrends',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        parameters: [
          { name: 'projectId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 60 } },
        ],
        responses: {
          '200': {
            description: 'Trends data',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TrendsResponse' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/TooManyRequests' },
        },
      },
    },
    '/api/observe/traces': {
      post: {
        summary: 'Upload a trace summary from CLI observer',
        operationId: 'postTrace',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/PostTraceRequest' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Trace stored',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TraceRecord' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/TooManyRequests' },
        },
      },
      get: {
        summary: 'Get trace history for a project',
        operationId: 'getTraces',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        parameters: [
          { name: 'projectId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 50 } },
        ],
        responses: {
          '200': {
            description: 'Traces list with totals',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TracesResponse' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/TooManyRequests' },
        },
      },
    },
    '/api/validate-invoice': {
      post: {
        summary: 'Validate an e-invoice (Brazil NFS-e/NF-e)',
        operationId: 'validateInvoice',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ValidateInvoiceRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Validation result',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ValidateInvoiceResponse' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/TooManyRequests' },
        },
      },
      get: {
        summary: 'Get invoice validation history',
        operationId: 'getInvoices',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        parameters: [
          { name: 'projectId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 50 } },
        ],
        responses: {
          '200': {
            description: 'Invoice history',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/InvoicesResponse' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/TooManyRequests' },
        },
      },
    },
    '/api/comply/generate': {
      post: {
        summary: 'Generate compliance documentation pack',
        operationId: 'generateCompliance',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/PostComplianceRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Generated compliance pack',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ComplianceResponse' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/TooManyRequests' },
        },
      },
      get: {
        summary: 'Get compliance pack history',
        operationId: 'getCompliancePacks',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        parameters: [
          { name: 'projectId', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Compliance packs list',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ComplianceListResponse' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/api/health': {
      get: {
        summary: 'Health check endpoint',
        operationId: 'getHealth',
        responses: {
          '200': {
            description: 'Health status',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthResponse' },
              },
            },
          },
        },
      },
      options: {
        summary: 'CORS preflight for health endpoint',
        operationId: 'optionsHealth',
        responses: {
          '204': {
            description: 'CORS preflight successful',
          },
        },
      },
    },
  },
};




