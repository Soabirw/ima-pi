import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { convertTools } from "@earendil-works/pi-ai/api/google-shared";
import { Check } from "typebox/value";
import integrations, { coordinateContext, coordinateLifecycle } from "../extensions/integrations.ts";
const identity = { project: "ima-pi", lifecycleKey: "ima-pi:taskwarrior:FNR-3007:uuid", lifecycleRootMemoryId: "root", taskwarriorProject: "FNR-3007", taskwarriorTask: "uuid", taskwarriorUuid: "uuid", jiraKey: "FNR-3016", sourceRefs: ["Taskwarrior:uuid"], priorArtifactIds: ["plan"] };
const artifact = "minimal implementation artifact";
const gateway = (calls) => async (program, args) => {
  calls.push([program, args]);
  const [service, operation, value] = args;

  if (service === "serena" && operation === "project") {
    return { ok: true, command: "serena.project.activate", data: {} };
  }
  if (service === "serena" && operation === "instructions") {
    return { ok: true, command: "serena.instructions", data: {} };
  }
  if (service === "serena" && operation === "memory" && value === "list") {
    return {
      ok: true,
      command: "serena.memory.list",
      data: { memories: ["core", "conventions", "tech_stack", "suggested_commands", "task_completion"] },
    };
  }
  if (service === "serena" && operation === "memory") {
    return { ok: true, command: "serena.memory.read", data: { content: value } };
  }
  if (service === "ima-mcp") throw new Error("unexpected");

  return null;
};

const vestigePattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const invalidVestigeId = "-".repeat(36);

test("context registration advertises the exact provider-compatible request contract", () => {
  const tools = [];
  integrations({ registerTool: (tool) => tools.push(tool) });
  const contextTool = tools.find((tool) => tool.name === "ima_context");
  const lifecycleTool = tools.find((tool) => tool.name === "ima_lifecycle");
  assert.match(String(lifecycleTool.execute), /details: result/);
  const parameters = contextTool.parameters;
  const source = parameters.properties.source;
  const sources = [{ type: "jira", key: "FNR-3016" }, { type: "taskwarrior", project: "FNR-3007", uuid: "689fa7ac-84b7-42d0-8912-b8ef76041370" }, { type: "file", path: "README.md" }, { type: "vestige", id: "7027acec-43d3-4fa4-83ec-16e993551720" }, { type: "text", title: "Brief", content: "Scope" }];
  const requiredFields = [["type", "key"], ["type", "project", "uuid"], ["type", "path"], ["type", "id"], ["type", "title", "content"]];

  assert.equal(parameters.additionalProperties, false);
  assert.equal(source.type, "object");
  assert.equal(source.oneOf.length, sources.length);
  assert.deepEqual(source.oneOf.map((branch) => branch.required), requiredFields);
  assert.deepEqual(source.oneOf.map((branch) => branch.properties.type.enum), [["jira"], ["taskwarrior"], ["file"], ["vestige"], ["text"]]);
  assert.equal(source.oneOf.every((branch) => branch.additionalProperties === false), true);
  assert.equal(source.oneOf[3].properties.id.pattern, vestigePattern);
  assert.equal(Check(parameters, { source: { ...sources[3], id: invalidVestigeId } }), false);
  assert.doesNotMatch(JSON.stringify(source), /"const"/);
  assert.deepEqual(parameters.properties.durableKnowledge.required, ["query"]);
  for (const value of sources) assert.equal(Check(parameters, { source: value }), true);
  assert.equal(Check(parameters, { source: sources[0], durableKnowledge: { query: "FNR-3016", collection: "ima", limit: 5 } }), true);

  for (const [index, value] of sources.entries()) {
    for (const required of requiredFields[index]) assert.equal(Check(parameters, { source: Object.fromEntries(Object.entries(value).filter(([key]) => key !== required)) }), false);
    for (const foreign of sources.flatMap((other) => Object.entries(other).filter(([key]) => key !== "type" && !(key in value)))) assert.equal(Check(parameters, { source: { ...value, [foreign[0]]: foreign[1] } }), false);
    assert.equal(Check(parameters, { source: { ...value, unexpected: true } }), false);
  }
  for (const request of [
    { source: "https://flccc.atlassian.net/browse/FNR-3016" },
    { source: { type: "shell", command: "pwd" } },
    { source: sources[0], durableKnowledge: { required: true, correlationKeys: ["FNR-3016"], sources: ["serena", "vestige"] } },
  ]) assert.equal(Check(parameters, request), false);

  for (const legacy of [false, true]) {
    const declaration = convertTools([contextTool], legacy)[0].functionDeclarations[0];
    const serialized = declaration[legacy ? "parameters" : "parametersJsonSchema"];
    assert.equal(serialized.properties.source.oneOf.length, sources.length);
    assert.deepEqual(serialized.properties.source.oneOf.map((branch) => branch.properties.type.enum), [["jira"], ["taskwarrior"], ["file"], ["vestige"], ["text"]]);
    assert.equal(serialized.properties.source.oneOf[3].properties.id.pattern, vestigePattern);
    assert.doesNotMatch(JSON.stringify(serialized), /"const"/);
  }

  const marker = "fake-context-token=do-not-echo";
  const prepared = contextTool.prepareArguments({ source: { type: "jira", key: marker, path: "README.md" } });
  assert.deepEqual(prepared, { source: { type: "invalid_context_request" } });
  assert.doesNotMatch(JSON.stringify(prepared), /fake-context-token=do-not-echo/);
  assert.throws(() => validateToolArguments(contextTool, { name: contextTool.name, arguments: prepared }), (error) => {
    assert.match(String(error), /Validation failed for tool "ima_context"/);
    assert.doesNotMatch(String(error), /fake-context-token=do-not-echo/);
    return true;
  });
  const preparedVestige = contextTool.prepareArguments({ source: { type: "vestige", id: invalidVestigeId } });
  assert.deepEqual(preparedVestige, { source: { type: "invalid_context_request" } });
  assert.doesNotMatch(JSON.stringify(preparedVestige), new RegExp(invalidVestigeId));
  assert.throws(() => validateToolArguments(contextTool, { name: contextTool.name, arguments: preparedVestige }), (error) => {
    assert.doesNotMatch(String(error), new RegExp(invalidVestigeId));
    return true;
  });
});

test("invalid context requests do not enter external boundaries", async () => {
  const calls = [];
  const marker = "fake-context-token=do-not-echo";
  const result = await coordinateContext({ source: { type: "jira", key: marker, path: "README.md" } }, "/repo", { run: async (...args) => { calls.push(args); return null; }, canonical: async (...args) => { calls.push(args); return "/repo"; } });
  assert.equal(result.status, "failed");
  assert.deepEqual(calls, []);
  assert.doesNotMatch(JSON.stringify(result), /fake-context-token=do-not-echo/);
});

test("invalid Vestige UUID requests do not enter external boundaries", async () => {
  const calls = [];
  const result = await coordinateContext({ source: { type: "vestige", id: invalidVestigeId } }, "/repo", { run: async (...args) => { calls.push(args); return null; }, canonical: async (...args) => { calls.push(args); return "/repo"; } });
  assert.equal(result.status, "failed");
  assert.deepEqual(calls, []);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(invalidVestigeId));
});

test("successful file hydration redacts returned path metadata", async () => {
  const calls = [];
  const result = await coordinateContext(
    { source: { type: "file", path: "fixtures/token=demo-value" } },
    "/repo",
    {
      run: gateway(calls),
      canonical: async (path) => path,
      stat: async () => ({ isFile: () => true, size: 14 }),
      read: async () => "File contents",
    },
  );
  assert.equal(result.status, "ready");
  assert.deepEqual(result.source, { type: "file", key: "fixtures/[redacted]", title: "fixtures/[redacted]", content: "File contents", references: ["File:fixtures/[redacted]"] });
  assert.doesNotMatch(JSON.stringify(result.source), /demo-value/);
});

test("Jira hydration uses helper descriptionText and preserves summary fallback", async () => {
  const cases = [
    { issue: { key: "FNR-3016", summary: "Issue summary", descriptionText: "  Authoritative issue body  " }, expected: "Authoritative issue body" },
    { issue: { key: "FNR-3016", summary: " Issue summary " }, expected: "Issue summary" },
    { issue: { key: "FNR-3016", summary: " Issue summary ", descriptionText: "   " }, expected: "Issue summary" },
    { issue: { key: "FNR-3016", summary: " Issue summary ", descriptionText: 42 }, expected: "Issue summary" },
  ];
  for (const { issue, expected } of cases) {
    const calls = [];
    const run = async (program, args) => {
      if (program === "node") {
        calls.push([program, args]);
        return issue;
      }
      return gateway(calls)(program, args);
    };
    const result = await coordinateContext(
      { source: { type: "jira", key: issue.key } },
      "/repo",
      { run, canonical: async (path) => path, home: () => "/home/test" },
    );
    assert.equal(result.status, "ready");
    assert.deepEqual(result.source, {
      type: "jira",
      key: "FNR-3016",
      title: "Issue summary",
      content: expected,
      references: ["Jira:FNR-3016", "https://flccc.atlassian.net/browse/FNR-3016"],
    });
    assert.deepEqual(calls.slice(0, 3).map(([, args]) => args.slice(0, 3)), [
      ["serena", "project", "activate"],
      ["serena", "instructions", "--json"],
      ["serena", "memory", "list"],
    ]);
    const nodeCall = calls.find(([program]) => program === "node");
    assert.deepEqual(nodeCall, ["node", ["/home/test/.agents/skills/mcp-atlassian/scripts/atlassian-api.mjs", "jira:get", "FNR-3016"]]);
    assert.equal(calls.indexOf(nodeCall), 8);
  }
});

test("context performs Serena before text hydration and reads every listed memory", async () => { const calls = []; const result = await coordinateContext({ source: { type: "text", title: "Brief", content: "Scope" } }, "/repo", { run: gateway(calls), canonical: async (path) => path }); assert.equal(result.status, "ready"); assert.deepEqual(calls.slice(0, 3).map(([, args]) => args.slice(0, 3)), [["serena", "project", "activate"], ["serena", "instructions", "--json"], ["serena", "memory", "list"]]); assert.equal(calls.filter(([, args]) => args[0] === "serena" && args[2] !== "list").length, 7); });
test("blocking Serena failure prevents source calls", async () => { const calls = []; const result = await coordinateContext({ source: { type: "text", title: "Brief", content: "Scope" } }, "/repo", { run: async (p, a) => { calls.push([p, a]); return null; }, canonical: async (path) => path }); assert.equal(result.status, "failed"); assert.equal(calls.length, 1); });
test("context applies the requested durable knowledge limit", async () => {
  const run = async (program, args) => args[0] === "qdrant"
    ? { ok: true, command: "qdrant.find", data: { results: [{ summary: "one" }, { summary: "two" }, { summary: "three" }] } }
    : gateway([])(program, args);
  const result = await coordinateContext({ source: { type: "text", title: "Brief", content: "Scope" }, durableKnowledge: { query: "evidence", limit: 2 } }, "/repo", { run, canonical: async (path) => path });
  assert.equal(result.status, "ready");
  assert.deepEqual(result.durableKnowledge.references.map(({ summary }) => summary), ["one", "two"]);
});
test("context redacts assignment-like secrets from durable knowledge", async () => {
  const run = async (program, args) => args[0] === "qdrant"
    ? { ok: true, command: "qdrant.find", data: { results: [{ summary: "token=secret-value" }, { content: "password=hidden" }] } }
    : gateway([])(program, args);
  const result = await coordinateContext({ source: { type: "text", title: "Brief", content: "Scope" }, durableKnowledge: { query: "evidence" } }, "/repo", { run, canonical: async (path) => path });
  assert.deepEqual(result.durableKnowledge.references.map(({ summary }) => summary), ["[redacted]", "[redacted]"]);
});
test("context exposes only known source error codes", async () => {
  const dependencies = { run: gateway([]), canonical: async (path) => { if (path === "/repo") return path; throw new Error("Authorization: Bearer abc123"); } };
  const unknown = await coordinateContext({ source: { type: "file", path: "missing" } }, "/repo", dependencies);
  assert.equal(unknown.diagnostics[0].code, "source_boundary_unavailable");
  assert.doesNotMatch(JSON.stringify(unknown), /abc123/);
  const known = await coordinateContext({ source: { type: "file", path: "../outside" } }, "/repo", { run: gateway([]), canonical: async (path) => path });
  assert.equal(known.diagnostics[0].code, "source_path_outside_project");
});
test("lifecycle persists through direct Vestige MCP and verifies the nonce", async () => {
  const vestigeCalls = [];
  const runCalls = [];
  const result = await coordinateLifecycle(
    { type: "implementation", identity, artifact },
    {
      run: async (...args) => {
        runCalls.push(args);
        return null;
      },
      vestige: async (tool, args) => {
        vestigeCalls.push([tool, args]);
        if (tool === "smart_ingest") {
          return { isError: false, structuredContent: { id: "receipt" } };
        }

        const nonce = String(args.query).split(" ")[1];
        return {
          isError: false,
          structuredContent: {
            results: [{
              content: `${identity.lifecycleKey} ${nonce} phase=implementation; ${identity.jiraKey} ${identity.taskwarriorUuid} outcome=completed`,
            }],
          },
        };
      },
    },
  );

  const [ingestTool, ingestArgs] = vestigeCalls[0];
  const [recallTool, recallArgs] = vestigeCalls[1];
  assert.equal(result.status, "completed");
  assert.equal(result.artifactId, "receipt");
  assert.deepEqual(vestigeCalls.map(([tool]) => tool), ["smart_ingest", "recall"]);
  assert.equal(ingestTool, "smart_ingest");
  assert.equal(ingestArgs.forceCreate, true);
  assert.equal(ingestArgs.node_type, "decision");
  assert.equal(ingestArgs.source, identity.lifecycleKey);
  assert.deepEqual(ingestArgs.tags, [identity.project, "lifecycle", "implementation"]);
  assert.equal(recallTool, "recall");
  assert.equal(recallArgs.mode, "lookup");
  assert.equal(recallArgs.limit, 10);
  assert.match(ingestArgs.content, new RegExp(String(recallArgs.query).split(" ")[1]));
  assert.deepEqual(runCalls, []);
});

test("lifecycle rejects malformed identity arrays before Vestige I/O", async () => {
  const vestigeCalls = [];
  const result = await coordinateLifecycle(
    {
      type: "implementation",
      identity: { ...identity, sourceRefs: [null] },
      artifact,
    },
    {
      vestige: async (...args) => {
        vestigeCalls.push(args);
        return null;
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "invalid_lifecycle_request");
  assert.deepEqual(vestigeCalls, []);
});

test("lifecycle reports a direct Vestige save failure", async () => {
  const result = await coordinateLifecycle(
    { type: "implementation", identity, artifact },
    { vestige: async () => null },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "vestige_save_failed");
});

test("lifecycle sanitizes a thrown direct Vestige save failure", async () => {
  const result = await coordinateLifecycle(
    { type: "implementation", identity, artifact },
    { vestige: async () => { throw new Error("Authorization: Bearer abc123"); } },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "vestige_save_failed");
  assert.doesNotMatch(JSON.stringify(result), /abc123/);
});

test("lifecycle rejects an invalid direct Vestige receipt", async () => {
  const result = await coordinateLifecycle(
    { type: "implementation", identity, artifact },
    { vestige: async () => ({ isError: true, content: [] }) },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "vestige_receipt_invalid");
});

test("lifecycle rejects an explicitly negative direct receipt without recall", async () => {
  const calls = [];
  const secret = "token=negative-receipt-secret";
  const result = await coordinateLifecycle(
    { type: "implementation", identity, artifact },
    {
      vestige: async (tool) => {
        calls.push(tool);
        return {
          isError: false,
          content: [{ type: "text", text: JSON.stringify({ success: false, message: secret }) }],
        };
      },
    },
  );

  assert.deepEqual(calls, ["smart_ingest"]);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "vestige_receipt_invalid");
  assert.doesNotMatch(JSON.stringify(result), /negative-receipt-secret/);
});

test("lifecycle rejects text-only receipts without recall", async () => {
  const receipts = [
    "artifact could not be stored",
    "artifact wasn't stored",
    "artifact was not only stored successfully, but also indexed",
  ];

  for (const [index, receipt] of receipts.entries()) {
    const calls = [];
    const secret = `token=text-receipt-secret-${index}`;
    const result = await coordinateLifecycle(
      { type: "implementation", identity, artifact },
      {
        vestige: async (tool) => {
          calls.push(tool);
          return {
            isError: false,
            content: [{ type: "text", text: `${receipt} ${secret}` }],
          };
        },
      },
    );

    assert.deepEqual(calls, ["smart_ingest"]);
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "vestige_receipt_invalid");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  }
});

test("lifecycle rejects an unrelated receipt UUID without recall", async () => {
  const calls = [];
  const unrelatedUuid = "abcdefab-cdef-abcd-efab-cdefabcdefab";
  const result = await coordinateLifecycle(
    { type: "implementation", identity, artifact },
    {
      vestige: async (tool) => {
        calls.push(tool);
        return { isError: false, content: [{ type: "text", text: `reference ${unrelatedUuid}` }] };
      },
    },
  );

  assert.deepEqual(calls, ["smart_ingest"]);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "vestige_receipt_invalid");
  assert.equal(result.artifactId, null);
});

test("lifecycle rejects a direct Vestige recall without the nonce match", async () => {
  const result = await coordinateLifecycle(
    { type: "implementation", identity, artifact },
    {
      vestige: async (tool) => tool === "smart_ingest"
        ? { isError: false, structuredContent: { id: "receipt" } }
        : { isError: false, structuredContent: { results: [] } },
    },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "vestige_semantic_completion_unverified");
});

test("lifecycle rejects an error-marked direct Vestige recall", async () => {
  const calls = [];
  const secret = "token=error-recall-secret";
  const result = await coordinateLifecycle(
    { type: "implementation", identity, artifact },
    {
      vestige: async (tool, args) => {
        calls.push(tool);
        if (tool === "smart_ingest") {
          return { isError: false, structuredContent: { id: "receipt" } };
        }

        const nonce = String(args.query).split(" ")[1];
        return {
          isError: true,
          content: [{ type: "text", text: secret }],
          structuredContent: {
            results: [{
              content: `${identity.lifecycleKey} ${nonce} implementation ${identity.jiraKey} ${identity.taskwarriorUuid} outcome=completed`,
            }],
          },
        };
      },
    },
  );

  assert.deepEqual(calls, ["smart_ingest", "recall"]);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "vestige_recall_failed");
  assert.doesNotMatch(JSON.stringify(result), /error-recall-secret/);
});

test("lifecycle reports an unavailable direct Vestige recall", async () => {
  const result = await coordinateLifecycle(
    { type: "implementation", identity, artifact },
    {
      vestige: async (tool) => tool === "smart_ingest"
        ? { isError: false, structuredContent: { id: "receipt" } }
        : null,
    },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "vestige_recall_failed");
});

test("lifecycle sanitizes a thrown direct Vestige recall failure", async () => {
  const result = await coordinateLifecycle(
    { type: "implementation", identity, artifact },
    {
      vestige: async (tool) => {
        if (tool === "smart_ingest") {
          return { isError: false, structuredContent: { id: "receipt" } };
        }
        throw new Error("token=def456");
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "vestige_recall_failed");
  assert.doesNotMatch(JSON.stringify(result), /def456/);
});

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
