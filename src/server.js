#!/usr/bin/env node
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createContextMiddleware } from '@ctxprotocol/sdk';
import { config } from './config.js';
import { logger, createRequestId } from './lib/logger.js';
import { createMcpServer } from './mcp/server.js';

const app = createMcpExpressApp({
  host: config.mcpHost,
  allowedHosts: config.mcpAllowedHosts || undefined
});

app.use(createContextMiddleware());

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
