# pgdev - PostgreSQL and NpgsqlRest Development Toolchain

## Overview
Bun-based CLI tool with a TUI experience inspired by Claude Code. Provides commands for PostgreSQL and NpgsqlRest development workflows.

## Related Projects
The NpgsqlRest source code is available at `../NpgsqlRest/` (relative to this project root). This is a sibling directory that is part of the pgdev workspace. When working on pgdev commands that interact with NpgsqlRest, you can read and reference files from that directory.

## Tech Stack
- **Runtime**: Bun
- **Language**: TypeScript (strict mode)
- **Colors**: picocolors
- **No frameworks** - minimal dependencies, Bun built-ins for subprocess, fetch, fs

## Project Structure
```
src/
├── cli.ts              # Arg parsing and command dispatch
├── config.ts           # Config loading (pgdev.toml + pgdev.local.toml)
├── constants.ts        # Package name, registry URLs
├── commands/           # One file per command
│   ├── detect.ts       # Auto-detect installed tools
│   ├── setup.ts        # Interactive setup wizard
│   └── update.ts       # Self-update
└── utils/
    ├── prompt.ts       # Interactive prompts (ask, askPath)
    ├── terminal.ts     # Spinner, colors, formatting helpers
    └── version.ts      # npm version checking
```

## Development
- `bun run pgdev.ts <command>` - run locally from source
- `bun run dev` - alias for the above
- `bun run build` - bundle into `dist/cli.js` (minified, single file)
- `bun run typecheck` - run TypeScript type checking

## npm Distribution
- Only `dist/cli.js` is published (see `files` field in package.json)
- `bin` points to `dist/cli.js` which has a `#!/usr/bin/env bun` shebang
- Users install with `bun install -g pgdev` (requires Bun)
- `prepublishOnly` script auto-builds before `npm publish`
- GitHub Actions publishes to npm on merge to master

## Configuration
- **`pgdev.toml`** - Project config, checked into repo. Shared with team.
- **`pgdev.local.toml`** - Personal overrides, gitignored. Optional.
- Both live in the project root (where `pgdev` is invoked)
- TOML format, parsed with `Bun.TOML.parse()` (zero deps)
- Layering: defaults → `pgdev.toml` → `pgdev.local.toml` (shallow merge)

## Conventions
- Each command lives in `src/commands/<name>.ts` and exports an async function
- Commands are registered in `src/cli.ts` switch statement
- Use `pc` (picocolors) for all color output
- Write to `stderr` for status/progress, `stdout` for data output
- Keep dependencies minimal - prefer Bun built-ins
- No classes unless truly necessary - prefer functions and plain objects
- All imports use `.ts` extensions

### Verbose mode vs setup commands
- `config.verbose` defaults to `false` — detection commands use `spinner()` for quiet progress
- **Setup/install commands** (setup.ts) always show full output — they use `Bun.spawn()` with inherited stdio and `noopSpinner()` (no animated spinner). These are long-running system commands with their own progress output (e.g. `brew install`, `npm install`)
- **Detection commands** (detect.ts) respect `config.verbose` — quiet mode uses `spinner()`, verbose mode uses `noopSpinner()` and `logCommand()`

### Subprocess execution
- When passing commands to Bun's `$` shell template, always use array form: `$\`${cmd}\`` where `cmd` is `string[]`. String interpolation like `$\`${path} --version\`` can break on paths containing `@` or other special characters
- `Bun.write(file, response)` hangs on large files from `fetch()`. Always buffer first: `const buf = await response.arrayBuffer(); await Bun.write(file, buf);`

### Version parsing
- PostgreSQL tools may append `(Homebrew)` to version output (e.g. `psql (PostgreSQL) 15.16 (Homebrew)`). Use `/(\d+(?:\.\d+)+)/` to extract the version — never anchor to end-of-string with `$`

## Adding a New Command
1. Create `src/commands/<name>.ts` with an exported async function
2. Add the case to the switch in `src/cli.ts`
3. Add it to the help text in `src/cli.ts`
