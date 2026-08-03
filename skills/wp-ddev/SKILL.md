---
name: "wp-ddev"
description: "Run WordPress WP-CLI commands in DDEV environments. Database queries, plugin management, user ops, themes, cache, cron. Zero config from any DDEV project dir. Supply chain isolated package management. Triggers on: ddev wp, ddev setup, ddev import, wp plugin, wp db, wp user, wp option, wp-cli, DDEV."
---

# WordPress WP-DDEV

Execute WP-CLI commands in DDEV WordPress environments. Zero configuration — just be in a DDEV project directory.

**Prerequisites**: Docker + DDEV v1.25+

```bash
ddev start
ddev wp plugin list
ddev wp db query "SELECT * FROM wp_posts LIMIT 5"
ddev describe  # URLs, ports, credentials
```

## How It Works

- DDEV auto-detects `.ddev/config.yaml`
- WP-CLI runs inside web container with correct PHP, MySQL, WordPress paths
- No host environment pollution, no UUIDs, no socket paths

## Common Commands

### Database
```bash
ddev wp db query "SELECT * FROM wp_users"
ddev wp db export dump.sql
ddev wp db import dump.sql
ddev wp search-replace 'old.com' 'new.com' --dry-run
ddev wp search-replace 'old.com' 'new.com' --all-tables
```

### Plugins
```bash
ddev wp plugin list --status=active --format=json
ddev wp plugin activate my-plugin
ddev wp plugin install contact-form-7 --activate
ddev wp plugin is-installed woocommerce && echo "yes"
```

### Users
```bash
ddev wp user list --role=administrator --format=table
ddev wp user create testuser test@example.com --role=editor
ddev wp user update 1 --display_name="Admin User"
ddev wp user add-role 2 editor
```

### Themes
```bash
ddev wp theme list
ddev wp theme activate twentytwentyfour
ddev wp theme status flavor
```

### Cache & Transients
```bash
ddev wp cache flush
ddev wp transient delete --all
ddev wp transient get my_transient_key
```

### Options
```bash
ddev wp option get siteurl
ddev wp option update blogname "New Site Name"
ddev wp option list --search="woocommerce_*" --format=table
ddev wp option delete my_old_option
```

### Posts
```bash
ddev wp post list --post_type=page --format=table
ddev wp post list --post_status=draft --fields=ID,post_title
ddev wp post create --post_type=post --post_title="Test" --post_status=publish
ddev wp post update 42 --post_title="Updated Title"
ddev wp post delete 42 --force
ddev wp post meta update 42 custom_field "new value"
```

### Taxonomy
```bash
ddev wp term list category --format=table
ddev wp term create category "New Category" --slug=new-category
ddev wp term update category 5 --name="Renamed"
ddev wp term delete category 5
```

### Menu
```bash
ddev wp menu list --format=table
ddev wp menu item add-post primary-menu 42
ddev wp menu item add-custom primary-menu "Link" https://example.com
```

### Rewrite
```bash
ddev wp rewrite flush
ddev wp rewrite structure '/%postname%/'
```

### Scaffold
```bash
ddev wp scaffold plugin my-plugin --plugin_name="My Plugin"
ddev wp scaffold post-type product --plugin=my-plugin
ddev wp scaffold taxonomy genre --post_types=product --plugin=my-plugin
ddev wp scaffold child-theme flavor-child --parent_theme=flavor
```

### Eval
```bash
ddev wp eval "echo home_url();"
ddev wp eval "var_dump(wp_get_current_user());"
ddev wp eval-file test-script.php
```

## DDEV Project Commands

```bash
ddev start            # Start containers
ddev stop             # Stop (preserves database)
ddev restart          # Restart after config changes
ddev describe         # URLs, ports, DB credentials, PHP version
ddev list             # All DDEV projects on machine
ddev ssh              # Interactive shell in web container
ddev exec ls -la      # Run command in web container
ddev logs             # Web server logs
ddev logs -s db       # Database logs
ddev launch           # Open site in browser
ddev launch wp-admin/ # Open WP admin
```

## IMA Addon Commands

```bash
ddev setup                                      # First-time bootstrap (idempotent)
ddev import-assets ~/path/to/extracted-archive  # Import wp-content from WPE archive
ddev import-db --file=~/path/to/dump.sql        # Import database dump
ddev add-on update ima-ddev-wordpress           # Update addon
```

## Supply Chain Security

Use `ddev npm`/`ddev composer` — never bare host commands. Container isolation prevents compromised deps from accessing host SSH keys, env vars, other projects.

| Instead of | Use |
|---|---|
| `npm install` | `ddev npm install` |
| `composer install` | `ddev composer install` |
| `npm run composer:dev` | `ddev npm run composer:dev` |

**Exception**: `npm run deploy` stays on host — needs SSH for WP Engine push.

## Global Flags

| Flag | Description |
|---|---|
| `--format=<format>` | `table`, `csv`, `json`, `yaml`, `count`, `ids` |
| `--fields=<fields>` | Comma-separated columns |
| `--quiet` | Suppress informational messages |
| `--skip-themes` | Skip loading themes |
| `--skip-plugins` | Skip all plugins (debug conflicts) |
| `--skip-plugins=<plugin>` | Skip specific plugin |
| `--debug` | Show debug output |
| `--user=<id\|login>` | Run as specific user |

```bash
ddev wp help
ddev wp help plugin
```

See [`references/wp-cli-reference.md`](references/wp-cli-reference.md) and [`references/ddev-commands.md`](references/ddev-commands.md).

## Quality Gates

Before destructive commands:
- Correct project: `ddev describe`
- Backup if needed: `ddev export-db --file=backup.sql.gz`
- Containers running: `ddev start`
