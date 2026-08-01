import assert from "node:assert/strict";
import test from "node:test";
import { coordinateContext, coordinateLifecycle } from "../extensions/integrations.ts";
const identity = { project: "ima-pi", lifecycleKey: "ima-pi:taskwarrior:FNR-3007:uuid", lifecycleRootMemoryId: "root", taskwarriorProject: "FNR-3007", taskwarriorTask: "uuid", taskwarriorUuid: "uuid", jiraKey: "FNR-3016", sourceRefs: ["Taskwarrior:uuid"], priorArtifactIds: ["plan"] };
const artifact = "# Source and approved outcome\n## Scope\n## Non-goals\n## Phase result\n## Changed files\n## Decisions\n## Verification commands/results\n## Blockers\n## Residual risk\n## Prior artifacts\n## Recommended next phase";
const gateway = (calls, recall = true) => async (program, args) => { calls.push([program, args]); const [service, operation, value] = args; if (service === "serena" && operation === "project") return { ok: true, command: "serena.project.activate", data: {} }; if (service === "serena" && operation === "instructions") return { ok: true, command: "serena.instructions", data: {} }; if (service === "serena" && operation === "memory" && value === "list") return { ok: true, command: "serena.memory.list", data: { memories: ["core", "conventions", "tech_stack", "suggested_commands", "task_completion"] } }; if (service === "serena" && operation === "memory") return { ok: true, command: "serena.memory.read", data: { content: value } }; if (service === "ima-mcp") throw new Error("unexpected"); if (program === "ima-mcp" && service === "vestige" && operation === "save") return { ok: true, command: "vestige.save", data: { stored: true, type: args[3], id: "receipt" } }; if (program === "ima-mcp" && service === "vestige" && operation === "search") return { ok: true, command: "vestige.search", data: { results: recall ? [{ content: `${args[2]} ${args[3] ?? ""} implementation FNR-3016 uuid outcome completed` }] : [] } }; return null; };
test("context performs Serena before text hydration and reads every listed memory", async () => { const calls = []; const result = await coordinateContext({ source: { type: "text", title: "Brief", content: "Scope" } }, "/repo", { run: gateway(calls), canonical: async (path) => path }); assert.equal(result.status, "ready"); assert.deepEqual(calls.slice(0, 3).map(([, args]) => args.slice(0, 3)), [["serena", "project", "activate"], ["serena", "instructions", "--json"], ["serena", "memory", "list"]]); assert.equal(calls.filter(([, args]) => args[0] === "serena" && args[2] !== "list").length, 7); });
test("blocking Serena failure prevents source calls", async () => { const calls = []; const result = await coordinateContext({ source: { type: "text", title: "Brief", content: "Scope" } }, "/repo", { run: async (p, a) => { calls.push([p, a]); return null; }, canonical: async (path) => path }); assert.equal(result.status, "failed"); assert.equal(calls.length, 1); });
test("lifecycle saves once, then searches and cleans generated artifact", async () => { const calls = []; const writes = []; const removed = []; const result = await coordinateLifecycle({ type: "implementation", identity, artifact }, { run: async (program, args) => { calls.push([program, args]); if (args[1] === "save") return { ok: true, command: "vestige.save", data: { stored: true, type: "implementation", id: "receipt" } }; const query = args[2]; const nonce = query.split(" ")[1]; return { ok: true, command: "vestige.search", data: { results: [{ content: `${identity.lifecycleKey} ${nonce} implementation FNR-3016 outcome completed` }] } }; }, temp: async () => "/tmp/ima-test", write: async (path, value) => { writes.push([path, value]); }, remove: async (path) => { removed.push(path); } }); assert.equal(result.status, "completed"); assert.equal(calls.filter(([, args]) => args[1] === "save").length, 1); assert.equal(calls.filter(([, args]) => args[1] === "search").length, 1); assert.equal(writes.length, 1); assert.equal(removed.length, 1); });

test("Taskwarrior source accepts exactly one matching read-only export", async () => { const calls = []; const run = async (program, args) => { calls.push([program, args]); if (program === "task") return [{ uuid: "689fa7ac-84b7-42d0-8912-b8ef76041370", project: "FNR-3007", description: "Integrate", status: "pending" }]; return gateway(calls)(program, args); }; const result = await coordinateContext({ source: { type: "taskwarrior", project: "FNR-3007", uuid: "689fa7ac-84b7-42d0-8912-b8ef76041370" } }, "/repo", { run, canonical: async (path) => path }); assert.equal(result.status, "ready"); assert.deepEqual(calls.find(([program]) => program === "task")[1], ["rc.verbose=nothing", "project:FNR-3007", "689fa7ac-84b7-42d0-8912-b8ef76041370", "export"]); });

test("Taskwarrior source fails closed unless export contains exactly one matching task", async () => {
  const matching = { uuid: "689fa7ac-84b7-42d0-8912-b8ef76041370", project: "FNR-3007", description: "Integrate", status: "pending" };
  const cases = [
    [],
    [{ ...matching, project: "OTHER" }],
    [{ ...matching, uuid: "other" }],
    [matching, { ...matching }],
  ];
  for (const tasks of cases) {
    const result = await coordinateContext(
      { source: { type: "taskwarrior", project: "FNR-3007", uuid: "689fa7ac-84b7-42d0-8912-b8ef76041370" } },
      "/repo",
      { run: async (program, args) => program === "task" ? tasks : gateway([])(program, args), canonical: async (path) => path },
    );
    assert.equal(result.status, "failed");
    assert.equal(result.source, null);
  }
});

test("lifecycle reports temporary cleanup failure after otherwise verified persistence", async () => {
  const result = await coordinateLifecycle(
    { type: "implementation", identity, artifact },
    {
      run: async (_program, args) => args[1] === "save"
        ? { ok: true, command: "vestige.save", data: { stored: true, type: "implementation", id: "receipt" } }
        : { ok: true, command: "vestige.search", data: { results: [{ content: `${identity.lifecycleKey} ${args[2].split(" ")[1]} implementation FNR-3016 outcome completed` }] } },
      temp: async () => "/tmp/ima-test",
      write: async () => {},
      remove: async () => { throw new Error("cleanup failed"); },
    },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "temporary_cleanup_failed");
});
