# Suggested Commands

- Test package: `cd /home/eric/IMA/dev/ima-pi && npm test`.
- Try local package interactively: `cd /home/eric/IMA/dev/ima-pi && pi -e .`.
- Test a namespaced command non-interactively: `IMA_PI_PROBE_RESULT=/tmp/result.json pi --no-session -e . -p "/ima:probe package"`.
- Verify repository state: `git status --short` and `git diff --check`.
- Search Jira source: `node ~/.agents/skills/mcp-atlassian/scripts/atlassian-api.mjs jira:get <Jira-key>`.
- Retrieve lifecycle evidence through `ima_context` and the pin-aware `ima-lifecycle-contract`. Use package-native `ima_corpus_recall`/`ima_corpus_get` only for institutional knowledge or the exact unpinned historical-Qdrant authority check; recall returns manifest summaries only and selected direct get returns complete detail.
- Activate Serena explicitly: call the package MCP adapter's `serena_activate_project` tool with `{ project: "/home/eric/IMA/dev/ima-pi" }`.