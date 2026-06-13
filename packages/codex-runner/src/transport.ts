import { spawn } from 'node:child_process';
import { redactSecrets } from '@pokedex/security';
import { gitHeadlessEnv } from './local.js';
import type { AgentConfig } from '@pokedex/protocol';
import type { AppServerEvent, AppServerProcess, JsonRecord, RpcId } from './types.js';
import { asRecord, stringFrom, stripUndefined } from './utils.js';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

const eventHistoryLimit = 500;

export class AppServerTransport {
  private child: AppServerProcess | null = null;
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private commandKey = '';
  private nextId = 1;
  private buffer = '';
  private stderr = '';
  private readonly pending = new Map<number, PendingRequest>();
  private readonly events: unknown[] = [];
  private readonly listeners = new Set<(event: AppServerEvent) => void>();

  onEvent(listener: (event: AppServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async warm(config: AgentConfig): Promise<void> {
    this.ensureStarted(config);
    await this.ensureInitialized();
  }

  async request(
    config: AgentConfig,
    method: string,
    params: unknown,
    timeoutMs = 120_000
  ): Promise<unknown> {
    this.ensureStarted(config);
    if (method !== 'initialize') await this.ensureInitialized();
    return await this.sendRequest(method, params, timeoutMs);
  }

  sendResponse(id: RpcId, result: unknown): void {
    const child = this.child;
    if (!child) throw new Error('codex app-server is not running');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  stop(): void {
    this.stopCurrentChild();
  }

  async close(timeoutMs = 2_000): Promise<void> {
    const child = this.stopCurrentChild();
    if (!child) return;
    if (await waitForChildClose(child, timeoutMs)) return;
    signalChild(child, 'SIGKILL');
    await waitForChildClose(child, 1_000);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initializing ??= this.sendRequest(
      'initialize',
      {
        clientInfo: {
          name: 'pokedex',
          version: '0.1.0',
        },
      },
      30_000
    )
      .then(() => {
        this.sendNotification('initialized', {});
        this.initialized = true;
      })
      .finally(() => {
        this.initializing = null;
      });
    await this.initializing;
  }

  private ensureStarted(config: AgentConfig): void {
    const commandKey = JSON.stringify([config.appServerCommand, config.appServerArgs]);
    if (this.child && !childExited(this.child) && this.commandKey !== commandKey) this.stop();
    if (this.child && !childExited(this.child)) return;

    this.initialized = false;
    this.initializing = null;
    this.commandKey = commandKey;
    this.buffer = '';
    this.stderr = '';
    const child = spawn(config.appServerCommand, config.appServerArgs, {
      cwd: process.cwd(),
      env: gitHeadlessEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    child.on('error', (error) => {
      if (this.child === child) this.failAll(error);
    });
    child.on('close', () => {
      if (this.child !== child) return;
      this.failAll(new Error(formatAppServerStop(this.stderr)));
      this.child = null;
      this.commandKey = '';
      this.initialized = false;
      this.initializing = null;
    });
  }

  private sendRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child) throw new Error('codex app-server did not start');

    const id = this.nextId++;
    const payload = JSON.stringify(stripUndefined({ jsonrpc: '2.0', id, method, params }));

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server timeout for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      child.stdin.write(`${payload}\n`);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    const child = this.child;
    if (!child) throw new Error('codex app-server did not start');
    child.stdin.write(`${JSON.stringify(stripUndefined({ jsonrpc: '2.0', method, params }))}\n`);
  }

  private stopCurrentChild(): AppServerProcess | null {
    const child = this.child;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('codex app-server stopped'));
      this.pending.delete(id);
    }
    if (child && !childExited(child)) signalChild(child, 'SIGTERM');
    this.child = null;
    this.commandKey = '';
    this.initialized = false;
    this.initializing = null;
    return child;
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.handleLine(line);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    const message = JSON.parse(line) as JsonRecord;
    const id = typeof message.id === 'number' ? message.id : null;

    if (id !== null && this.pending.has(id)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      if (message.error) {
        this.emitMessage({ ...message, method: stringFrom(message.method) ?? 'rpc/error' });
        pending.reject(new Error(formatRpcError(message.error)));
      } else pending.resolve(message.result ?? {});
      return;
    }

    this.emitMessage(message);
  }

  private emitMessage(message: JsonRecord): void {
    const redacted = redactSecrets(message) as JsonRecord;
    const event: AppServerEvent = { raw: redacted };
    if (typeof redacted.method === 'string') event.method = redacted.method;
    if ('params' in redacted) event.params = redacted.params;
    this.events.push(event.raw);
    if (this.events.length > eventHistoryLimit) this.events.shift();
    for (const listener of this.listeners) listener(event);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function childExited(child: AppServerProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function signalChild(child: AppServerProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // app-server may have exited between the liveness check and the signal.
  }
}

function waitForChildClose(child: AppServerProcess, timeoutMs: number): Promise<boolean> {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off('close', onClose);
      resolve(false);
    }, timeoutMs);
    const onClose = () => done(true);
    const done = (closed: boolean) => {
      clearTimeout(timeout);
      child.off('close', onClose);
      resolve(closed);
    };
    child.once('close', onClose);
  });
}

function formatRpcError(error: unknown): string {
  const raw = asRecord(error);
  return stringFrom(raw.message) ?? JSON.stringify(error);
}

function formatAppServerStop(stderr: string): string {
  const details = String(redactSecrets(stderr)).trim();
  return details
    ? `Codex app-server stopped before answering.\n${details}`
    : 'Codex app-server stopped before answering.';
}
