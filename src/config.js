import 'dotenv/config';

const parseIntSafe = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: parseIntSafe(process.env.PORT, 3000),
  mcpHost: process.env.MCP_HOST || '127.0.0.1',
  mcpAllowedHosts: process.env.MCP_ALLOWED_HOSTS
    ? process.env.MCP_ALLOWED_HOSTS.split(',').map(v => v.trim()).filter(Boolean)
    : null,
  logLevel: process.env.LOG_LEVEL || 'info',
  contextAudience: process.env.CONTEXT_AUDIENCE || undefined,
  databaseUrl: process.env.DATABASE_URL,
  secUserAgent: process.env.SEC_USER_AGENT,
  secMinIntervalMs: parseIntSafe(process.env.SEC_MIN_INTERVAL_MS, 200),
  embeddingProvider: process.env.EMBEDDING_PROVIDER || 'openai',
  embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
  embeddingDim: parseIntSafe(process.env.EMBEDDING_DIM, 1536),
  embeddingMaxTokens: parseIntSafe(process.env.EMBEDDING_MAX_TOKENS, 7000),
  openaiApiKey: process.env.OPENAI_API_KEY,
  llmProvider: process.env.LLM_PROVIDER || 'none',
  llmModel: process.env.LLM_MODEL || 'gpt-4o-mini',
  llmMaxInputTokens: parseIntSafe(process.env.LLM_MAX_INPUT_TOKENS, 6000),
  tavilyApiKey: process.env.TAVILY_API_KEY,
  tavilyMaxResults: parseIntSafe(process.env.TAVILY_MAX_RESULTS, 3),
  tavilyTimeoutMs: parseIntSafe(process.env.TAVILY_TIMEOUT_MS, 10000),
  transcriptProvider: process.env.TRANSCRIPT_PROVIDER || 'fmp',
  fmpApiKey: process.env.FMP_API_KEY,
  chunkMaxWords: parseIntSafe(process.env.CHUNK_MAX_WORDS, 900),
  chunkOverlapWords: parseIntSafe(process.env.CHUNK_OVERLAP_WORDS, 120),
  ingestFilingConcurrency: parseIntSafe(process.env.INGEST_FILING_CONCURRENCY, 1),
  ingestSectionConcurrency: parseIntSafe(process.env.INGEST_SECTION_CONCURRENCY, 3),
  precomputeConcurrency: parseIntSafe(process.env.PRECOMPUTE_CONCURRENCY, 3)
};

if (!config.databaseUrl) {
  // eslint-disable-next-line no-console
  console.warn('DATABASE_URL is not set. Server will fail on DB access.');
}
if (!config.secUserAgent) {
  // eslint-disable-next-line no-console
  console.warn('SEC_USER_AGENT is not set. SEC requests will fail.');
}
