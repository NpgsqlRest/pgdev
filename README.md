# pgdev

PostgreSQL and NpgsqlRest Development Toolchain.

A CLI tool with a TUI experience for managing PostgreSQL client tools and [NpgsqlRest](https://github.com/NpgsqlRest/NpgsqlRest) in your development environment.

> **Note:** This project is under active development. Commands, options, and behavior are subject to change.

## Requirements

- [Bun](https://bun.sh) runtime

## Install

```bash
bun install -g pgdev
```

## Update

```bash
pgdev update
```

## Uninstall

```bash
bun uninstall -g pgdev
```

## Commands

### `pgdev config`

Interactive TUI dashboard for configuring your development environment. This is the main entry point for all configuration. Aliases: `pgdev init`, `pgdev setup`.

Sections:

- **NpgsqlRest** — detect or install NpgsqlRest (npm, bun, standalone binary, or Docker)
- **PostgreSQL Tools** — detect or install psql, pg_dump, pg_restore (Homebrew, apt, apk, dnf)
- **NpgsqlRest Config Files** — create and manage NpgsqlRest JSON config files (production, development, local) with a TUI editor for connection strings, config settings, and more
- **pgdev Environment** — configure env file, database connection, and project directories (migrations, routines, tests, schemas)

### `pgdev exec <sql>`

Execute a SQL command via psql using the configured connection.

```bash
pgdev exec "SELECT version()"
```

### `pgdev psql`

Open an interactive psql session using the configured connection.

### `pgdev sync`

Dump database schema to the configured migrations directory.

### `pgdev update`

Update pgdev to the latest published version.

### `pgdev <custom>`

Run custom NpgsqlRest commands defined in `pgdev.toml` under `[npgsqlrest.commands]`. For example, if your config has:

```toml
[npgsqlrest.commands]
dev = "./config/production.json --optional ./config/development.json"
```

Then `pgdev dev` will launch NpgsqlRest with those arguments.

## Options

| Option | Description |
|--------|-------------|
| `--version`, `-v` | Show versions of pgdev, NpgsqlRest, PostgreSQL tools, and connected server |
| `--help`, `-h` | Show help message |

## Configuration

pgdev uses two TOML config files in your project root:

| File | Purpose | Git |
|------|---------|-----|
| `pgdev.toml` | Shared project config | Commit |
| `pgdev.local.toml` | Personal overrides (tool paths, credentials) | Gitignore |

Layering: defaults → `pgdev.toml` → `pgdev.local.toml`

Running `pgdev` for the first time creates a `pgdev.toml` with all available options. The full structure:

```toml
# Path to .env file for resolving {ENV_VAR} placeholders in config values
env_file = ""

# Show detailed output during tool detection and updates
verbose = true

# Tool paths — bare command name uses PATH, or set a full path
[tools]
npgsqlrest = "npgsqlrest"
psql = "psql"
pg_dump = "pg_dump"
pg_restore = "pg_restore"

# NpgsqlRest run commands — value is the config file args passed to npgsqlrest CLI
# Example: dev = "./config/production.json --optional ./config/development.json"
[npgsqlrest.commands]
dev = ""
validate = ""
serve = ""
validate-prod = ""

# SQL commands used by pgdev
[commands]
schemas_query = "select nspname::text from pg_namespace ..."

# Database connection for pgdev tools (psql, pg_dump, pg_restore)
# Values support {ENV_VAR} placeholders resolved via env_file above
# To share connection with NpgsqlRest instead, set config_file to a JSON config path
[connection]
host = "{PGHOST}"
port = "{PGPORT}"
database = "{PGDATABASE}"
username = "{PGUSER}"
password = "{PGPASSWORD}"
# config_file = "./config/production.json"
# connection_name = "Default"

# Project directories for SQL source files
# Leave empty to skip; directories are created when first needed
[project]
routines_dir = ""
migrations_dir = ""
tests_dir = ""
schemas = []
```

### Top-level options

| Key | Default | Description |
|-----|---------|-------------|
| `env_file` | `""` | Path to `.env` file for resolving `{ENV_VAR}` placeholders in config values |
| `verbose` | `true` | Show detailed output (command echoes, full error messages) |

### `[tools]`

Paths to external tools. Use a bare command name to use PATH, or set a full path.

| Key | Default | Description |
|-----|---------|-------------|
| `npgsqlrest` | `"npgsqlrest"` | NpgsqlRest server command |
| `psql` | `"psql"` | PostgreSQL interactive terminal |
| `pg_dump` | `"pg_dump"` | PostgreSQL dump utility |
| `pg_restore` | `"pg_restore"` | PostgreSQL restore utility |

### `[npgsqlrest.commands]`

Custom NpgsqlRest run commands. Each key becomes a `pgdev <name>` subcommand. The value is the config file arguments passed to the NpgsqlRest CLI.

| Key | Default | Description |
|-----|---------|-------------|
| `dev` | `""` | Development server command |
| `validate` | `""` | Validate config command |
| `serve` | `""` | Production serve command |
| `validate-prod` | `""` | Validate production config command |

### `[commands]`

SQL commands used internally by pgdev.

| Key | Description |
|-----|-------------|
| `schemas_query` | SQL query to list project schemas (used by sync and config) |

### `[connection]`

Database connection for pgdev tools. Two modes:

**Independent connection** — set host, port, database, username, password directly:

| Key | Default | Description |
|-----|---------|-------------|
| `host` | `"{PGHOST}"` | PostgreSQL host |
| `port` | `"{PGPORT}"` | PostgreSQL port |
| `database` | `"{PGDATABASE}"` | Database name |
| `username` | `"{PGUSER}"` | Username |
| `password` | `"{PGPASSWORD}"` | Password |

**Shared connection** — read connection string from a NpgsqlRest JSON config file:

| Key | Description |
|-----|-------------|
| `config_file` | Path to NpgsqlRest JSON config file (e.g. `"./config/production.json"`) |
| `connection_name` | Connection string name in the config file (default: `"Default"`) |

### `[project]`

Project directory paths for SQL source files.

| Key | Default | Description |
|-----|---------|-------------|
| `routines_dir` | `""` | Directory for SQL routines (functions/procedures) |
| `migrations_dir` | `""` | Directory for migration scripts |
| `tests_dir` | `""` | Directory for SQL test files |
| `schemas` | `[]` | Schemas used by this project (empty = all non-system schemas) |

## License

MIT
