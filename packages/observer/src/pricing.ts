/**
 * Priced model catalogue for cost estimation.
 *
 * Prices are per million tokens and are the thing most people get wrong when
 * estimating an agent's cost by hand. They change often, so they live in one
 * place, are versioned, and are overridable from config -- rather than being
 * hardcoded into the observer.
 *
 * Source: provider published pricing. `asOf` is when these were last checked;
 * the CLI prints it when a cost estimate is materially uncertain.
 */
export interface ModelPrice {
  /** Provider-prefixed model id, e.g. `openai/gpt-4o`. */
  id: string;
  provider: Provider;
  /** USD per million input tokens. */
  inputPerMillion: number;
  /** USD per million output tokens. */
  outputPerMillion: number;
  /** USD per million cached input tokens, where the provider offers one. */
  cachedInputPerMillion?: number;
  /** Context window in tokens. */
  contextWindow?: number;
  /** Maximum output tokens per request. */
  maxOutput?: number;
  /** True when the provider does not charge, e.g. a local Ollama model. */
  free?: boolean;
  asOf: string;
}

export type Provider = 'openai' | 'anthropic' | 'google' | 'mistral' | 'meta' | 'local' | 'unknown';

const AS_OF = '2026-01';

export const MODEL_PRICES: readonly ModelPrice[] = Object.freeze([
  // --- OpenAI ---------------------------------------------------------------
  { id: 'openai/gpt-4o-mini', provider: 'openai', inputPerMillion: 0.15, outputPerMillion: 0.6, cachedInputPerMillion: 0.075, contextWindow: 128_000, maxOutput: 16_384, asOf: AS_OF },
  { id: 'openai/gpt-4o', provider: 'openai', inputPerMillion: 2.5, outputPerMillion: 10, cachedInputPerMillion: 1.25, contextWindow: 128_000, maxOutput: 16_384, asOf: AS_OF },
  { id: 'openai/gpt-4.1', provider: 'openai', inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.5, contextWindow: 1_000_000, maxOutput: 32_768, asOf: AS_OF },
  { id: 'openai/gpt-4.1-mini', provider: 'openai', inputPerMillion: 0.4, outputPerMillion: 1.6, cachedInputPerMillion: 0.1, contextWindow: 1_000_000, maxOutput: 32_768, asOf: AS_OF },
  { id: 'openai/gpt-4.1-nano', provider: 'openai', inputPerMillion: 0.1, outputPerMillion: 0.4, cachedInputPerMillion: 0.025, contextWindow: 1_000_000, maxOutput: 32_768, asOf: AS_OF },
  { id: 'openai/o3-mini', provider: 'openai', inputPerMillion: 1.1, outputPerMillion: 4.4, cachedInputPerMillion: 0.55, contextWindow: 200_000, maxOutput: 100_000, asOf: AS_OF },
  { id: 'openai/o3', provider: 'openai', inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.5, contextWindow: 200_000, maxOutput: 100_000, asOf: AS_OF },
  { id: 'openai/text-embedding-3-small', provider: 'openai', inputPerMillion: 0.02, outputPerMillion: 0, contextWindow: 8_191, asOf: AS_OF },
  { id: 'openai/text-embedding-3-large', provider: 'openai', inputPerMillion: 0.13, outputPerMillion: 0, contextWindow: 8_191, asOf: AS_OF },

  // --- Anthropic ------------------------------------------------------------
  { id: 'anthropic/claude-3-5-haiku', provider: 'anthropic', inputPerMillion: 0.8, outputPerMillion: 4, cachedInputPerMillion: 0.08, contextWindow: 200_000, maxOutput: 8_192, asOf: AS_OF },
  { id: 'anthropic/claude-3-5-sonnet', provider: 'anthropic', inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3, contextWindow: 200_000, maxOutput: 8_192, asOf: AS_OF },
  { id: 'anthropic/claude-3-7-sonnet', provider: 'anthropic', inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3, contextWindow: 200_000, maxOutput: 64_000, asOf: AS_OF },
  { id: 'anthropic/claude-sonnet-4', provider: 'anthropic', inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3, contextWindow: 200_000, maxOutput: 64_000, asOf: AS_OF },
  { id: 'anthropic/claude-opus-4', provider: 'anthropic', inputPerMillion: 15, outputPerMillion: 75, cachedInputPerMillion: 1.5, contextWindow: 200_000, maxOutput: 32_000, asOf: AS_OF },
  { id: 'anthropic/claude-haiku-4-5', provider: 'anthropic', inputPerMillion: 1, outputPerMillion: 5, cachedInputPerMillion: 0.1, contextWindow: 200_000, maxOutput: 64_000, asOf: AS_OF },

  // --- Google ---------------------------------------------------------------
  { id: 'google/gemini-1.5-flash', provider: 'google', inputPerMillion: 0.075, outputPerMillion: 0.3, contextWindow: 1_000_000, maxOutput: 8_192, asOf: AS_OF },
  { id: 'google/gemini-1.5-pro', provider: 'google', inputPerMillion: 1.25, outputPerMillion: 5, contextWindow: 2_000_000, maxOutput: 8_192, asOf: AS_OF },
  { id: 'google/gemini-2.0-flash', provider: 'google', inputPerMillion: 0.1, outputPerMillion: 0.4, contextWindow: 1_000_000, maxOutput: 8_192, asOf: AS_OF },
  { id: 'google/gemini-2.5-flash', provider: 'google', inputPerMillion: 0.3, outputPerMillion: 2.5, contextWindow: 1_000_000, maxOutput: 65_536, asOf: AS_OF },
  { id: 'google/gemini-2.5-pro', provider: 'google', inputPerMillion: 1.25, outputPerMillion: 10, contextWindow: 1_000_000, maxOutput: 65_536, asOf: AS_OF },

  // --- Other providers ------------------------------------------------------
  { id: 'mistral/mistral-large', provider: 'mistral', inputPerMillion: 2, outputPerMillion: 6, contextWindow: 128_000, maxOutput: 8_192, asOf: AS_OF },
  { id: 'mistral/mistral-small', provider: 'mistral', inputPerMillion: 0.2, outputPerMillion: 0.6, contextWindow: 32_000, maxOutput: 8_192, asOf: AS_OF },
  { id: 'meta/llama-3.1-70b', provider: 'meta', inputPerMillion: 0.88, outputPerMillion: 0.88, contextWindow: 128_000, maxOutput: 8_192, asOf: AS_OF },
  { id: 'meta/llama-3.1-8b', provider: 'meta', inputPerMillion: 0.055, outputPerMillion: 0.055, contextWindow: 128_000, maxOutput: 8_192, asOf: AS_OF },

  // --- Local / self-hosted: no marginal cost ------------------------------
  { id: 'local/ollama/llama3.1', provider: 'local', inputPerMillion: 0, outputPerMillion: 0, contextWindow: 128_000, free: true, asOf: AS_OF },
  { id: 'local/ollama/qwen2.5-coder', provider: 'local', inputPerMillion: 0, outputPerMillion: 0, contextWindow: 32_000, free: true, asOf: AS_OF },
]);

const BY_ID = new Map(MODEL_PRICES.map((p) => [p.id.toLowerCase(), p]));

/**
 * Aliases people actually type. The observer normalises model strings before
 * looking them up, so `gpt-4o-mini` and `openai/gpt-4o-mini` both resolve.
 */
const ALIASES: Record<string, string> = {
  'gpt-4o-mini': 'openai/gpt-4o-mini',
  'gpt-4o': 'openai/gpt-4o',
  'gpt-4.1': 'openai/gpt-4.1',
  'gpt-4.1-mini': 'openai/gpt-4.1-mini',
  'gpt-4.1-nano': 'openai/gpt-4.1-nano',
  'gpt-3.5-turbo': 'openai/gpt-4o-mini',
  'gpt-4-turbo': 'openai/gpt-4o',
  'gpt-4': 'openai/gpt-4o',
  'o3-mini': 'openai/o3-mini',
  'o3': 'openai/o3',
  'text-embedding-3-small': 'openai/text-embedding-3-small',
  'text-embedding-3-large': 'openai/text-embedding-3-large',
  'claude-3-5-haiku': 'anthropic/claude-3-5-haiku',
  'claude-3-5-sonnet': 'anthropic/claude-3-5-sonnet',
  'claude-3-7-sonnet': 'anthropic/claude-3-7-sonnet',
  'claude-sonnet-4': 'anthropic/claude-sonnet-4',
  'claude-sonnet-4-0': 'anthropic/claude-sonnet-4',
  'claude-opus-4': 'anthropic/claude-opus-4',
  'claude-opus-4-0': 'anthropic/claude-opus-4',
  'claude-haiku-4-5': 'anthropic/claude-haiku-4-5',
  'claude-3-opus': 'anthropic/claude-opus-4',
  'gemini-1.5-flash': 'google/gemini-1.5-flash',
  'gemini-1.5-pro': 'google/gemini-1.5-pro',
  'gemini-2.0-flash': 'google/gemini-2.0-flash',
  'gemini-2.5-flash': 'google/gemini-2.5-flash',
  'gemini-2.5-pro': 'google/gemini-2.5-pro',
  'mistral-large-latest': 'mistral/mistral-large',
  'llama-3.1-70b': 'meta/llama-3.1-70b',
  'llama3.1': 'local/ollama/llama3.1',
  'llama3.1:8b': 'local/ollama/llama3.1',
  'qwen2.5-coder': 'local/ollama/qwen2.5-coder',
  'llama-3.1-8b': 'meta/llama-3.1-8b',
};

/**
 * Look up a model by any spelling.
 *
 * Returns undefined for an unknown model rather than guessing, because a wrong
 * cost estimate is worse than no cost estimate: it is acted on.
 */
export function lookupModel(rawModel: string): ModelPrice | undefined {
  if (!rawModel) return undefined;
  const needle = rawModel.trim().toLowerCase();
  const direct = BY_ID.get(needle);
  if (direct) return direct;

  const aliased = ALIASES[needle];
  if (aliased) return BY_ID.get(aliased);

  // Provider-prefixed with a version suffix, e.g. `gpt-4o-2024-08-06`.
  const base = needle.replace(/-\d{4}-\d{2}-\d{2}(-\d{2})?$/, '');
  if (base !== needle) {
    const aliasedBase = ALIASES[base];
    if (aliasedBase) return BY_ID.get(aliasedBase);
  }
  // Bedrock and Vertex style: `anthropic.claude-3-5-sonnet-...@v1:0`.
  const bedrock = /(?:anthropic|meta|mistral)\.([\w.-]+)/.exec(needle)?.[1];
  if (bedrock) {
    const key = Object.keys(ALIASES).find((k) => bedrock.startsWith(k));
    if (key) return BY_ID.get(ALIASES[key]!);
  }
  // Strip a provider prefix and retry.
  const withoutProvider = needle.replace(/^[a-z0-9_-]+\//, '');
  if (withoutProvider !== needle) {
    const inner = BY_ID.get(withoutProvider) ?? BY_ID.get(ALIASES[withoutProvider] ?? '');
    if (inner) return inner;
  }
  return undefined;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface CostEstimate {
  usd: number;
  model: string;
  /** False when the model was not in the catalogue. */
  priced: boolean;
  asOf?: string;
}

/**
 * Estimate the USD cost of one call.
 *
 * `priced: false` means we do not know this model. The observer records the
 * token counts anyway and flags the cost as unknown, rather than reporting $0
 * for a model that costs real money.
 */
export function estimateCost(model: string, usage: Usage): CostEstimate {
  const price = lookupModel(model);
  if (!price) return { usd: 0, model, priced: false };

  const cached = usage.cachedInputTokens ?? 0;
  const uncachedInput = Math.max(0, usage.inputTokens - cached);

  const usd =
    (uncachedInput / 1_000_000) * price.inputPerMillion +
    (cached / 1_000_000) * (price.cachedInputPerMillion ?? price.inputPerMillion) +
    (usage.outputTokens / 1_000_000) * price.outputPerMillion;

  return { usd: round(usd, 6), model: price.id, priced: true, asOf: price.asOf };
}

/**
 * Rough token count for text, without sending it anywhere.
 *
 * Used when a provider reports usage but not token counts, and for the
 * cost-control advice in `shipready observe`. Deliberately conservative
 * (4 chars per token): underestimating a long prompt is the safer error here,
 * because the advice is "this input is expensive", not an invoice.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Estimate cost for text in and text out.
 *
 * Warning: this ignores tokenisation, so it is wrong by tens of percent.
 * Use it for live feedback, never for billing.
 */
export function estimateTextCost(model: string, input: string, output: string): CostEstimate {
  return estimateCost(model, {
    inputTokens: estimateTokens(input),
    outputTokens: estimateTokens(output),
  });
}

function round(n: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}