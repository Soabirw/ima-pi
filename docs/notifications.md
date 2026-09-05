# Desktop notifications

`ima-pi` can send one generic desktop notification when an interactive Pi session is
waiting for input. The feature uses the repository's Pi 0.84.4 development baseline
and supports installed Pi runtimes accepted by the peer range `^0.84.4 || ^0.85.0`.

## Behavior

Notifications are enabled by default for interactive TUI sessions only. Print, JSON,
and RPC modes remain silent, including RPC contexts where `hasUI` is true.

A notification is attempted when:

- Pi reaches final `agent_settled` state after an observed run; or
- an extension opens one outer `confirm`, `select`, `input`, `editor`, or `custom`
  dialog span.

Each distinct waiting event gets at most one attempt. New input, another run, tree
navigation, prompt closure, and shutdown suppress stale pending work. A prompt that
opens while settlement delivery is pending replaces that settlement notification.
Nested Pi extension dialogs are coalesced by Pi into one outer prompt span.

The visible content is always:

```text
Pi
Pi is ready for your input
```

No prompt title, response, project name, path, credential, or session identifier is
included in a notification.

## Configuration

The package ships `config/notifications.json`:

```json
{"enable": true}
```

To opt out, create `~/.pi/agent/ima/notifications.json` (or the equivalent path
under `PI_CODING_AGENT_DIR`) with:

```json
{"enable": false}
```

Only the boolean `enable` key is supported. An empty user object inherits the bundled
default. Missing user configuration also retains the default.

Malformed, unknown, unreadable, oversized, nonregular, or unsafe configuration
files disable notifications for that extension instance. Each configuration file is
limited to 4 KiB and must resolve to a regular file inside its approved package or
user configuration base. Configuration is cached until `/reload` or restart; there
is no watcher or configuration-writing command.

## Platform prerequisites and limitations

- **Linux:** `/usr/bin/notify-send` must be available and permitted by the desktop.
- **macOS:** `/usr/bin/osascript` uses Apple's `display notification` command with
  the stock `Frog` sound.
- **Other platforms:** no notification command runs.

The extension uses fixed absolute executables and fixed argument arrays through
`pi.exec()` with a two-second timeout. It does not use a shell, `PATH` search,
actions, replacement IDs, retries, fallback transports, output display, or raw error
logging. Missing executables, failed commands, timeouts, cancellation, OS notification
permissions, Focus/Do Not Disturb, and desktop policy can all suppress delivery
silently. A submitted OS notification cannot be retracted.

## Manual acceptance

Automated tests never send a desktop notification. On Linux Mint and macOS, run:

```bash
./node_modules/.bin/pi -e . -e ./tests/fixtures/notifications-prompts.ts
```

Use exactly one enabled `ima-pi` copy and allow notifications in the operating system.
After Pi starts, run `/ima:notification-prompts`. In its nested step, use the configured
confirm action to open the inner confirmation, then answer that inner confirmation; use
cancel before opening it to close the outer fixture without an inner dialog.

Verify final settlement, each fixture dialog, and the nested outer span produce one
generic notification; answering a dialog does not produce another; a later waiting event
does; opt-out plus reload suppresses all notifications; and noninteractive execution
remains silent. Record platform-specific appearance, timing, and sound separately:
automated results do not prove desktop delivery.
