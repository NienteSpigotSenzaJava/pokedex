# The Codex to Poke Bridge

![Pokedex](https://raw.githubusercontent.com/NienteSpigotSenzaJava/pokedex/main/assets/hero.png)

🧭 Pokedex connects your local Codex to your Poke.

It runs on your machine, keeps workspace access local, and exposes Codex through a small authenticated MCP relay. Version `0.1.5` focuses on native Codex threads, app-server progress streaming, runtime overrides, plugin discovery, usage and rate-limit visibility, and cleaner shutdown behavior.

```text
Codex App Server -> Pokedex agent -> Pokedex relay -> Poke Tunnel -> Your Poke
```

The Codex runner follows the app-server `initialize`/`initialized` handshake and keeps transport, event parsing, approval requests, settings, skill/plugin discovery, and local git checks in separate modules so progress and failures stay visible to Poke.

## 🚀 Usage

1. Add the recipe to Poke: <https://poke.com/r/z-hW49hTZk7>
2. Start Pokedex:

```bash
npx codex-to-poke
```

Start Pokedex in the workspace you want Codex to see:

```bash
cd /path/to/project
npx codex-to-poke
```

When the terminal says it is ready, try saying "is pokedex connected?" to your Poke. Type `help` in the Pokedex prompt to see commands.

## 🔐 Permissions

Pokedex starts read-only unless your saved config already allows writes.

```bash
npx codex-to-poke --read-only
npx codex-to-poke --write
npx codex-to-poke --full-access
```

Use `--write` for normal code changes. Use `--full-access` only on machines and projects you trust.

## 🗂️ Workspaces

The first run stores the current folder as the `main` workspace. You can choose another workspace with:

```bash
npx codex-to-poke --workspace /path/to/project
```

Inside the prompt:

```text
ws list
ws add api /path/to/api
ws use api
ws write api on
restart
```

## 💬 Prompt Commands

```text
status                                      show relay, agent, poke, workspace, and access status
config                                      print the saved config with secrets hidden
output [relay|agent|poke]                   show recent logs for one service or all services
write <on|off>                              set write permission for the active workspace
full-access <on|off>                        set full filesystem access for the active workspace
ws list                                     show configured workspaces
ws add <alias> <path> [description]         add or update a workspace
ws remove <alias>                           remove a workspace
ws use <alias>                              make a workspace active and restart services
ws describe <alias> <description>           change a workspace description
ws write <alias> <on|off>                   set write permission for one workspace
ws full-access <alias> <on|off>             set full access for one workspace
model <name>                                set the default Codex model
reasoning minimal|low|medium|high|xhigh     set the default reasoning effort
verbosity low|medium|high                   set the default answer verbosity
approval untrusted|on-request|never         set the default approval policy
port <number>                               change the local relay port and restart services
token rotate                                create a new relay token and restart services
restart                                     restart relay, agent, and poke
help                                        show this command list
quit                                        stop Pokedex and close the prompt
```

## ⚙️ Config

Pokedex stores config in:

```text
~/.pokedex/config.jsonc
```

The JSONC config contains the random relay token, default model settings, permissions, and workspace list. Default local wiring such as port `4200`, user `local`, and `codex app-server --listen stdio://` is kept internal unless you override it. If the configured relay port is busy or unavailable, Pokedex automatically tries the next usable local port for that run.

## 🎛️ Runtime Settings

Runtime settings are per-request MCP arguments that Poke can pass when it calls Codex tools. They override defaults for one thread, turn, resume, or review request.

Persistent defaults are edited from the running Pokedex prompt:

```text
model <name>
reasoning minimal|low|medium|high|xhigh
verbosity low|medium|high
approval untrusted|on-request|never
write <on|off>
full-access <on|off>
ws write <alias> <on|off>
ws full-access <alias> <on|off>
```

The saved defaults live in `~/.pokedex/config.jsonc`. Poke should help the user write these commands, but it should use runtime settings directly when the user wants a one-time override for a Codex turn.

## 🧰 MCP Tools

Pokedex exposes these tools to Poke:

```text
pokedex_setup_check
pokedex_list_workspaces
pokedex_list_tasks
pokedex_list_sessions
pokedex_list_threads
pokedex_list_skills
pokedex_list_plugins
pokedex_list_operations
pokedex_read_operation
pokedex_start_task
pokedex_start_thread
pokedex_continue_task
pokedex_send_turn
pokedex_resume_task
pokedex_resume_thread
pokedex_read_thread
pokedex_fork_thread
pokedex_set_goal
pokedex_clear_goal
pokedex_review
pokedex_interrupt
pokedex_list_approvals
pokedex_approve
pokedex_decline
pokedex_cancel_approval
pokedex_get_diff
pokedex_git_check
pokedex_get_usage
```

Prefer native thread tools (`pokedex_start_thread`, `pokedex_send_turn`, `pokedex_resume_thread`, and `pokedex_list_threads`). The task and session tools are compatibility aliases for the same thread-backed behavior.

Task and thread tools accept `workspaceAlias`, `prompt`, and optional runtime settings such as `model`, `profile`, `reasoningEffort`, `verbosity`, `sandbox`, `approvalPolicy`, `webSearch`, `skillNames`, and `skills`.

Use `pokedex_list_skills` to fetch local skills from Codex, including `~/.agents/skills` and `~/.codex/skills`. You can pass `skillNames: ["caveman"]` or include `$caveman` in the prompt; Pokedex resolves the path and sends a skill input item to Codex.

Use `pokedex_list_plugins` to fetch installed Codex plugins and marketplace plugin data when the local Codex app-server exposes it.

Long-running Codex work is tracked as a local operation. If a start, send, resume, or review call returns an `operationId` with `operationStatus: "running"`, the work is not complete yet. Do not report success and do not retry the same request. Use `pokedex_read_operation` with that `operationId`, or `pokedex_list_operations` after reconnects, failed responses, or when checking what Codex is doing. For live progress, call `pokedex_read_operation` again with the previous `eventsSeen` as `afterEventsSeen` and `waitMs` up to `30000` so Poke waits for the next Codex event instead of promising a later update.

Use `pokedex_get_usage` to inspect observed token usage plus account rate-limit data and reset timing when Codex exposes it through app-server. Rate-limit failures are reported as failed operations with `failureKind: "rate_limit"` and any available reset time.

Use `pokedex_git_check` before commit or push work to verify git identity, remotes, and the headless SSH/GPG/credential environment visible to Pokedex. Set `checkRemote: true` for push, publish, or sync-to-GitHub requests.

If Codex pauses for approval, ask Poke to list approvals, then approve or decline the pending request. When only one approval is pending, `pokedex_approve` and `pokedex_decline` do not need an `approvalId`.

## 🧪 Troubleshooting

If Poke login does not complete automatically:

```bash
npx poke@latest login
```

If Codex cannot be found:

```bash
npm install -g @openai/codex@latest
```

To pin a different relay port:

```bash
npx codex-to-poke --port 4201
```

Inside Pokedex, use `help` for a list of available commands.

## 🖥️ Platform Support

Pokedex supports macOS, Linux, and Windows on Node.js 20 or newer.

## ⚖️ Disclaimer

Pokedex is an independent, unofficial open-source project. It is not affiliated with, endorsed by, sponsored by, or maintained by OpenAI, Poke, The Interaction Company of California Inc., or Interaction. OpenAI, Codex, ChatGPT, Poke, and Interaction names are used only to describe compatibility with their respective products and services.

## 🔒 Security And Legal

See [LEGAL.md](https://github.com/NienteSpigotSenzaJava/pokedex/blob/main/LEGAL.md) for trademark and affiliation notes.
