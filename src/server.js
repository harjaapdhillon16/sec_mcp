#!/usr/bin/env node
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createContextMiddleware } from '@ctxprotocol/sdk';
import { config } from './config.js';
import { logger, createRequestId } from './lib/logger.js';
import { createMcpServer } from './mcp/server.js';
import { db } from './db/index.js';
import { embedText } from './lib/embeddings.js';

const HEALTH_TIMEOUT_MS = 8000;

const withTimeout = (promise, timeoutMs, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    reject(new Error(`${label} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  promise.then(
    (value) => {
      clearTimeout(timer);
      resolve(value);
    },
    (error) => {
      clearTimeout(timer);
      reject(error);
    }
  );
});

const fetchWithTimeout = async (url, options, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const parseNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const checkDatabase = async () => {
  await db.query('select 1');
  return { ok: true };
};

const checkEmbeddings = async () => {
  if (config.embeddingProvider === 'openai' && !config.openaiApiKey) {
    return { ok: false, status: 'missing_api_key' };
  }
  const embedding = await embedText('health check');
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('Embedding service returned empty vector');
  }
  return { ok: true, provider: config.embeddingProvider, dim: embedding.length };
};

const checkOpenAiCredits = async () => {
  const requiresOpenAI = config.embeddingProvider === 'openai' || config.llmProvider === 'openai';
  if (!config.openaiApiKey) {
    return {
      ok: !requiresOpenAI,
      status: requiresOpenAI ? 'missing_api_key' : 'skipped',
      required: requiresOpenAI
    };
  }

  const response = await fetchWithTimeout(
    'https://api.openai.com/v1/dashboard/billing/credit_grants',
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`
      }
    },
    HEALTH_TIMEOUT_MS
  );

  if (!response.ok) {
    const body = await response.text().catch(() => null);
    return {
      ok: false,
      status: 'error',
      httpStatus: response.status,
      error: body ? body.slice(0, 200) : response.statusText
    };
  }

  const data = await response.json().catch(() => ({}));
  const totalAvailable = parseNumber(data?.total_available);
  const totalGranted = parseNumber(data?.total_granted);
  const totalUsed = parseNumber(data?.total_used);
  const available = totalAvailable ?? (totalGranted !== null && totalUsed !== null
    ? totalGranted - totalUsed
    : null);
  const ok = available !== null ? available > 0 : false;

  return {
    ok,
    status: ok ? 'ok' : 'insufficient_quota',
    totalAvailable: available,
    totalGranted,
    totalUsed
  };
};

const runCheck = async (name, fn, timeoutMs) => {
  const start = Date.now();
  try {
    const result = await withTimeout(Promise.resolve().then(fn), timeoutMs, name);
    const ok = typeof result?.ok === 'boolean' ? result.ok : true;
    return { name, ok, durationMs: Date.now() - start, ...result };
  } catch (error) {
    return {
      name,
      ok: false,
      durationMs: Date.now() - start,
      error: error?.message || 'Unknown error'
    };
  }
};

const app = createMcpExpressApp({
  host: config.mcpHost,
  allowedHosts: config.mcpAllowedHosts || undefined
});

app.use(createContextMiddleware());

app.get('/health', async (req, res) => {
  const start = Date.now();
  const checks = await Promise.all([
    runCheck('database', checkDatabase, HEALTH_TIMEOUT_MS),
    runCheck('openai', checkOpenAiCredits, HEALTH_TIMEOUT_MS),
    runCheck('embeddings', checkEmbeddings, HEALTH_TIMEOUT_MS)
  ]);
  const checkMap = checks.reduce((acc, item) => {
    const { name, ...rest } = item;
    acc[name] = rest;
    return acc;
  }, {});
  const ok = checks.every(check => check.ok);
  const status = ok ? 'ok' : 'error';
  res.status(ok ? 200 : 503).json({
    status,
    durationMs: Date.now() - start,
    checks: checkMap
  });
});

app.post('/mcp', async (req, res) => {
  const requestId = createRequestId();
  const reqLogger = logger.child({ requestId });
  const start = Date.now();
  reqLogger.info('MCP request received', { method: req.body?.method });
  const server = createMcpServer();
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      reqLogger.info('MCP request completed', { durationMs: Date.now() - start });
      transport.close();
      server.close();
    });
  } catch (error) {
    reqLogger.error('Error handling MCP request', { error: error?.message });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error'
        },
        id: null
      });
    }
  }
});

const methodNotAllowed = (req, res) => {
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message: 'Method not allowed.'
    },
    id: null
  }));
};

app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

app.listen(config.port, (error) => {
  if (error) {
    logger.error('Failed to start server', { error: error?.message });
    process.exit(1);
  }
  logger.info('MCP server listening', { port: config.port });
});
