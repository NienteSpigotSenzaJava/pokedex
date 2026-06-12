#!/usr/bin/env node
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import express, { type Request } from 'express';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import WebSocket, { WebSocketServer } from 'ws';
import {
  AgentResponseSchema,
  mcpToolNames,
  parseJsonc,
  toMcpText,
  type AgentRequest,
  type McpToolName,
  type ToolResult,
} from '@pokedex/protocol';
import { SecurityError, redactSecrets, verifyBearerToken } from '@pokedex/security';
import { mcpToolDefinitions, toolSpecs } from './tools.js';

const defaultPort = 4200;
const options = relayOptions();

const logger = pino({
  name: 'pokedex-relay',
  level: 'warn',
  redact: ['req.headers.authorization', 'req.query.token', 'req.url'],
});
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/agent' });
const relayToken = options.token;
const expectedUserId = options.userId;
const agents = new Map<string, WebSocket>();
const pending = new Map<
  string,
  {
    userId: string;
    resolve: (value: ToolResult) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }
>();
const mcpToolNameSet = new Set<string>(mcpToolNames);
const protocolVersion = '2025-11-25';
const agentResponseTimeoutMs = 600_000;
const shutdownGraceMs = 3_000;
const shutdownSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
let shuttingDown = false;

app.use(express.json({ limit: '1mb' }));
app.use(pinoHttp({ logger }));
server.on('error', exitOnListenError);
wss.on('error', exitOnListenError);
for (const signal of shutdownSignals) {
  process.once(signal, () => void shutdown(signal));
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, name: 'pokedex', agents: agents.size, tools: toolSpecs.length });
});

app.get('/mcp', async (req, res) => {
  try {
    if (req.accepts(['text/event-stream', 'json']) === 'text/event-stream') {
      authenticateMcpRequest(req);
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('connection', 'keep-alive');
      res.type('text/event-stream').send(': pokedex has no server-side events\n\n');
      return;
    }
    res.json(serverInfo());
  } catch (error) {
    const status = error instanceof SecurityError ? 401 : 500;
    req.log.warn({ err: redactSecrets(error) }, 'mcp request failed');
    if (!res.headersSent)
      res
        .status(status)
        .json({ error: error instanceof Error ? error.message : 'mcp request failed' });
  }
});

app.post('/mcp', handleMcpRequest);

app.get(/^\/(?:.*)?$/, (_req, res) => {
  res.json(serverInfo());
});

app.post(/^\/(?:.*)?$/, handleMcpRequest);

function serverInfo() {
  return {
    ok: true,
    name: 'pokedex',
    mcp: 'post Streamable HTTP MCP requests to /mcp',
    agentPath: '/agent',
    agents: agents.size,
    tools: mcpToolNames,
  };
}

async function handleMcpRequest(req: Request, res: express.Response): Promise<void> {
  const startedAt = Date.now();
  let completed = false;
  res.on('close', () => {
    if (completed) return;
    req.log.warn({ elapsedMs: Date.now() - startedAt }, 'mcp client disconnected before response');
  });
  try {
    const userId = authenticateMcpRequest(req);
    const response = await handleJsonRpc(userId, req.body);
    if (!response) {
      completed = true;
      res.status(202).send('');
      return;
    }
    res.setHeader('mcp-session-id', req.header('mcp-session-id') ?? randomUUID());
    completed = true;
    res.json(response);
  } catch (error) {
    const status = error instanceof SecurityError ? 401 : 500;
    req.log.warn({ err: redactSecrets(error) }, 'mcp request failed');
    if (!res.headersSent) {
      completed = true;
      res
        .status(status)
        .json({ error: error instanceof Error ? error.message : 'mcp request failed' });
    }
  }
}

async function handleJsonRpc(userId: string, body: unknown): Promise<unknown> {
  const messages = Array.isArray(body) ? body : [body];
  const responses = (
    await Promise.all(messages.map(async (message) => await handleJsonRpcMessage(userId, message)))
  ).filter(Boolean);
  if (responses.length === 0) return undefined;
  return Array.isArray(body) ? responses : responses[0];
}

async function handleJsonRpcMessage(userId: string, message: unknown): Promise<unknown> {
  if (!isJsonRpcRequest(message)) return jsonRpcError(null, -32600, 'invalid json-rpc request');
  if (message.id === undefined) return undefined;
  if (message.method === 'initialize') {
    return jsonRpcResult(message.id, {
      protocolVersion:
        typeof message.params?.protocolVersion === 'string'
          ? message.params.protocolVersion
          : protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'pokedex', version: '0.1.0', title: 'pokedex' },
    });
  }
  if (message.method === 'tools/list')
    return jsonRpcResult(message.id, { tools: mcpToolDefinitions() });
  if (message.method === 'tools/call')
    return await handleToolCall(userId, message.id, message.params);
  return jsonRpcError(message.id, -32601, `unsupported method: ${message.method}`);
}

async function handleToolCall(
  userId: string,
  id: string | number | null,
  params: Record<string, unknown> | undefined
): Promise<unknown> {
  const name = typeof params?.name === 'string' ? params.name : '';
  if (!mcpToolNameSet.has(name))
    return jsonRpcError(id, -32601, `tool not found: ${name || 'unknown'}`);
  const args =
    typeof params?.arguments === 'object' && params.arguments !== null
      ? (params.arguments as Record<string, unknown>)
      : {};
  const result = await callAgent({
    id: randomUUID(),
    userId,
    toolName: name as McpToolName,
    arguments: args,
  });
  return jsonRpcResult(id, {
    content: [{ type: 'text', text: toMcpText(result) }],
    isError: !result.ok,
  });
}

function isJsonRpcRequest(
  value: unknown
): value is { id?: string | number | null; method: string; params?: Record<string, unknown> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'method' in value &&
    typeof value.method === 'string'
  );
}

function jsonRpcResult(id: string | number | null, result: unknown): object {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id: string | number | null, code: number, message: string): object {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

wss.on('connection', (socket, request) => {
  try {
    verifyBearerToken(request.headers.authorization, relayToken);
    const url = new URL(request.url ?? '/agent', 'http://localhost');
    const userId = url.searchParams.get('userId') ?? expectedUserId;
    if (!userId) throw new SecurityError('missing user id');
    agents.set(userId, socket);
    logger.info({ userId }, 'agent connected');

    socket.on('message', (raw) => {
      try {
        const response = AgentResponseSchema.parse(JSON.parse(raw.toString()));
        const waiting = pending.get(response.id);
        if (!waiting) return;
        clearTimeout(waiting.timeout);
        pending.delete(response.id);
        if (response.error) waiting.reject(new Error(response.error));
        else
          waiting.resolve(
            response.result ?? { ok: false, summary: 'agent returned no result', data: {} }
          );
      } catch (error) {
        logger.warn({ err: redactSecrets(error) }, 'agent response could not be parsed');
      }
    });

    socket.on('close', () => {
      if (agents.get(userId) === socket) agents.delete(userId);
      rejectPendingForUser(userId, new Error('local codex agent disconnected before answering'));
      logger.warn({ userId }, 'agent disconnected');
    });
  } catch (error) {
    logger.warn(
      {
        err: redactSecrets(error),
        reason: error instanceof Error ? error.message : 'unknown error',
      },
      'agent connection rejected'
    );
    socket.close(1008, 'unauthorized');
  }
});

function authenticateMcpRequest(req: Request): string {
  const headerUserId = req.header('x-pokedex-user-id') ?? req.header('x-poke-user-id');
  req.log.info(
    {
      path: req.path,
      hasAuthorization: Boolean(req.header('authorization')),
      hasTokenQuery: typeof req.query.token === 'string',
      hasUserId: Boolean(headerUserId),
    },
    'mcp request routed'
  );
  verifyBearerToken(
    req.header('authorization') ??
      (typeof req.query.token === 'string' ? `Bearer ${req.query.token}` : undefined),
    relayToken
  );
  const userId = expectedUserId || headerUserId;
  if (!userId) throw new SecurityError('missing pokedex user id');
  return userId;
}

async function callAgent(request: AgentRequest): Promise<ToolResult> {
  if (shuttingDown)
    return {
      ok: false,
      summary: 'relay is shutting down.',
      data: { connected: false },
    };

  const socket =
    agents.get(request.userId) ?? (agents.size === 1 ? [...agents.values()][0] : undefined);
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return {
      ok: false,
      summary: 'local codex agent is not connected.',
      data: { connected: false },
    };
  }

  return await new Promise<ToolResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(request.id);
      reject(new Error('agent response timeout'));
    }, agentResponseTimeoutMs);

    pending.set(request.id, { userId: request.userId, resolve, reject, timeout });
    try {
      socket.send(JSON.stringify(request));
    } catch (error) {
      clearTimeout(timeout);
      pending.delete(request.id);
      reject(error instanceof Error ? error : new Error('agent websocket send failed'));
    }
  });
}

function rejectPendingForUser(userId: string, error: Error): void {
  for (const [id, waiting] of pending) {
    if (waiting.userId !== userId) continue;
    clearTimeout(waiting.timeout);
    pending.delete(id);
    waiting.reject(error);
  }
}

function rejectAllPending(error: Error): void {
  for (const [id, waiting] of pending) {
    clearTimeout(waiting.timeout);
    pending.delete(id);
    waiting.reject(error);
  }
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'relay shutting down');
  rejectAllPending(new Error('relay stopped before the local codex agent answered'));
  closeAgentSockets();
  const forceExit = setTimeout(() => {
    terminateAgentSockets();
    server.closeAllConnections();
    logger.warn({ signal }, 'relay shutdown forced after grace period');
    process.exit(1);
  }, shutdownGraceMs);
  forceExit.unref();
  await Promise.allSettled([closeWebSocketServer(), closeHttpServer()]);
  clearTimeout(forceExit);
  process.exit(0);
}

function closeAgentSockets(): void {
  for (const socket of new Set(wss.clients)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
      socket.close(1001, 'relay shutting down');
  }
  agents.clear();
}

function terminateAgentSockets(): void {
  for (const socket of wss.clients) socket.terminate();
}

function closeWebSocketServer(): Promise<void> {
  return new Promise((resolve) => wss.close(() => resolve()));
}

function closeHttpServer(): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}

function relayOptions(): { port: number; token: string; userId: string } {
  const configPath =
    value('--config') ??
    (existsSync(existingDefaultConfigPath()) ? existingDefaultConfigPath() : undefined);
  if (configPath) {
    const config = parseJsonc(readFileSync(configPath, 'utf8')) as {
      port?: string | number;
      relayToken?: string;
      userId?: string;
    };
    return {
      port: Number(value('--port') ?? config.port ?? defaultPort),
      token: value('--token') ?? config.relayToken ?? randomBytes(32).toString('hex'),
      userId: value('--user-id') ?? config.userId ?? 'local',
    };
  }

  return {
    port: Number(value('--port') ?? defaultPort),
    token: value('--token') ?? randomBytes(32).toString('hex'),
    userId: value('--user-id') ?? '',
  };
}

function value(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function defaultConfigPath(): string {
  return join(homedir(), '.pokedex', 'config.jsonc');
}

function legacyConfigPath(): string {
  return join(homedir(), '.pokedex', 'config.json');
}

function existingDefaultConfigPath(): string {
  return existsSync(defaultConfigPath()) ? defaultConfigPath() : legacyConfigPath();
}

function exitOnListenError(error: Error): void {
  logger.error({ err: error }, 'relay failed to listen');
  process.exit(1);
}

server.listen(options.port, '127.0.0.1', () =>
  logger.info({ host: '127.0.0.1', port: options.port }, 'relay listening')
);
