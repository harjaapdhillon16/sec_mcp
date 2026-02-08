#!/usr/bin/env node
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createContextMiddleware } from '@ctxprotocol/sdk';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { createMcpServer } from './mcp/server.js';

const app = createMcpExpressApp({
  host: config.mcpHost,
  allowedHosts: config.mcpAllowedHosts || undefined
});

app.use((req, res, next) => {
  const logResponse = (body) => {
    if (res.locals?.__responseLogged) return;
    res.locals.__responseLogged = true;
    logger.info('HTTP response', { statusCode: res.statusCode, body });
  };
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    logResponse(body);
    return originalJson(body);
  };
  const originalSend = res.send.bind(res);
  res.send = (body) => {
    logResponse(body);
    return originalSend(body);
  };
  next();
});

app.use(createContextMiddleware({ audience: config.contextAudience }));

app.post('/mcp', async (req, res) => {
  const server = createMcpServer();
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    if (!res.headersSent) {
      const payload = {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error'
        },
        id: null
      };
      res.status(500).json(payload);
    }
  }
});

const methodNotAllowed = (req, res) => {
  const payload = {
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message: 'Method not allowed.'
    },
    id: null
  };
  res.status(200).json(payload);
};

app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

app.get('/health', (req, res) => {
  const payload = {
    status: 'ok'
  };
  res.status(200).json(payload);
});

app.listen(config.port, (error) => {
  if (error) {
    process.exit(1);
  }
});
