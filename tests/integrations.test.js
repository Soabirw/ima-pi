import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { convertTools } from "@earendil-works/pi-ai/api/google-shared";
import { Check } from "typebox/value";
import integrations, { coordinateContext, coordinateLifecycle, recallVestige } from "../extensions/integrations.ts";
import { LIFECYCLE_ARTIFACT_MAXIMUM, parseQdrantResults } from "../lib/ima-context.ts";
import { buildLifecycleArtifact } from "../lib/ima-lifecycle.ts";
const identity = { project: "ima-pi", lifecycleKey: "ima-pi:taskwarrior:FNR-3007:uuid", lifecycleRootMemoryId: "root", taskwarriorProject: "FNR-3007", taskwarriorTask: "uuid", taskwarriorUuid: "uuid", jiraKey: "FNR-3016", sourceRefs: ["Taskwarrior:uuid"], priorArtifactIds: ["plan"] };
const artifact = "minimal implementation artifact";
const STANDARD_MEMORY_NAMES = ["core", "conventions", "tech_stack", "suggested_commands", "task_completion"];
const directResult = (result) => ({ isError: false, structuredContent: { result } });
const defaultSessionResponse = (server, name, arguments_) => {
  if (server !== "serena") return null;
  if (name === "activate_project") return directResult("activated");
  if (name === "initial_instructions") return directResult("instructions");
  if (name === "list_memories") return directResult(JSON.stringify({ memories: STANDARD_MEMORY_NAMES }));
  if (name === "read_memory") return directResult(arguments_.memory_name);
  return null;
};
const createSessionGateway = (responseFor = defaultSessionResponse) => {
  const sessions = [];
  const calls = [];
  const signals = [];
  return {
    sessions,
    calls,
    signals,
    session: async (server, callback, signal) => {
      sessions.push(server);
      signals.push(signal);
      return callback(async (name, arguments_) => {
        calls.push([server, name, arguments_]);
        return responseFor(server, name, arguments_);
      });
    },
  };
};
const runGateway = (calls) => async (program, args) => {
  calls.push([program, args]);
  return null;
};

const vestigePattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const invalidVestigeId = "-".repeat(36);

test("recallVestige discovers IDs then reads bounded exact memories", async () => {
  const artifactId = "aac9ae23-432d-4144-a9e6-4bb49457d03a";
  const calls = [];
  const result = await recallVestige("lifecycle-key implementation", async (server, callback) => callback(
    async (tool, args, timeout) => {
      calls.push({ server, tool, args, timeout });
      return tool === "recall"
        ? { isError: false, structuredContent: { results: [{ id: artifactId }] } }
        : {
          isError: false,
          structuredContent: {
            action: "get",
            found: true,
            node: { id: artifactId, content: "bounded artifact" },
          },
        };
    },
  ));

  assert.deepEqual(result, {
    isError: false,
    structuredContent: { results: [{ id: artifactId, content: "bounded artifact" }] },
  });
  assert.deepEqual(calls, [
    {
      server: "vestige",
      tool: "recall",
      args: {
        query: "lifecycle-key implementation",
        mode: "lookup",
        retrieval_mode: "precise",
        detail_level: "brief",
        concrete: false,
        limit: 10,
        token_budget: 1_000,
      },
      timeout: 300_000,
    },
    {
      server: "vestige",
      tool: "memory",
      args: { action: "get", id: artifactId },
      timeout: 300_000,
    },
  ]);
  assert.equal(await recallVestige("key", async () => { throw new Error("token=hidden"); }), null);
});

test("context registration advertises the exact provider-compatible request contract", () => {
  const tools = [];
  integrations({ registerTool: (tool) => tools.push(tool) });
  const contextTool = tools.find((tool) => tool.name === "ima_context");
  const lifecycleTool = tools.find((tool) => tool.name === "ima_lifecycle");
  assert.match(String(lifecycleTool.execute), /details: result/);
  assert.match(String(lifecycleTool.execute), /coordinateLifecycle\(request, undefined, signal\)/);
  assert.match(String(contextTool.execute), /coordinateContext\(request, ctx\.cwd, undefined, signal\)/);
  const parameters = contextTool.parameters;
  const source = parameters.properties.source;
  const sources = [{ type: "jira", key: "FNR-3016" }, { type: "taskwarrior", project: "FNR-3007", uuid: "689fa7ac-84b7-42d0-8912-b8ef76041370" }, { type: "file", path: "README.md" }, { type: "vestige", id: "7027acec-43d3-4fa4-83ec-16e993551720" }, { type: "lifecycle", key: "ima-pi:adhoc:lifecycle-source-identifiers:2026-08-04" }, { type: "reference", value: "jira:FNR-3016" }, { type: "text", title: "Brief", content: "Scope" }];
  const requiredFields = [["type", "key"], ["type", "project", "uuid"], ["type", "path"], ["type", "id"], ["type", "key"], ["type", "value"], ["type", "title", "content"]];

  assert.equal(parameters.additionalProperties, false);
  assert.equal(source.type, "object");
  assert.equal(source.oneOf.length, sources.length);
  assert.deepEqual(source.oneOf.map((branch) => branch.required), requiredFields);
  assert.deepEqual(source.oneOf.map((branch) => branch.properties.type.enum), [["jira"], ["taskwarrior"], ["file"], ["vestige"], ["lifecycle"], ["reference"], ["text"]]);
  assert.equal(source.oneOf.every((branch) => branch.additionalProperties === false), true);
  assert.equal(source.oneOf[3].properties.id.pattern, vestigePattern);
  assert.equal(source.oneOf[4].properties.key.maxLength, 512);
  assert.equal(source.oneOf[5].properties.value.maxLength, 1_024);
  assert.equal(Check(parameters, { source: { ...sources[3], id: invalidVestigeId } }), false);
  assert.doesNotMatch(JSON.stringify(source), /"const"/);
  assert.deepEqual(parameters.properties.durableKnowledge.required, ["query"]);
  for (const value of sources) assert.equal(Check(parameters, { source: value }), true);
  assert.equal(Check(parameters, { source: sources[0], durableKnowledge: { query: "FNR-3016", collection: "ima", limit: 5 } }), true);
  assert.deepEqual(contextTool.prepareArguments({ source: sources[5] }), { source: sources[0] });

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
    assert.deepEqual(serialized.properties.source.oneOf.map((branch) => branch.properties.type.enum), [["jira"], ["taskwarrior"], ["file"], ["vestige"], ["lifecycle"], ["reference"], ["text"]]);
    assert.equal(serialized.properties.source.oneOf[3].properties.id.pattern, vestigePattern);
    assert.equal(serialized.properties.source.oneOf[4].properties.key.maxLength, 512);
    assert.equal(serialized.properties.source.oneOf[5].properties.value.maxLength, 1_024);
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
  const mcp = createSessionGateway();
  const marker = "fake-context-token=do-not-echo";
  const result = await coordinateContext(
    { source: { type: "jira", key: marker, path: "README.md" } },
    "/repo",
    {
      run: async (...args) => {
        calls.push(args);
        return null;
      },
      canonical: async (...args) => {
        calls.push(args);
        return "/repo";
      },
      session: mcp.session,
    },
  );
  assert.equal(result.status, "failed");
  assert.deepEqual(calls, []);
  assert.deepEqual(mcp.calls, []);
  assert.doesNotMatch(JSON.stringify(result), /fake-context-token=do-not-echo/);
});

test("invalid Vestige UUID requests do not enter external boundaries", async () => {
  const calls = [];
  const mcp = createSessionGateway();
  const result = await coordinateContext(
    { source: { type: "vestige", id: invalidVestigeId } },
    "/repo",
    {
      run: async (...args) => {
        calls.push(args);
        return null;
      },
      canonical: async (...args) => {
        calls.push(args);
        return "/repo";
      },
      session: mcp.session,
    },
  );
  assert.equal(result.status, "failed");
  assert.deepEqual(calls, []);
  assert.deepEqual(mcp.calls, []);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(invalidVestigeId));
});

test("successful file hydration redacts returned path metadata", async () => {
  const runCalls = [];
  const mcp = createSessionGateway();
  const result = await coordinateContext(
    { source: { type: "file", path: "fixtures/token=demo-value" } },
    "/repo",
    {
      run: runGateway(runCalls),
      canonical: async (path) => path,
      stat: async () => ({ isFile: () => true, size: 14 }),
      read: async () => "File contents",
      session: mcp.session,
    },
  );
  assert.equal(result.status, "ready");
  assert.deepEqual(result.source, { type: "file", key: "fixtures/[redacted]", title: "fixtures/[redacted]", content: "File contents", references: ["File:fixtures/[redacted]"] });
  assert.doesNotMatch(JSON.stringify(result.source), /demo-value/);
  assert.deepEqual(runCalls, []);
});

test("Jira hydration uses helper descriptionText and preserves summary fallback", async () => {
  const cases = [
    { issue: { key: "FNR-3016", summary: "Issue summary", descriptionText: "  Authoritative issue body  " }, expected: "Authoritative issue body" },
    { issue: { key: "FNR-3016", summary: " Issue summary " }, expected: "Issue summary" },
    { issue: { key: "FNR-3016", summary: " Issue summary ", descriptionText: "   " }, expected: "Issue summary" },
    { issue: { key: "FNR-3016", summary: " Issue summary ", descriptionText: 42 }, expected: "Issue summary" },
  ];
  for (const { issue, expected } of cases) {
    const runCalls = [];
    const mcp = createSessionGateway();
    const run = async (program, args) => {
      if (program === "node") {
        runCalls.push([program, args]);
        return issue;
      }
      return runGateway(runCalls)(program, args);
    };
    const result = await coordinateContext(
      { source: { type: "jira", key: issue.key } },
      "/repo",
      {
        run,
        canonical: async (path) => path,
        home: () => "/home/test",
        session: mcp.session,
      },
    );
    assert.equal(result.status, "ready");
    assert.deepEqual(result.source, {
      type: "jira",
      key: "FNR-3016",
      title: "Issue summary",
      content: expected,
      references: ["Jira:FNR-3016", "https://flccc.atlassian.net/browse/FNR-3016"],
    });
    assert.deepEqual(mcp.sessions, ["serena"]);
    assert.deepEqual(mcp.calls.slice(0, 3), [
      ["serena", "activate_project", { project: "/repo" }],
      ["serena", "initial_instructions", {}],
      ["serena", "list_memories", {}],
    ]);
    assert.equal(mcp.calls.length, 8);
    assert.deepEqual(runCalls, [["node", ["/home/test/.agents/skills/mcp-atlassian/scripts/atlassian-api.mjs", "jira:get", "FNR-3016"]]]);
  }
});

test("context uses one ordered Serena direct-MCP session before source hydration", async () => {
  const mcp = createSessionGateway();
  const runCalls = [];
  const result = await coordinateContext(
    { source: { type: "text", title: "Brief", content: "Scope" } },
    "/repo",
    {
      run: runGateway(runCalls),
      canonical: async (path) => path,
      session: mcp.session,
    },
  );

  assert.equal(result.status, "ready");
  assert.deepEqual(mcp.sessions, ["serena"]);
  assert.deepEqual(mcp.calls, [
    ["serena", "activate_project", { project: "/repo" }],
    ["serena", "initial_instructions", {}],
    ["serena", "list_memories", {}],
    ...STANDARD_MEMORY_NAMES.map((name) => ["serena", "read_memory", { memory_name: name }]),
  ]);
  assert.deepEqual(runCalls, []);
});

test("a failed Serena memory read degrades context without bypassing source validation", async () => {
  const mcp = createSessionGateway((server, name, arguments_) => {
    if (server === "serena" && name === "read_memory" && arguments_.memory_name === "conventions") {
      return { isError: true, content: [{ type: "text", text: "token=read-failure" }] };
    }
    return defaultSessionResponse(server, name, arguments_);
  });
  const result = await coordinateContext(
    { source: { type: "text", title: "Brief", content: "Scope" } },
    "/repo",
    { canonical: async (path) => path, session: mcp.session },
  );

  assert.equal(result.status, "degraded");
  assert.equal(result.serena.memories.conventions.status, "failed");
  assert.deepEqual(result.serena.missingRequiredMemories, ["conventions"]);
  assert.doesNotMatch(JSON.stringify(result), /read-failure/);
});

test("blocking Serena failure prevents source, durable knowledge, and command effects", async () => {
  const mcp = createSessionGateway(() => null);
  const runCalls = [];
  const result = await coordinateContext(
    {
      source: { type: "jira", key: "FNR-3016" },
      durableKnowledge: { query: "evidence" },
    },
    "/repo",
    {
      run: runGateway(runCalls),
      canonical: async (path) => path,
      session: mcp.session,
    },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.diagnostics[0].code, "serena_activation_failed");
  assert.deepEqual(mcp.sessions, ["serena"]);
  assert.deepEqual(mcp.calls, [["serena", "activate_project", { project: "/repo" }]]);
  assert.deepEqual(runCalls, []);
});

test("later blocking Serena failures prevent source and durable-knowledge effects", async () => {
  const cases = [
    {
      failingTool: "initial_instructions",
      response: { isError: true, content: [{ type: "text", text: "token=instructions-failure" }] },
      expectedCode: "serena_instructions_failed",
      expectedCalls: ["activate_project", "initial_instructions"],
    },
    {
      failingTool: "list_memories",
      response: directResult("not JSON"),
      expectedCode: "serena_memory_list_failed",
      expectedCalls: ["activate_project", "initial_instructions", "list_memories"],
    },
  ];

  for (const { failingTool, response, expectedCode, expectedCalls } of cases) {
    const mcp = createSessionGateway((server, name, arguments_) => (
      server === "serena" && name === failingTool
        ? response
        : defaultSessionResponse(server, name, arguments_)
    ));
    const runCalls = [];
    const result = await coordinateContext(
      {
        source: { type: "jira", key: "FNR-3016" },
        durableKnowledge: { query: "evidence" },
      },
      "/repo",
      {
        run: runGateway(runCalls),
        canonical: async (path) => path,
        session: mcp.session,
      },
    );

    assert.equal(result.status, "failed");
    assert.equal(result.diagnostics[0].code, expectedCode);
    assert.deepEqual(mcp.sessions, ["serena"]);
    assert.deepEqual(mcp.calls.map(([, name]) => name), expectedCalls);
    assert.deepEqual(runCalls, []);
    assert.doesNotMatch(JSON.stringify(result), /instructions-failure/);
  }
});

test("context cancellation interrupts Serena and prevents later effects", async () => {
  const controller = new AbortController();
  let markActivationStarted;
  const activationStarted = new Promise((resolve) => {
    markActivationStarted = resolve;
  });
  const mcp = createSessionGateway((server, name, arguments_) => {
    if (server === "serena" && name === "activate_project") {
      markActivationStarted();
      return new Promise((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      });
    }
    return defaultSessionResponse(server, name, arguments_);
  });
  const runCalls = [];
  const pending = coordinateContext(
    {
      source: { type: "jira", key: "FNR-3016" },
      durableKnowledge: { query: "evidence" },
    },
    "/repo",
    {
      run: runGateway(runCalls),
      canonical: async (path) => path,
      session: mcp.session,
    },
    controller.signal,
  );

  await activationStarted;
  controller.abort();
  await assert.rejects(pending, (error) => {
    assert.equal(error, controller.signal.reason);
    return true;
  });
  assert.deepEqual(mcp.sessions, ["serena"]);
  assert.deepEqual(mcp.signals, [controller.signal]);
  assert.deepEqual(mcp.calls, [["serena", "activate_project", { project: "/repo" }]]);
  assert.deepEqual(runCalls, []);
});

test("parseQdrantResults keeps complete top-level result blocks", () => {
  assert.deepEqual(parseQdrantResults(""), []);

  const formatted = [
    "## Result 1 (score: 0.75)",
    "First result",
    "### Detail",
    "```md",
    "## Result 9 (score: 0.1)",
    "```",
    "",
    "## Result 2 (score: -1.25e-1)",
    "Second result",
  ].join("\n");

  assert.deepEqual(parseQdrantResults(formatted), [
    {
      summary: "First result\n### Detail\n```md\n## Result 9 (score: 0.1)\n```",
      score: 0.75,
    },
    { summary: "Second result", score: -0.125 },
  ]);
  assert.deepEqual(parseQdrantResults([
    "## Result 1 (score: invalid)",
    "Ignored",
    "## Result 2 (score: 0.5)",
    "",
    "## Result 3 (score: 0.6)",
    "Valid",
  ].join("\n")), [{ summary: "Valid", score: 0.6 }]);
  assert.deepEqual(parseQdrantResults("## Result 1 (score: 0.5)\n"), []);
});

test("parseQdrantResults preserves result-looking headers inside valid fences", () => {
  const fourBacktickFence = [
    "## Result 1 (score: 0.9)",
    "Outer",
    "````markdown",
    "```",
    "## Result 9 (score: 0.1)",
    "````",
    "",
    "## Result 2 (score: 0.8)",
    "Second",
  ].join("\n");
  assert.deepEqual(parseQdrantResults(fourBacktickFence), [
    {
      summary: "Outer\n````markdown\n```\n## Result 9 (score: 0.1)\n````",
      score: 0.9,
    },
    { summary: "Second", score: 0.8 },
  ]);

  const suffixedDelimiter = [
    "## Result 1 (score: 0.7)",
    "```javascript",
    "```not-a-close",
    "## Result 9 (score: 0.1)",
    "```",
    "",
    "## Result 2 (score: 0.6)",
    "Second",
  ].join("\n");
  assert.deepEqual(parseQdrantResults(suffixedDelimiter), [
    {
      summary: "```javascript\n```not-a-close\n## Result 9 (score: 0.1)\n```",
      score: 0.7,
    },
    { summary: "Second", score: 0.6 },
  ]);

  const tildeFence = [
    "## Result 1 (score: 0.5)",
    "~~~yaml",
    "## Result 9 (score: 0.1)",
    "~~~~",
    "",
    "## Result 2 (score: 0.4)",
    "Second",
  ].join("\n");
  assert.deepEqual(parseQdrantResults(tildeFence), [
    { summary: "~~~yaml\n## Result 9 (score: 0.1)\n~~~~", score: 0.5 },
    { summary: "Second", score: 0.4 },
  ]);
});

test("context parses direct Qdrant results, preserves scores, and applies the requested limit", async () => {
  const mcp = createSessionGateway((server, name, arguments_) => {
    if (server === "qdrant-memory" && name === "qdrant_find") {
      return directResult([
        "## Result 1 (score: 0.91)",
        "one",
        "",
        "## Result 2 (score: 0.75)",
        "two",
        "",
        "## Result 3 (score: 0.5)",
        "three",
      ].join("\n"));
    }
    return defaultSessionResponse(server, name, arguments_);
  });
  const result = await coordinateContext(
    {
      source: { type: "text", title: "Brief", content: "Scope" },
      durableKnowledge: { query: "evidence", collection: "ima", limit: 2 },
    },
    "/repo",
    { canonical: async (path) => path, session: mcp.session },
  );

  assert.equal(result.status, "ready");
  assert.deepEqual(result.durableKnowledge.references, [
    { summary: "one", score: 0.91 },
    { summary: "two", score: 0.75 },
  ]);
  assert.deepEqual(mcp.sessions, ["serena", "qdrant-memory"]);
  assert.deepEqual(mcp.calls.at(-1), [
    "qdrant-memory",
    "qdrant_find",
    { query: "evidence", collection_name: "ima", limit: 2 },
  ]);
});

test("context forwards Qdrant limits before local bounding", async () => {
  const formatted = Array.from({ length: 21 }, (_, index) => [
    `## Result ${index + 1} (score: ${index + 1})`,
    `result ${index + 1}`,
  ].join("\n")).join("\n\n");
  const mcp = createSessionGateway((server, name, arguments_) => (
    server === "qdrant-memory" && name === "qdrant_find"
      ? directResult(formatted)
      : defaultSessionResponse(server, name, arguments_)
  ));
  const result = await coordinateContext(
    {
      source: { type: "text", title: "Brief", content: "Scope" },
      durableKnowledge: { query: "evidence", limit: 20 },
    },
    "/repo",
    { canonical: async (path) => path, session: mcp.session },
  );

  assert.equal(result.durableKnowledge.references.length, 20);
  assert.deepEqual(result.durableKnowledge.references.at(-1), {
    summary: "result 20",
    score: 20,
  });
  assert.deepEqual(mcp.calls.at(-1), [
    "qdrant-memory",
    "qdrant_find",
    { query: "evidence", limit: 20 },
  ]);
});

test("context redacts direct Qdrant summaries", async () => {
  const mcp = createSessionGateway((server, name, arguments_) => {
    if (server === "qdrant-memory" && name === "qdrant_find") {
      return directResult([
        "## Result 1 (score: 0.9)",
        "token=secret-value",
        "",
        "## Result 2 (score: 0.8)",
        "password=hidden",
      ].join("\n"));
    }
    return defaultSessionResponse(server, name, arguments_);
  });
  const result = await coordinateContext(
    {
      source: { type: "text", title: "Brief", content: "Scope" },
      durableKnowledge: { query: "evidence" },
    },
    "/repo",
    { canonical: async (path) => path, session: mcp.session },
  );

  assert.deepEqual(result.durableKnowledge.references, [
    { summary: "[redacted]", score: 0.9 },
    { summary: "[redacted]", score: 0.8 },
  ]);
});

test("context distinguishes direct Qdrant failures from successful empty results", async () => {
  const cases = [
    {
      response: { isError: true, content: [{ type: "text", text: "token=direct-error" }] },
      contextStatus: "degraded",
      durableStatus: "failed",
    },
    {
      response: directResult("not a Qdrant result block"),
      contextStatus: "ready",
      durableStatus: "empty",
    },
  ];

  for (const { response, contextStatus, durableStatus } of cases) {
    const mcp = createSessionGateway((server, name, arguments_) => (
      server === "qdrant-memory" && name === "qdrant_find"
        ? response
        : defaultSessionResponse(server, name, arguments_)
    ));
    const result = await coordinateContext(
      {
        source: { type: "text", title: "Brief", content: "Scope" },
        durableKnowledge: { query: "evidence" },
      },
      "/repo",
      { canonical: async (path) => path, session: mcp.session },
    );

    assert.equal(result.status, contextStatus);
    assert.equal(result.durableKnowledge.status, durableStatus);
    assert.deepEqual(result.durableKnowledge.references, []);
    assert.doesNotMatch(JSON.stringify(result), /direct-error/);
  }
});

test("context hydrates Vestige sources through direct MCP", async () => {
  const sourceId = "7027acec-43d3-4fa4-83ec-16e993551720";
  const mcp = createSessionGateway((server, name, arguments_) => {
    if (server === "vestige" && name === "memory") {
      return {
        isError: false,
        structuredContent: { found: true, node: { content: "Vestige source" } },
      };
    }
    return defaultSessionResponse(server, name, arguments_);
  });
  const result = await coordinateContext(
    { source: { type: "vestige", id: sourceId } },
    "/repo",
    { canonical: async (path) => path, session: mcp.session },
  );

  assert.equal(result.status, "ready");
  assert.deepEqual(result.source, {
    type: "vestige",
    key: sourceId,
    title: `Vestige ${sourceId}`,
    content: "Vestige source",
    references: [`Vestige:${sourceId}`],
  });
  assert.deepEqual(mcp.calls.at(-1), [
    "vestige",
    "memory",
    { action: "get", id: sourceId },
  ]);
});

test("context fails closed for invalid direct Vestige source responses", async () => {
  const sourceId = "7027acec-43d3-4fa4-83ec-16e993551720";
  const responses = [
    { isError: true, content: [{ type: "text", text: "token=vestige-error" }] },
    { isError: false, structuredContent: { found: false } },
    { isError: false, structuredContent: { found: true, node: { content: " " } } },
  ];

  for (const response of responses) {
    const mcp = createSessionGateway((server, name, arguments_) => (
      server === "vestige" && name === "memory"
        ? response
        : defaultSessionResponse(server, name, arguments_)
    ));
    const result = await coordinateContext(
      { source: { type: "vestige", id: sourceId } },
      "/repo",
      { canonical: async (path) => path, session: mcp.session },
    );

    assert.equal(result.status, "failed");
    assert.equal(result.source, null);
    assert.equal(result.diagnostics[0].code, "source_boundary_unavailable");
    assert.doesNotMatch(JSON.stringify(result), /vestige-error/);
  }
});

test("context hydrates verified lifecycle sources through bounded Vestige retrieval", async () => {
  const lifecycleKey = "ima-pi:adhoc:lifecycle-source-identifiers:2026-08-04";
  const artifactId = "aac9ae23-432d-4144-a9e6-4bb49457d03a";
  const content = `# Plan\n<!-- ima-lifecycle verification: lifecycle_key=${lifecycleKey}; nonce=01234567-89ab-cdef-0123-456789abcdef; phase=plan; jira_key=; taskwarrior_uuid=; outcome=completed -->`;
  const runCalls = [];
  const mcp = createSessionGateway((server, name, arguments_) => {
    if (server !== "vestige") return defaultSessionResponse(server, name, arguments_);
    if (name === "recall") return { isError: false, structuredContent: { results: [{ id: artifactId }] } };
    if (name === "memory") {
      return {
        isError: false,
        structuredContent: { action: "get", found: true, node: { id: artifactId, content } },
      };
    }
    return null;
  });
  const result = await coordinateContext(
    { source: { type: "reference", value: `lifecycle:${lifecycleKey}` } },
    "/repo",
    { canonical: async (path) => path, run: runGateway(runCalls), session: mcp.session },
  );

  assert.equal(result.status, "ready");
  assert.deepEqual(result.source, {
    type: "lifecycle",
    key: lifecycleKey,
    title: `Lifecycle ${lifecycleKey}`,
    content,
    references: [`Lifecycle:${lifecycleKey}`, `Vestige:${artifactId}`],
  });
  assert.deepEqual(mcp.calls.slice(-2), [
    [
      "vestige",
      "recall",
      {
        query: lifecycleKey,
        mode: "lookup",
        retrieval_mode: "precise",
        detail_level: "brief",
        concrete: false,
        limit: 10,
        token_budget: 1_000,
      },
    ],
    ["vestige", "memory", { action: "get", id: artifactId }],
  ]);
  assert.deepEqual(runCalls, []);
});

test("context skips an oversized lifecycle candidate and hydrates a later verified record", async () => {
  const lifecycleKey = "ima-pi:adhoc:lifecycle-source-identifiers:2026-08-04";
  const oversizedId = "aec9ae23-432d-4144-a9e6-4bb49457d03a";
  const usableId = "bec9ae23-432d-4144-a9e6-4bb49457d03a";
  const content = `# Plan\n<!-- ima-lifecycle verification: lifecycle_key=${lifecycleKey}; nonce=01234567-89ab-cdef-0123-456789abcdef; phase=plan; jira_key=; taskwarrior_uuid=; outcome=completed -->`;
  const mcp = createSessionGateway((server, name, arguments_) => {
    if (server !== "vestige") return defaultSessionResponse(server, name, arguments_);
    if (name === "recall") return { isError: false, structuredContent: { results: [{ id: oversizedId }, { id: usableId }] } };
    if (arguments_.id === oversizedId) {
      return {
        isError: false,
        structuredContent: {
          action: "get",
          found: true,
          node: { id: oversizedId, content: "x".repeat(LIFECYCLE_ARTIFACT_MAXIMUM + 1) },
        },
      };
    }
    return {
      isError: false,
      structuredContent: { action: "get", found: true, node: { id: usableId, content } },
    };
  });

  const result = await coordinateContext(
    { source: { type: "lifecycle", key: lifecycleKey } },
    "/repo",
    { canonical: async (path) => path, run: runGateway([]), session: mcp.session },
  );

  assert.equal(result.status, "ready");
  assert.equal(result.source.references.at(-1), `Vestige:${usableId}`);
  assert.deepEqual(
    mcp.calls.filter(([server, name]) => server === "vestige" && name === "memory"),
    [
      ["vestige", "memory", { action: "get", id: oversizedId }],
      ["vestige", "memory", { action: "get", id: usableId }],
    ],
  );
});

test("lifecycle sources fail closed for unavailable or non-authoritative recall", async () => {
  const lifecycleKey = "ima-pi:adhoc:lifecycle-source-identifiers:2026-08-04";
  const verified = `<!-- ima-lifecycle verification: lifecycle_key=${lifecycleKey}; nonce=01234567-89ab-cdef-0123-456789abcdef; phase=plan; jira_key=; taskwarrior_uuid=; outcome=completed -->`;
  const abbreviated = `<!-- ima-lifecycle verification: lifecycle_key=${lifecycleKey}; outcome=completed -->`;
  const tailTruncated = verified.slice(0, -4);
  const responses = [
    { isError: true, content: [{ type: "text", text: "token=vestige-error" }] },
    { isError: false, structuredContent: { results: [] } },
    { isError: false, structuredContent: { results: [{ id: "case-mismatch", content: verified.replace(lifecycleKey, lifecycleKey.toUpperCase()) }] } },
    { isError: false, structuredContent: { results: [{ id: "abbreviated", content: abbreviated }] } },
    { isError: false, structuredContent: { results: [{ id: "tail-truncated", content: tailTruncated }] } },
    { isError: false, structuredContent: { results: [{ id: "trailing", content: `${verified}\nunrelated` }] } },
    { isError: false, structuredContent: { results: [{ id: "blocked", content: verified.replace("outcome=completed", "outcome=blocked") }] } },
  ];

  for (const response of responses) {
    const runCalls = [];
    const mcp = createSessionGateway((server, name, arguments_) => (
      server === "vestige" && name === "recall" ? response : defaultSessionResponse(server, name, arguments_)
    ));
    const result = await coordinateContext(
      { source: { type: "lifecycle", key: lifecycleKey } },
      "/repo",
      { canonical: async (path) => path, run: runGateway(runCalls), session: mcp.session },
    );

    assert.equal(result.status, "failed");
    assert.equal(result.source, null);
    assert.equal(result.diagnostics[0].code, "source_boundary_unavailable");
    assert.deepEqual(runCalls, []);
    assert.equal(mcp.calls.filter(([server, name]) => server === "vestige" && name === "recall").length, 1);
    assert.equal(mcp.calls.some(([server, name]) => server === "vestige" && name === "memory"), false);
    assert.doesNotMatch(JSON.stringify(result), /vestige-error/);
  }
});

test("context exposes only known source error codes", async () => {
  const unknownMcp = createSessionGateway();
  const dependencies = {
    run: runGateway([]),
    canonical: async (path) => {
      if (path === "/repo") return path;
      throw new Error("Authorization: Bearer abc123");
    },
    session: unknownMcp.session,
  };
  const unknown = await coordinateContext({ source: { type: "file", path: "missing" } }, "/repo", dependencies);
  assert.equal(unknown.diagnostics[0].code, "source_boundary_unavailable");
  assert.doesNotMatch(JSON.stringify(unknown), /abc123/);

  const knownMcp = createSessionGateway();
  const known = await coordinateContext(
    { source: { type: "file", path: "../outside" } },
    "/repo",
    {
      run: runGateway([]),
      canonical: async (path) => path,
      session: knownMcp.session,
    },
  );
  assert.equal(known.diagnostics[0].code, "source_path_outside_project");
});
test("lifecycle persists through batch force-create and verifies the exact receipt node", async () => {
  const artifactId = "aac9ae23-432d-4144-a9e6-4bb49457d03a";
  const vestigeCalls = [];
  const runCalls = [];
  let recallQuery = "";
  const mcp = createSessionGateway((server, name, arguments_) => {
    if (server !== "vestige") return defaultSessionResponse(server, name, arguments_);
    if (name === "recall") {
      recallQuery = String(arguments_.query);
      return { isError: false, structuredContent: { results: [{ id: artifactId }] } };
    }
    const nonce = recallQuery.split(" ")[1];
    return {
      isError: false,
      structuredContent: {
        action: "get",
        found: true,
        node: {
          id: artifactId,
          content: `${identity.lifecycleKey} ${nonce} phase=implementation; ${identity.jiraKey} ${identity.taskwarriorUuid} outcome=completed`,
        },
      },
    };
  });
  const result = await coordinateLifecycle(
    { type: "implementation", identity, artifact },
    {
      run: async (...args) => {
        runCalls.push(args);
        return null;
      },
      vestige: async (tool, args) => {
        vestigeCalls.push([tool, args]);
        return {
          isError: false,
          structuredContent: {
            results: [{ status: "saved", decision: "create", nodeId: artifactId }],
          },
        };
      },
      session: mcp.session,
    },
  );

  const [ingestTool, ingestArgs] = vestigeCalls[0];
  assert.equal(result.status, "completed");
  assert.equal(result.artifactId, artifactId);
  assert.deepEqual(vestigeCalls.map(([tool]) => tool), ["smart_ingest"]);
  assert.equal(ingestTool, "smart_ingest");
  assert.equal(ingestArgs.forceCreate, true);
  assert.equal(ingestArgs.batchMergePolicy, "force_create");
  assert.deepEqual(ingestArgs.items, [{
    content: ingestArgs.items[0].content,
    node_type: "decision",
    forceCreate: true,
    source: identity.lifecycleKey,
    tags: [identity.project, "lifecycle", "implementation"],
  }]);
  assert.deepEqual(mcp.calls.filter(([server]) => server === "vestige"), [
    [
      "vestige",
      "recall",
      {
        query: recallQuery,
        mode: "lookup",
        retrieval_mode: "precise",
        detail_level: "brief",
        concrete: true,
        limit: 10,
        token_budget: 1_000,
      },
    ],
    ["vestige", "memory", { action: "get", id: artifactId }],
  ]);
  assert.match(ingestArgs.items[0].content, new RegExp(recallQuery.split(" ")[1]));
  assert.deepEqual(runCalls, []);
});

test("lifecycle rejects oversized serialized artifacts before Vestige I/O", async () => {
  const requests = [
    {
      identity,
      artifact: "x".repeat(LIFECYCLE_ARTIFACT_MAXIMUM),
    },
    {
      identity: {
        ...identity,
        sourceRefs: ["x".repeat(LIFECYCLE_ARTIFACT_MAXIMUM)],
      },
      artifact,
    },
  ];

  for (const request of requests) {
    const vestigeCalls = [];
    const sessionCalls = [];
    const result = await coordinateLifecycle(
      { type: "implementation", ...request },
      {
        vestige: async (...args) => {
          vestigeCalls.push(args);
          return null;
        },
        session: async (...args) => {
          sessionCalls.push(args);
          return null;
        },
      },
    );

    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "invalid_lifecycle_request");
    assert.deepEqual(vestigeCalls, []);
    assert.deepEqual(sessionCalls, []);
  }
});

test("lifecycle allows an artifact at the exact serialized bound", async () => {
  const artifactId = "aac9ae23-432d-4144-a9e6-4bb49457d03a";
  const sampleNonce = "01234567-89ab-cdef-0123-456789abcdef";
  const emptyArtifact = buildLifecycleArtifact({
    type: "implementation",
    identity,
    artifact: "",
    nonce: sampleNonce,
  });
  const artifactAtLimit = "x".repeat(
    LIFECYCLE_ARTIFACT_MAXIMUM - emptyArtifact.length,
  );
  const vestigeCalls = [];
  let recallQuery = "";
  const mcp = createSessionGateway((server, name, arguments_) => {
    if (server !== "vestige") return null;
    if (name === "recall") {
      recallQuery = String(arguments_.query);
      return { isError: false, structuredContent: { results: [{ id: artifactId }] } };
    }
    const nonce = recallQuery.split(" ")[1];
    return {
      isError: false,
      structuredContent: {
        action: "get",
        found: true,
        node: {
          id: artifactId,
          content: `${identity.lifecycleKey} ${nonce} phase=implementation; ${identity.jiraKey} ${identity.taskwarriorUuid} outcome=completed`,
        },
      },
    };
  });

  const result = await coordinateLifecycle(
    { type: "implementation", identity, artifact: artifactAtLimit },
    {
      vestige: async (tool, arguments_) => {
        vestigeCalls.push([tool, arguments_]);
        return {
          isError: false,
          structuredContent: {
            results: [{ status: "saved", decision: "create", nodeId: artifactId }],
          },
        };
      },
      session: mcp.session,
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(vestigeCalls.length, 1);
  assert.equal(
    vestigeCalls[0][1].items[0].content.length,
    LIFECYCLE_ARTIFACT_MAXIMUM,
  );
});

test("lifecycle preserves a pre-aborted signal without external effects", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled before lifecycle mutation");
  const vestigeCalls = [];
  const sessionCalls = [];
  controller.abort(reason);

  await assert.rejects(
    coordinateLifecycle(
      { type: "implementation", identity, artifact },
      {
        vestige: async (...args) => {
          vestigeCalls.push(args);
          return null;
        },
        session: async (...args) => {
          sessionCalls.push(args);
          return null;
        },
      },
      controller.signal,
    ),
    (error) => error === reason,
  );
  assert.deepEqual(vestigeCalls, []);
  assert.deepEqual(sessionCalls, []);
});

test("lifecycle aborts after discovery without retrying or reading the receipt", async () => {
  const artifactId = "aac9ae23-432d-4144-a9e6-4bb49457d03a";
  const controller = new AbortController();
  const reason = new Error("cancelled during lifecycle discovery");
  const vestigeCalls = [];
  const vestigeSignals = [];
  const mcp = createSessionGateway((server, name) => {
    if (server !== "vestige" || name !== "recall") return null;
    controller.abort(reason);
    return { isError: false, structuredContent: { results: [{ id: artifactId }] } };
  });

  await assert.rejects(
    coordinateLifecycle(
      { type: "implementation", identity, artifact },
      {
        vestige: async (tool, arguments_, signal) => {
          vestigeCalls.push([tool, arguments_]);
          vestigeSignals.push(signal);
          return {
            isError: false,
            structuredContent: {
              results: [{ status: "saved", decision: "create", nodeId: artifactId }],
            },
          };
        },
        session: mcp.session,
      },
      controller.signal,
    ),
    (error) => error === reason,
  );
  assert.deepEqual(vestigeCalls.map(([tool]) => tool), ["smart_ingest"]);
  assert.deepEqual(vestigeSignals, [controller.signal]);
  assert.deepEqual(mcp.signals, [controller.signal]);
  assert.equal(mcp.calls.some(([server, name]) => server === "vestige" && name === "memory"), false);
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

test("lifecycle rejects embedded prior artifacts before Vestige I/O", async () => {
  const vestigeCalls = [];
  const embeddedArtifact = `${artifact}\n<!-- ima-lifecycle verification: lifecycle_key=${identity.lifecycleKey}; nonce=01234567-89ab-cdef-0123-456789abcdef; phase=plan; jira_key=${identity.jiraKey}; taskwarrior_uuid=${identity.taskwarriorUuid}; outcome=completed -->`;
  const result = await coordinateLifecycle(
    { type: "implementation", identity, artifact: embeddedArtifact },
    {
      vestige: async (...args) => {
        vestigeCalls.push(args);
        return null;
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "lifecycle_artifact_embeds_prior_artifact");
  assert.equal(
    result.error.message,
    "Lifecycle artifact embeds a prior artifact. Reference prior IDs in prior_artifact_ids or source_refs instead of pasting content.",
  );
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

test("lifecycle rejects a brief discovery that omits the created receipt node", async () => {
  const artifactId = "aac9ae23-432d-4144-a9e6-4bb49457d03a";
  const mcp = createSessionGateway((server, name) => (
    server === "vestige" && name === "recall"
      ? { isError: false, structuredContent: { results: [] } }
      : null
  ));
  const result = await coordinateLifecycle(
    { type: "implementation", identity, artifact },
    {
      vestige: async () => ({
        isError: false,
        structuredContent: { results: [{ status: "saved", decision: "create", nodeId: artifactId }] },
      }),
      session: mcp.session,
    },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "vestige_semantic_completion_unverified");
  assert.equal(mcp.calls.some(([server, name]) => server === "vestige" && name === "memory"), false);
});

test("lifecycle fails closed after one unavailable exact receipt read", async () => {
  const artifactId = "aac9ae23-432d-4144-a9e6-4bb49457d03a";
  const secret = "token=error-recall-secret";
  const mcp = createSessionGateway((server, name) => {
    if (server !== "vestige") return null;
    if (name === "recall") return { isError: false, structuredContent: { results: [{ id: artifactId }] } };
    return { isError: true, content: [{ type: "text", text: secret }] };
  });
  const calls = [];
  const result = await coordinateLifecycle(
    { type: "implementation", identity, artifact },
    {
      vestige: async (tool) => {
        calls.push(tool);
        return {
          isError: false,
          structuredContent: { results: [{ status: "saved", decision: "create", nodeId: artifactId }] },
        };
      },
      session: mcp.session,
    },
  );

  assert.deepEqual(calls, ["smart_ingest"]);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "vestige_recall_failed");
  assert.equal(mcp.calls.filter(([server, name]) => server === "vestige" && name === "memory").length, 1);
  assert.doesNotMatch(JSON.stringify(result), /error-recall-secret/);
});

test("Taskwarrior source accepts exactly one matching read-only export", async () => {
  const runCalls = [];
  const mcp = createSessionGateway();
  const run = async (program, args) => {
    runCalls.push([program, args]);
    if (program === "task") {
      return [{
        uuid: "689fa7ac-84b7-42d0-8912-b8ef76041370",
        project: "FNR-3007",
        description: "Integrate",
        status: "pending",
      }];
    }
    return runGateway(runCalls)(program, args);
  };
  const result = await coordinateContext(
    {
      source: {
        type: "taskwarrior",
        project: "FNR-3007",
        uuid: "689fa7ac-84b7-42d0-8912-b8ef76041370",
      },
    },
    "/repo",
    { run, canonical: async (path) => path, session: mcp.session },
  );

  assert.equal(result.status, "ready");
  assert.deepEqual(runCalls, [["task", [
    "rc.verbose=nothing",
    "project:FNR-3007",
    "689fa7ac-84b7-42d0-8912-b8ef76041370",
    "export",
  ]]]);
});

test("Taskwarrior source fails closed unless export contains exactly one matching task", async () => {
  const matching = {
    uuid: "689fa7ac-84b7-42d0-8912-b8ef76041370",
    project: "FNR-3007",
    description: "Integrate",
    status: "pending",
  };
  const cases = [
    [],
    [{ ...matching, project: "OTHER" }],
    [{ ...matching, uuid: "other" }],
    [matching, { ...matching }],
  ];
  for (const tasks of cases) {
    const mcp = createSessionGateway();
    const result = await coordinateContext(
      {
        source: {
          type: "taskwarrior",
          project: "FNR-3007",
          uuid: "689fa7ac-84b7-42d0-8912-b8ef76041370",
        },
      },
      "/repo",
      {
        run: async (program, args) => (
          program === "task" ? tasks : runGateway([])(program, args)
        ),
        canonical: async (path) => path,
        session: mcp.session,
      },
    );
    assert.equal(result.status, "failed");
    assert.equal(result.source, null);
  }
});
