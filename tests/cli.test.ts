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
    expect(output).toContain('~/.pokedex/config.jsonc');
    expect(output).toContain('output [relay|agent|poke]');
    expect(output).toContain('show recent logs for one service or all services');
    expect(output).toContain('workspace add <alias> <path> [description]');
    expect(output).toContain('add or update a workspace');
    expect(output).toContain('write <on|off>');
    expect(output).toContain('workspace write <alias> <on|off>');
    expect(output).not.toContain('write [on|off]');
    expect(output).not.toContain('codex <command>');
  });

  it('does not duplicate help guidance for errors that already include it', () => {
    const source = readFileSync(cliPath, 'utf8');

    expect(source).toContain('if (message.includes(\'Type "help" for commands.\'))');
    expect(source).toContain(
      'throw new Error(`Unknown command: ${name}. Type "help" for commands.`);'
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

    expect(source).toContain('function stringifyConfigJsonc');
    expect(source).toContain('function advancedConfigLines');
    expect(source).toContain('optional relay port override');
    expect(source).toContain('global write gate; workspace_write also needs allowWrite');
    expect(source).toContain('workspace full-access gate; danger_full_access needs this');
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

    expect(source).toContain("if (name === 'approval' || name === 'approve')");
    expect(source).toContain('await saveSetting(key, raw);');
    expect(source).toContain("await saveSetting('port', config.port, true);");
  });

  it('makes workspace write on effective immediately and after restart', () => {
    const source = readFileSync(cliPath, 'utf8');

    expect(source).toContain(
      "if (key === 'allowWrite' && workspace[key]) config.writeTasksEnabled = true;"
    );
    expect(source).toContain(
      'Boolean(saved.writeTasksEnabled || fullAccess || existing?.allowWrite || first.allowWrite)'
    );
    expect(source).toContain('writeTasksEnabled: writeEnabled');
  });

  it('requires explicit on or off for access commands', () => {
    const source = readFileSync(cliPath, 'utf8');

    expect(source).toContain("parseOnOff(raw, 'write <on|off>')");
    expect(source).toContain("parseOnOff(raw, 'full-access <on|off>')");
    expect(source).toContain('throw new Error(`usage: ${usage}`);');
    expect(source).toContain('workspace write <alias> <on|off>');
    expect(source).not.toContain('parseOnOff(raw, !');
    expect(source).not.toContain("if (name === 'codex')");
    expect(source).not.toContain('async function setCodex');
  });
});
