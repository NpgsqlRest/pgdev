# pgdev

PostgreSQL and NpgsqlRest Development Toolchain.

A CLI tool that manages PostgreSQL client tools and [NpgsqlRest](https://github.com/NpgsqlRest/NpgsqlRest) installations for your development environment.

## Install

Requires [Bun](https://bun.sh) runtime.

```bash
bun install -g pgdev
```

## Commands

### `pgdev detect`

Auto-detects installed tools and updates your local configuration.

- Scans for **NpgsqlRest** — checks local binary, node_modules, PATH, and Docker images
- Scans for **PostgreSQL client tools** — checks PATH, Homebrew, Postgres.app, and system package locations
- If multiple PostgreSQL versions are found, prompts you to choose which one to use
- Writes results to `pgdev.local.toml`

```
$ pgdev detect
✔ Found NpgsqlRest v3.8.0.0
  Source: local bun package
ℹ Config updated: tools.npgsqlrest = "bunx npgsqlrest"
✔ Found 2 PostgreSQL installations

  Which installation should pgdev use?

  1. v18.1    PATH (default)
  2. v15.16   Homebrew postgresql@15 (/opt/homebrew/opt/postgresql@15/bin)

> 1
ℹ Config updated: tools.psql = "psql"
ℹ Config updated: tools.pg_dump = "pg_dump"
ℹ Config updated: tools.pg_restore = "pg_restore"
```

### `pgdev setup`

Interactive wizard for installing development tools.

**NpgsqlRest** — choose from four installation methods:

| Method | Options |
|--------|---------|
| npm | Local (dependencies or devDependencies) or global |
| bun | Local (dependencies or devDependencies) or global |
| Binary | Download standalone executable to a chosen path |
| Docker | Pull a Docker image (latest, JIT, ARM64, or Bun variant) |

**PostgreSQL client tools** (psql, pg_dump, pg_restore) — auto-detects your system package manager:

| Package Manager | Options |
|-----------------|---------|
| Homebrew (macOS) | `libpq` (client-only, ~7 MB) or `postgresql@{version}` (full server + client, ~19 MB) |
| apt (Debian/Ubuntu) | `postgresql-client-{version}` |
| apk (Alpine) | `postgresql{version}-client` |
| dnf (Fedora/RHEL) | `postgresql{version}` |

```
$ pgdev setup

  What would you like to set up?

  1. npgsqlrest  NpgsqlRest server
  2. pg-tools    PostgreSQL client tools (psql, pg_dump, pg_restore)
```

### `pgdev update`

Updates pgdev itself to the latest version from npm.

### `pgdev -v`

Shows versions of all configured tools:

```
$ pgdev -v
pgdev       0.0.3
npgsqlrest  3.8.0.0
psql        15.16
pg_dump     15.16
pg_restore  15.16
```

## Configuration

pgdev uses two TOML config files in your project root:

| File | Purpose | Git |
|------|---------|-----|
| `pgdev.toml` | Shared project config | Commit |
| `pgdev.local.toml` | Personal overrides (tool paths, etc.) | Gitignore |

Layering: defaults &rarr; `pgdev.toml` &rarr; `pgdev.local.toml`

Example `pgdev.local.toml`:

```toml
[tools]
npgsqlrest = "bunx npgsqlrest"
psql = "/opt/homebrew/opt/postgresql@15/bin/psql"
pg_dump = "/opt/homebrew/opt/postgresql@15/bin/pg_dump"
pg_restore = "/opt/homebrew/opt/postgresql@15/bin/pg_restore"
```

## License

MIT
