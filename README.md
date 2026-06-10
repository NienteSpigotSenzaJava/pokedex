# Pokedex

🧭 Pokedex connects a Poke recipe to your local Codex app-server.

It runs on your machine, keeps your files local, and exposes Codex through a small local MCP relay.

```text
Poke -> Poke tunnel -> Pokedex relay -> Pokedex agent -> Codex app-server
```

## Quick Start

```bash
codex login
npx poke@latest login
npx @pokedex/cli
```

Keep the terminal open while you use the Pokedex recipe in Poke.

## Config

Pokedex stores its config in your home directory:

```text
~/.pokedex/config.json
```

On Windows, `~` means your current user home folder. The config is not written to the project where you run Pokedex.

The config contains the local port, relay token, Codex command, default model, permissions, and workspace list.

## Permissions

Pokedex starts in read-only mode.

```bash
npx @pokedex/cli --read-only
npx @pokedex/cli --write
npx @pokedex/cli --full-access
```

Use `--full-access` only for projects and machines you trust.

## Workspaces

By default, the first run saves the folder where you started Pokedex as the `main` workspace.

```bash
cd /path/to/project
npx @pokedex/cli
```

You can also choose a workspace directly:

```bash
npx @pokedex/cli --workspace /path/to/project
```

Inside the interactive prompt:

```text
workspace list
workspace add api /path/to/api
workspace use api
write on
restart
quit
```

## MCP Tools

Common tools exposed to Poke:

- `pokedex_list_workspaces`
- `pokedex_list_threads`
- `pokedex_start_task`
- `pokedex_continue_task`
- `pokedex_read_thread`
- `pokedex_get_diff`

Most task tools accept `workspaceAlias`, `prompt`, and optional runtime settings such as `model`, `reasoningEffort`, `verbosity`, `sandbox`, and `approvalPolicy`.

## Development

```bash
npm install
npm run lint
npm run check
npm test
npm run build
```

Generated `dist/` folders and TypeScript build info files are ignored by git.

## Platform Support

✅ macOS  
✅ Linux  
✅ Windows

Pokedex uses Node.js APIs for paths, process spawning, and home-directory config resolution so the CLI works across platforms.
