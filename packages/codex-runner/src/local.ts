import { spawn, spawnSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import type {
  AgentConfig,
  GitCheck,
  GitCommit,
  GitCommitPush,
  GitPush,
  ToolResult,
} from '@pokedex/protocol';
import {
  GitCheckSchema,
  GitCommitPushSchema,
  GitCommitSchema,
  GitPushSchema,
  RuntimeSettingsSchema,
  ToolResultSchema,
  WorkspaceRequestSchema,
  codexHistoryGuidance,
  codexPromptGuidance,
  pokeResponseGuidance,
  pokedexRepositoryUrl,
  supportedPokedexCommands,
  terminalOnlyPokedexCommands,
} from '@pokedex/protocol';
import { findWorkspace, redactSecrets, resolveWorkspaceRoot } from '@pokedex/security';
import { buildSettings } from './settings.js';
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
  const access = gitWorkspaceAccess(config, workspace);
  const issues = [
    ...gitWorkspaceAccessIssues(config, workspace, args.checkRemote),
    ...gitCheckIssues(checks, sshAgent, remoteAuth, gitEnv),
  ];

  return {
    ok: checkSucceeded(checks.insideWorkTree) && issues.length === 0,
    summary: issues.length
      ? `git check found ${issues.length} issue${issues.length === 1 ? '' : 's'} for commit/push.`
      : 'git check passed for local commit/push prerequisites.',
    data: stripUndefined({
      workspaceAlias: workspace.alias,
      root,
      access,
      checks: redactSecrets(checks),
      env: gitEnvSummary(gitEnv),
      sshAgent: redactSecrets(sshAgent),
      remoteAuth: remoteAuth ? redactSecrets(remoteAuth) : undefined,
      issues,
      nextAction: gitCheckNextAction(workspace.alias, args.checkRemote, access, issues),
      commandSurface: pokedexCommandSurface(),
      assistantGuidance: assistantGuidance(),
    }),
  };
}

export async function gitCommitResult(config: AgentConfig, input: unknown): Promise<ToolResult> {
  const args = GitCommitSchema.parse(input) satisfies GitCommit;
  const workspace = findWorkspace(config, args.workspaceAlias);
  const root = resolveWorkspaceRoot(workspace);
  const gitEnv = gitHeadlessEnv();
  const stage = commitStageMode(args);
  const files = normalizeGitPaths(root, args.files);
  const checks = await gitBasicChecks(root, gitEnv);
  const issues = [
    ...gitWorkspaceAccessIssues(config, workspace, false),
    ...gitCommitIssues(checks),
    ...commitInputIssues(stage, files),
  ];

  if (issues.length) {
    return gitActionBlockedResult(
      'git commit',
      workspace.alias,
      root,
      gitWorkspaceAccess(config, workspace),
      issues
    );
  }

  const stageResult = await stageCommitChanges(root, gitEnv, stage, files);
  if (stageResult && stageResult.exitCode !== 0) {
    return {
      ok: false,
      summary: 'git commit failed while staging changes.',
      data: {
        workspaceAlias: workspace.alias,
        root,
        stage,
        files,
        stageResult: redactSecrets(stageResult),
      },
    };
  }

  const stagedFiles = await gitNameList(root, gitEnv, ['diff', '--cached', '--name-only']);
  if (!stagedFiles.length) {
    return {
      ok: false,
      summary: 'no staged changes to commit.',
      data: {
        workspaceAlias: workspace.alias,
        root,
        stage,
        files,
        nextAction:
          stage === 'staged'
            ? 'ask the user which files to stage, or use stage all only if the user explicitly requested all changes.'
            : 'check the workspace diff before retrying.',
      },
    };
  }

  const commit = await runPlainCommand({
    command: 'git',
    args: ['commit', '-m', args.message],
    cwd: root,
    env: gitEnv,
    timeoutMs: 60_000,
  });
  if (commit.exitCode !== 0) {
    return {
      ok: false,
      summary: 'git commit failed.',
      data: {
        workspaceAlias: workspace.alias,
        root,
        stage,
        files,
        stagedFiles,
        commit: redactSecrets(commit),
      },
    };
  }

  const commitSha = (await gitOutput(root, gitEnv, ['rev-parse', 'HEAD'])).trim();
  const status = await runPlainCommand({
    command: 'git',
    args: ['status', '--short'],
    cwd: root,
    env: gitEnv,
    timeoutMs: 10_000,
  });

  return {
    ok: true,
    summary: `git commit ${shortSha(commitSha)} created.`,
    data: {
      workspaceAlias: workspace.alias,
      root,
      commitSha,
      shortSha: shortSha(commitSha),
      message: args.message,
      stage,
      files,
      committedFiles: stagedFiles,
      status: status.stdout,
      commit: redactSecrets(commit),
    },
  };
}

export async function gitPushResult(config: AgentConfig, input: unknown): Promise<ToolResult> {
  const args = GitPushSchema.parse(input) satisfies GitPush;
  const workspace = findWorkspace(config, args.workspaceAlias);
  const root = resolveWorkspaceRoot(workspace);
  const gitEnv = gitHeadlessEnv();
  const remote = validateRemoteName(args.remote);
  const branch = await validatePushRef(root, gitEnv, args.branch);
  const checks = await gitPushChecks(root, gitEnv, remote);
  const issues = [
    ...gitWorkspaceAccessIssues(config, workspace, true),
    ...gitPushInputIssues(remote, branch, args.setUpstream),
    ...gitPushIssues(checks, gitEnv),
  ];

  if (issues.length) {
    return gitActionBlockedResult(
      'git push',
      workspace.alias,
      root,
      gitWorkspaceAccess(config, workspace),
      issues
    );
  }

  const pushArgs = ['push', '--porcelain'];
  if (args.setUpstream) pushArgs.push('--set-upstream');
  if (remote) pushArgs.push(remote);
  if (branch) pushArgs.push(branch);

  const push = await runPlainCommand({
    command: 'git',
    args: pushArgs,
    cwd: root,
    env: gitEnv,
    timeoutMs: 120_000,
  });
  if (push.exitCode !== 0) {
    return {
      ok: false,
      summary: 'git push failed.',
      data: {
        workspaceAlias: workspace.alias,
        root,
        remote,
        branch,
        setUpstream: args.setUpstream,
        push: redactSecrets(push),
      },
    };
  }

  const head = (await gitOutput(root, gitEnv, ['rev-parse', 'HEAD'])).trim();
  const status = await runPlainCommand({
    command: 'git',
    args: ['status', '-sb'],
    cwd: root,
    env: gitEnv,
    timeoutMs: 10_000,
  });

  return {
    ok: true,
    summary: `git push completed at ${shortSha(head)}.`,
    data: {
      workspaceAlias: workspace.alias,
      root,
      commitSha: head,
      shortSha: shortSha(head),
      remote,
      branch,
      setUpstream: args.setUpstream,
      status: status.stdout,
      push: redactSecrets(push),
    },
  };
}

export async function gitCommitPushResult(
  config: AgentConfig,
  input: unknown
): Promise<ToolResult> {
  const args = GitCommitPushSchema.parse(input) satisfies GitCommitPush;
  const commit = await gitCommitResult(config, args);
  if (!commit.ok) return commit;

  const push = await gitPushResult(config, args);
  if (!push.ok) {
    return {
      ok: false,
      summary: `${commit.summary} Push failed.`,
      data: {
        commit: commit.data,
        push: push.data,
        nextAction:
          'report that the commit exists locally, then fix the push issue before retrying push.',
      },
    };
  }

  return {
    ok: true,
    summary: `${commit.summary} ${push.summary}`,
    data: {
      commit: commit.data,
      push: push.data,
    },
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
      pokedexCommandsEnabled: config.pokedexCommandsEnabled,
      pokedexRepositoryUrl,
      codexHistory: { nativeThreads: true, persistent: true, guidance: codexHistoryGuidance },
      runtimeDefaults: runtimeDefaults(config),
      commandSurface: pokedexCommandSurface(),
      assistantGuidance: assistantGuidance(),
      workspaces: config.workspaces.map((workspace) => ({
        alias: workspace.alias,
        description: workspace.description,
        access: gitWorkspaceAccess(config, workspace),
        defaultSettings: buildSettings(config, workspace, RuntimeSettingsSchema.parse({})),
      })),
    },
  });
}

function runtimeDefaults(config: AgentConfig): JsonRecord {
  return {
    model: config.defaultModel,
    reasoningEffort: config.defaultReasoning,
    verbosity: config.defaultVerbosity,
    approvalPolicy: config.defaultApprovalPolicy,
    writeTasksEnabled: config.writeTasksEnabled,
    fullAccessEnabled: config.fullAccessEnabled,
    pokedexCommandsEnabled: config.pokedexCommandsEnabled,
  };
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

function gitWorkspaceAccess(
  config: AgentConfig,
  workspace: AgentConfig['workspaces'][number]
): 'full-access' | 'write' | 'read-only' {
  if (canUseFullAccess(config, workspace)) return 'full-access';
  if (canUseWriteAccess(config, workspace)) return 'write';
  return 'read-only';
}

function gitWorkspaceAccessIssues(
  config: AgentConfig,
  workspace: AgentConfig['workspaces'][number],
  checkRemote: boolean
): string[] {
  const issues: string[] = [];
  // git commit/push writes lock files and refs, so read-only workspaces fail later with cryptic git errors.
  if (!canUseWriteAccess(config, workspace))
    issues.push('workspace is read-only; commit/push needs write access');
  if (checkRemote && !canUseFullAccess(config, workspace))
    issues.push('workspace does not have full access; push/publish/sync needs full-access');
  return issues;
}

function canUseWriteAccess(
  config: AgentConfig,
  workspace: AgentConfig['workspaces'][number]
): boolean {
  return canUseFullAccess(config, workspace) || (config.writeTasksEnabled && workspace.allowWrite);
}

function canUseFullAccess(
  config: AgentConfig,
  workspace: AgentConfig['workspaces'][number]
): boolean {
  return config.fullAccessEnabled && workspace.allowFullAccess;
}

function gitCheckNextAction(
  alias: string,
  checkRemote: boolean,
  access: ReturnType<typeof gitWorkspaceAccess>,
  issues: string[]
): string {
  if (access === 'read-only')
    return `workspace is read-only. for commits ask the user to run \`ws perms ${alias} write\`; for push/publish/sync ask for \`ws perms ${alias} full-access\` or restart with \`npx codex-to-poke --full-access\`. do not suggest any unlisted permission command.`;
  if (checkRemote && access !== 'full-access')
    return `push/publish/sync needs full-access. ask the user to run \`ws perms ${alias} full-access\` or restart with \`npx codex-to-poke --full-access\`. do not suggest any unlisted permission command.`;
  if (issues.length) return 'report the exact git check issues to the user before starting Codex.';
  return "send Codex the user's exact commit/push intent without adding files, branches, remotes, commands, or commit messages the user did not name.";
}

function commitStageMode(args: GitCommit): 'staged' | 'files' | 'tracked' | 'all' {
  if (args.stage) return args.stage;
  return args.files.length ? 'files' : 'staged';
}

function normalizeGitPaths(root: string, files: string[]): string[] {
  return files.map((file) => {
    if (file.includes('\0') || file.includes('\r') || file.includes('\n'))
      throw new Error('git file paths must not contain control characters');
    if (isAbsolute(file)) throw new Error('git file paths must be relative to the workspace');
    const resolved = resolve(root, file);
    const normalized = relative(root, resolved);
    if (!normalized || normalized.startsWith('..') || isAbsolute(normalized))
      throw new Error('git file paths must stay inside the workspace');
    return normalized.replaceAll('\\', '/');
  });
}

async function gitBasicChecks(
  root: string,
  env: NodeJS.ProcessEnv
): Promise<Record<string, CommandResult>> {
  return Object.fromEntries(
    await Promise.all(
      [
        ['insideWorkTree', ['rev-parse', '--is-inside-work-tree']],
        ['userName', ['config', '--get', 'user.name']],
        ['userEmail', ['config', '--get', 'user.email']],
      ].map(async ([name, gitArgs]) => [
        name,
        await runPlainCommand({
          command: 'git',
          args: gitArgs as string[],
          cwd: root,
          env,
          timeoutMs: 10_000,
        }),
      ])
    )
  ) as Record<string, CommandResult>;
}

function gitCommitIssues(checks: Record<string, CommandResult>): string[] {
  const issues: string[] = [];
  if (!checkSucceeded(checks.insideWorkTree)) issues.push('workspace is not a git repository');
  if (!checkHasOutput(checks.userName)) issues.push('git user.name is not configured');
  if (!checkHasOutput(checks.userEmail)) issues.push('git user.email is not configured');
  return issues;
}

function commitInputIssues(stage: ReturnType<typeof commitStageMode>, files: string[]): string[] {
  const issues: string[] = [];
  if (stage === 'files' && !files.length) issues.push('stage files requires at least one file');
  if (stage !== 'files' && files.length)
    issues.push('files can only be provided when stage is files');
  return issues;
}

function gitActionBlockedResult(
  action: string,
  workspaceAlias: string,
  root: string,
  access: ReturnType<typeof gitWorkspaceAccess>,
  issues: string[]
): ToolResult {
  return {
    ok: false,
    summary: `${action} blocked by ${issues.length} prerequisite issue${
      issues.length === 1 ? '' : 's'
    }.`,
    data: {
      workspaceAlias,
      root,
      access,
      issues,
      nextAction: 'report the exact issues to the user before retrying.',
    },
  };
}

async function stageCommitChanges(
  root: string,
  env: NodeJS.ProcessEnv,
  stage: ReturnType<typeof commitStageMode>,
  files: string[]
): Promise<CommandResult | null> {
  if (stage === 'staged') return null;
  const args =
    stage === 'all'
      ? ['add', '-A', '--', '.']
      : stage === 'tracked'
        ? ['add', '-u', '--', '.']
        : ['add', '--', ...files];
  return await runPlainCommand({
    command: 'git',
    args,
    cwd: root,
    env,
    timeoutMs: 30_000,
  });
}

async function gitNameList(
  root: string,
  env: NodeJS.ProcessEnv,
  args: string[]
): Promise<string[]> {
  return (await gitOutput(root, env, args)).split(/\r?\n/).filter(Boolean);
}

async function gitOutput(root: string, env: NodeJS.ProcessEnv, args: string[]): Promise<string> {
  const result = await runPlainCommand({
    command: 'git',
    args,
    cwd: root,
    env,
    timeoutMs: 10_000,
  });
  return result.exitCode === 0 ? result.stdout : '';
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function validateRemoteName(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  if (remote.startsWith('-') || !/^[A-Za-z0-9._-]+$/.test(remote))
    throw new Error('git remote must be a configured remote name, not a URL or option');
  return remote;
}

async function validatePushRef(
  root: string,
  env: NodeJS.ProcessEnv,
  branch: string | undefined
): Promise<string | undefined> {
  if (!branch) return undefined;
  if (branch.startsWith('-') || /[\0\r\n:~^?*[\\]/.test(branch))
    throw new Error('git push branch must be a simple ref name');
  if (branch === 'HEAD') return branch;
  const check = await runPlainCommand({
    command: 'git',
    args: ['check-ref-format', '--branch', branch],
    cwd: root,
    env,
    timeoutMs: 10_000,
  });
  if (check.exitCode !== 0) throw new Error('git push branch is not a valid branch name');
  return branch;
}

type GitPushChecks = {
  insideWorkTree: CommandResult;
  currentBranch: CommandResult;
  pushDefault: CommandResult;
  branchRemote: CommandResult | undefined;
  credentialHelper: CommandResult;
  coreSshCommand: CommandResult;
  remoteName: string | undefined;
  remoteUrl: CommandResult | undefined;
  sshAgent: CommandResult;
  remoteAuth: CommandResult | undefined;
};

async function gitPushChecks(
  root: string,
  env: NodeJS.ProcessEnv,
  requestedRemote: string | undefined
): Promise<GitPushChecks> {
  const [insideWorkTree, currentBranch, pushDefault, credentialHelper, coreSshCommand] =
    await Promise.all([
      runPlainCommand({
        command: 'git',
        args: ['rev-parse', '--is-inside-work-tree'],
        cwd: root,
        env,
        timeoutMs: 10_000,
      }),
      runPlainCommand({
        command: 'git',
        args: ['branch', '--show-current'],
        cwd: root,
        env,
        timeoutMs: 10_000,
      }),
      runPlainCommand({
        command: 'git',
        args: ['config', '--get', 'remote.pushDefault'],
        cwd: root,
        env,
        timeoutMs: 10_000,
      }),
      runPlainCommand({
        command: 'git',
        args: ['config', '--get', 'credential.helper'],
        cwd: root,
        env,
        timeoutMs: 10_000,
      }),
      runPlainCommand({
        command: 'git',
        args: ['config', '--get', 'core.sshCommand'],
        cwd: root,
        env,
        timeoutMs: 10_000,
      }),
    ]);
  const branchName = currentBranch.stdout.trim();
  const branchRemote = branchName
    ? await runPlainCommand({
        command: 'git',
        args: ['config', '--get', `branch.${branchName}.remote`],
        cwd: root,
        env,
        timeoutMs: 10_000,
      })
    : undefined;
  const configuredRemote = pushDefault.stdout.trim() || branchRemote?.stdout.trim() || undefined;
  const remoteName = requestedRemote ?? configuredRemote;
  const remoteUrl = remoteName
    ? await runPlainCommand({
        command: 'git',
        args: ['remote', 'get-url', '--push', remoteName],
        cwd: root,
        env,
        timeoutMs: 10_000,
      })
    : undefined;
  const sshAgent = await runPlainCommand({
    command: 'ssh-add',
    args: ['-l'],
    cwd: root,
    env,
    timeoutMs: 5_000,
  }).catch((error: unknown) => ({
    exitCode: 1,
    stdout: '',
    stderr: error instanceof Error ? error.message : 'ssh-add failed',
  }));
  const remoteAuth =
    remoteName && remoteUrl?.exitCode === 0
      ? await runPlainCommand({
          command: 'git',
          args: ['ls-remote', '--heads', remoteName],
          cwd: root,
          env,
          timeoutMs: 15_000,
        })
      : undefined;

  return {
    insideWorkTree,
    currentBranch,
    pushDefault,
    branchRemote,
    credentialHelper,
    coreSshCommand,
    remoteName,
    remoteUrl,
    sshAgent,
    remoteAuth,
  };
}

function gitPushInputIssues(
  remote: string | undefined,
  branch: string | undefined,
  setUpstream: boolean
): string[] {
  const issues: string[] = [];
  if (branch && !remote)
    issues.push('git push with an explicit branch requires an explicit remote');
  if (setUpstream && (!remote || !branch))
    issues.push('setUpstream requires both remote and branch');
  return issues;
}

function gitPushIssues(checks: GitPushChecks, env: NodeJS.ProcessEnv): string[] {
  const issues: string[] = [];
  if (!checkSucceeded(checks.insideWorkTree)) issues.push('workspace is not a git repository');
  if (!checks.remoteName) issues.push('no push remote or upstream is configured');
  if (checks.remoteName && !checkSucceeded(checks.remoteUrl))
    issues.push(`git remote ${checks.remoteName} push URL is not configured`);
  if (
    remoteNeedsSshAuth(checks.remoteUrl?.stdout) &&
    checks.sshAgent.exitCode !== 0 &&
    !checkHasOutput(checks.coreSshCommand)
  )
    issues.push('no usable ssh-agent or core.sshCommand was visible to the Pokedex process');
  if (
    remoteNeedsHttpsAuth(checks.remoteUrl?.stdout) &&
    !hasGitHubToken(env) &&
    !checkHasOutput(checks.credentialHelper)
  )
    issues.push('no GitHub token or git credential helper was visible to the Pokedex process');
  if (checks.remoteAuth && checks.remoteAuth.exitCode !== 0)
    issues.push('remote auth check failed in non-interactive mode');
  return issues;
}

function pokedexCommandSurface(): JsonRecord {
  return {
    supported: supportedPokedexCommands,
    terminalOnly: terminalOnlyPokedexCommands,
    spellingRule: 'only the supported command strings are valid; every other spelling is invalid',
  };
}

function assistantGuidance(): JsonRecord {
  return {
    prompt: codexPromptGuidance,
    response: pokeResponseGuidance,
  };
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
