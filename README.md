# ima-pi

Pi-native IMA agent harness, packaged through Pi's standard Git/npm package model.

## Current status

Technical spikes are validating Pi-native conventions before the runtime architecture is fixed. The first spike proves package resource discovery and namespaced commands.

## Try the package

```bash
pi -e .
```

Then type `/ima:probe` or `/ima:prompt hello`.

## Test

```bash
npm test
```

See [`docs/spikes/FNR-3008.md`](docs/spikes/FNR-3008.md) for discovery evidence and precedence rules.
