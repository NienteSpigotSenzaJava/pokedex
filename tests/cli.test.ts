import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cliPath = fileURLToPath(new URL('../apps/cli/src/index.js', import.meta.url));
const runnerPath = fileURLToPath(new URL('../packages/codex-runner/src/index.ts', import.meta.url));

describe('pokedex cli', () => {
  it('prints command help without setup guidance', () => {
    const output = execFileSync(process.execPath, [cliPath, 'help'], { encoding: 'utf8' });

    expect(output).not.toContain('setup');
    expect(output).not.toContain('Poke login opens automatically if needed');
    expect(output).not.toContain('codex login');
    expect(output).toContain('pokedex help');
    expect(output).toContain('[--port 4200]');
    expect(output).toContain('~/.pokedex/config.jsonc');
    expect(output).toContain('logs [relay|agent|poke]');
    expect(output).toContain('show recent logs for one service or all services');
    expect(output).toContain('shell <on|off>');
    expect(output).toContain('dangerous: allow Poke to run Pokedex prompt commands');
    expect(output).toContain('ws add <alias> <path> [description]');
    expect(output).toContain('add or update a workspace');
    expect(output).toContain('ws rm <alias>');
    expect(output).toContain('ws use <alias>');
    expect(output).toContain('ws desc <alias> <description>');
    expect(output).toContain('ws perms <alias> read-only|write|full-access');
    expect(output).toContain('set workspace access');
    expect(output).not.toContain('config                                      ');
    expect(output).not.toContain('output [relay|agent|poke]');
    expect(output).not.toContain('ws remove');
    expect(output).not.toContain('ws switch');
    expect(output).not.toContain('ws describe');
    expect(output).not.toContain('ws permissions');
    expect(output).not.toContain(`write <${'on|off'}>`);
    expect(output).not.toContain(`full-access <${'on|off'}>`);
    expect(output).not.toContain(`${['ws', 'write'].join(' ')} <alias> <${'on|off'}>`);
    expect(output).not.toContain('codex <command>');
  });

  it('does not duplicate help guidance for errors that already include it', () => {
    const source = readFileSync(cliPath, 'utf8');

    expect(source).toContain(
      'if (message.includes(\'Type "help" for commands, or just ask your Poke.\'))'
    );
    expect(source).toContain(
      'throw new Error(`Unknown command: ${name}. Type "help" for commands, or just ask your Poke.`);'
    );
  });

  it('defaults approval policy to never for poke compatibility', () => {
    const source = readFileSync(cliPath, 'utf8');

    expect(source).toContain(
      "defaultApprovalPolicy: value('--approval') ?? saved.defaultApprovalPolicy ?? 'never'"
    );
    expect(source).not.toContain(
      "defaultApprovalPolicy: value('--approval') ?? saved.defaultApprovalPolicy ?? 'on-request'"
    );
  });

  it('keeps terminal-facing failure text friendly', () => {
    const source = `${readFileSync(cliPath, 'utf8')}\n${readFileSync(runnerPath, 'utf8')}`;

    for (const text of [
      'startup failed',
      'exited with code',
      'poke logs:',
      "Run 'poke login'",
      'Poke login opens automatically if needed',
      "Everything's ready",
    ]) {
      expect(source).not.toContain(text);
    }
  });

  it('only installs codex when the command is missing', () => {
    const source = readFileSync(cliPath, 'utf8');

    expect(source).toContain('await ensureCodexReady();');
    expect(source).toContain("['install', '-g', '@openai/codex@latest']");
    expect(source).not.toContain("['doctor']");
    expect(source).not.toContain("['login']");
    expect(source).not.toContain('Codex check failed');
    expect(source).not.toContain('Poke is not logged in. Starting');
    expect(source).not.toContain('Poke login finished');
  });

  it('confirms saved settings without replaying startup guidance', () => {
    const source = readFileSync(cliPath, 'utf8');

    expect(source).toContain('console.log(`✅ ${setting} set to ${value}.`);');
    expect(source).toContain('if (restart) await startStack({ announceReady: false });');
    expect(source).not.toContain('console.log(`✅ ${message}. Saved.`);');
  });

  it('writes commented jsonc with inline app-server args', () => {
    const source = readFileSync(cliPath, 'utf8');

    expect(source).toContain("const defaultPort = '4200';");
    expect(source).toContain("const defaultPortLabel = '4200';");
    expect(source).toContain('const portScanLimit = 100;');
    expect(source).toContain('const unprivilegedPortStart = 1024;');
    expect(source).toContain('function stringifyConfigJsonc');
    expect(source).toContain('function advancedConfigLines');
    expect(source).toContain('optional relay port override');
    expect(source).toContain('global write gate; workspace_write also needs allowWrite');
    expect(source).toContain('workspace full-access gate; danger_full_access needs this');
    expect(source).toContain('dangerous gate for pokedex_command');
    expect(source).toContain(
      '`  "pokedexCommandsEnabled": ${Boolean(raw.pokedexCommandsEnabled)},`'
    );
    expect(source).toContain('`  "appServerArgs": ${inlineArray(raw.appServerArgs)},`');
  });

  it('labels status workspace output as active among configured workspaces', () => {
    const source = readFileSync(cliPath, 'utf8');

    expect(source).toContain('console.log(`active ${workspace.alias} -> ${workspace.root}`);');
    expect(source).toContain(
      "`${config.workspaces.length} ${config.workspaces.length === 1 ? 'workspace' : 'workspaces'} configured`"
    );
    expect(source).not.toContain('console.log(`spaces ${config.workspaces.length}');
    expect(source).not.toContain('console.log(`space  ${activeWorkspace().alias}');
  });

  it('does not report downstream services as ok when relay stops', () => {
    const source = readFileSync(cliPath, 'utf8');

    expect(source).toContain("if (name === 'relay') markRelayDependentsBlocked();");
    expect(source).toContain("statuses[name] = 'blocked';");
    expect(source).toContain("status === 'blocked'");
  });

  it('falls forward from busy relay ports before starting services', () => {
    const source = readFileSync(cliPath, 'utf8');

    expect(source).toContain("import { createServer as createNetServer } from 'node:net';");
    expect(source).toContain('await useAvailableRelayPort();');
    expect(source).toContain('async function findAvailablePort(start)');
    expect(source).toContain('function portSearchRanges(start)');
    expect(source).toContain("server.listen(port, '127.0.0.1');");
    expect(source).toContain('port ${displayPort(requested)} is unavailable; using ${port}');
    expect(source).toContain('configuredRelayPort || config.port');
  });

  it('does not rewrite an existing config just by starting pokedex', () => {
    const source = readFileSync(cliPath, 'utf8');

    expect(source).toContain('if (!configFileExists || startupConfigOverrides()) saveConfig();');
    expect(source).toContain('const existing = rawWorkspace(saved, alias);');
    expect(source).toContain('const accessOverride = hasAccessOverride();');
    expect(source).toContain(
      'const workspaceWrite = accessOverride ? writeEnabled : (existing?.allowWrite ?? writeEnabled);'
    );
    expect(source).toContain('function hasAccessOverride()');
    expect(source).not.toContain('config = createConfig(loadSavedConfig());\n  saveConfig();');
    expect(source).not.toContain('description: first.description ?? `${alias} workspace`');
  });

  it('keeps normal config edits live without restarting the mcp stack', () => {
    const source = readFileSync(cliPath, 'utf8');

    expect(source).toContain("if (name === 'approval')");
    expect(source).not.toContain("name === 'approve'");
    expect(source).toContain("if (name === 'shell') return await setShell(subcommand);");
    expect(source).toContain('await saveSetting(key, raw);');
    expect(source).toContain("await saveSetting('port', config.port, true);");
  });

  it('lets the poke tunnel remove its temporary mcp integration before shutdown', () => {
    const source = readFileSync(cliPath, 'utf8');

    expect(source).toContain("await stopManagedChild('poke', 'SIGINT', 20_000)");
    expect(source).toContain(
      '// poke removes the temporary mcp connection from its own signal handler.'
    );
    expect(source).toContain('process.kill(-entry.child.pid, signal)');
    expect(source).toContain("for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])");
    expect(source).toContain(
      "process.once('uncaughtException', (error) => void stopAfterFatal(error));"
    );
    expect(source).toContain('return child.exitCode !== null || child.signalCode !== null;');
  });

  it('closes the local mcp stack when a managed service stops unexpectedly', () => {
    const source = readFileSync(cliPath, 'utf8');

    expect(source).toContain('void handleUnexpectedServiceExit(name);');
    expect(source).toContain('async function closeStackAfterUnexpectedExit(name)');
    expect(source).toContain('Closing the local MCP stack.');
    expect(source).toContain('await stopStack(false);');
    expect(source).toContain('Pokedex closed the local MCP stack. Type "restart"');
  });

  it('waits for detached process groups to stop before restarting', () => {
    const source = readFileSync(cliPath, 'utf8');

    expect(source).toContain('const managedShutdownPollMs = 50;');
    expect(source).toContain('const relayPortCloseTimeoutMs = 2_000;');
    expect(source).toContain('await waitForManagedChildExit(entry, timeoutMs)');
    expect(source).toContain('await waitForManagedChildExit(entry, 2_000)');
    expect(source).toContain('await waitForRelayPortClosed(relayPort, relayPortCloseTimeoutMs)');
    expect(source).toContain('relay port ${relayPort} is still in use after shutdown.');
    expect(source).toContain('process.kill(-pid, 0)');
    expect(source).toContain('process.kill(-entry.child.pid, signal)');
    expect(source).toContain('Start was cancelled so no duplicate stack is left running.');
  });

  it('sets workspace permissions through one explicit command', () => {
    const source = readFileSync(cliPath, 'utf8');

    expect(source).toContain("workspace.allowWrite = mode !== 'read-only';");
    expect(source).toContain("workspace.allowFullAccess = mode === 'full-access';");
    expect(source).toContain('function syncGlobalAccessGates()');
    expect(source).toContain('config.fullAccessEnabled = config.workspaces.some');
    expect(source).toContain(
      'Boolean(saved.writeTasksEnabled || fullAccess || existing?.allowWrite || first.allowWrite)'
    );
    expect(source).toContain('writeTasksEnabled: writeEnabled');
  });

  it('keeps shell on/off explicit and workspace access mode-based', () => {
    const source = readFileSync(cliPath, 'utf8');

    expect(source).toContain("parseOnOff(raw, 'shell <on|off>')");
    expect(source).toContain('parseWorkspacePermission(raw)');
    expect(source).toContain('usage: ws perms <alias> read-only|write|full-access');
    expect(source).toContain('throw new Error(`usage: ${usage}`);');
    expect(source).not.toContain(`parseOnOff(raw, 'write <${'on|off'}>')`);
    expect(source).not.toContain(`parseOnOff(raw, 'full-access <${'on|off'}>')`);
    expect(source).not.toContain('parseOnOff(raw, !');
    expect(source).not.toContain("if (name === 'codex')");
    expect(source).not.toContain('async function setCodex');
    expect(source).not.toContain("['on', 'true', 'yes', '1']");
    expect(source).not.toContain("'readonly'");
    expect(source).not.toContain("'workspace-write'");
  });
});
