#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
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
const defaultPort = '4200';
const defaultPortLabel = '4200';
const portScanLimit = 100;
const unprivilegedPortStart = 1024;
const managedShutdownPollMs = 50;
const relayPortCloseTimeoutMs = 2_000;
const bannerText = [
  '▄▄▄▄   ▄▄▄  ▄▄ ▄▄ ▄▄▄▄▄ ▄▄▄▄  ▄▄▄▄▄ ▄▄ ▄▄ ',
  '██▄█▀ ██▀██ ██▄█▀ ██▄▄  ██▀██ ██▄▄  ▀█▄█▀ ',
  '██    ▀███▀ ██ ██ ██▄▄▄ ████▀ ██▄▄▄ ██ ██ ',
].join('\n');
const interactiveCommands = [
  ['status', 'show relay, agent, poke, workspace, and access status'],
  ['logs [relay|agent|poke]', 'show recent logs for one service or all services'],
  ['shell <on|off>', 'dangerous: allow Poke to run Pokedex prompt commands'],
  ['ws list', 'show configured workspaces'],
  ['ws add <alias> <path> [description]', 'add or update a workspace'],
  ['ws rm <alias>', 'remove a workspace'],
  ['ws use <alias>', 'make a workspace active and restart services'],
  ['ws desc <alias> <description>', 'change a workspace description'],
  ['ws perms <alias> read-only|write|full-access', 'set workspace access'],
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
let configuredRelayPort = '';
let readline = null;
let stopping = false;
let restarting = false;
let closingAfterServiceExit = false;

if (command === 'help') help();
else if (command === 'local') await local();
else die(`unknown command: ${command}`);

async function local() {
  configPath = existingConfigPath();
  const configFileExists = existsSync(configPath);
  config = createConfig(loadSavedConfig());
  configuredRelayPort = config.port;
  if (!configFileExists || startupConfigOverrides()) saveConfig();

  printBanner();

  registerSignals();
  try {
    await startStack();
  } catch (error) {
    console.error(formatError(error));
    try {
      await stopStack(false);
    } catch (stopError) {
      console.error(formatError(stopError));
    }
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

  const port = normalizePort(value('--port') ?? saved.port ?? defaultPort, '--port <number>');

  return {
    port: String(port),
    userId: value('--user-id') ?? saved.userId ?? 'local',
    relayUrl: relayUrlForPort(port),
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
    pokedexCommandsEnabled: Boolean(saved.pokedexCommandsEnabled),
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
  await useAvailableRelayPort();

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
  if (name === 'quit') return await stopManaged(0);
  if (name === 'help') return printInteractiveHelp();
  if (name === 'status') return printStatus();
  if (name === 'logs') return printServiceLogs(subcommand);
  if (name === 'restart') return await restartStack();
  if (name === 'shell') return await setShell(subcommand);
  if (name === 'write' || name === 'full-access')
    throw new Error('use `ws perms <alias> read-only|write|full-access` instead');
  if (name === 'ws') return await handleWorkspaceCommand(subcommand, rest);
  if (name === 'port') return await setPort(subcommand);
  if (name === 'token' && subcommand === 'rotate') return await rotateToken();
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
  throw new Error(`Unknown command: ${name}. Type "help" for commands, or just ask your Poke.`);
}

async function setShell(raw) {
  const enabled = parseOnOff(raw, 'shell <on|off>');
  config.pokedexCommandsEnabled = enabled;
  if (enabled) {
    console.log(
      'WARNING: this lets Poke change Pokedex settings such as workspaces and permissions. Only enable it if you trust the current Poke session.'
    );
  }
  await saveSetting('pokedexCommandsEnabled', enabled ? 'on' : 'off');
}

async function handleWorkspaceCommand(subcommand, rest) {
  if (subcommand === 'list' || !subcommand) return printWorkspaces();
  if (subcommand === 'add') return await addWorkspace(rest);
  if (subcommand === 'rm') return await removeWorkspace(rest[0]);
  if (subcommand === 'use') return await useWorkspace(rest[0]);
  if (subcommand === 'desc') return await describeWorkspace(rest[0], rest.slice(1).join(' '));
  if (subcommand === 'perms') return await setWorkspacePermissions(rest[0], rest[1]);
  if (subcommand === 'write' || subcommand === 'full-access')
    throw new Error('use `ws perms <alias> read-only|write|full-access` instead');
  throw new Error('ws commands: list, add, rm, use, desc, perms');
}

async function addWorkspace(parts) {
  const [alias, root, ...description] = parts;
  assertAlias(alias);
  if (!root) throw new Error('usage: ws add <alias> <path> [description]');
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
  syncGlobalAccessGates();
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
  if (!description) throw new Error('usage: ws desc <alias> <description>');
  findWorkspace(alias).description = description;
  await saveAndRestart(`workspace ${alias} described`);
}

async function setWorkspacePermissions(alias, raw) {
  const usage = 'ws perms <alias> read-only|write|full-access';
  if (!alias || !raw) throw new Error(`usage: ${usage}`);
  assertAlias(alias);
  const workspace = findWorkspace(alias);
  const mode = parseWorkspacePermission(raw);
  workspace.allowWrite = mode !== 'read-only';
  workspace.allowFullAccess = mode === 'full-access';
  syncWorkspaceSandbox(workspace);
  syncGlobalAccessGates();
  await saveAndRestart(`workspace ${alias} permissions set to ${mode}`);
}

async function setPort(raw) {
  const port = normalizePort(raw, 'port <number>');
  configuredRelayPort = String(port);
  config.port = String(port);
  config.relayUrl = relayUrlForPort(port);
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

async function useAvailableRelayPort() {
  const requested = normalizePort(configuredRelayPort || config.port, 'port <number>');
  const port = await findAvailablePort(requested);
  config.port = String(port);
  config.relayUrl = relayUrlForPort(port);
  if (port !== requested)
    console.log(`⚠️ port ${displayPort(requested)} is unavailable; using ${port} for this run.`);
}

async function findAvailablePort(start) {
  const ranges = portSearchRanges(start);
  for (const [first, last] of ranges) {
    for (let port = first; port <= last; port += 1) {
      if (await isPortAvailable(port)) return port;
    }
  }
  throw new Error(
    `no available localhost port found from ${displayPort(start)} through ${ranges.at(-1)?.[1] ?? start}.`
  );
}

function portSearchRanges(start) {
  const ranges = [[start, Math.min(65535, start + portScanLimit - 1)]];
  if (start < unprivilegedPortStart && ranges[0][1] < unprivilegedPortStart)
    ranges.push([
      unprivilegedPortStart,
      Math.min(65535, unprivilegedPortStart + portScanLimit - 1),
    ]);
  return ranges;
}

function isPortAvailable(port) {
  return new Promise((resolvePort) => {
    const server = createNetServer();
    let settled = false;
    const settle = (available) => {
      if (settled) return;
      settled = true;
      resolvePort(available);
    };
    server.unref();
    server.once('error', () => settle(false));
    server.once('listening', () => server.close(() => settle(true)));
    server.listen(port, '127.0.0.1');
  });
}

function normalizePort(raw, usage) {
  const port = Number(raw);
  if (!/^\d+$/.test(String(raw ?? '')) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`usage: ${usage}`);
  return port;
}

function relayUrlForPort(port) {
  return `ws://127.0.0.1:${port}/agent`;
}

function displayPort(port) {
  return port === Number(defaultPort) ? defaultPortLabel : String(port);
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
  console.log(`shell  ${config.pokedexCommandsEnabled ? 'enabled' : 'disabled'}`);
  console.log(
    `${config.workspaces.length} ${config.workspaces.length === 1 ? 'workspace' : 'workspaces'} configured`
  );
  console.log('tip    type "help" for commands');
}

function printWorkspaces() {
  for (const workspace of config.workspaces) {
    const marker = workspace === activeWorkspace() ? '*' : ' ';
    console.log(`${marker} ${workspace.alias} ${modeLabel(workspace)} ${workspace.root}`);
  }
}

function printServiceLogs(name) {
  const names = name ? [name] : ['relay', 'agent', 'poke'];
  for (const key of names) {
    const lines = serviceLogs.get(key);
    if (!lines) {
      console.log(`\n${serviceTitle(key)} logs\nNo logs yet.`);
      continue;
    }
    console.log(`\n${serviceTitle(key)} logs`);
    console.log(lines.slice(-30).join('\n') || 'no logs');
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
    void handleUnexpectedServiceExit(name);
  });
}

async function handleUnexpectedServiceExit(name) {
  statuses[name] = 'down';
  if (name === 'relay') markRelayDependentsBlocked();
  if (!readline) return;
  console.error(`\n⚠️ ${serviceTitle(name)} stopped. Closing the local MCP stack.`);
  await closeStackAfterUnexpectedExit(name);
}

async function closeStackAfterUnexpectedExit(name) {
  if (closingAfterServiceExit || stopping) return;
  closingAfterServiceExit = true;
  try {
    await stopStack(false);
    console.error(
      `⚠️ ${serviceTitle(name)} stopped, so Pokedex closed the local MCP stack. Type "restart" to start it again.`
    );
  } catch (error) {
    console.error(formatError(error));
  } finally {
    closingAfterServiceExit = false;
    readline?.prompt();
  }
}

function markRelayDependentsBlocked() {
  for (const name of ['agent', 'poke']) {
    if (statuses[name] === 'ok' || statuses[name] === 'starting') statuses[name] = 'blocked';
  }
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
  return lines.length ? `${serviceTitle(name)} logs:\n${lines.slice(-20).join('\n')}` : '';
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
  const hadRelay = managedChildren.has('relay');
  const relayPort = Number(config.port);
  const failures = new Set();
  // poke removes the temporary mcp connection from its own signal handler.
  if (!(await stopManagedChild('poke', 'SIGINT', 20_000))) failures.add('poke');
  const stopResults = await Promise.all(
    [...managedChildren.keys()].map(async (name) => ({
      name,
      stopped: await stopManagedChild(name, 'SIGTERM', 8_000),
    }))
  );
  for (const { name, stopped: isStopped } of stopResults) {
    if (!isStopped) failures.add(name);
  }
  if (
    hadRelay &&
    Number.isInteger(relayPort) &&
    !(await waitForRelayPortClosed(relayPort, relayPortCloseTimeoutMs))
  ) {
    appendLog('relay', `relay port ${relayPort} is still in use after shutdown.`);
    failures.add('relay');
  }
  if (!final) {
    restarting = false;
    statuses.relay = 'idle';
    statuses.agent = 'idle';
    statuses.poke = 'idle';
  }
  if (failures.size) {
    const message = `${[...failures].map(serviceTitle).join(', ')} did not stop cleanly. Start was cancelled so no duplicate stack is left running.`;
    if (!final) throw new Error(message);
    console.error(`⚠️ ${message}`);
    return false;
  }
  return true;
}

async function stopManaged(code) {
  if (stopping) return;
  stopping = true;
  readline?.close();
  const stopped = await stopStack(true);
  process.exit(stopped ? code : 1);
}

async function waitForRelayPortClosed(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // a closed relay means the localhost port can be rebound.
    if (await isPortAvailable(port)) return true;
    await sleep(100);
  }
  return false;
}

async function stopManagedChild(name, signal, timeoutMs) {
  const entry = managedChildren.get(name);
  if (!entry) return true;
  signalManagedChild(name, entry, signal);
  if (!(await waitForManagedChildExit(entry, timeoutMs))) {
    appendLog(name, `${serviceTitle(name)} did not stop in time; forcing shutdown.`);
    signalManagedChild(name, entry, 'SIGKILL');
    if (!(await waitForManagedChildExit(entry, 2_000))) {
      appendLog(name, `${serviceTitle(name)} still appears to be running after SIGKILL.`);
      return false;
    }
  }
  managedChildren.delete(name);
  return true;
}

function signalManagedChild(name, entry, signal) {
  const canSignalGroup = entry.detached && entry.child.pid && process.platform !== 'win32';
  if (canSignalGroup && processGroupAlive(entry.child.pid)) {
    try {
      process.kill(-entry.child.pid, signal);
      return;
    } catch (error) {
      if (error?.code === 'ESRCH') return;
      appendLog(name, `${serviceTitle(name)} process-group ${signal} failed: ${error.message}`);
    }
  }
  if (childExited(entry.child)) return;
  try {
    entry.child.kill(signal);
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    appendLog(name, `${serviceTitle(name)} ${signal} failed: ${error.message}`);
  }
}

function waitForManagedChildExit(entry, timeoutMs) {
  if (managedChildStopped(entry)) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    let pollTimer;
    let timeoutTimer;
    const done = (stopped) => {
      if (pollTimer) clearTimeout(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      entry.child.off('exit', check);
      resolveExit(stopped);
    };
    const check = () => {
      if (managedChildStopped(entry)) {
        done(true);
        return;
      }
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(check, managedShutdownPollMs);
    };
    entry.child.once('exit', check);
    timeoutTimer = setTimeout(() => {
      if (pollTimer) clearTimeout(pollTimer);
      entry.child.off('exit', check);
      resolveExit(false);
    }, timeoutMs);
    check();
  });
}

function managedChildStopped(entry) {
  if (!childExited(entry.child)) return false;
  return !entry.detached || !processGroupAlive(entry.child.pid);
}

function processGroupAlive(pid) {
  if (!pid || process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
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
  writeFileSync(
    configPath,
    stringifyConfigJsonc({
      ...config,
      port: configuredRelayPort || config.port,
      relayUrl: relayUrlForPort(configuredRelayPort || config.port),
    })
  );
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
    '  // dangerous gate for pokedex_command. keep false unless you trust Poke to change Pokedex settings.',
    `  "pokedexCommandsEnabled": ${Boolean(raw.pokedexCommandsEnabled)},`,
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
  const defaultRelayUrl = `ws://127.0.0.1:${raw.port ?? defaultPort}/agent`;
  addAdvancedConfigLine(lines, raw.port !== defaultPort, [
    `  // optional relay port override. omit this for the default ${defaultPortLabel}.`,
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

function syncGlobalAccessGates() {
  config.fullAccessEnabled = config.workspaces.some((workspace) => workspace.allowFullAccess);
  config.writeTasksEnabled =
    config.fullAccessEnabled || config.workspaces.some((workspace) => workspace.allowWrite);
}

function sandboxFor(writeEnabled, fullAccess) {
  if (fullAccess) return 'danger_full_access';
  if (writeEnabled) return 'workspace_write';
  return 'read_only';
}

function modeLabel(workspace) {
  if (config.fullAccessEnabled && workspace.allowFullAccess) return 'full-access';
  if (config.writeTasksEnabled && workspace.allowWrite) return 'write';
  return 'read-only';
}

function statusIcon(status) {
  if (status === 'ok') return '✅';
  if (status === 'starting') return '⏳';
  if (status === 'error' || status === 'down' || status === 'blocked') return '⚠️';
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
  if (name === 'agent') return 'Type `logs agent` to inspect Codex app-server logs.';
  if (name === 'relay')
    return `Pokedex tries the next local port automatically. Type \`logs relay\`, or run \`pokedex --port <number>\` to pin a port.`;
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
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  throw new Error('use on or off');
}

function parseWorkspacePermission(raw) {
  const value = raw?.toLowerCase().replace(/_/g, '-');
  if (!value) throw new Error('usage: ws perms <alias> read-only|write|full-access');
  if (['read-only', 'write', 'full-access'].includes(value)) return value;
  throw new Error('allowed permissions: read-only, write, full-access');
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
  pokedex [--workspace .] [--port ${defaultPortLabel}] [--write] [--read-only]
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
