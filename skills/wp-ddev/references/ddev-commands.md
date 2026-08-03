# DDEV Commands Reference

DDEV-specific commands for WordPress local development. For WP-CLI commands, see [wp-cli-reference.md](wp-cli-reference.md).

## Table of Contents

- [Project Lifecycle](#project-lifecycle)
- [Information](#information)
- [Database](#database)
- [Shell & Execution](#shell--execution)
- [Package Managers](#package-managers)
- [IMA Addon Commands](#ima-addon-commands)
- [Configuration Files](#configuration-files)
- [Logs & Debugging](#logs--debugging)
- [URLs & Networking](#urls--networking)
- [Snapshots](#snapshots)
- [Add-ons](#add-ons)
- [Troubleshooting](#troubleshooting)

---

## Project Lifecycle

```bash
ddev start               # Start containers (creates if first time)
ddev stop                # Stop containers (preserves data)
ddev restart             # Restart after config changes
ddev delete              # Remove containers and database (destructive!)
ddev delete --omit-snapshot  # Delete without creating snapshot first
```

**Gotcha**: `ddev stop` preserves the database. `ddev delete` destroys it. When in doubt, snapshot first.

---

## Information

```bash
ddev describe            # URLs, ports, DB credentials, PHP version, container status
ddev list                # All DDEV projects on this machine
ddev version             # DDEV version
```

`ddev describe` is your first stop — it shows everything: the HTTPS URL, database port, PHP version, and whether containers are healthy.

---

## Database

```bash
ddev import-db --file=dump.sql         # Import SQL dump
ddev import-db --file=dump.sql.gz      # Import compressed dump
ddev export-db --file=backup.sql.gz    # Export database (compressed)
ddev export-db                         # Export to stdout
ddev mysql                             # Interactive MySQL client (inside container)
ddev mysql -e "SHOW TABLES"            # Run single query
```

**Credentials**: database=`db`, user=`db`, password=`db`, host=`db` (inside container) or `127.0.0.1:<port>` from host — port shown by `ddev describe`.

---

## Shell & Execution

```bash
ddev ssh                               # Interactive bash in web container
ddev ssh -s db                         # Shell into database container
ddev exec ls -la wp-content/plugins/   # Run command in web container
ddev exec cat wp-content/debug.log     # Read a file inside the container
```

`ddev exec` runs one-off commands. `ddev ssh` for interactive sessions.

---

## Package Managers

All package operations run inside the container:

```bash
ddev npm install                       # npm in container
ddev npm run build                     # npm scripts in container
ddev npm run composer:dev              # Composer via npm script
ddev composer install                  # Composer in container
ddev composer require vendor/package   # Add dependency
ddev yarn install                      # Yarn alternative
```

**Why**: Running on host exposes SSH keys, env vars, and other projects to postinstall scripts. Container isolation prevents supply chain attacks.

**Exception**: `npm run deploy` runs on host — it needs SSH access for WP Engine push.

---

## IMA Addon Commands

Provided by `ima-ddev-wordpress`:

```bash
# First-time setup (idempotent — safe to re-run)
ddev setup
# - Downloads WordPress core
# - Creates wp-config.php with DDEV credentials
# - Rewrites URLs to match DDEV hostname
# - Installs free plugins from .ddev/ima-wordpress.yaml
# - Fixes known vendor issues (e.g., Mockery dev deps)

# Import wp-content from a WPE site archive
ddev import-assets ~/path/to/extracted-archive
# - Copies: PRO plugins, parent theme, compiled CSS, uploads, vendor deps
# - Never overwrites git-tracked files (rsync --ignore-existing)

# Install or update the addon itself
ddev add-on get https://gitea.theflccc.org/IMA/ima-ddev-wordpress
ddev add-on update ima-ddev-wordpress
```

**Key flag**: `--ignore-existing` means `ddev import-assets` is safe to re-run — it won't clobber your local changes.

---

## Configuration Files

```
.ddev/
├── config.yaml              # Project config (type, PHP version, DB)
├── ima-wordpress.yaml       # Free plugin list (site-specific)
├── php/                     # PHP overrides (upload_max_filesize, etc.)
├── .env                     # Environment variables for containers
├── commands/web/setup       # Custom 'ddev setup' command
└── commands/host/import-assets  # Custom 'ddev import-assets' command
```

**Key `config.yaml` settings**: `type: wordpress`, `php_version`, `database`, `webserver_type`, `router_http_port`, `router_https_port`.

After editing `config.yaml`, run `ddev restart` to apply changes.

---

## Logs & Debugging

```bash
ddev logs                    # Web server (nginx/Apache) logs
ddev logs -s db              # MySQL server logs
ddev logs -f                 # Follow logs (tail -f style)
ddev exec cat wp-content/debug.log | tail -50   # WordPress debug log
ddev xdebug on               # Enable Xdebug (for PHPStorm/VS Code)
ddev xdebug off              # Disable Xdebug (faster execution)
```

**Gotcha**: Xdebug significantly slows PHP execution. Toggle it off when not actively stepping through code.

---

## URLs & Networking

```bash
ddev launch                  # Open site in default browser
ddev launch wp-admin/        # Open WP admin
ddev share                   # Create ngrok tunnel for external access
```

**Port conflicts**: If 80/443 are in use (e.g., another web server), DDEV auto-assigns alternate ports. Check with `ddev describe`. The `ddev setup` command configures WordPress URLs accordingly — no manual search-replace needed.

---

## Snapshots

```bash
ddev snapshot                               # Create database snapshot
ddev snapshot --name=before-migration       # Named snapshot
ddev snapshot restore                       # Restore latest snapshot
ddev snapshot restore --latest              # Same as above
ddev snapshot restore --name=before-migration  # Restore specific
ddev snapshot list                          # List all snapshots
```

Snapshots are fast database checkpoints. Take one before any risky operation (migrations, plugin updates, data imports).

---

## Add-ons

```bash
ddev add-on list                            # List installed add-ons
ddev add-on get ddev/ddev-redis             # Install from DDEV registry
ddev add-on get https://gitea.theflccc.org/IMA/ima-ddev-wordpress  # Install from URL
ddev add-on update ima-ddev-wordpress       # Update specific add-on
ddev add-on remove redis                    # Remove add-on
```

---

## Troubleshooting

**"Critical error" on page load:**
Missing plugin or broken dependency. Check the debug log first:
```bash
ddev exec cat wp-content/debug.log | tail -20
ddev wp plugin activate --all
```

**ima-payments fatal error (Mockery not found):**
WPE archives include dev dependencies. Re-run setup (it auto-fixes this) or fix manually:
```bash
ddev exec bash -c "cd wp-content/plugins/ima-payments && composer install --no-dev"
```

**No CSS / unstyled site:**
Compiled CSS is a build artifact not tracked in git. Re-import from the WPE archive:
```bash
ddev import-assets ~/path/to/extracted-archive
```

**Can't connect to database:**
```bash
ddev describe    # Check container status
ddev restart     # Restart containers
```

**Port conflict:**
```bash
ddev describe    # Shows actual assigned ports
# DDEV auto-handles conflicts; ddev setup rewrites WordPress URLs to match
```

**Docker not running:**
```bash
docker info      # Check Docker daemon status
# Start Docker Desktop, or: sudo systemctl start docker
ddev start
```
