# Suggested Commands

- Test package: `cd /home/eric/IMA/dev/ima-pi && npm test`.
- Try local package interactively: `cd /home/eric/IMA/dev/ima-pi && pi -e .`.
- Test a namespaced command non-interactively: `IMA_PI_PROBE_RESULT=/tmp/result.json pi --no-session -e . -p "/ima:probe package"`.
- Verify repository state: `git status --short` and `git diff --check`.
- Search Jira source: `node ~/.agents/skills/mcp-atlassian/scripts/atlassian-api.mjs jira:get <Jira-key>`.
- Search lifecycle memory: call package-native `ima_corpus_recall` with `{ lifecycleKey: "<exact-lifecycle-key>", limit: 10 }`; it returns manifest summaries only. Call `ima_corpus_get` with a selected deterministic `recordKey` only when complete detail is needed.
- Activate Serena explicitly: call the package MCP adapter's `serena_activate_project` tool with `{ project: "/home/eric/IMA/dev/ima-pi" }`.