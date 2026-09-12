# Tech Stack

- Node.js >=24, ESM TypeScript extensions loaded directly by Pi, and Markdown prompts/skills/docs.
- Package manager: npm metadata with intentionally minimal dependencies.
- Pi package manifest: root `package.json` `pi` key declares `extensions`, `skills`, and `prompts`.
- Runtime peer: `@earendil-works/pi-coding-agent`; extension schemas should use Pi-bundled packages as documented.
- Tests: Node built-in test runner via `npm test` -> `node --test tests/*.test.js`.
- Serena config: `.serena/project.yml`, project `ima-pi`, TypeScript, UTF-8.
- `ima_context` uses package-owned direct MCP sessions for Serena and explicitly cited Vestige legacy sources; formal lifecycle hydration, `ima_lifecycle`, and `/ima:cycle` reconciliation use the package-native Tier-1 Qdrant corpus with manifest summary recall and verified direct detail reassembly.
- Pi natively loads global AGENTS.md (under PI_CODING_AGENT_DIR when set) for routine user preferences; no package preference loader is needed.
- Local continuation durability: cycle records use `.ima-cycle/agent-sessions.json`; eligible direct/manual records use `.ima-cycle/direct-agent-sessions.json`. These records and adjacent exclusive native lock sidecars are local-only values. Cycle references remain owner-bound; one focused continuation may own a canonical session file at a time. Locks are never stolen automatically; unverified child cleanup retains the lease and blocks retry.