import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { convertTools } from "@earendil-works/pi-ai/api/google-shared";
import { Check } from "typebox/value";
import integrations, { coordinateContext, coordinateLifecycle } from "../extensions/integrations.ts";
import { parseQdrantResults } from "../lib/ima-context.ts";
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
  if (program === "ima-mcp") throw new Error("unexpected");
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
  assert.match(String(contextTool.execute), /coordinateContext\(request, ctx\.cwd, undefined, signal\)/);
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
