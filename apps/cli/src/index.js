#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
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
const interactiveCommands = [
  ['status', 'show relay, agent, poke, workspace, and access status'],
  ['config', 'print the saved config with secrets hidden'],
  ['output [relay|agent|poke]', 'show recent logs for one service or all services'],
  ['write <on|off>', 'set write permission for the active workspace'],
  ['full-access <on|off>', 'set full filesystem access for the active workspace'],
  ['workspace list', 'show configured workspaces'],
  ['workspace add <alias> <path> [description]', 'add or update a workspace'],
  ['workspace remove <alias>', 'remove a workspace'],
  ['workspace use <alias>', 'make a workspace active and restart services'],
  ['workspace describe <alias> <description>', 'change a workspace description'],
  ['workspace write <alias> <on|off>', 'set write permission for one workspace'],
  ['workspace full-access <alias> <on|off>', 'set full access for one workspace'],
  ['model <name>', 'set the default Codex model'],
  ['reasoning minimal|low|medium|high|xhigh', 'set the default reasoning effort'],
  ['verbosity low|medium|high', 'set the default answer verbosity'],
  ['approval untrusted|on-request|never', 'set the default approval policy'],
  ['port <number>', 'change the local relay port and restart services'],
  ['token rotate', 'create a new relay token and restart services'],
  ['restart', 'restart relay, agent, and poke'],
  ['help', 'show this command list'],
  ['quit', 'stop Pokedex and close the prompt'],
];
let configPath = '';
let config = {};
let readline = null;
let stopping = false;
let restarting = false;

if (command === 'help') help();
else if (command === 'local') await local();
else die(`unknown command: ${command}`);

async function local() {
  configPath = existingConfigPath();
  const configFileExists = existsSync(configPath);
  config = createConfig(loadSavedConfig());
  if (!configFileExists || startupConfigOverrides()) saveConfig();

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
  const alias = value('--alias') ?? first.alias ?? 'main';
  const existing = rawWorkspace(saved, alias);
  const accessOverride = hasAccessOverride();
  const root = value('--workspace')
    ? resolveUserPath(value('--workspace'))
    : existing?.root
      ? String(existing.root)
      : (first.root ?? resolveUserPath('.'));
  const readOnly = has('--read-only');
  const fullAccess = readOnly
    ? false
    : has('--full-access')
      ? true
      : has('--write')
        ? false
        : Boolean(saved.fullAccessEnabled || existing?.allowFullAccess || first.allowFullAccess);
  const writeEnabled = readOnly
    ? false
    : has('--write') || has('--full-access')
      ? true
      : Boolean(saved.writeTasksEnabled || fullAccess || existing?.allowWrite || first.allowWrite);
  const workspaces = normalizeWorkspaces(saved.workspaces, {
    alias,
    root,
    writeEnabled,
    fullAccess,
  });
  const workspaceWrite = accessOverride ? writeEnabled : (existing?.allowWrite ?? writeEnabled);
  const workspaceFullAccess = accessOverride
    ? fullAccess
    : (existing?.allowFullAccess ?? fullAccess);

  upsertWorkspace(workspaces, {
    alias,
    root,
    description: existing?.description ? String(existing.description) : `${alias} workspace`,
    allowWrite: workspaceWrite,
    allowFullAccess: workspaceFullAccess,
    defaultSandbox: sandboxFor(workspaceWrite, workspaceFullAccess),
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
    defaultApprovalPolicy: value('--approval') ?? saved.defaultApprovalPolicy ?? 'never',
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

async function startStack({ announceReady = true } = {}) {
  await stopStack(false);
  await ensureCodexReady();

  statuses.relay = 'starting';
  spawnManaged('relay', 'pokedex-relay', [
    '--config',
    configPath,
    '--port',
    config.port,
    '--token',
    config.relayToken,
    '--user-id',
    config.userId,
  ]);
  await waitForRelay();
  statuses.relay = 'ok';

  statuses.agent = 'starting';
  spawnManaged('agent', 'pokedex-agent', [
    '--config',
    configPath,
    '--relay-url',
    config.relayUrl,
    '--user-id',
    config.userId,
  ]);
  await waitForAgent();
  statuses.agent = 'ok';

  await startPokeTunnel();
  statuses.poke = 'ok';
  if (announceReady) {
    console.log("✅ Everything's fine, we're ready.\n");
    console.log('Try saying "is pokedex connected?" to your Poke!\n');
    console.log(
      'Type "help" for commands, or just ask your Poke. Keep this terminal open while you use Poke.\n'
    );
  }
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
  const code = await runInteractive(npxBin(), ['poke@latest', 'login'], 'Poke login');
  if (code !== 0)
    throw new Error('Poke login did not complete. Run `npx poke@latest login` and retry.');
}

async function ensureCodexReady() {
  if (config.appServerCommand !== 'codex') return;
  if (!commandExists(config.appServerCommand)) await installCodexCli();
}

async function installCodexCli() {
  console.log('Codex CLI missing. Installing `@openai/codex` with npm...\n');
  const code = await runInteractive(
    npmBin(),
    ['install', '-g', '@openai/codex@latest'],
    'Codex install'
  );
  if (code !== 0)
    throw new Error(
      'Codex CLI install failed. Install it with `npm install -g @openai/codex@latest`, then retry.'
    );
  if (!commandExists(config.appServerCommand))
    throw new Error(
      'Codex CLI installed, but `codex` is still not on PATH. Open a new terminal or install it with `npm install -g @openai/codex@latest`.'
    );
}

function commandExists(command) {
  const result = spawnSync(command, ['--version'], {
    cwd: invocationCwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });
  return !result.error;
}

function runInteractive(command, commandArgs, label) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, {
      cwd: invocationCwd,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', rejectRun);
    child.on('exit', (code, signal) => {
      if (signal) rejectRun(new Error(`${label} stopped by ${signal}.`));
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
  if (!child || childExited(child) || child.killed)
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
  if (name === 'restart') return await restartStack();
  if (name === 'write') return await setWrite(subcommand);
  if (name === 'full-access') return await setFullAccess(subcommand);
  if (name === 'workspace') return await handleWorkspaceCommand(subcommand, rest);
  if (name === 'port') return await setPort(subcommand);
  if (name === 'token' && subcommand === 'rotate') return await rotateToken();
  if (name === 'user-id') return await setScalar('userId', subcommand, 'user id', true);
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
  if (name === 'approval' || name === 'approve')
    return await setEnum('defaultApprovalPolicy', subcommand, ['untrusted', 'on-request', 'never']);
  throw new Error(`Unknown command: ${name}. Type "help" for commands, or just ask your Poke.`);
}

async function setWrite(raw) {
  const enabled = parseOnOff(raw, 'write <on|off>');
  config.writeTasksEnabled = enabled;
  activeWorkspace().allowWrite = enabled;
  if (!enabled) {
    config.fullAccessEnabled = false;
    activeWorkspace().allowFullAccess = false;
  }
  syncWorkspaceSandbox(activeWorkspace());
  await saveSetting('writeTasksEnabled', enabled ? 'on' : 'off');
}

async function setFullAccess(raw) {
  const enabled = parseOnOff(raw, 'full-access <on|off>');
  config.fullAccessEnabled = enabled;
  config.writeTasksEnabled = enabled || config.writeTasksEnabled;
  activeWorkspace().allowFullAccess = enabled;
  activeWorkspace().allowWrite = enabled || activeWorkspace().allowWrite;
  syncWorkspaceSandbox(activeWorkspace());
  await saveSetting('fullAccessEnabled', enabled ? 'on' : 'off');
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
  const usage =
    key === 'allowWrite'
      ? 'workspace write <alias> <on|off>'
      : 'workspace full-access <alias> <on|off>';
  if (!alias || !raw) throw new Error(`usage: ${usage}`);
  assertAlias(alias);
  const workspace = findWorkspace(alias);
  workspace[key] = parseOnOff(raw, usage);
  if (key === 'allowWrite' && workspace[key]) config.writeTasksEnabled = true;
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
  await saveSetting('port', config.port, true);
}

async function rotateToken() {
  config.relayToken = randomHex();
  await saveAndRestart('token rotated', true);
}

async function setScalar(key, raw, label, restart = false) {
  if (!raw) throw new Error(`usage: ${label} <value>`);
  config[key] = raw;
  await saveSetting(key, raw, restart);
}

async function setEnum(key, raw, allowed) {
  if (!allowed.includes(raw)) throw new Error(`allowed values: ${allowed.join(', ')}`);
  config[key] = raw;
  await saveSetting(key, raw);
}

async function restartStack() {
  console.log('✅ restarting stack');
  await startStack();
}

async function saveSetting(setting, value, restart = false) {
  saveConfig();
  console.log(`✅ ${setting} set to ${value}.`);
  if (restart) await startStack({ announceReady: false });
}

async function saveAndRestart(message, restart = false) {
  saveConfig();
  console.log(`✅ ${message}`);
  if (restart) await startStack({ announceReady: false });
}

function printStatus() {
  const workspace = activeWorkspace();
  console.log(`relay  ${statusIcon(statuses.relay)} ${statuses.relay}`);
  console.log(`agent  ${statusIcon(statuses.agent)} ${statuses.agent}`);
  console.log(`poke   ${statusIcon(statuses.poke)} ${statuses.poke}`);
  console.log(`mcp    ${mcpHttpUrl()}`);
  console.log(`active ${workspace.alias} -> ${workspace.root}`);
  console.log(`access ${modeLabel(workspace)} for active workspace`);
  console.log(
    `${config.workspaces.length} ${config.workspaces.length === 1 ? 'workspace' : 'workspaces'} configured`
  );
  console.log('tip    type "help" for commands');
}

function printConfig() {
  console.log(stringifyConfigJsonc(redactConfig(config)));
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
${formatCommandHelp(interactiveCommands)}`);
}

function spawnManaged(name, bin, binArgs) {
  const commandInfo = commandFor(bin);
  const detached = process.platform !== 'win32';
  const child = spawn(commandInfo.command, [...commandInfo.args, ...binArgs], {
    cwd: invocationCwd,
    detached,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const entry = { child, detached, exitCode: null, signal: null };
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
      `\n⚠️ ${serviceTitle(name)} stopped. Type "status" or "restart"; type "help" for commands, or just ask your Poke.`
    );
    readline?.prompt();
  });
}

function failIfServiceExited(name, detail) {
  const entry = managedChildren.get(name);
  if (!entry) throw serviceFailure(name, detail);
  if (childExited(entry.child) || entry.child.killed || statuses[name] === 'error') {
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
    (!childExited(entry.child) &&
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
  // poke removes the temporary mcp connection from its own signal handler.
  await stopManagedChild('poke', 'SIGINT', 20_000);
  await Promise.all(
    [...managedChildren.keys()].map((name) => stopManagedChild(name, 'SIGTERM', 8_000))
  );
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

async function stopManagedChild(name, signal, timeoutMs) {
  const entry = managedChildren.get(name);
  if (!entry) return;
  signalManagedChild(name, entry, signal);
  if (!(await waitForExit(entry.child, timeoutMs))) {
    appendLog(name, `${serviceTitle(name)} did not stop in time; forcing shutdown.`);
    signalManagedChild(name, entry, 'SIGKILL');
    await waitForExit(entry.child, 2_000);
  }
  managedChildren.delete(name);
}

function signalManagedChild(name, entry, signal) {
  if (childExited(entry.child)) return;
  try {
    if (entry.detached && entry.child.pid) process.kill(-entry.child.pid, signal);
    else entry.child.kill(signal);
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    if (entry.detached) {
      try {
        entry.child.kill(signal);
        return;
      } catch (fallbackError) {
        appendLog(
          name,
          `${serviceTitle(name)} ${signal} fallback failed: ${fallbackError.message}`
        );
      }
    }
    appendLog(name, `${serviceTitle(name)} ${signal} failed: ${error.message}`);
  }
}

function waitForExit(child, timeoutMs = 0) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    let timer;
    const done = () => {
      if (timer) clearTimeout(timer);
      resolveExit(true);
    };
    child.once('exit', done);
    if (timeoutMs) {
      timer = setTimeout(() => {
        child.off('exit', done);
        resolveExit(false);
      }, timeoutMs);
    }
  });
}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
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
  writeFileSync(configPath, stringifyConfigJsonc(config));
}

function loadSavedConfig() {
  if (existsSync(configPath)) return readJsonc(configPath);
  return {};
}

function readJsonc(path) {
  if (!existsSync(path)) return {};
  try {
    const state = parseJsonc(readFileSync(path, 'utf8'));
    return state && typeof state === 'object' ? state : {};
  } catch (error) {
    die(`invalid jsonc file ${path}: ${error.message}`);
  }
}

function stringifyConfigJsonc(raw) {
  const lines = [
    '{',
    ...advancedConfigLines(raw),
    '  // random bearer token shared by the relay, agent, and poke tunnel.',
    `  "relayToken": ${quote(raw.relayToken)},`,
    '',
    '  // default model used when a poke request does not override it.',
    `  "defaultModel": ${quote(raw.defaultModel)},`,
    '',
    '  // default reasoning effort used when a poke request does not override it.',
    `  "defaultReasoning": ${quote(raw.defaultReasoning)},`,
    '',
    '  // default response verbosity used when a poke request does not override it.',
    `  "defaultVerbosity": ${quote(raw.defaultVerbosity)},`,
    '',
    '  // default approval policy used when a poke request does not override it.',
    `  "defaultApprovalPolicy": ${quote(raw.defaultApprovalPolicy)},`,
    '',
    '  // global write gate; workspace_write also needs allowWrite on the selected workspace.',
    `  "writeTasksEnabled": ${Boolean(raw.writeTasksEnabled)},`,
    '',
    '  // global full-access gate; danger_full_access also needs allowFullAccess on the selected workspace.',
    `  "fullAccessEnabled": ${Boolean(raw.fullAccessEnabled)},`,
    '',
    '  // configured local workspaces that poke can ask codex to use.',
    '  "workspaces": [',
    ...configWorkspaceLines(Array.isArray(raw.workspaces) ? raw.workspaces : []),
    '  ]',
    '}',
    '',
  ];
  return lines.join('\n');
}

function advancedConfigLines(raw) {
  const lines = [];
  const defaultRelayUrl = `ws://127.0.0.1:${raw.port ?? '3000'}/agent`;
  addAdvancedConfigLine(lines, raw.port !== '3000', [
    '  // optional relay port override. omit this for the default 3000.',
    `  "port": ${quote(raw.port)},`,
  ]);
  addAdvancedConfigLine(lines, raw.userId !== 'local', [
    '  // optional local user id override used to pair this agent with the relay.',
    `  "userId": ${quote(raw.userId)},`,
  ]);
  addAdvancedConfigLine(lines, raw.relayUrl !== defaultRelayUrl, [
    '  // optional websocket url override where the local agent connects to the relay.',
    `  "relayUrl": ${quote(raw.relayUrl)},`,
  ]);
  addAdvancedConfigLine(lines, raw.appServerCommand !== 'codex', [
    '  // optional command override used to start the codex app server.',
    `  "appServerCommand": ${quote(raw.appServerCommand)},`,
  ]);
  addAdvancedConfigLine(
    lines,
    !sameArray(raw.appServerArgs, ['app-server', '--listen', 'stdio://']),
    [
      '  // optional arguments override passed to the app server command.',
      `  "appServerArgs": ${inlineArray(raw.appServerArgs)},`,
    ]
  );
  return lines;
}

function addAdvancedConfigLine(lines, include, section) {
  if (!include) return;
  lines.push(...section, '');
}

function configWorkspaceLines(workspaces) {
  return workspaces.flatMap((workspace, index) => [
    '    {',
    '      // short alias used as workspaceAlias in poke requests.',
    `      "alias": ${quote(workspace.alias)},`,
    '',
    '      // absolute folder where codex runs for this workspace.',
    `      "root": ${quote(workspace.root)},`,
    '',
    '      // human-readable label shown when poke lists workspaces.',
    `      "description": ${quote(workspace.description)},`,
    '',
    '      // workspace write gate; workspace_write needs this and writeTasksEnabled.',
    `      "allowWrite": ${Boolean(workspace.allowWrite)},`,
    '',
    '      // workspace full-access gate; danger_full_access needs this and fullAccessEnabled.',
    `      "allowFullAccess": ${Boolean(workspace.allowFullAccess)},`,
    '',
    '      // default sandbox used when a poke request does not choose one.',
    `      "defaultSandbox": ${quote(workspace.defaultSandbox)}`,
    `    }${index === workspaces.length - 1 ? '' : ','}`,
  ]);
}

function parseJsonc(text) {
  return JSON.parse(stripJsonc(text));
}

function stripJsonc(text) {
  let output = '';
  let quoteChar = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    const next = text[index + 1] ?? '';

    if (lineComment) {
      if (char === '\n' || char === '\r') {
        lineComment = false;
        output += char;
      } else output += ' ';
      continue;
    }

    if (blockComment) {
      if (char === '*' && next === '/') {
        output += '  ';
        index += 1;
        blockComment = false;
      } else output += char === '\n' || char === '\r' ? char : ' ';
      continue;
    }

    if (quoteChar) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quoteChar) quoteChar = '';
      continue;
    }

    if (char === '"' || char === "'") {
      quoteChar = char;
      output += char;
      continue;
    }

    if (char === '/' && next === '/') {
      output += '  ';
      index += 1;
      lineComment = true;
      continue;
    }

    if (char === '/' && next === '*') {
      output += '  ';
      index += 1;
      blockComment = true;
      continue;
    }

    output += char;
  }

  return removeTrailingCommas(output);
}

function removeTrailingCommas(text) {
  let output = '';
  let quoteChar = '';
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';

    if (quoteChar) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quoteChar) quoteChar = '';
      continue;
    }

    if (char === '"' || char === "'") {
      quoteChar = char;
      output += char;
      continue;
    }

    if (char === ',') {
      let nextIndex = index + 1;
      while (/\s/.test(text[nextIndex] ?? '')) nextIndex += 1;
      if (['}', ']'].includes(text[nextIndex] ?? '')) continue;
    }

    output += char;
  }

  return output;
}

function quote(value) {
  return JSON.stringify(value ?? '');
}

function inlineArray(value) {
  return `[${(Array.isArray(value) ? value : []).map(quote).join(', ')}]`;
}

function sameArray(left, right) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

function upsertWorkspace(workspaces, workspace) {
  const existing = workspaces.findIndex((item) => item.alias === workspace.alias);
  if (existing === -1) workspaces.unshift(workspace);
  else workspaces[existing] = { ...workspaces[existing], ...workspace };
}

function firstWorkspace(raw) {
  return Array.isArray(raw.workspaces) && raw.workspaces[0] ? raw.workspaces[0] : {};
}

function rawWorkspace(raw, alias) {
  if (!Array.isArray(raw.workspaces)) return undefined;
  return raw.workspaces.find(
    (workspace) => workspace && typeof workspace === 'object' && workspace.alias === alias
  );
}

function hasAccessOverride() {
  return ['--read-only', '--write', '--full-access'].some((flag) => args.includes(flag));
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
  if (name === 'agent') return 'Type `output agent` to inspect Codex app-server output.';
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
  if (message.includes('Type "help" for commands, or just ask your Poke.')) return `⚠️ ${message}`;
  return `⚠️ ${message}\nType "help" for commands, or just ask your Poke.`;
}

function formatCommandHelp(commands) {
  const width = Math.max(...commands.map(([name]) => name.length)) + 2;
  return commands.map(([name, description]) => `  ${name.padEnd(width)}${description}`).join('\n');
}

function parseOnOff(raw, usage) {
  if (!raw) throw new Error(`usage: ${usage}`);
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
  return join(homedir(), '.pokedex', 'config.jsonc');
}

function legacyConfigPath() {
  return join(homedir(), '.pokedex', 'config.json');
}

function existingConfigPath() {
  if (existsSync(defaultConfigPath())) return defaultConfigPath();
  if (existsSync(legacyConfigPath())) return legacyConfigPath();
  return defaultConfigPath();
}

function startupConfigOverrides() {
  return [
    '--read-only',
    '--write',
    '--full-access',
    '--alias',
    '--workspace',
    '--port',
    '--token',
    '--codex',
    '--model',
    '--reasoning',
    '--verbosity',
    '--approval',
    '--user-id',
  ].some((flag) => args.includes(flag));
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
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => void stopManaged(0));
  }
  process.once('uncaughtException', (error) => void stopAfterFatal(error));
  process.once('unhandledRejection', (error) => void stopAfterFatal(error));
}

async function stopAfterFatal(error) {
  console.error(formatError(error));
  await stopManaged(1);
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

config
  ~/.pokedex/config.jsonc

interactive commands
${formatCommandHelp(interactiveCommands)}

common
  npx codex-to-poke
  npx codex-to-poke --write
  npx codex-to-poke --read-only
`);
}
