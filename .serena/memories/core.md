# Core

- Project: `ima-pi`, the Pi-native IMA agent harness and full capability port target for `ima-goose` plus relevant `ima-claude` agent behavior.
- Repository boundary: new independent sibling project; never modify or retire `ima-goose` or `ima-claude` as part of this port.
- Product requirements: Jira epic FNR-3007, release 10170, and Vestige memory `5f27af6e-7a24-4f27-91ca-254892765234`.
- Stable capability: `/ima:cycle` coordinates one explicit, user-gated Story through `plan -> implement -> test -> review -> resolution/rereview -> document -> close`; it does not auto-progress.
- Pi-native artifact direction: commands/prompts, agents, skills, extensions, policies, and config; preserve outcomes rather than Goose YAML/ETA internals.
- Package resources are declared by root `package.json`; technical-spike evidence lives under `docs/spikes/`.
- Manual phase workflows remain available alongside `/ima:cycle`; neither introduces a generic workflow DSL.
- Release exception: `ima-pi` is a Pi package, not a WordPress or deployable site; its version/tag releases do not require a project `npm run ship-it` script or `ship-it` dry-run. Retain the ordinary Git safeguards for related changes, immutable annotated tags, and remote-ref verification.