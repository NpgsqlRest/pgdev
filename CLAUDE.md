# pgdev - PostgreSQL Development Toolchain

## Overview
Bun-based CLI tool with a TUI experience inspired by Claude Code. Provides commands for PostgreSQL development workflows.

## Tech Stack
- **Runtime**: Bun
- **Language**: TypeScript (strict mode)
- **Colors**: picocolors
- **No frameworks** - minimal dependencies, Bun built-ins for subprocess, fetch, fs

## Project Structure
```
src/
├── cli.ts              # Arg parsing and command dispatch
├── constants.ts        # Package name, registry URLs
├── commands/           # One file per command
│   └── update.ts
└── utils/
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

## Conventions
- Each command lives in `src/commands/<name>.ts` and exports an async function
- Commands are registered in `src/cli.ts` switch statement
- Use `spinner()` from `utils/terminal.ts` for long-running operations
- Use `pc` (picocolors) for all color output
- Write to `stderr` for status/progress, `stdout` for data output
- Keep dependencies minimal - prefer Bun built-ins
- No classes unless truly necessary - prefer functions and plain objects
- All imports use `.ts` extensions

## Adding a New Command
1. Create `src/commands/<name>.ts` with an exported async function
2. Add the case to the switch in `src/cli.ts`
3. Add it to the help text in `src/cli.ts`
