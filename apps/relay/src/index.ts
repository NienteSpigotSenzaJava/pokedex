#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import express, { type Request } from "express";
import pino from "pino";
import { pinoHttp } from "pino-http";
import WebSocket, { WebSocketServer } from "ws";
import { AgentResponseSchema, mcpToolNames, toMcpText, type AgentRequest, type McpToolName, type ToolResult } from "@pokedex/protocol";
import { SecurityError, redactSecrets, verifyBearerToken } from "@pokedex/security";
import { mcpToolDefinitions, toolSpecs } from "./tools.js";

const options = relayOptions();

const logger = pino({
  name: "pokedex-relay",
  level: "warn",
  redact: ["req.headers.authorization", "req.query.token", "req.url"]
});
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/agent" });
const relayToken = options.token;
const expectedUserId = options.userId;
const agents = new Map<string, WebSocket>();
const pending = new Map<string, { resolve: (value: ToolResult) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>();
const mcpToolNameSet = new Set<string>(mcpToolNames);
const protocolVersion = "2025-11-25";
const agentResponseTimeoutMs = 120_000;

app.use(express.json({ limit: "1mb" }));
app.use(pinoHttp({ logger }));
server.on("error", exitOnListenError);
wss.on("error", exitOnListenError);

app.get("/health", (_req, res) => {
  res.json({ ok: true, name: "pokedex", agents: agents.size, tools: toolSpecs.length });
});

app.get("/mcp", async (req, res) => {
  try {
    if (req.accepts(["text/event-stream", "json"]) === "text/event-stream") {
      authenticateMcpRequest(req);
      res.setHeader("cache-control", "no-cache");
      res.setHeader("connection", "keep-alive");
      res.type("text/event-stream").send(": pokedex has no server-side events\n\n");
      return;
    }
    res.json(serverInfo());
  } catch (error) {
    const status = error instanceof SecurityError ? 401 : 500;
    req.log.warn({ err: redactSecrets(error) }, "mcp request failed");
    if (!res.headersSent) res.status(status).json({ error: error instanceof Error ? error.message : "mcp request failed" });
  }
});

app.post("/mcp", handleMcpRequest);

app.get(/^\/(?:.*)?$/, (_req, res) => {
  res.json(serverInfo());
});

app.post(/^\/(?:.*)?$/, handleMcpRequest);

function serverInfo() {
  return {
    ok: true,
    name: "pokedex",
    mcp: "post Streamable HTTP MCP requests to /mcp",
    agentPath: "/agent",
    agents: agents.size,
    tools: mcpToolNames
  };
}

async function handleMcpRequest(req: Request, res: express.Response): Promise<void> {
  try {
    const userId = authenticateMcpRequest(req);
    const response = await handleJsonRpc(userId, req.body);
    if (!response) {
      res.status(202).send("");
      return;
    }
    res.setHeader("mcp-session-id", req.header("mcp-session-id") ?? randomUUID());
    res.json(response);
  } catch (error) {
    const status = error instanceof SecurityError ? 401 : 500;
    req.log.warn({ err: redactSecrets(error) }, "mcp request failed");
    if (!res.headersSent) res.status(status).json({ error: error instanceof Error ? error.message : "mcp request failed" });
  }
}

async function handleJsonRpc(userId: string, body: unknown): Promise<unknown> {
  const messages = Array.isArray(body) ? body : [body];
  const responses = (await Promise.all(messages.map(async (message) => await handleJsonRpcMessage(userId, message)))).filter(Boolean);
  if (responses.length === 0) return undefined;
  return Array.isArray(body) ? responses : responses[0];
}

async function handleJsonRpcMessage(userId: string, message: unknown): Promise<unknown> {
  if (!isJsonRpcRequest(message)) return jsonRpcError(null, -32600, "invalid json-rpc request");
  if (message.id === undefined) return undefined;
  if (message.method === "initialize") {
    return jsonRpcResult(message.id, {
      protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "pokedex", version: "0.2.0", title: "pokedex" }
    });
  }
  if (message.method === "tools/list") return jsonRpcResult(message.id, { tools: mcpToolDefinitions() });
  if (message.method === "tools/call") return await handleToolCall(userId, message.id, message.params);
  return jsonRpcError(message.id, -32601, `unsupported method: ${message.method}`);
}

async function handleToolCall(userId: string, id: string | number | null, params: Record<string, unknown> | undefined): Promise<unknown> {
  const name = typeof params?.name === "string" ? params.name : "";
  if (!mcpToolNameSet.has(name)) return jsonRpcError(id, -32601, `tool not found: ${name || "unknown"}`);
  const args = typeof params?.arguments === "object" && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
  const result = await callAgent({ id: randomUUID(), userId, toolName: name as McpToolName, arguments: args });
  return jsonRpcResult(id, { content: [{ type: "text", text: toMcpText(result) }], isError: !result.ok });
}

function isJsonRpcRequest(value: unknown): value is { id?: string | number | null; method: string; params?: Record<string, unknown> } {
  return typeof value === "object" && value !== null && "method" in value && typeof value.method === "string";
}

function jsonRpcResult(id: string | number | null, result: unknown): object {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: string | number | null, code: number, message: string): object {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

wss.on("connection", (socket, request) => {
  try {
    verifyBearerToken(request.headers.authorization, relayToken);
    const url = new URL(request.url ?? "/agent", "http://localhost");
    const userId = url.searchParams.get("userId") ?? expectedUserId;
    if (!userId) throw new SecurityError("missing user id");
    agents.set(userId, socket);
    logger.info({ userId }, "agent connected");

    socket.on("message", (raw) => {
      const response = AgentResponseSchema.parse(JSON.parse(raw.toString()));
      const waiting = pending.get(response.id);
      if (!waiting) return;
      clearTimeout(waiting.timeout);
      pending.delete(response.id);
      if (response.error) waiting.reject(new Error(response.error));
      else waiting.resolve(response.result ?? { ok: false, summary: "agent returned no result", data: {} });
    });

    socket.on("close", () => {
      if (agents.get(userId) === socket) agents.delete(userId);
      logger.warn({ userId }, "agent disconnected");
    });
  } catch (error) {
    logger.warn({ err: redactSecrets(error), reason: error instanceof Error ? error.message : "unknown error" }, "agent connection rejected");
    socket.close(1008, "unauthorized");
  }
});

function authenticateMcpRequest(req: Request): string {
  const headerUserId = req.header("x-pokedex-user-id") ?? req.header("x-poke-user-id");
  req.log.info({ path: req.path, hasAuthorization: Boolean(req.header("authorization")), hasTokenQuery: typeof req.query.token === "string", hasUserId: Boolean(headerUserId) }, "mcp request routed");
  verifyBearerToken(req.header("authorization") ?? (typeof req.query.token === "string" ? `Bearer ${req.query.token}` : undefined), relayToken);
  const userId = expectedUserId || headerUserId;
  if (!userId) throw new SecurityError("missing pokedex user id");
  return userId;
}

async function callAgent(request: AgentRequest): Promise<ToolResult> {
  const socket = agents.get(request.userId) ?? (agents.size === 1 ? [...agents.values()][0] : undefined);
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return { ok: false, summary: "local codex agent is not connected.", data: { connected: false } };
  }

  return await new Promise<ToolResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(request.id);
      reject(new Error("agent response timeout"));
    }, agentResponseTimeoutMs);

    pending.set(request.id, { resolve, reject, timeout });
    socket.send(JSON.stringify(request));
  });
}

function relayOptions(): { port: number; token: string; userId: string } {
  const configPath = value("--config") ?? (existsSync(defaultConfigPath()) ? defaultConfigPath() : undefined);
  if (configPath) {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { port?: string | number; relayToken?: string; userId?: string };
    return {
      port: Number(config.port ?? 3000),
      token: config.relayToken ?? randomBytes(32).toString("hex"),
      userId: config.userId ?? "local"
    };
  }

  return {
    port: Number(value("--port") ?? 3000),
    token: value("--token") ?? randomBytes(32).toString("hex"),
    userId: value("--user-id") ?? ""
  };
}

function value(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function defaultConfigPath(): string {
  return join(homedir(), ".pokedex", "config.json");
}

function exitOnListenError(error: Error): void {
  logger.error({ err: error }, "relay failed to listen");
  process.exit(1);
}

server.listen(options.port, () => logger.info({ port: options.port }, "relay listening"));
