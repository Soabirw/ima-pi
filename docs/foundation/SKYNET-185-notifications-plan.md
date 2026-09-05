# Approved technical plan — SKYNET-185

**Phase result:** APPROVED — explicitly approved by the operator; implementation has not begun.
**Source:** `lifecycle:ima-pi:plane:ima:SKYNET-185`
**Plane source:** `plane:ima:SKYNET-185`
**Outcome:** One cohesive feature that delivers generic OS desktop notifications when interactive Pi awaits input.
**Local plan copy:** `SKYNET-185-notifications-plan.md`

## Qdrant persistence receipt

- **Status:** completed; receipt accepted and lifecycle identity, nonce, phase, source identity, and outcome verified.
- **Lifecycle key:** `ima-pi:plane:ima:SKYNET-185`
- **artifactId:** `521e9225-e326-5c7c-a047-24d1234a7050`
- **recordKey:** `ima-pi:plane:ima:SKYNET-185:plan:3725ede8cde6`
- Stored through `ima_lifecycle` as `plan`. The approved plan body below matches the submitted artifact; this local receipt records the references returned after storage.

## 1. Scope and approved decisions

- One plan and one implementation deliverable.
- Update the tested Pi baseline from **0.82.1 to 0.85.1**.
- Notify after final agent settlement and when a documented extension dialog opens: `confirm`, `select`, `input`, `editor`, or `custom`.
- Linux and macOS; enabled by default with a user opt-out.
- One notification attempt per distinct waiting event.
- Generic title **“Pi”** and body **“Pi is ready for your input”**.
- Notification-service failures remain silent and do not disrupt Pi.

**Excluded:** built-in pickers, startup trust prompts, Pi internals changes, Windows/WSL support, terminal-protocol fallbacks, notification history, configurable commands/messages, click-to-focus, focus suppression, separate audio playback, and changes to TTS or cycle orchestration.

## 2. Implementation surface

| File                                              | Responsibility                                                                                                                                                                         |
|---------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `../../package.json`                                    | Set coding-agent development dependency to `0.85.1`, peer range to `^0.85.1`, and align direct `pi-ai` dependency to `0.85.1`. Preserve other direct dependencies and package version. |
| `../../package-lock.json`                               | Regenerate for that bounded dependency update; inspect resulting changes.                                                                                                              |
| **New** `../../extensions/notifications.ts`             | Pi event registration, configuration reads, scheduling, cancellation, and OS-command execution.                                                                                        |
| **New** `../../lib/ima-notifications.ts`                | Pure configuration validation, waiting-event transitions, delivery eligibility, and fixed platform-command selection.                                                                  |
| **New** `../../config/notifications.json`               | Bundled `{"enable": true}`.                                                                                                                                                            |
| **New** `../../tests/notifications.test.js`             | Pure rules and platform-command tests.                                                                                                                                                 |
| **New** `../../tests/notifications-extension.test.js`   | Event ordering, deduplication, cancellation, and command-failure tests.                                                                                                                |
| **New** `../../tests/notifications-config.test.js`      | Configuration filesystem-boundary tests.                                                                                                                                               |
| **New** `../../tests/notifications-discovery.test.js`   | Actual Pi resource-loader discovery and registration tests.                                                                                                                            |
| **New** `../../tests/fixtures/notifications-prompts.ts` | Explicitly loaded, manual-only dialog acceptance fixture.                                                                                                                              |
| **New** `../notifications.md`                   | Behavior, configuration, platform prerequisites, limitations, and manual acceptance procedure.                                                                                         |
| `../../README.md`, `../../config/README.md`, `../guide.md`  | Default-on announcement, opt-out example, Pi baseline, and documentation links.                                                                                                        |

The existing `pi.extensions: ["./extensions"]` declaration discovers the extension without another manifest entry. The test fixture stays outside that directory.

### Pure/effect boundary

```text
Pi events + validated configuration
    → pure waiting-state transition
    → current-state eligibility check
    → fixed command and argument array
    → asynchronous OS notification attempt
```

Proposed pure helpers: `parseNotificationConfigLayer`, `nextNotificationState`, `canDeliverNotification`, and `notificationCommand`.

The extension owns effects through explicit dependencies: configuration loading, platform detection, scheduling, and `pi.exec`. No model calls, session-history reads, notification persistence, or generic event framework.

## 3. Event behavior and ordering

Maintain only session-local state: observed run generation, consumed settlement generation, current prompt span, pending delivery identities, and shutdown state.

| Event                         | Required behavior                                                                                                                   |
|-------------------------------|-------------------------------------------------------------------------------------------------------------------------------------|
| `session_start`               | Initialize configuration lazily; never emit a startup notification or replay an old response.                                       |
| `agent_start`                 | Advance the run generation and invalidate pending settlement delivery.                                                              |
| `input`, `before_agent_start` | Invalidate a pending settlement notification without modifying input or arming a fictitious run.                                    |
| `agent_settled`               | For an observed, unconsumed run, require TUI, `hasUI`, and idle state. Reserve the event synchronously before asynchronous work.    |
| `ui_prompt_start`             | Reserve one notification for a new valid outer prompt span, even while the agent is busy. Ignore duplicate starts within that span. |
| `ui_prompt_end`               | Close the span and cancel pending prompt delivery. Do not notify again merely because the dialog closed.                            |
| `session_tree`                | Invalidate pending settlement delivery tied to the previous branch.                                                                 |
| `session_shutdown`            | Invalidate pending work, clear scheduled callbacks, and abort active notification commands.                                         |

Additional rules:

- Use **`agent_settled`**, not `agent_end`, so retries, compaction retries, and queued continuations do not create intermediate notifications.
- Defer settlement delivery with one `setImmediate`, then recheck identity, UI mode, idle state, configuration, and shutdown immediately before execution. This is not a debounce or polling policy.
- Prompt delivery has no intentional delay. Recheck that its span remains open after any configuration await.
- If settlement occurs while a prompt is already open, consume that settlement without a redundant notification. Opening a prompt also invalidates any pending settlement notification.
- Separate prompt spans and later settled runs remain separate events.
- Do **not** reuse TTS’s successful-response selector. A failed, interrupted, or length-limited run that genuinely settles awaiting input can notify; this feature reports readiness, not success.
- Never retry a failed delivery within the same waiting event.

All notification handlers return promptly; they do not await OS delivery. Asynchronous failures must be caught.

## 4. Configuration contract

Precedence:

1. Bundled `../../config/notifications.json`.
2. Optional `getAgentDir()/ima/notifications.json`.

User opt-out:

```json
{"enable": false}
```

- Only `enable` is supported, and its value must be boolean.
- The bundled file must provide it; a user `{}` inherits the bundle.
- A missing user file retains the default.
- Malformed, unreadable, oversized, or invalid configuration disables notifications for that extension instance. Do not silently turn an invalid opt-out into default-on behavior.
- Read only fixed configuration paths beneath their approved package/user bases. Require regular files, cap each read at **4 KiB**, and reject symlink targets escaping the corresponding base.
- Cache configuration per extension instance. Changes take effect after `/reload` or restart; no watcher or config-writing command.
- Unsupported/non-interactive modes perform no notification setup or execution.

This uses TTS’s configuration-location precedent, but deliberately uses stricter failure behavior because notifications default to enabled.

## 5. OS delivery and security

**Linux:** invoke `/usr/bin/notify-send` with separate fixed arguments for app name, normal urgency, generic title/body, and the standard `sound-name` hint. Do not use actions, replacement IDs, or `--wait`.

**macOS:** invoke `/usr/bin/osascript` with a fixed `-e` script using Apple’s documented `display notification` command and a stock system sound, `Frog`.

Both paths use:

- `pi.exec(command, args, { timeout: 2000, signal })`.
- Fixed absolute executables; no `PATH` search or user-configured command.
- No shell interpolation. Installed Pi 0.85.1’s execution implementation uses `shell: false`.
- Contained handling of missing executables, rejection, nonzero exit, timeout, and cancellation.
- No retries, fallback notifications, raw error logging, or command-output display.

Only constants reach the desktop notification. Prompt titles, responses, project names, paths, credentials, and session identifiers are neither read for content nor forwarded.

Sound remains subject to OS capabilities and user notification settings. Commands already accepted by the OS cannot reliably be recalled.

**Not applicable:** HTTP authorization, CSRF, SQL, HTML encoding, and remote-service credentials. Relevant boundaries are configuration files, Pi event/context data, dependency updates, and local process execution.

## 6. Standards Impact

- Keep the notification extension and pure core separate by responsibility rather than adding this behavior to existing large modules.
- Target each new handwritten production/test file comfortably below the **500-line smell**. Split tests by configuration, state/effects, and discovery as listed above.
- Existing documents are small enough for the proposed additions: `../../README.md` currently 346 lines, `../../config/README.md` 33, and `../guide.md` 74.
- `../../package-lock.json` is approximately 4,929 lines. Retain it intact: it is a generated dependency graph, not a manually maintained multi-responsibility module.
- Do not enlarge `../../extensions/cycle.ts`, its large test file, or general configuration tests.
- Apply descriptive names, guard clauses, immutable state transitions, named limits, and the soft approximately-50-line function heuristic. Retain cohesive exceptions only with a concrete readability justification.
- No custom FP utilities, policy engine, inheritance hierarchy, or notification framework.

## 7. Implementation order and tests

1. **Update the Pi baseline and lockfile.** Run the existing suite before adding notification behavior. If the update exposes unrelated incompatibilities requiring broader production changes, stop and report the exact failures rather than silently expanding scope.
2. **Implement the pure rules and tests.**
3. **Implement configuration loading and the extension shell.**
4. **Add discovery coverage and the manual dialog fixture.**
5. **Update documentation and complete verification.**

Automated coverage must prove:

- Default-on, opt-out, inheritance, malformed/unknown configuration, size limits, and path constraints.
- TUI-only behavior, including exclusion of RPC even when `hasUI` is true.
- No startup replay, intermediate-run notification, or duplicate settlement.
- Each supported dialog kind, duplicate/coalesced starts, repeated distinct spans, and settlement during an open prompt.
- Legitimate idle settlement after success, error, interruption, and length termination.
- Stale suppression after new input, new runs, branch navigation, shutdown, delayed configuration, or a prompt closing.
- Missing notifier, execution rejection, nonzero exit, timeout/cancellation results, and silent failure containment.
- Exact command arguments and absence of sensitive event data at the execution boundary.
- Real `DefaultResourceLoader` discovery of exactly one notification extension with package provenance and the expected handlers.

Use Node’s test runner, direct pure-function tests, injected filesystem/process/scheduler boundaries, and deterministic deferred promises. Default tests must not send desktop notifications or make model requests.

## 8. Verification and acceptance

**Implementation-phase commands:**

| Command                                                        | Expected signal                                                                                         |
|----------------------------------------------------------------|---------------------------------------------------------------------------------------------------------|
| `npm install`                                                  | Updated dependency graph and lockfile limited to the approved baseline change and required transitives. |
| `npm ls @earendil-works/pi-coding-agent @earendil-works/pi-ai` | Expected 0.85.1 direct versions; no invalid dependency relationships.                                   |
| `node --test tests/notifications*.test.js`                     | All new automated tests pass without desktop effects.                                                   |
| `npm test`                                                     | Entire existing and new suite passes.                                                                   |
| `git diff --check`                                             | Exit 0 with no whitespace errors.                                                                       |

Installation is a **local-write** operation authorized only after plan approval and implementation dispatch. No install or dependency update was performed while saving this plan.

**Human desktop acceptance**, on Linux Mint and macOS:

```bash
./node_modules/.bin/pi -e . -e ./tests/fixtures/notifications-prompts.ts
```

Run with exactly one ima-pi copy enabled and notifications permitted by the OS.

Verify:

1. Final settled work produces one generic desktop notification within **three seconds** under normal desktop conditions.
2. Each fixture dialog produces one notification; its nested-dialog case produces one for the outer span.
3. Answering a dialog does not itself generate another notification.
4. A subsequent distinct waiting event notifies again.
5. Opt-out plus reload suppresses all notifications.
6. Startup/reload does not replay prior work.
7. Native sound works where supported and enabled; suppressed sound is recorded accurately.
8. Non-interactive execution remains silent.

Desktop appearance, timing, and sound require human evidence; automated command success alone does not prove delivery. Both platforms must be verified before claiming complete cross-platform acceptance.

### Verification performed for this plan handoff

- During discovery: read-only repository and runtime inspection; `git diff --check` passed. No tests were run before the proposed plan was presented.
- After explicit plan approval, the repository-required existing-suite check ran: `npm test` — **801 tests, 797 passed, 4 skipped, 0 failed** (approximately 26 seconds).
- This is existing-baseline evidence only. The repository still has its original Pi dependency baseline; notification code and its new tests do not exist yet. This run does **not** verify Pi 0.85.1 dependency compatibility or the planned feature.
- No builds, installs, dependency changes, or live desktop-notification acceptance were performed. No implementation phase was dispatched.

## 9. Rollout, rollback, and risks

**Rollout:** document the default-on change and opt-out before release. Require the supported Pi baseline; do not automatically upgrade an operator’s global Pi installation.

**Immediate rollback:** set `{"enable":false}` in the user notification config and reload.

**Code rollback:** revert the feature changes, including manifest and lockfile, together; reinstall the restored dependency graph. No data migration or notification-state cleanup is required.

Residual risks:

- OS notification permissions, Focus/Do Not Disturb, and desktop policies can suppress delivery or sound.
- Pi prompt events are best-effort; unrelated slow extension handlers can affect timing.
- Cancellation cannot retract an already submitted OS notification.
- Dependency-update compatibility remains unverified until implementation tests run.
- Linux executables were located, but neither Linux nor macOS delivery has been exercised in planning.

No unresolved product decision remains. Implementation dispatch and subsequent verification are still required. Unresolved Critical or Warning security findings must go through resolution and rereview before closeout; they are not style-only debt.

## 10. Evidence and lifecycle continuity

Evidence reviewed:

- Serena standard project memories: `core`, `conventions`, `tech_stack`, `suggested_commands`, `task_completion`, and `memory_maintenance`.
- The lifecycle, memory-workflow, FP, JavaScript FP, readability, security, architecture, unit-testing, Pi documentation, and delegation contracts loaded in this session.
- `../../extensions/tts.ts`, `../../lib/ima-tts.ts`, `../../lib/ima-tts-session.ts`, `../../config/tts.json`, TTS test fixtures, `../../tests/discovery.test.js`, package metadata, configuration/docs, and `../spikes/FNR-3008.md`.
- Installed Pi **0.85.1** documentation under `/home/eric/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/`: `docs/extensions.md`, `docs/packages.md`, `docs/sdk.md`, and `docs/tui.md`; `examples/extensions/notify.ts`, `examples/extensions/timed-confirm.ts`, and `examples/sdk/06-extensions.ts`; `dist/core/agent-session.js`, `dist/core/extensions/runner.js`, `dist/core/extensions/types.d.ts`, `dist/core/resource-loader.d.ts`, and `dist/core/exec.js`.
- Repository-local Pi **0.82.1** metadata and extension-event declarations: settlement exists, blocking-prompt events are absent.
- Context7 documentation for `/earendil-works/pi`, checked against installed-version evidence.
- Apple, *Displaying Notifications*: <https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/DisplayNotifications.html>.
- `notify-send` manual: <https://manpages.debian.org/bookworm/libnotify-bin/notify-send.1.en.html>.
- Freedesktop notification hints: <https://specifications.freedesktop.org/notification-spec/latest/hints.html>.
- Read-only specialist mapping: `notification-surface`, explore session `01a072c2-06fe-7426-86a8-1aa7406dbc8b`. No child writes or tests.

### Prior artifacts

Approved requirements:

- `artifactId`: `f0b8dd6b-5f79-5807-b162-a90ae2349e87`
- `recordKey`: `ima-pi:plane:ima:SKYNET-185:decision:f42f71891182`
- `priorArtifactIds`: `["f0b8dd6b-5f79-5807-b162-a90ae2349e87"]`
- `priorArtifactRecordKeys`: `["ima-pi:plane:ima:SKYNET-185:decision:f42f71891182"]`

### Reused lifecycle identity

- `project`: `ima-pi`
- `lifecycleKey`: `ima-pi:plane:ima:SKYNET-185`
- `lifecycleRootMemoryId`: `ima-pi:plane:ima:SKYNET-185`
- `planeWorkspace`: `ima`
- `planeWorkItem`: `SKYNET-185`
- `taskwarriorProject`, `taskwarriorTask`, `taskwarriorUuid`, `jiraKey`: empty strings.
- Canonical source references: `plane:ima:SKYNET-185` and `lifecycle:ima-pi:plane:ima:SKYNET-185`.

The operator’s single-deliverable decision supersedes the requirements artifact’s decomposition recommendation. The operator explicitly approved the Pi baseline update, documented-extension-dialog scope, and then this complete technical plan. The subsequent request explicitly authorizes Qdrant persistence and this Markdown plan copy, not implementation.

### Changed files and phase boundary

The only repository change authorized for the planning handoff is the new `SKYNET-185-notifications-plan.md`. All files in the implementation-surface table remain future work. No code, configuration, dependency, or operator-settings changes are made by this planning phase.

### Recommended next phase

After verified plan persistence, use:

```text
/ima:implement lifecycle:ima-pi:plane:ima:SKYNET-185
```

This is a manual human-gated phase, not an `/ima:cycle` dispatch; no cycle outcome marker applies.

I will not make code changes in this planning session.
