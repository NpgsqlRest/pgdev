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

### `pgdev sync`

Extract database schema and routines into project files (DB → Files):

- Dumps the full schema to `migrations_dir/schema.sql` (DDL for tables, types, etc.)
- Extracts each routine (function, procedure, or other configured types) into individual `.sql` files in `routines_dir`
- Applies configurable formatting (see `[format]` options)
- Organizes files into subdirectories based on `group_order` (by API type, schema, name segment, or object kind)
- Supports `VIEW` extraction when added to `routine_types`
- On re-sync, updates existing files in place and reports created/updated/unchanged counts

Selective sync updates only specific aspects of existing source files without overwriting them:

| Flag | Description |
|------|-------------|
| `--comments` | Surgically insert or update `COMMENT ON` statements from the database |
| `--grants` | Update `GRANT`/`REVOKE` statements from the database |
| `--definitions` | Update routine definitions from the database |
| `--all` | Apply all selective updates above |

### `pgdev diff`

Compare project SQL files against the live database (read-only):

- Parses all `.sql` files in `routines_dir` and fetches routine metadata from `pg_catalog`
- Reports routines that need creating, updating, or dropping
- Compares definition (parameters, return type, body, attributes), comments, and optionally grants
- Supports `ignore_body_whitespace` for whitespace-insensitive body comparison
- Supports routines inside `DO $$ ... $$` blocks and files with multiple routines

### `pgdev exec <sql>`

Execute a SQL command via psql using the configured connection.

```bash
pgdev exec "SELECT version()"
```

### `pgdev psql`

Open an interactive psql session using the configured connection.

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
| `--status`, `-s` | Show tools status |
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

# Project directories and settings
[project]
routines_dir = ""
migrations_dir = ""
tests_dir = ""
schemas = []
grants = false
ignore_body_whitespace = false
routine_types = ["FUNCTION", "PROCEDURE"]
api_dir = ""
internal_dir = ""
group_segment = 0
skip_prefixes = []
group_order = []

# SQL formatting options (applied during sync)
[format]
lowercase = true
param_style = "multiline"
indent = "    "
simplify_defaults = true
omit_default_direction = true
attribute_style = "multiline"
strip_dump_comments = true
comment_signature_style = "types_only"
drop_before_create = true
create_or_replace = false
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

Project directories and sync/diff settings.

| Key | Default | Description |
|-----|---------|-------------|
| `routines_dir` | `""` | Directory for extracted SQL routines |
| `migrations_dir` | `""` | Directory for migration scripts (schema.sql is written here) |
| `tests_dir` | `""` | Directory for SQL test files |
| `schemas` | `[]` | Schemas to include (empty = all non-system schemas) |
| `grants` | `false` | Include GRANT/REVOKE statements in sync and diff |
| `ignore_body_whitespace` | `false` | Ignore whitespace differences in routine bodies during diff |
| `routine_types` | `["FUNCTION", "PROCEDURE"]` | Object types to extract into individual files. Supported: `FUNCTION`, `PROCEDURE`, `VIEW` |
| `api_dir` | `""` | Subdirectory for API routines (those with HTTP comments) within the "type" grouping dimension |
| `internal_dir` | `""` | Subdirectory for non-API routines within the "type" grouping dimension |
| `group_segment` | `0` | Name segment index for the "name" grouping dimension (0 = disabled). Splits on `_` after skipping common prefixes |
| `skip_prefixes` | `[]` | Prefixes to skip when extracting group segment (e.g. `["get", "set", "delete"]`). Uses built-in defaults when empty |
| `group_order` | `[]` | Directory nesting order. Available dimensions: `"type"`, `"schema"`, `"name"`, `"kind"`. Empty = flat directory |

**Directory grouping dimensions:**

- **`type`** — Split by API vs internal (uses `api_dir`/`internal_dir` names). Routines with HTTP comments go to `api_dir`, others to `internal_dir`.
- **`schema`** — Split by PostgreSQL schema name (uses the schema name as directory).
- **`name`** — Split by name segment extracted from the routine's snake_case name (e.g. `get_user_data` with `group_segment=1` → `user/`).
- **`kind`** — Split by object type (uses lowercase type name: `function/`, `procedure/`, `view/`).

Example: `group_order = ["type", "schema", "kind"]` produces paths like `api/myschema/function/my_func.sql`.

### `[format]`

SQL formatting options applied when extracting routines during sync.

| Key | Default | Description |
|-----|---------|-------------|
| `lowercase` | `true` | Lowercase SQL keywords |
| `param_style` | `"multiline"` | Parameter layout: `"inline"` or `"multiline"` |
| `indent` | `"    "` | Indentation string for multiline formatting |
| `simplify_defaults` | `true` | Simplify default expressions (e.g. `NULL::text` → `null`) |
| `omit_default_direction` | `true` | Omit `IN` direction since it's the default |
| `attribute_style` | `"multiline"` | Attribute placement: `"inline"` or `"multiline"` |
| `strip_dump_comments` | `true` | Remove pg_dump header/footer comments |
| `comment_signature_style` | `"types_only"` | COMMENT ON signature: `"types_only"` or `"full"` (includes param names) |
| `drop_before_create` | `true` | Add `DROP FUNCTION/PROCEDURE IF EXISTS` before `CREATE` |
| `create_or_replace` | `false` | Use `CREATE OR REPLACE` instead of `CREATE` |

## License

MIT
