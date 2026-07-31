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
