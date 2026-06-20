# Production Status

Date: 2026-06-20

## Current State

Pokedex is prepared for the next package release as `codex-to-poke@0.1.6`.

Completed work:

- Cleaned temporary planning/debug artifacts from the repository.
- Split `@pokedex/protocol` into focused modules for constants, schemas, capabilities, JSONC parsing, and MCP output formatting.
- Split `@pokedex/security` into focused modules for bearer auth, secret redaction, workspace access, and errors.
- Moved Pokedex prompt-command handling out of the agent entrypoint into `apps/agent/src/pokedex-commands.ts`.
- Kept the root README and package README identical.
- Updated the public website content to match the current project structure and feature set.
- Prepared the package tarball with the built CLI, relay bundle, agent bundle, README, license, and package metadata.

## Verified Gates

Main repository:

- `npm install`: passed, 0 vulnerabilities.
- `npm audit --workspaces --include-workspace-root`: passed, 0 vulnerabilities.
- `npm run format:check`: passed.
- `npm run lint`: passed.
- `npm run check`: passed.
- `npm test`: passed, 7 files and 62 tests.
- `npm run build`: passed.
- `npm run pack:dry`: passed for `codex-to-poke@0.1.6`.
- `npm run release:check`: passed.

Website repository:

- `npm install`: passed, 0 vulnerabilities.
- `npm run build`: passed with Next.js static export.

## External Release State

NPM:

- `codex-to-poke@0.1.5` already exists on npm.
- The package is now prepared as `codex-to-poke@0.1.6`.
- This machine is not authenticated to npm: `npm whoami` returns `E401 Unauthorized`.
- Publish is ready to retry after npm authentication with an account that can publish `codex-to-poke`.

Git:

- Main repository branch: `main`.
- Main repository remote: `https://github.com/NienteSpigotSenzaJava/pokedex.git`.
- Website repository branch: `main`.
- Website repository remote: `https://github.com/NienteSpigotSenzaJava/pokedex.my.git`.

## Manual Tests To Run

Before announcing the OSS release:

1. Install the local tarball or package preview and run `npx codex-to-poke` in a clean test project.
2. Verify first-run config creation at `~/.pokedex/config.jsonc`.
3. Verify `pokedex>` prompt commands:
   - `status`
   - `logs`
   - `ws list`
   - `ws add`
   - `ws rm`
   - `ws use`
   - `ws desc`
   - `ws perms`
   - `model`
   - `reasoning`
   - `verbosity`
   - `approval`
4. Verify Poke recipe calls:
   - setup check
   - list workspaces
   - start thread
   - read operation until completion
   - list skills
   - list plugins
   - read diff
   - git check
5. Verify structured git flow in a disposable repository:
   - `pokedex_git_commit`
   - `pokedex_git_push`
   - `pokedex_git_commit_push`
6. Verify approval flow when Codex requests command or file-change approval.
7. Verify `--read-only`, `--write`, and `--full-access` startup modes.
8. Verify the website pages:
   - `/`
   - `/features`
   - `/how-it-works`
   - `/docs`
   - `/faq`
9. Verify the recipe URL still opens the intended Poke recipe.
10. Verify legal and affiliation wording before public launch.

## Publish Commands

After npm login:

```bash
npm whoami
npm publish --workspace ./apps/cli --access public
```

After git review:

```bash
git push origin main
```
