#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const command = ['help', '--help', '-h'].includes(args[0] ?? '')
  ? 'help'
  : args[0]?.startsWith('-')
    ? 'local'
    : (args[0] ?? 'local');
const invocationCwd = process.env.INIT_CWD ?? process.cwd();
const managedChildren = new Map();
const serviceLogs = new Map();
const statuses = { relay: 'idle', agent: 'idle', poke: 'idle' };
const bannerText = [
  '▄▄▄▄   ▄▄▄  ▄▄ ▄▄ ▄▄▄▄▄ ▄▄▄▄  ▄▄▄▄▄ ▄▄ ▄▄ ',
  '██▄█▀ ██▀██ ██▄█▀ ██▄▄  ██▀██ ██▄▄  ▀█▄█▀ ',
  '██    ▀███▀ ██ ██ ██▄▄▄ ████▀ ██▄▄▄ ██ ██ ',
].join('\n');
let configPath = '';
let config = {};
let readline = null;
let stopping = false;
let restarting = false;

if (command === 'help') help();
else if (command === 'local') await local();
else die(`unknown command: ${command}`);

async function local() {
  configPath = defaultConfigPath();
  config = createConfig(loadSavedConfig());
  saveConfig();

  printBanner();

  registerSignals();
  try {
    await startStack();
  } catch (error) {
    console.error(formatError(error));
    await stopStack(false);
    process.exit(1);
  }
  startConsole();
}

function createConfig(saved) {
  const first = firstWorkspace(saved);
  const readOnly = has('--read-only');
  const writeEnabled = readOnly
    ? false
    : has('--write') || has('--full-access')
      ? true
      : (saved.writeTasksEnabled ?? first.allowWrite ?? false);
  const fullAccess = readOnly
    ? false
    : has('--full-access')
      ? true
      : has('--write')
        ? false
        : (saved.fullAccessEnabled ?? first.allowFullAccess ?? false);
  const alias = value('--alias') ?? first.alias ?? 'main';
  const root = value('--workspace')
    ? resolveUserPath(value('--workspace'))
    : (first.root ?? resolveUserPath('.'));
  const workspaces = normalizeWorkspaces(saved.workspaces, {
    alias,
    root,
    writeEnabled,
    fullAccess,
  });

  upsertWorkspace(workspaces, {
    alias,
    root,
    description: first.description ?? `${alias} workspace`,
    allowWrite: writeEnabled,
    allowFullAccess: fullAccess,
    defaultSandbox: sandboxFor(writeEnabled, fullAccess),
  });

  return {
    port: String(value('--port') ?? saved.port ?? '3000'),
    userId: value('--user-id') ?? saved.userId ?? 'local',
    relayUrl: `ws://127.0.0.1:${value('--port') ?? saved.port ?? '3000'}/agent`,
    relayToken: value('--token') ?? saved.relayToken ?? randomHex(),
    appServerCommand: value('--codex') ?? saved.appServerCommand ?? 'codex',
    appServerArgs: Array.isArray(saved.appServerArgs)
      ? saved.appServerArgs
      : ['app-server', '--listen', 'stdio://'],
    defaultModel: value('--model') ?? saved.defaultModel ?? 'gpt-5.5',
    defaultReasoning: value('--reasoning') ?? saved.defaultReasoning ?? 'medium',
    defaultVerbosity: value('--verbosity') ?? saved.defaultVerbosity ?? 'medium',
    defaultApprovalPolicy: value('--approval') ?? saved.defaultApprovalPolicy ?? 'on-request',
    writeTasksEnabled: writeEnabled,
    fullAccessEnabled: fullAccess,
    workspaces,
  };
}

function normalizeWorkspaces(workspaces, defaults) {
  const items = Array.isArray(workspaces) ? workspaces : [];
  const normalized = items
    .filter(
      (workspace) => workspace && typeof workspace === 'object' && workspace.alias && workspace.root
    )
    .map((workspace) => ({
      alias: String(workspace.alias),
      root: String(workspace.root),
      description: workspace.description
        ? String(workspace.description)
        : `${workspace.alias} workspace`,
      allowWrite: Boolean(workspace.allowWrite),
      allowFullAccess: Boolean(workspace.allowFullAccess),
      defaultSandbox:
        workspace.defaultSandbox ?? sandboxFor(workspace.allowWrite, workspace.allowFullAccess),
    }));

  if (normalized.length) return normalized;
  return [
    {
      alias: defaults.alias,
      root: defaults.root,
      description: `${defaults.alias} workspace`,
      allowWrite: defaults.writeEnabled,
      allowFullAccess: defaults.fullAccess,
      defaultSandbox: sandboxFor(defaults.writeEnabled, defaults.fullAccess),
    },
  ];
}

async function startStack() {
  await stopStack(false);

  statuses.relay = 'starting';
  spawnManaged('relay', 'pokedex-relay', ['--config', configPath]);
  await waitForRelay();
  statuses.relay = 'ok';

  statuses.agent = 'starting';
  spawnManaged('agent', 'pokedex-agent', ['--config', configPath]);
  await waitForAgent();
  statuses.agent = 'ok';

  await startPokeTunnel();
  statuses.poke = 'ok';
  console.log("✅ Everything's fine, we're ready.\n");
  console.log('Try saying "is pokedex connected?" to your Poke!\n');
  console.log('Type "help" for commands. Keep this terminal open while you use Poke.\n');
}

async function startPokeTunnel() {
  statuses.poke = 'starting';
  spawnPokeTunnel();
  try {
    await waitForPoke();
  } catch (error) {
    if (!pokeNeedsLogin()) throw error;
    await runPokeLogin();
    spawnPokeTunnel();
    await waitForPoke();
  }
}

function spawnPokeTunnel() {
  spawnManaged('poke', npxBin(), ['poke@latest', 'tunnel', mcpHttpUrlWithToken(), '-n', 'pokedex']);
}

async function runPokeLogin() {
  console.log('Poke is not logged in. Starting `npx poke@latest login`...\n');
  const code = await runInteractive(npxBin(), ['poke@latest', 'login']);
  if (code !== 0)
    throw new Error('Poke login did not complete. Run `npx poke@latest login` and retry.');
  console.log('\nPoke login finished. Starting the tunnel again...\n');
}

function runInteractive(command, commandArgs) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, {
      cwd: invocationCwd,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', rejectRun);
    child.on('exit', (code, signal) => {
      if (signal) rejectRun(new Error(`Poke login stopped by ${signal}.`));
      else resolveRun(code ?? 0);
    });
  });
}

function pokeNeedsLogin() {
  return (serviceLogs.get('poke') ?? []).some((line) =>
    /not logged in|npx poke@latest login|poke login/i.test(line)
  );
}

async function waitForRelay() {
  await waitFor(
    async () => {
      const health = await fetchJson(`http://127.0.0.1:${config.port}/health`);
      return health?.ok === true;
    },
    10_000,
    'relay did not become healthy',
    'relay'
  );
}

async function waitForAgent() {
  await waitFor(
    async () => {
      const health = await fetchJson(`http://127.0.0.1:${config.port}/health`);
      return Number(health?.agents ?? 0) > 0;
    },
    15_000,
    'agent did not connect to relay',
    'agent'
  );
}

async function waitForPoke() {
  await sleep(1400);
  const child = managedChildren.get('poke')?.child;
  if (!child || child.exitCode !== null || child.killed)
    throw serviceFailure('poke', 'Poke stopped before the tunnel was ready.');
}

async function waitFor(check, timeoutMs, message, serviceName) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serviceName) failIfServiceExited(serviceName, message);
    if (await check()) return;
    await sleep(250);
  }
  throw serviceFailure(serviceName, message);
}

function startConsole() {
  readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'pokedex> ',
  });
  readline.on('line', (line) => void runConsoleCommand(line));
  readline.on('close', () => void stopManaged(0));
  readline.prompt();
}

async function runConsoleCommand(line) {
  readline?.pause();
  try {
    await handleCommand(splitCommand(line.trim()));
  } catch (error) {
    console.error(formatError(error));
  } finally {
    if (!stopping) {
      readline?.resume();
      readline?.prompt();
    }
  }
}

async function handleCommand(parts) {
  const [name, subcommand, ...rest] = parts;
  if (!name) return printStatus();
  if (['q', 'quit', 'exit'].includes(name)) return await stopManaged(0);
  if (name === 'help') return printInteractiveHelp();
  if (name === 'status') return printStatus();
  if (name === 'config') return printConfig();
  if (name === 'output') return printServiceOutput(subcommand);
  if (name === 'restart') return await saveAndRestart('restarting stack');
  if (name === 'write') return await setWrite(subcommand);
  if (name === 'full-access') return await setFullAccess(subcommand);
  if (name === 'workspace') return await handleWorkspaceCommand(subcommand, rest);
  if (name === 'port') return await setPort(subcommand);
  if (name === 'token' && subcommand === 'rotate') return await rotateToken();
  if (name === 'user-id') return await setScalar('userId', subcommand, 'user id');
  if (name === 'model') return await setScalar('defaultModel', subcommand, 'model');
  if (name === 'reasoning')
    return await setEnum('defaultReasoning', subcommand, [
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  if (name === 'verbosity')
    return await setEnum('defaultVerbosity', subcommand, ['low', 'medium', 'high']);
  if (name === 'approval')
    return await setEnum('defaultApprovalPolicy', subcommand, ['untrusted', 'on-request', 'never']);
  if (name === 'codex') return await setCodex([subcommand, ...rest].filter(Boolean));
  throw new Error(`Unknown command: ${name}. Type "help" for commands.`);
}

async function setWrite(raw) {
  const enabled = parseOnOff(raw, !config.writeTasksEnabled);
  config.writeTasksEnabled = enabled;
  activeWorkspace().allowWrite = enabled;
  if (!enabled) {
    config.fullAccessEnabled = false;
    activeWorkspace().allowFullAccess = false;
  }
  syncWorkspaceSandbox(activeWorkspace());
  await saveAndRestart(`write ${enabled ? 'on' : 'off'}`);
}

async function setFullAccess(raw) {
  const enabled = parseOnOff(raw, !config.fullAccessEnabled);
  config.fullAccessEnabled = enabled;
  config.writeTasksEnabled = enabled || config.writeTasksEnabled;
  activeWorkspace().allowFullAccess = enabled;
  activeWorkspace().allowWrite = enabled || activeWorkspace().allowWrite;
  syncWorkspaceSandbox(activeWorkspace());
  await saveAndRestart(`full-access ${enabled ? 'on' : 'off'}`);
}

async function handleWorkspaceCommand(subcommand, rest) {
  if (subcommand === 'list' || !subcommand) return printWorkspaces();
  if (subcommand === 'add') return await addWorkspace(rest);
  if (subcommand === 'remove') return await removeWorkspace(rest[0]);
  if (subcommand === 'use') return await useWorkspace(rest[0]);
  if (subcommand === 'describe') return await describeWorkspace(rest[0], rest.slice(1).join(' '));
  if (subcommand === 'write') return await setWorkspaceAccess(rest[0], 'allowWrite', rest[1]);
  if (subcommand === 'full-access')
    return await setWorkspaceAccess(rest[0], 'allowFullAccess', rest[1]);
  throw new Error('workspace commands: list, add, remove, use, describe, write, full-access');
}

async function addWorkspace(parts) {
  const [alias, root, ...description] = parts;
  assertAlias(alias);
  if (!root) throw new Error('usage: workspace add <alias> <path> [description]');
  upsertWorkspace(config.workspaces, {
    alias,
    root: resolveUserPath(root),
    description: description.join(' ') || `${alias} workspace`,
    allowWrite: config.writeTasksEnabled,
    allowFullAccess: config.fullAccessEnabled,
    defaultSandbox: sandboxFor(config.writeTasksEnabled, config.fullAccessEnabled),
  });
  await saveAndRestart(`workspace ${alias} saved`);
}

async function removeWorkspace(alias) {
  assertAlias(alias);
  if (config.workspaces.length === 1) throw new Error('cannot remove the last workspace');
  findWorkspace(alias);
  config.workspaces = config.workspaces.filter((workspace) => workspace.alias !== alias);
  await saveAndRestart(`workspace ${alias} removed`);
}

async function useWorkspace(alias) {
  assertAlias(alias);
  const workspace = findWorkspace(alias);
  config.workspaces = [workspace, ...config.workspaces.filter((item) => item.alias !== alias)];
  await saveAndRestart(`active workspace ${alias}`);
}

async function describeWorkspace(alias, description) {
  assertAlias(alias);
  if (!description) throw new Error('usage: workspace describe <alias> <description>');
  findWorkspace(alias).description = description;
  await saveAndRestart(`workspace ${alias} described`);
}

async function setWorkspaceAccess(alias, key, raw) {
  assertAlias(alias);
  const workspace = findWorkspace(alias);
  workspace[key] = parseOnOff(raw, !workspace[key]);
  if (key === 'allowFullAccess' && workspace[key]) {
    workspace.allowWrite = true;
    config.writeTasksEnabled = true;
    config.fullAccessEnabled = true;
  }
  if (key === 'allowWrite' && !workspace[key]) workspace.allowFullAccess = false;
  syncWorkspaceSandbox(workspace);
  await saveAndRestart(`workspace ${alias} updated`);
}

async function setPort(raw) {
  if (!/^\d+$/.test(raw ?? '')) throw new Error('usage: port <number>');
  config.port = String(Number(raw));
  config.relayUrl = `ws://127.0.0.1:${config.port}/agent`;
  await saveAndRestart(`port ${config.port}`);
}

async function rotateToken() {
  config.relayToken = randomHex();
  await saveAndRestart('token rotated');
}

async function setScalar(key, raw, label) {
  if (!raw) throw new Error(`usage: ${label} <value>`);
  config[key] = raw;
  await saveAndRestart(`${label} ${raw}`);
}

async function setEnum(key, raw, allowed) {
  if (!allowed.includes(raw)) throw new Error(`allowed values: ${allowed.join(', ')}`);
  config[key] = raw;
  await saveAndRestart(`${key} ${raw}`);
}

async function setCodex(parts) {
  if (!parts.length) throw new Error('usage: codex <command> [app-server args...]');
  config.appServerCommand = parts[0];
  config.appServerArgs = parts.slice(1).length
    ? parts.slice(1)
    : ['app-server', '--listen', 'stdio://'];
  await saveAndRestart(`codex command ${config.appServerCommand}`);
}

async function saveAndRestart(message) {
  saveConfig();
  console.log(`✅ ${message}. Saved.`);
  await startStack();
}

function printStatus() {
  console.log(`relay  ${statusIcon(statuses.relay)} ${statuses.relay}`);
  console.log(`agent  ${statusIcon(statuses.agent)} ${statuses.agent}`);
  console.log(`poke   ${statusIcon(statuses.poke)} ${statuses.poke}`);
  console.log(`mcp    ${mcpHttpUrl()}`);
  console.log(`mode   ${modeLabel(activeWorkspace())}`);
  console.log(`space  ${activeWorkspace().alias} -> ${activeWorkspace().root}`);
  console.log('tip    type "help" for commands');
}

function printConfig() {
  console.log(JSON.stringify(redactConfig(config), null, 2));
}

function printWorkspaces() {
  for (const workspace of config.workspaces) {
    const marker = workspace === activeWorkspace() ? '*' : ' ';
    console.log(`${marker} ${workspace.alias} ${modeLabel(workspace)} ${workspace.root}`);
  }
}

function printServiceOutput(name) {
  const names = name ? [name] : ['relay', 'agent', 'poke'];
  for (const key of names) {
    const lines = serviceLogs.get(key);
    if (!lines) {
      console.log(`\n${serviceTitle(key)} output\nNo output yet.`);
      continue;
    }
    console.log(`\n${serviceTitle(key)} output`);
    console.log(lines.slice(-30).join('\n') || 'no output');
  }
}

function printInteractiveHelp() {
  console.log(`pokedex commands
  status
  config
  output [relay|agent|poke]
  write [on|off]
  full-access [on|off]
  workspace list
  workspace add <alias> <path> [description]
  workspace remove <alias>
  workspace use <alias>
  workspace describe <alias> <description>
  workspace write <alias> [on|off]
  workspace full-access <alias> [on|off]
  model <name>
  reasoning minimal|low|medium|high|xhigh
  verbosity low|medium|high
  approval untrusted|on-request|never
  codex <command> [app-server args...]
  port <number>
  token rotate
  restart
  quit

setup
  codex login
  Poke login opens automatically if needed`);
}

function spawnManaged(name, bin, binArgs) {
  const commandInfo = commandFor(bin);
  const child = spawn(commandInfo.command, [...commandInfo.args, ...binArgs], {
    cwd: invocationCwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const entry = { child, exitCode: null, signal: null };
  managedChildren.set(name, entry);
  serviceLogs.set(name, []);
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => appendLog(name, chunk));
  child.stderr?.on('data', (chunk) => appendLog(name, chunk));
  child.on('error', (error) => {
    statuses[name] = 'error';
    appendLog(name, error.message);
  });
  child.on('exit', (code, signal) => {
    entry.exitCode = code ?? 0;
    entry.signal = signal;
    if (stopping || restarting) return;
    statuses[name] = 'down';
    if (!readline) return;
    console.error(
      `\n⚠️ ${serviceTitle(name)} stopped. Type "status" or "restart"; type "help" for commands.`
    );
    readline?.prompt();
  });
}

function failIfServiceExited(name, detail) {
  const entry = managedChildren.get(name);
  if (!entry) throw serviceFailure(name, detail);
  if (entry.child.exitCode !== null || entry.child.killed || statuses[name] === 'error') {
    throw serviceFailure(name, detail);
  }
}

function serviceFailure(name, detail) {
  if (!name) return new Error(detail);
  const entry = managedChildren.get(name);
  const output = formatServiceOutput(name);
  const lines = [`⚠️ ${serviceTitle(name)} needs attention.`, serviceHint(name, detail)];
  if (
    !entry ||
    (entry.child.exitCode === null &&
      !entry.child.killed &&
      entry.exitCode === null &&
      !entry.signal &&
      statuses[name] !== 'error')
  ) {
    if (output) lines.push('', output);
    lines.push('', 'Tip: type "help" after Pokedex starts to see commands.');
    return new Error(lines.join('\n'));
  }
  if (output) lines.push('', output);
  lines.push('', 'Tip: type "help" after Pokedex starts to see commands.');
  return new Error(lines.join('\n'));
}

function formatServiceOutput(name) {
  const lines = serviceLogs.get(name) ?? [];
  return lines.length ? `${serviceTitle(name)} output:\n${lines.slice(-20).join('\n')}` : '';
}

function appendLog(name, chunk) {
  const lines = serviceLogs.get(name) ?? [];
  lines.push(
    ...String(chunk)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .map((line) => cleanServiceLine(name, line))
      .filter(Boolean)
  );
  serviceLogs.set(name, lines.slice(-100));
}

async function stopStack(final) {
  restarting = !final;
  for (const entry of managedChildren.values()) entry.child.kill('SIGTERM');
  const children = [...managedChildren.values()].map((entry) => waitForExit(entry.child));
  await Promise.all(children);
  managedChildren.clear();
  if (!final) {
    restarting = false;
    statuses.relay = 'idle';
    statuses.agent = 'idle';
    statuses.poke = 'idle';
  }
}

async function stopManaged(code) {
  if (stopping) return;
  stopping = true;
  readline?.close();
  await stopStack(true);
  process.exit(code);
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => child.once('exit', resolveExit));
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function saveConfig() {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function loadSavedConfig() {
  if (existsSync(configPath)) return readJson(configPath);
  return {};
}

function readJson(path) {
  if (!existsSync(path)) return {};
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    return state && typeof state === 'object' ? state : {};
  } catch (error) {
    die(`invalid json file ${path}: ${error.message}`);
  }
}

function upsertWorkspace(workspaces, workspace) {
  const existing = workspaces.findIndex((item) => item.alias === workspace.alias);
  if (existing === -1) workspaces.unshift(workspace);
  else workspaces[existing] = { ...workspaces[existing], ...workspace };
}

function firstWorkspace(raw) {
  return Array.isArray(raw.workspaces) && raw.workspaces[0] ? raw.workspaces[0] : {};
}

function activeWorkspace() {
  return config.workspaces[0];
}

function findWorkspace(alias) {
  const workspace = config.workspaces.find((item) => item.alias === alias);
  if (!workspace) throw new Error(`unknown workspace: ${alias}`);
  return workspace;
}

function syncWorkspaceSandbox(workspace) {
  workspace.defaultSandbox = sandboxFor(workspace.allowWrite, workspace.allowFullAccess);
}

function sandboxFor(writeEnabled, fullAccess) {
  if (fullAccess) return 'danger_full_access';
  if (writeEnabled) return 'workspace_write';
  return 'read_only';
}

function modeLabel(workspace) {
  if (workspace.allowFullAccess) return 'full-access';
  if (workspace.allowWrite) return 'write';
  return 'read-only';
}

function statusIcon(status) {
  if (status === 'ok') return '✅';
  if (status === 'starting') return '⏳';
  if (status === 'error' || status === 'down') return '⚠️';
  return '•';
}

function serviceTitle(name) {
  if (name === 'relay') return 'pokedex relay';
  if (name === 'agent') return 'Codex agent';
  if (name === 'poke') return 'Poke tunnel';
  return 'pokedex';
}

function serviceHint(name, detail) {
  if (name === 'poke') return 'Run `npx poke@latest login`, then start Pokedex again.';
  if (name === 'agent') return 'Run `codex login` and `codex doctor`, then start Pokedex again.';
  if (name === 'relay')
    return 'Check the port with `pokedex --port <number>`, then start Pokedex again.';
  return detail;
}

function cleanServiceLine(name, line) {
  if (name !== 'poke') return line;
  return line.replace(/Run ['"]?poke login['"]?\.?/gi, 'Run npx poke@latest login.');
}

function formatError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('⚠️') || message.startsWith('✅')) return message;
  return `⚠️ ${message}\nType "help" for commands.`;
}

function parseOnOff(raw, defaultValue) {
  if (!raw) return defaultValue;
  if (['on', 'true', 'yes', '1'].includes(raw)) return true;
  if (['off', 'false', 'no', '0'].includes(raw)) return false;
  throw new Error('use on or off');
}

function assertAlias(alias) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(alias ?? ''))
    throw new Error('alias must match /^[a-z0-9][a-z0-9_-]{0,63}$/i');
}

function splitCommand(line) {
  const parts = [];
  let current = '';
  let quote = '';
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

function redactConfig(raw) {
  return { ...raw, relayToken: raw.relayToken ? `${raw.relayToken.slice(0, 6)}...` : '' };
}

function mcpHttpUrl() {
  return `http://127.0.0.1:${config.port}/mcp`;
}

function mcpHttpUrlWithToken() {
  return `${mcpHttpUrl()}?token=${encodeURIComponent(config.relayToken)}`;
}

function commandFor(bin) {
  return resolveManagedCommand(bin) ?? { command: bin, args: [] };
}

function resolveManagedCommand(bin) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const packagedPaths = {
    'pokedex-agent': join(packageRoot, 'dist/agent.cjs'),
    'pokedex-relay': join(packageRoot, 'dist/relay.cjs'),
  };
  const paths = {
    'pokedex-agent': join(root, 'apps/agent/dist/index.js'),
    'pokedex-relay': join(root, 'apps/relay/dist/index.js'),
  };
  if (existsSync(join(root, 'package.json'))) ensureLocalBuild(root, packagedPaths);
  if (packagedPaths[bin] && existsSync(packagedPaths[bin]))
    return { command: process.execPath, args: [packagedPaths[bin]] };
  if (paths[bin] && existsSync(paths[bin]))
    return { command: process.execPath, args: [paths[bin]] };
  return null;
}

function ensureLocalBuild(root, packagedPaths) {
  if (Object.values(packagedPaths).every((path) => existsSync(path))) return;
  const result = spawnSync(npmBin(), ['run', 'build'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });
  if (result.status !== 0)
    throw new Error(`local build failed. run npm run build and retry.${formatBuildOutput(result)}`);
}

function formatBuildOutput(result) {
  const output = [result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-30)
    .join('\n');
  return output ? `\n${output}` : '';
}

function npmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function npxBin() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function defaultConfigPath() {
  return join(homedir(), '.pokedex', 'config.json');
}

function resolveUserPath(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return resolve(invocationCwd, path);
}

function value(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function has(flag) {
  return args.includes(flag);
}

function randomHex() {
  return randomBytes(32).toString('hex');
}

function registerSignals() {
  process.once('SIGINT', () => void stopManaged(0));
  process.once('SIGTERM', () => void stopManaged(0));
}

function printBanner() {
  console.log(color(bannerText, '33;1'));
  console.log('');
}

function color(text, code) {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return text;
  return `\u001b[${code}m${text}\u001b[0m`;
}

function die(message) {
  console.error(formatError(message));
  process.exit(1);
}

function help() {
  console.log(`pokedex
Local Poke to Codex bridge.

usage
  pokedex [--workspace .] [--port 3000] [--write] [--read-only]
  pokedex help

setup
  codex login
  Poke login opens automatically if needed

config
  ~/.pokedex/config.json

interactive commands
  status
  output [relay|agent|poke]
  write on
  workspace add repo ./repo
  model gpt-5.5
  restart
  help
  quit

common
  npx codex-to-poke
  npx codex-to-poke --write
  npx codex-to-poke --read-only
`);
}
