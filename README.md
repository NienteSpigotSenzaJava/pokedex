# The Codex to Poke Bridge

![Pokedex](./assets/hero.png)

Pokedex connects your local Codex to your Poke.

It runs on your machine, keeps workspace access local, and exposes Codex through a small authenticated MCP relay.

```text
Codex App Server -> Pokedex agent -> Pokedex relay -> Poke Tunnel -> Your Poke
```

## Usage

1. Add the recipe to Poke

<https://poke.com/r/z-hW49hTZk7>

2. Start Pokedex

```bash
npx codex-to-poke
```

## Setup

Authenticate Codex before starting Pokedex. Pokedex starts the Poke login flow automatically if the tunnel needs it.

```bash
codex login
```

Then start Pokedex in the workspace you want Codex to see:

```bash
cd /path/to/project
npx codex-to-poke
```

When the terminal says it is ready, try saying "is pokedex connected?" to your Poke. Type `help` in the Pokedex prompt to see commands.

## Permissions

Pokedex starts read-only unless your saved config already allows writes.

```bash
npx codex-to-poke --read-only
npx codex-to-poke --write
npx codex-to-poke --full-access
```

Use `--write` for normal code changes. Use `--full-access` only on machines and projects you trust.

## Workspaces

The first run stores the current folder as the `main` workspace. You can choose another workspace with:

```bash
npx codex-to-poke --workspace /path/to/project
```

Inside the prompt:

```text
workspace list
workspace add api /path/to/api
workspace use api
workspace write api on
restart
```

## Prompt Commands

```text
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
```

## Config

Pokedex stores config in:

```text
~/.pokedex/config.jsonc
```

The JSONC config contains the random relay token, default model settings, permissions, and workspace list. Default local wiring such as port `3000`, user `local`, and `codex app-server --listen stdio://` is kept internal unless you override it.

## MCP Tools

Pokedex exposes these tools to Poke:

```text
pokedex_setup_check
pokedex_list_workspaces
pokedex_list_tasks
pokedex_list_sessions
pokedex_list_threads
pokedex_list_skills
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
pokedex_get_usage
```

Task and thread tools accept `workspaceAlias`, `prompt`, and optional runtime settings such as `model`, `reasoningEffort`, `verbosity`, `sandbox`, `approvalPolicy`, `skillNames`, and `skills`.

Use `pokedex_list_skills` to fetch local skills from Codex, including `~/.agents/skills` and `~/.codex/skills`. You can pass `skillNames: ["caveman"]` or include `$caveman` in the prompt; Pokedex resolves the path and sends a skill input item to Codex.

If Codex pauses for approval, ask Poke to list approvals, then approve or decline the pending request. When only one approval is pending, `pokedex_approve` and `pokedex_decline` do not need an `approvalId`.

## Troubleshooting

If Poke login does not complete automatically:

```bash
npx poke@latest login
```

If Codex needs authentication or setup checks:

```bash
codex login
codex doctor
```

If port `3000` is busy:

```bash
npx codex-to-poke --port 3010
```

Inside Pokedex, use `help` for a list of available commands.

## Platform Support

Pokedex supports macOS, Linux, and Windows on Node.js 20 or newer.

## Disclaimer

Pokedex is an independent, unofficial open-source project. It is not affiliated with, endorsed by, sponsored by, or maintained by OpenAI, Poke, The Interaction Company of California Inc., or Interaction. OpenAI, Codex, ChatGPT, Poke, and Interaction names are used only to describe compatibility with their respective products and services.

## Security And Legal

See [LEGAL.md](./LEGAL.md) for trademark and affiliation notes.
