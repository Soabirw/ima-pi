# Tech Stack

- Node.js >=24, ESM TypeScript extensions loaded directly by Pi, and Markdown prompts/skills/docs.
- Package manager: npm metadata with intentionally minimal dependencies.
- Pi package manifest: root `package.json` `pi` key declares `extensions`, `skills`, and `prompts`.
- Runtime peer: `@earendil-works/pi-coding-agent`; extension schemas should use Pi-bundled packages as documented.
- Tests: Node built-in test runner via `npm test` -> `node --test tests/*.test.js`.
- Serena config: `.serena/project.yml`, project `ima-pi`, TypeScript, UTF-8.
- External integrations remain behind `ima-mcp` or native CLIs: Serena, Vestige, Qdrant, Jira, and Taskwarrior.