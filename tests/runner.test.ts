import { describe, expect, it } from "vitest";
import { CodexAppServerClient, buildSettings, mapSandboxForAppServer, parseUsage } from "../packages/codex-runner/src/index.js";
import type { AgentConfig } from "../packages/protocol/src/index.js";

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

const config: AgentConfig = {
  userId: "user",
  relayUrl: "ws://localhost:3000/agent",
  relayToken: "1234567890123456",
  appServerCommand: process.execPath,
  appServerArgs: ["-e", fakeServer],
  defaultModel: "gpt-5.5",
  defaultReasoning: "medium",
  defaultVerbosity: "medium",
  defaultApprovalPolicy: "on-request",
  writeTasksEnabled: false,
  fullAccessEnabled: false,
  workspaces: [{ alias: "repo", root: "/tmp/repo", allowWrite: false, allowFullAccess: false, defaultSandbox: "read_only" }]
};

describe("codex app-server client", () => {
  it("maps sandbox values to app-server config values", () => {
    expect(mapSandboxForAppServer("workspace_write")).toBe("workspace-write");
  });

  it("builds least-privilege runtime settings", () => {
    expect(buildSettings(config, config.workspaces[0]!, { imagePaths: [] })).toMatchObject({
      model: "gpt-5.5",
      sandbox_mode: "read-only",
      approval_policy: "on-request"
    });
  });

  it("parses usage shapes", () => {
    expect(parseUsage({ usage: { input_tokens: 1, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 4 } })).toEqual({
      inputTokens: 1,
      cachedInputTokens: 2,
      outputTokens: 3,
      reasoningOutputTokens: 4
    });
  });

  it("starts native threads and collects streamed events", async () => {
    const client = new CodexAppServerClient();
    const seen: unknown[] = [];
    const result = await client.startThread(config, { workspaceAlias: "repo", prompt: "build" }, (event) => seen.push(event));
    client.stop();

    expect(result.threadId).toBe("thread-1");
    expect(result.finalMessage).toBe("done");
    expect(result.usage.inputTokens).toBe(2);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("supports list, read, resume, fork, goal, review, and interrupt", async () => {
    const client = new CodexAppServerClient();

    await expect(client.listThreads(config, { workspaceAlias: "repo" })).resolves.toMatchObject({ ok: true });
    await expect(client.readThread(config, { threadId: "thread-1" })).resolves.toMatchObject({ ok: true });
    await expect(client.resumeThread(config, { threadId: "thread-1", prompt: "next" })).resolves.toMatchObject({ finalMessage: "done" });
    await expect(client.forkThread(config, { threadId: "thread-1" })).resolves.toMatchObject({ ok: true });
    await expect(client.setGoal(config, { threadId: "thread-1", goal: "finish" })).resolves.toMatchObject({ ok: true });
    await expect(client.clearGoal(config, { threadId: "thread-1" })).resolves.toMatchObject({ ok: true });
    await expect(client.review(config, { workspaceAlias: "repo", threadId: "thread-1" })).resolves.toMatchObject({ finalMessage: "review started" });
    await expect(client.interrupt(config, { threadId: "thread-1" })).resolves.toMatchObject({ ok: true });

    client.stop();
  });

  it("passes explicit skill references to app-server turns", async () => {
    const client = new CodexAppServerClient();
    await expect(
      client.startThread(config, {
        workspaceAlias: "repo",
        prompt: "answer short",
        skills: [{ name: "caveman", path: "/home/user/.agents/skills/caveman/SKILL.md" }]
      })
    ).resolves.toMatchObject({ threadId: "thread-1" });
    client.stop();
  });
});
