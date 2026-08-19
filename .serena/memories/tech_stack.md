# Tech Stack

- Node.js >=24, ESM TypeScript extensions loaded directly by Pi, and Markdown prompts/skills/docs.
- Package manager: npm metadata with intentionally minimal dependencies.
- Pi package manifest: root `package.json` `pi` key declares `extensions`, `skills`, and `prompts`.
- Runtime peer: `@earendil-works/pi-coding-agent`; extension schemas should use Pi-bundled packages as documented.
- Tests: Node built-in test runner via `npm test` -> `node --test tests/*.test.js`.
- Serena config: `.serena/project.yml`, project `ima-pi`, TypeScript, UTF-8.
- `ima_context` uses package-owned direct MCP sessions for Serena, Vestige, and optional Qdrant work; Jira and Taskwarrior retain their native boundaries, while `/ima:cycle` reconciliation separately retains an `ima-mcp` Vestige search.