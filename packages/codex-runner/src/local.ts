import { spawn, spawnSync } from 'node:child_process';
import type { AgentConfig, GitCheck, ToolResult } from '@pokedex/protocol';
import { GitCheckSchema, ToolResultSchema, WorkspaceRequestSchema } from '@pokedex/protocol';
import { findWorkspace, redactSecrets, resolveWorkspaceRoot } from '@pokedex/security';
import type { JsonRecord } from './types.js';
import { stripUndefined, uniqueStrings } from './utils.js';

type CommandResult = { exitCode: number; stdout: string; stderr: string };

let cachedGhAuthToken: string | null | undefined;

export async function diffResult(config: AgentConfig, input: unknown): Promise<ToolResult> {
  const args = WorkspaceRequestSchema.parse(input);
  const workspace = findWorkspace(config, args.workspaceAlias);
  const root = resolveWorkspaceRoot(workspace);
  const [status, unstagedStat, stagedStat, unstagedNames, stagedNames] = await Promise.all([
    runPlainCommand({
      command: 'git',
      args: ['status', '--short'],
      cwd: root,
      env: gitHeadlessEnv(),
    }),
    runPlainCommand({ command: 'git', args: ['diff', '--stat'], cwd: root, env: process.env }),
    runPlainCommand({
      command: 'git',
      args: ['diff', '--cached', '--stat'],
      cwd: root,
      env: gitHeadlessEnv(),
    }),
    runPlainCommand({
      command: 'git',
      args: ['diff', '--name-only'],
      cwd: root,
      env: gitHeadlessEnv(),
    }),
    runPlainCommand({
      command: 'git',
      args: ['diff', '--cached', '--name-only'],
      cwd: root,
      env: gitHeadlessEnv(),
    }),
  ]);
  const statusFiles = parseStatusFiles(status.stdout);
  const files = uniqueStrings([
    ...unstagedNames.stdout.split(/\r?\n/).filter(Boolean),
    ...stagedNames.stdout.split(/\r?\n/).filter(Boolean),
    ...statusFiles,
  ]);
  const stat = [unstagedStat.stdout.trim(), stagedStat.stdout.trim()].filter(Boolean).join('\n');
  const ok = [status, unstagedStat, stagedStat, unstagedNames, stagedNames].every(
    (check) => check.exitCode === 0
  );

  return {
    ok,
    summary: stat || (files.length ? `${files.length} changed file(s).` : 'no diff.'),
    data: {
      stat,
      status: status.stdout,
      files,
      unstagedFiles: unstagedNames.stdout.split(/\r?\n/).filter(Boolean),
      stagedFiles: stagedNames.stdout.split(/\r?\n/).filter(Boolean),
      statusFiles,
    },
  };
}

export async function gitCheckResult(config: AgentConfig, input: unknown): Promise<ToolResult> {
  const args = GitCheckSchema.parse(input) satisfies GitCheck;
  const workspace = findWorkspace(config, args.workspaceAlias);
  const root = resolveWorkspaceRoot(workspace);
  const gitEnv = gitHeadlessEnv();
  const checks = Object.fromEntries(
    await Promise.all(
      [
        ['insideWorkTree', ['rev-parse', '--is-inside-work-tree']],
        ['topLevel', ['rev-parse', '--show-toplevel']],
        ['branch', ['branch', '--show-current']],
        ['statusShort', ['status', '--short']],
        ['remoteVerbose', ['remote', '-v']],
        ['pushRemote', ['remote', 'get-url', '--push', 'origin']],
        ['userName', ['config', '--get', 'user.name']],
        ['userEmail', ['config', '--get', 'user.email']],
        ['commitGpgSign', ['config', '--get', 'commit.gpgsign']],
        ['gpgFormat', ['config', '--get', 'gpg.format']],
        ['userSigningKey', ['config', '--get', 'user.signingkey']],
        ['credentialHelper', ['config', '--get', 'credential.helper']],
        ['coreSshCommand', ['config', '--get', 'core.sshCommand']],
      ].map(async ([name, gitArgs]) => [
        name,
        await runPlainCommand({
          command: 'git',
          args: gitArgs as string[],
          cwd: root,
          env: gitEnv,
          timeoutMs: 10_000,
        }),
      ])
    )
  ) as Record<string, CommandResult>;
  const sshAgent = await runPlainCommand({
    command: 'ssh-add',
    args: ['-l'],
    cwd: root,
    env: gitEnv,
    timeoutMs: 5_000,
  }).catch((error: unknown) => ({
    exitCode: 1,
    stdout: '',
    stderr: error instanceof Error ? error.message : 'ssh-add failed',
  }));
  const remoteAuth = args.checkRemote
    ? await runPlainCommand({
        command: 'git',
        args: ['ls-remote', '--heads', 'origin'],
        cwd: root,
        env: gitEnv,
        timeoutMs: 15_000,
      })
    : undefined;
  const issues = gitCheckIssues(checks, sshAgent, remoteAuth, gitEnv);

  return {
    ok: checkSucceeded(checks.insideWorkTree) && issues.length === 0,
    summary: issues.length
      ? `git check found ${issues.length} issue${issues.length === 1 ? '' : 's'} for commit/push.`
      : 'git check passed for local commit/push prerequisites.',
    data: stripUndefined({
      workspaceAlias: workspace.alias,
      root,
      checks: redactSecrets(checks),
      env: gitEnvSummary(gitEnv),
      sshAgent: redactSecrets(sshAgent),
      remoteAuth: remoteAuth ? redactSecrets(remoteAuth) : undefined,
      issues,
    }),
  };
}

export function gitHeadlessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GCM_INTERACTIVE: 'never',
    GIT_TERMINAL_PROMPT: '0',
  };
  const token = env.GH_TOKEN || env.GITHUB_TOKEN || ghAuthToken();
  if (!token) return env;

  env.GH_TOKEN ??= token;
  env.GITHUB_TOKEN ??= token;
  injectGithubCredentialHelper(env);
  return env;
}

export async function runPlainCommand(command: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<CommandResult> {
  let stdout = '';
  let stderr = '';

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: command.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timer: NodeJS.Timeout | undefined;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => (stdout += chunk));
    child.stderr?.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve(code ?? 1);
    });
    if (command.timeoutMs) {
      timer = setTimeout(() => {
        stderr += `\ncommand timed out after ${command.timeoutMs}ms`;
        child.kill('SIGTERM');
      }, command.timeoutMs);
    }
  });

  return { exitCode, stdout, stderr };
}

export async function setupCheckResult(config: AgentConfig): Promise<ToolResult> {
  const doctor = await runPlainCommand({
    command: config.appServerCommand,
    args: ['doctor'],
    cwd: process.cwd(),
    env: process.env,
  });

  return ToolResultSchema.parse({
    ok: doctor.exitCode === 0,
    summary:
      doctor.exitCode === 0 ? 'codex setup looks usable.' : 'codex doctor reported setup issues.',
    data: {
      stdout: redactSecrets(doctor.stdout),
      stderr: redactSecrets(doctor.stderr),
      appServer: { command: config.appServerCommand, args: config.appServerArgs },
      workspaces: config.workspaces.map(({ alias, description }) => ({ alias, description })),
    },
  });
}

function gitEnvSummary(env: NodeJS.ProcessEnv): JsonRecord {
  return {
    hasSshAuthSock: Boolean(env.SSH_AUTH_SOCK),
    hasGitAskpass: Boolean(env.GIT_ASKPASS),
    hasSshAskpass: Boolean(env.SSH_ASKPASS),
    hasGpgTty: Boolean(env.GPG_TTY),
    hasGhToken: Boolean(env.GH_TOKEN || env.GITHUB_TOKEN),
    hasInjectedGitCredentialHelper: gitConfigKeys(env).includes('credential.helper'),
    gcmInteractive: env.GCM_INTERACTIVE,
    gitTerminalPrompt: env.GIT_TERMINAL_PROMPT,
  };
}

function gitCheckIssues(
  checks: Record<string, CommandResult>,
  sshAgent: CommandResult,
  remoteAuth: CommandResult | undefined,
  env: NodeJS.ProcessEnv
): string[] {
  const issues: string[] = [];
  if (!checkSucceeded(checks.insideWorkTree)) issues.push('workspace is not a git repository');
  if (!checkHasOutput(checks.userName)) issues.push('git user.name is not configured');
  if (!checkHasOutput(checks.userEmail)) issues.push('git user.email is not configured');
  if (!checkHasOutput(checks.pushRemote))
    issues.push('git remote origin push URL is not configured');
  if (
    remoteNeedsSshAuth(checks.pushRemote?.stdout) &&
    sshAgent.exitCode !== 0 &&
    !checkHasOutput(checks.coreSshCommand)
  )
    issues.push('no usable ssh-agent or core.sshCommand was visible to the Pokedex process');
  if (
    remoteNeedsHttpsAuth(checks.pushRemote?.stdout) &&
    !hasGitHubToken(env) &&
    !checkHasOutput(checks.credentialHelper)
  )
    issues.push('no GitHub token or git credential helper was visible to the Pokedex process');
  if (remoteAuth && remoteAuth.exitCode !== 0)
    issues.push('remote auth check failed in non-interactive mode');
  return issues;
}

function ghAuthToken(): string | undefined {
  if (cachedGhAuthToken !== undefined) return cachedGhAuthToken ?? undefined;
  const result = spawnSync(process.platform === 'win32' ? 'gh.exe' : 'gh', ['auth', 'token'], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 3_000,
  });
  cachedGhAuthToken = result.status === 0 ? result.stdout.trim() || null : null;
  return cachedGhAuthToken ?? undefined;
}

function injectGithubCredentialHelper(env: NodeJS.ProcessEnv): void {
  const index = nextGitConfigIndex(env);
  env[`GIT_CONFIG_KEY_${index}`] = 'credential.helper';
  env[`GIT_CONFIG_VALUE_${index}`] =
    '!f() { if test "$1" = get; then echo username=x-access-token; echo password="${GH_TOKEN:-$GITHUB_TOKEN}"; fi; }; f';
  env.GIT_CONFIG_COUNT = String(index + 1);
}

function nextGitConfigIndex(env: NodeJS.ProcessEnv): number {
  const raw = env.GIT_CONFIG_COUNT;
  return raw && /^\d+$/.test(raw) ? Number(raw) : 0;
}

function gitConfigKeys(env: NodeJS.ProcessEnv): string[] {
  return Array.from(
    { length: nextGitConfigIndex(env) },
    (_, index) => env[`GIT_CONFIG_KEY_${index}`]
  ).filter((key): key is string => Boolean(key));
}

function hasGitHubToken(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.GH_TOKEN || env.GITHUB_TOKEN);
}

function parseStatusFiles(status: string): string[] {
  return status
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((line) => line.split(' -> ').pop() ?? line)
    .filter(Boolean);
}

function remoteNeedsSshAuth(remote: string | undefined): boolean {
  const value = remote?.trim() ?? '';
  return Boolean(value && (value.startsWith('git@') || value.startsWith('ssh://')));
}

function remoteNeedsHttpsAuth(remote: string | undefined): boolean {
  const value = remote?.trim() ?? '';
  return Boolean(value && /^https:\/\/github\.com[/:]/i.test(value));
}

function checkSucceeded(check: CommandResult | undefined): boolean {
  return Boolean(check && check.exitCode === 0);
}

function checkHasOutput(check: CommandResult | undefined): boolean {
  return Boolean(check && check.exitCode === 0 && check.stdout.trim());
}
