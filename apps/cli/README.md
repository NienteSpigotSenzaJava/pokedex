# Pokedex CLI

Unofficial local Poke to Codex bridge.

Pokedex is an independent open-source project. It is not affiliated with, endorsed by, sponsored by, or maintained by OpenAI, Poke, The Interaction Company of California Inc., or Interaction.

```bash
npx codex-to-poke
```

Keep the terminal open while using Poke. When the prompt opens, type `help` to see commands.

Common modes:

```bash
npx codex-to-poke --read-only
npx codex-to-poke --write
npx codex-to-poke --full-access
npx codex-to-poke --workspace /path/to/project
```

Pokedex stores its JSONC config in `~/.pokedex/config.jsonc` and supports Node.js 20 or newer.
