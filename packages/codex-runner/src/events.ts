import { extractUsage, usageTotal } from './usage.js';
import { asRecord, stringFrom } from './utils.js';

export function extractThreadId(value: unknown): string | undefined {
  const raw = asRecord(value);
  const params = asRecord(raw.params);
  const thread = asRecord(raw.thread);
  const paramsThread = asRecord(params.thread);
  return (
    stringFrom(raw.threadId) ??
    stringFrom(params.threadId) ??
    stringFrom(raw.id) ??
    stringFrom(thread.id) ??
    stringFrom(thread.threadId) ??
    stringFrom(paramsThread.id) ??
    stringFrom(paramsThread.threadId)
  );
}

export function extractEventThreadId(value: unknown): string | undefined {
  const raw = asRecord(value);
  const params = asRecord(raw.params);
  const thread = asRecord(raw.thread);
  const paramsThread = asRecord(params.thread);
  return (
    stringFrom(raw.threadId) ??
    stringFrom(params.threadId) ??
    stringFrom(thread.id) ??
    stringFrom(thread.threadId) ??
    stringFrom(paramsThread.id) ??
    stringFrom(paramsThread.threadId)
  );
}

export function extractTurnId(value: unknown): string | undefined {
  const raw = asRecord(value);
  const params = asRecord(raw.params);
  const turn = asRecord(raw.turn);
  const paramsTurn = asRecord(params.turn);
  return (
    stringFrom(raw.turnId) ??
    stringFrom(params.turnId) ??
    stringFrom(turn.id) ??
    stringFrom(turn.turnId) ??
    stringFrom(paramsTurn.id) ??
    stringFrom(paramsTurn.turnId)
  );
}

export function extractFinalMessage(value: unknown): string {
  const raw = asRecord(value);
  const item = asRecord(raw.item);
  const params = asRecord(raw.params);
  const paramsItem = asRecord(params.item);
  const turn = asRecord(raw.turn);
  const paramsTurn = asRecord(params.turn);
  const output = asRecord(raw.output);
  const paramsOutput = asRecord(params.output);
  return (
    stringFrom(raw.finalMessage) ??
    stringFrom(raw.finalResponse) ??
    stringFrom(raw.output_text) ??
    stringFrom(output.text) ??
    stringFrom(item.text) ??
    stringFrom(item.message) ??
    stringFrom(item.content) ??
    stringFrom(params.finalMessage) ??
    stringFrom(params.finalResponse) ??
    stringFrom(params.output_text) ??
    stringFrom(paramsOutput.text) ??
    stringFrom(params.text) ??
    stringFrom(paramsItem.text) ??
    stringFrom(paramsItem.message) ??
    stringFrom(paramsItem.content) ??
    stringFrom(turn.finalMessage) ??
    stringFrom(turn.finalResponse) ??
    stringFrom(paramsTurn.finalMessage) ??
    stringFrom(paramsTurn.finalResponse) ??
    ''
  );
}

export function throwIfFailedTurn(value: unknown): void {
  const failure = turnFailureMessage(value);
  if (failure) throw new Error(failure);
}

function turnFailureMessage(value: unknown): string | null {
  if (!isFailedTurnEvent(value)) return null;
  return (
    extractErrorMessage(value) ||
    extractFinalMessage(value) ||
    `codex turn ${turnStatus(value) ?? 'failed'}`
  );
}

export function terminalTurnResult(
  value: unknown,
  threadId: string | undefined,
  turnId: string | undefined
): unknown | null {
  if (!isTerminalTurnEvent(value)) return null;
  const eventThreadId = extractEventThreadId(value);
  if (threadId && eventThreadId && eventThreadId !== threadId) return null;
  const eventTurnId = extractTurnId(value);
  if (turnId && eventTurnId && eventTurnId !== turnId) return null;
  return value;
}

export function turnNeedsTerminalWait(value: unknown): boolean {
  const usage = extractUsage(value);
  if (extractFinalMessage(value) || (usage && usageTotal(usage) > 0)) return false;
  const status = turnStatus(value);
  return (
    status === 'inProgress' ||
    status === 'in_progress' ||
    status === 'running' ||
    status === 'pending' ||
    status === 'queued'
  );
}

export function turnStatus(value: unknown): string | undefined {
  const raw = asRecord(value);
  const params = asRecord(raw.params);
  const turn = asRecord(raw.turn);
  const paramsTurn = asRecord(params.turn);
  return (
    stringFrom(raw.status) ??
    stringFrom(params.status) ??
    stringFrom(turn.status) ??
    stringFrom(paramsTurn.status)
  );
}

export function extractEventName(value: unknown): string | undefined {
  const raw = asRecord(value);
  const params = asRecord(raw.params);
  return stringFrom(raw.method) ?? stringFrom(raw.type) ?? stringFrom(params.type);
}

export function extractProgressMessage(value: unknown): string {
  const raw = asRecord(value);
  const params = asRecord(raw.params);
  const item = asRecord(raw.item);
  const paramsItem = asRecord(params.item);
  return (
    extractErrorMessage(value) ||
    extractFinalMessage(value) ||
    stringFrom(raw.summary) ||
    stringFrom(params.summary) ||
    stringFrom(raw.message) ||
    stringFrom(params.message) ||
    stringFrom(raw.delta) ||
    stringFrom(params.delta) ||
    stringFrom(item.title) ||
    stringFrom(paramsItem.title) ||
    ''
  );
}

export function extractErrorMessage(value: unknown): string {
  const raw = asRecord(value);
  const params = asRecord(raw.params);
  const turn = asRecord(raw.turn);
  const paramsTurn = asRecord(params.turn);
  const candidates = [
    raw.error,
    raw.lastError,
    raw.errorMessage,
    params.error,
    params.lastError,
    params.errorMessage,
    turn.error,
    turn.lastError,
    paramsTurn.error,
    paramsTurn.lastError,
  ];
  for (const candidate of candidates) {
    const message = errorMessageFrom(candidate);
    if (message) return message;
  }
  return '';
}

export function extractRateLimits(value: unknown): unknown {
  const raw = asRecord(value);
  const params = asRecord(raw.params);
  for (const candidate of [
    raw.rateLimits,
    raw.rate_limits,
    raw.rateLimit,
    raw.rate_limit,
    params.rateLimits,
    params.rate_limits,
    params.rateLimit,
    params.rate_limit,
    raw.method === 'account/rateLimits/updated' ? params : undefined,
  ]) {
    if (looksLikeRateLimits(candidate)) return candidate;
  }
  return undefined;
}

function isTerminalTurnEvent(value: unknown): boolean {
  const raw = asRecord(value);
  const params = asRecord(raw.params);
  const method = stringFrom(raw.method);
  const type = stringFrom(raw.type) ?? stringFrom(params.type);
  const status = turnStatus(value);
  return (
    method === 'turn/completed' ||
    method === 'turn/failed' ||
    type === 'turn.completed' ||
    type === 'turn.failed' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'canceled'
  );
}

function isFailedTurnEvent(value: unknown): boolean {
  const raw = asRecord(value);
  const params = asRecord(raw.params);
  const method = stringFrom(raw.method);
  const type = stringFrom(raw.type) ?? stringFrom(params.type);
  const status = turnStatus(value);
  return (
    method === 'turn/failed' ||
    type === 'turn.failed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'canceled'
  );
}

function errorMessageFrom(value: unknown): string {
  if (typeof value === 'string') return value;
  const raw = asRecord(value);
  const message =
    stringFrom(raw.message) ??
    stringFrom(raw.detail) ??
    stringFrom(raw.reason) ??
    stringFrom(raw.code) ??
    stringFrom(raw.type);
  if (!message) return '';
  const code = stringFrom(raw.code) ?? stringFrom(raw.type);
  return code && code !== message ? `${message} (${code})` : message;
}

function looksLikeRateLimits(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(looksLikeRateLimits);
  const raw = asRecord(value);
  return Object.keys(raw).some((key) =>
    /^(rate_?limits?|limits?|primary|secondary|reset|resets|remaining|used)/i.test(key)
  );
}
