# Suggested Commands

- Test package: `cd /home/eric/IMA/dev/ima-pi && npm test`.
- Try local package interactively: `cd /home/eric/IMA/dev/ima-pi && pi -e .`.
- Test a namespaced command non-interactively: `IMA_PI_PROBE_RESULT=/tmp/result.json pi --no-session -e . -p "/ima:probe package"`.
- Verify repository state: `git status --short` and `git diff --check`.
- Search Jira source: `node ~/.agents/skills/mcp-atlassian/scripts/atlassian-api.mjs jira:get FNR-3008`.
- Search lifecycle memory: `ima-mcp vestige search "FNR-3008" --timeout-ms 300000 --json`.
- Activate Serena explicitly: `ima-mcp serena project activate /home/eric/IMA/dev/ima-pi --json`; pass `--project /home/eric/IMA/dev/ima-pi` to follow-up calls when cwd is elsewhere.