# Suggested Commands

- Test package: `cd /home/eric/IMA/dev/ima-pi && npm test`.
- Try local package interactively: `cd /home/eric/IMA/dev/ima-pi && pi -e .`.
- Test a namespaced command non-interactively: `IMA_PI_PROBE_RESULT=/tmp/result.json pi --no-session -e . -p "/ima:probe package"`.
- Verify repository state: `git status --short` and `git diff --check`.
- Search Jira source: `node ~/.agents/skills/mcp-atlassian/scripts/atlassian-api.mjs jira:get <Jira-key>`.
- Retrieve lifecycle evidence through `ima_context` and the pin-aware `ima-lifecycle-contract`: use the public `ima_lifecycle_recall` followed by selected exact `ima_lifecycle_get` pair; it derives checkout-pin-aware authority and uses exact all-phase historical Qdrant authority internally only while genuinely unpinned. `ima_corpus_*` is institutional-only, never lifecycle authority; corpus recall returns manifest summaries only and selected direct corpus get returns complete institutional detail.
- Call `ima_context` once with a validated typed source; the package owns same-connection initialization, exact checkout activation/verification, and standard-memory loading.