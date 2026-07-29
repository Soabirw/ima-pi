# Core

- Project: `ima-pi`, the Pi-native IMA agent harness and full capability port target for `ima-goose` plus relevant `ima-claude` agent behavior.
- Repository boundary: new independent sibling project; never modify or retire `ima-goose` or `ima-claude` as part of this port.
- Product requirements: Jira epic FNR-3007, release 10170, and Vestige memory `5f27af6e-7a24-4f27-91ca-254892765234`.
- Current task: FNR-3008 proves native package, namespaced command, and resource discovery conventions.
- Pi-native artifact direction: commands/prompts, agents, skills, extensions, policies, and config; preserve outcomes rather than Goose YAML/ETA internals.
- Package resources are declared by root `package.json`; technical-spike evidence lives under `docs/spikes/`.
- Manual phase workflows precede `/ima:cycle`; no generic workflow DSL.