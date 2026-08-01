# ima-pi

Pi-native IMA agent harness, packaged through Pi's standard Git/npm package model.

## Current status

Technical spikes are validating Pi-native conventions before the runtime architecture is fixed.

- **FNR-3008** proves package resource discovery, precedence, and namespaced commands.
- **FNR-3009** adds an executable probe for independently routed child agents, bounded non-interactive tool authority, and persisted-session reuse through Pi's SDK. Live evidence currently proves exact cross-provider routing and session reopening; full authority and nonce-continuity acceptance is blocked until OpenAI API credits are restored.
- **FNR-3010** adds a bounded parallel-control spike for concurrent child activity, exact cancellation with partial-effect disclosure, child-scoped destructive-action hooks, and explicit skill-load visibility.
- **FNR-3011** adds a bounded parent/child `ima-mcp` gateway and semantic Vestige lifecycle proof.
- **FNR-3012** adds a bounded dedicated vision-model image-routing and evidence-handoff probe.
- **FNR-3013** adds package homes and explicit, opt-in model-role configuration.
- **FNR-3014** adds bounded first-class agents, the `ima_delegate` production tool, source-aware discovery, and focused session inspection.
- **FNR-3015** adds concise production delegation activity, cancellation/possible-partial-state disclosure, structured stopped-state reports, and visible focused safety interception.
- **FNR-3016** adds Serena-first production context assembly and semantically verified Vestige lifecycle handoffs through external IMA service boundaries.

## Try the package

```bash
pi -e .
```

Then try:

```text
/ima:probe package
/ima:prompt hello
/ima:delegate-probe start <provider>/<model>
/ima:control-probe start <provider>/<model> <provider>/<model>
/ima:gateway-probe <provider>/<model>
/ima:vision-probe <provider>/<model> <absolute-image-path>
```

`/ima:delegate-probe`, `/ima:control-probe`, `/ima:gateway-probe`, and `/ima:vision-probe` are bounded technical-spike entry points, not production orchestration interfaces. The gateway probe performs one intentional semantic Vestige ingestion while Serena and Qdrant remain read-only. The control probe accepts `/ima:control-probe cancel <run-id> <a|b>` after startup; see its spike document for live acceptance steps and limitations.

## Production agents

`ima_delegate` is the model-callable production delegation tool. It accepts one to four complete, agent-defined assignments and fails closed for invalid authority, overlapping writer ownership, unavailable minimum capability, or unsafe reuse. During a run it projects at most five concise activity lines through Pi tool updates and one replaceable TUI widget/status, including phase, child agent, exact model, declared skills, sanitized tool/gateway category, state, elapsed time, retry, and escalation. Terminal results preserve child reports and add structured cancellation, possible-partial-state, blocker, resume-reference, and safe-next-action facts. Safety interception remains the narrow FNR-3014 mechanical ownership boundary; no confirmation loop or permission matrix was added.

Inspect resolved definitions with `/ima:agents`, session metadata with `/ima:agent-sessions`, and request a focused reusable continuation with `/ima:agent-follow-up <session-reference> <brief>`. See [`agents/README.md`](agents/README.md), [`policies/README.md`](policies/README.md), [`docs/foundation/FNR-3014.md`](docs/foundation/FNR-3014.md), and [`docs/foundation/FNR-3015.md`](docs/foundation/FNR-3015.md).

## Production integrations

`ima_context` is a model-callable tool that activates Serena, loads its instructions and standard project memories, then normalizes exactly one Jira, Taskwarrior, project-file, Vestige-memory, or free-text source into a versioned phase context. An optional Qdrant lookup is read-only. `ima_lifecycle` validates a complete lifecycle artifact, saves it only through `ima-mcp vestige save`, and requires a single semantic recall hit before reporting completion.

Both tools call externally installed/configured IMA gateway services; they do not provide service SDKs, mutate Jira or Taskwarrior, index Qdrant, or implement phase commands/cycle automation. Later stories own production phase commands. See [`docs/foundation/FNR-3016.md`](docs/foundation/FNR-3016.md) for contracts, ordering, security boundaries, limitations, and live acceptance.

## Configure model roles

Create `~/.pi/agent/ima/config.json` (or trusted `.pi/ima/config.json`) to opt into a preset:

```json
{
  "schemaVersion": 1,
  "profile": "openai-codex-56"
}
```

See [`config/README.md`](config/README.md) for schema, paths, trust, and precedence, and [`docs/foundation/FNR-3013.md`](docs/foundation/FNR-3013.md) for source-to-target coverage.

## Test

```bash
npm test
```

The default suite is provider-free and makes no paid model requests.

## Spike evidence

- [`docs/spikes/FNR-3008.md`](docs/spikes/FNR-3008.md) — package discovery and precedence
- [`docs/spikes/FNR-3009.md`](docs/spikes/FNR-3009.md) — child routing, authority, and persisted-session reuse
- [`docs/spikes/FNR-3010.md`](docs/spikes/FNR-3010.md) — parallel control, cancellation, narrow safety hooks, and skill observability
- [`docs/spikes/FNR-3011.md`](docs/spikes/FNR-3011.md) — external gateway access and semantic lifecycle verification
- [`docs/spikes/FNR-3012.md`](docs/spikes/FNR-3012.md) — dedicated vision-model routing and evidence handoff
