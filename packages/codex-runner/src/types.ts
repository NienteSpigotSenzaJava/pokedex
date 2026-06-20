import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { Usage } from '@pokedex/protocol';

export type AppServerProcess = ChildProcessByStdio<Writable, Readable, Readable>;
export type JsonRecord = Record<string, unknown>;
export type RpcId = string | number;

export type AppServerEvent = {
  method?: string;
  params?: unknown;
  raw: unknown;
};

export type RunnerProgress = {
  event: unknown;
  eventName?: string;
  threadId?: string;
  turnId?: string;
  status?: string;
  message?: string;
  error?: string;
  finalMessage?: string;
  rateLimits?: unknown;
  usage?: Usage;
};

export type RunnerResult = {
  threadId?: string;
  finalMessage: string;
  usage: Usage;
  events: unknown[];
  cwd?: string;
  workspaceAlias?: string;
  settings?: JsonRecord;
};
