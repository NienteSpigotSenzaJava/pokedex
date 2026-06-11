import { describe, expect, it } from 'vitest';
import {
  CodexAppServerClient,
  buildSettings,
  mapSandboxForAppServer,
  parseUsage,
} from '../packages/codex-runner/src/index.js';
import type { AgentConfig } from '../packages/protocol/src/index.js';

const fakeServer = `
const readline = require("node:readline");
let initialized = false;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    initialized = true;
    console.log(JSON.stringify({ id: msg.id, result: { userAgent: "fake-codex" } }));
    return;
  }
  if (!initialized) {
    console.log(JSON.stringify({ id: msg.id, error: { code: -32600, message: "Not initialized" } }));
    return;
  }
  if (msg.method === "thread/start") console.log(JSON.stringify({ id: msg.id, result: { thread: { id: "thread-1" } } }));
  if (msg.method === "turn/start") {
    const textItem = msg.params.input.find((item) => item.type === "text");
    const badSkill = msg.params.input.some((item) => item.type === "skill" && (!item.name || !item.path));
    if (!textItem || badSkill) {
      console.log(JSON.stringify({ id: msg.id, error: { code: -32600, message: "missing field type" } }));
      return;
    }
    console.log(JSON.stringify({ method: "turn/item", params: { text: "working", usage: { input_tokens: 1 } } }));
    console.log(JSON.stringify({ id: msg.id, result: { finalMessage: "done", usage: { input_tokens: 2 } } }));
  }
  if (msg.method === "thread/resume") console.log(JSON.stringify({ id: msg.id, result: { thread: { id: msg.params.threadId } } }));
  if (msg.method === "thread/list") console.log(JSON.stringify({ id: msg.id, result: { threads: [{ id: "thread-1" }], cursor: null } }));
  if (msg.method === "thread/read") console.log(JSON.stringify({ id: msg.id, result: { thread: { id: msg.params.threadId }, turns: [] } }));
  if (msg.method === "thread/fork") console.log(JSON.stringify({ id: msg.id, result: { thread: { id: "thread-2", forkedFromId: msg.params.threadId } } }));
  if (msg.method === "thread/goal/set") console.log(JSON.stringify({ id: msg.id, result: { ok: true } }));
  if (msg.method === "thread/goal/clear") console.log(JSON.stringify({ id: msg.id, result: { ok: true } }));
  if (msg.method === "review/start") console.log(JSON.stringify({ id: msg.id, result: { finalMessage: "review started" } }));
  if (msg.method === "turn/interrupt") console.log(JSON.stringify({ id: msg.id, result: { ok: true } }));
});
`;

function fakeServerForMessage(finalMessage: string): string {
  return `
  const readline = require("node:readline");
  let initialized = false;
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      initialized = true;
      console.log(JSON.stringify({ id: msg.id, result: { userAgent: "fake-codex" } }));
      return;
    }
    if (!initialized) {
      console.log(JSON.stringify({ id: msg.id, error: { code: -32600, message: "Not initialized" } }));
      return;
    }
    if (msg.method === "thread/start") console.log(JSON.stringify({ id: msg.id, result: { thread: { id: "thread-1" } } }));
    if (msg.method === "turn/start") console.log(JSON.stringify({ id: msg.id, result: { finalMessage: ${JSON.stringify(
      finalMessage
    )}, usage: { input_tokens: 2 } } }));
  });
  `;
}

function fakeServerForTurnSettings(): string {
  return `
  const readline = require("node:readline");
  let initialized = false;
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      initialized = true;
      console.log(JSON.stringify({ id: msg.id, result: { userAgent: "fake-codex" } }));
      return;
    }
    if (!initialized) {
      console.log(JSON.stringify({ id: msg.id, error: { code: -32600, message: "Not initialized" } }));
      return;
    }
    if (msg.method === "turn/start") {
      console.log(JSON.stringify({
        id: msg.id,
        result: {
          finalMessage: msg.params.settings.approval_policy,
          usage: { input_tokens: 1 }
        }
      }));
    }
  });
  `;
}

function fakeServerForApproval(): string {
  return `
  const readline = require("node:readline");
  let initialized = false;
  let pendingTurnId = null;
  let lastDecision = null;
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      initialized = true;
      console.log(JSON.stringify({ id: msg.id, result: { userAgent: "fake-codex" } }));
      return;
    }
    if (!initialized) {
      console.log(JSON.stringify({ id: msg.id, error: { code: -32600, message: "Not initialized" } }));
      return;
    }
    if (msg.method === "turn/start") {
      pendingTurnId = msg.id;
      console.log(JSON.stringify({
        id: "approval-request-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "item-1",
          threadId: msg.params.threadId,
          turnId: "turn-1",
          reason: "needs shell",
          command: ["npm", "test"],
          cwd: "/tmp/repo",
          availableDecisions: ["accept", "acceptForSession", "decline", "cancel"]
        }
      }));
      return;
    }
    if (msg.id === "approval-request-1") {
      lastDecision = msg.result;
      console.log(JSON.stringify({
        method: "serverRequest/resolved",
        params: { requestId: "approval-request-1", threadId: "thread-1" }
      }));
      console.log(JSON.stringify({
        id: pendingTurnId,
        result: { finalMessage: "approved with " + lastDecision, usage: { input_tokens: 3 } }
      }));
      return;
    }
    if (msg.method === "thread/list") {
      console.log(JSON.stringify({ id: msg.id, result: { lastDecision } }));
    }
  });
  `;
}

function fakeServerForSkills(): string {
  return `
  const readline = require("node:readline");
  let initialized = false;
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      initialized = true;
      console.log(JSON.stringify({ id: msg.id, result: { userAgent: "fake-codex" } }));
      return;
    }
    if (!initialized) {
      console.log(JSON.stringify({ id: msg.id, error: { code: -32600, message: "Not initialized" } }));
      return;
    }
    if (msg.method === "skills/list") {
      console.log(JSON.stringify({
        id: msg.id,
        result: {
          data: [{
            cwd: msg.params.cwds[0],
            skills: [
              {
                name: "caveman",
                path: "/home/user/.agents/skills/caveman/SKILL.md",
                description: "brief mode",
                enabled: true
              },
              {
                name: "2d-games",
                path: "/home/user/.agents/skills/game-development/2d-games/SKILL.md",
                description: "2d game principles",
                enabled: true
              }
            ],
            errors: []
          }]
        }
      }));
      return;
    }
    if (msg.method === "turn/start") {
      console.log(JSON.stringify({
        id: msg.id,
        result: {
          finalMessage: msg.params.input.map((item) => item.type === "skill" ? item.name + ":" + item.path : item.text).join("|"),
          usage: { input_tokens: 1 }
        }
      }));
    }
  });
  `;
}

const config: AgentConfig = {
  userId: 'user',
  relayUrl: 'ws://localhost:3000/agent',
  relayToken: '1234567890123456',
  appServerCommand: process.execPath,
  appServerArgs: ['-e', fakeServer],
  defaultModel: 'gpt-5.5',
  defaultReasoning: 'medium',
  defaultVerbosity: 'medium',
  defaultApprovalPolicy: 'never',
  writeTasksEnabled: false,
  fullAccessEnabled: false,
  workspaces: [
    {
      alias: 'repo',
      root: '/tmp/repo',
      allowWrite: false,
      allowFullAccess: false,
      defaultSandbox: 'read_only',
    },
  ],
};

describe('codex app-server client', () => {
  it('maps sandbox values to app-server config values', () => {
    expect(mapSandboxForAppServer('workspace_write')).toBe('workspace-write');
  });

  it('builds least-privilege runtime settings', () => {
    expect(buildSettings(config, config.workspaces[0]!, { imagePaths: [] })).toMatchObject({
      model: 'gpt-5.5',
      sandbox_mode: 'read-only',
      approval_policy: 'never',
    });
  });

  it('passes changed default approval to later mcp turns without restarting app-server', async () => {
    const client = new CodexAppServerClient();
    const appServerArgs = ['-e', fakeServerForTurnSettings()];

    await expect(
      client.startTurn(
        { ...config, appServerArgs, defaultApprovalPolicy: 'on-request' },
        { threadId: 'thread-1', prompt: 'first' }
      )
    ).resolves.toMatchObject({ finalMessage: 'on-request' });
    await expect(
      client.startTurn(
        { ...config, appServerArgs, defaultApprovalPolicy: 'never' },
        { threadId: 'thread-1', prompt: 'second' }
      )
    ).resolves.toMatchObject({ finalMessage: 'never' });
    client.stop();
  });

  it('lists and resolves app-server approval requests', async () => {
    const client = new CodexAppServerClient();
    const approvalConfig = { ...config, appServerArgs: ['-e', fakeServerForApproval()] };

    await expect(
      client.startTurn(approvalConfig, { threadId: 'thread-1', prompt: 'run tests' })
    ).resolves.toMatchObject({
      finalMessage: expect.stringContaining('approval-1'),
    });

    await expect(client.listApprovals()).resolves.toMatchObject({
      ok: true,
      data: {
        approvals: [
          expect.objectContaining({
            approvalId: 'approval-1',
            commandText: 'npm test',
            cwd: '/tmp/repo',
          }),
        ],
      },
    });
    await expect(client.approve({ forSession: true })).resolves.toMatchObject({
      ok: true,
      data: { decision: 'acceptForSession' },
    });
    await expect(client.listApprovals()).resolves.toMatchObject({
      data: { approvals: [] },
    });
    await expect(client.listThreads(approvalConfig, {})).resolves.toMatchObject({
      data: { result: { lastDecision: 'acceptForSession' } },
    });
    client.stop();
  });

  it('lists local skills and injects skill input items by name', async () => {
    const client = new CodexAppServerClient();
    const skillConfig = { ...config, appServerArgs: ['-e', fakeServerForSkills()] };

    await expect(client.listSkills(skillConfig, {})).resolves.toMatchObject({
      ok: true,
      data: {
        skills: expect.arrayContaining([
          expect.objectContaining({
            name: 'caveman',
            path: '/home/user/.agents/skills/caveman/SKILL.md',
          }),
        ]),
      },
    });
    await expect(
      client.startTurn(skillConfig, {
        threadId: 'thread-1',
        prompt: '$caveman answer',
        skillNames: ['2d-games'],
      })
    ).resolves.toMatchObject({
      finalMessage: expect.stringContaining('caveman:/home/user/.agents/skills/caveman/SKILL.md'),
    });
    client.stop();
  });

  it('parses usage shapes', () => {
    expect(
      parseUsage({
        usage: {
          input_tokens: 1,
          cached_input_tokens: 2,
          output_tokens: 3,
          reasoning_output_tokens: 4,
        },
      })
    ).toEqual({
      inputTokens: 1,
      cachedInputTokens: 2,
      outputTokens: 3,
      reasoningOutputTokens: 4,
    });
  });

  it('starts native threads and collects streamed events', async () => {
    const client = new CodexAppServerClient();
    const seen: unknown[] = [];
    const result = await client.startThread(
      config,
      { workspaceAlias: 'repo', prompt: 'build' },
      (event) => seen.push(event)
    );
    client.stop();

    expect(result.threadId).toBe('thread-1');
    expect(result.finalMessage).toBe('done');
    expect(result.usage.inputTokens).toBe(2);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('supports list, read, resume, fork, goal, review, and interrupt', async () => {
    const client = new CodexAppServerClient();

    await expect(client.listThreads(config, { workspaceAlias: 'repo' })).resolves.toMatchObject({
      ok: true,
    });
    await expect(client.readThread(config, { threadId: 'thread-1' })).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      client.resumeThread(config, { threadId: 'thread-1', prompt: 'next' })
    ).resolves.toMatchObject({ finalMessage: 'done' });
    await expect(client.forkThread(config, { threadId: 'thread-1' })).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      client.setGoal(config, { threadId: 'thread-1', goal: 'finish' })
    ).resolves.toMatchObject({ ok: true });
    await expect(client.clearGoal(config, { threadId: 'thread-1' })).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      client.review(config, { workspaceAlias: 'repo', threadId: 'thread-1' })
    ).resolves.toMatchObject({ finalMessage: 'review started' });
    await expect(client.interrupt(config, { threadId: 'thread-1' })).resolves.toMatchObject({
      ok: true,
    });

    client.stop();
  });

  it('passes explicit skill references to app-server turns', async () => {
    const client = new CodexAppServerClient();
    await expect(
      client.startThread(config, {
        workspaceAlias: 'repo',
        prompt: 'answer short',
        skills: [{ name: 'caveman', path: '/home/user/.agents/skills/caveman/SKILL.md' }],
      })
    ).resolves.toMatchObject({ threadId: 'thread-1' });
    client.stop();
  });

  it('restarts app-server when command args change', async () => {
    const client = new CodexAppServerClient();
    const first = { ...config, appServerArgs: ['-e', fakeServerForMessage('first')] };
    const second = { ...config, appServerArgs: ['-e', fakeServerForMessage('second')] };

    await expect(
      client.startThread(first, { workspaceAlias: 'repo', prompt: 'one' })
    ).resolves.toMatchObject({
      finalMessage: 'first',
    });
    await expect(
      client.startThread(second, { workspaceAlias: 'repo', prompt: 'two' })
    ).resolves.toMatchObject({
      finalMessage: 'second',
    });
    client.stop();
  });
});
