import assert from "node:assert/strict";
import test from "node:test";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { coordinateContext } from "../extensions/integrations.ts";
import { SERENA_BOOTSTRAP_TOOL, createMcpChildRuntime } from "../extensions/mcp.ts";
import { createSerenaLifecycleClient } from "../lib/serena-lifecycle-client.ts";
import { createSerenaLifecycleProvider } from "../lib/serena-lifecycle.ts";
import { createSerenaLifecycleProject } from "../lib/serena-lifecycle-record.ts";
import {
  createSerenaMcpSession,
  parseSerenaMcpCapabilities,
} from "../lib/serena-mcp-session.ts";

const ROOT = "/workspace/synthetic-serena-session-boundary";
const MEMORY_MAINTENANCE = "memory_maintenance";
const CONTEXT_MEMORIES = [
  "core",
  "conventions",
  "tech_stack",
  "suggested_commands",
  "task_completion",
  MEMORY_MAINTENANCE,
];
const NON_SECRET_SESSION_PLACEHOLDER = "synthetic-nonsecret-session-placeholder";

const textResponse = (text) => ({
  content: [{ type: "text", text }],
});

const contextRequest = () => ({
  source: {
    type: "text",
    title: "Synthetic Serena session boundary",
    content: "Synthetic non-sensitive context evidence.",
  },
});

const requiredFields = (fields, sessionArgument) => [
  ...fields,
  ...(sessionArgument ? [sessionArgument] : []),
];

const propertiesFor = (properties, sessionArgument) => ({
  ...properties,
  ...(sessionArgument ? { [sessionArgument]: { type: "string" } } : {}),
});

const advertisedTools = ({
  sessionArgument = null,
  instructionUsesSession = false,
} = {}) => {
  const instructionArgument = instructionUsesSession ? sessionArgument : null;
  return {
    tools: [
      {
        name: "activate_project",
        inputSchema: {
          type: "object",
          properties: propertiesFor({ project: { type: "string" } }, sessionArgument),
          required: requiredFields(["project"], sessionArgument),
        },
      },
      {
        name: "initial_instructions",
        inputSchema: {
          type: "object",
          properties: propertiesFor({}, instructionArgument),
          required: requiredFields([], instructionArgument),
        },
      },
      {
        name: "list_memories",
        inputSchema: {
          type: "object",
          properties: propertiesFor({ topic: { type: "string" } }, sessionArgument),
          required: requiredFields([], sessionArgument),
        },
      },
      {
        name: "read_memory",
        inputSchema: {
          type: "object",
          properties: propertiesFor({ memory_name: { type: "string" } }, sessionArgument),
          required: requiredFields(["memory_name"], sessionArgument),
        },
      },
      {
        name: "write_memory",
        inputSchema: {
          type: "object",
          properties: propertiesFor({
            memory_name: { type: "string" },
            content: { type: "string" },
            max_chars: { type: "integer" },
          }, sessionArgument),
          required: requiredFields(["memory_name", "content"], sessionArgument),
        },
      },
    ],
  };
};

const currentSessionAdvertisedTools = () => {
  const tools = advertisedTools();
  const activation = tools.tools.find(({ name }) => name === "activate_project");
  activation.inputSchema.properties.session_id = { type: "string" };
  activation.inputSchema.required.push("session_id");
  return tools;
};

const instructionSessionResponse = (
  sessionValue = NON_SECRET_SESSION_PLACEHOLDER,
) => {
  const instructions = [
    "Synthetic Serena instructions.",
    "<session>",
    `Your Serena session id is \`${sessionValue}\`. Pass it as the \`session_id\` parameter to tools which require it.`,
    "</session>",
  ].join("\n");
  return {
    ...textResponse(instructions),
    isError: false,
    structuredContent: { result: instructions },
  };
};

const activationReceipt = (projectName, projectPath) =>
  `The project with name '${projectName}' at ${projectPath} is activated.`;

const lifecycleRequest = () => ({
  type: "implementation",
  identity: {
    project: "ima-pi",
    lifecycleKey: "ima-pi:plane:ima:TEST-2400",
    lifecycleRootMemoryId: "",
    taskwarriorProject: "",
    taskwarriorTask: "",
    taskwarriorUuid: "",
    jiraKey: "",
    planeWorkspace: "ima",
    planeWorkItem: "TEST-2400",
    sourceRefs: ["plane:ima:TEST-2400"],
    priorArtifactIds: [],
  },
  summary: "Synthetic Serena session lifecycle behavior remains bounded.",
  artifact: "# Synthetic lifecycle artifact\n\nThis test has no external side effects.",
});

test("session-aware context discovers once, loads instructions first, and keeps private arguments on the original connection", async () => {
  const events = [];
  let connections = 0;
  const session = async (server, callback) => {
    assert.equal(server, "serena");
    connections += 1;
    const call = async (name, args, timeout) => {
      const usesExpectedSession = name === "activate_project"
        ? args.session_id === NON_SECRET_SESSION_PLACEHOLDER
        : !Object.hasOwn(args, "session_id");
      events.push({
        kind: "call",
        name,
        argumentNames: Object.keys(args).sort(),
        usesExpectedSession,
        timeout,
      });
      if (!usesExpectedSession) throw new Error("synthetic_session_argument_mismatch");
      if (name === "initial_instructions") {
        return instructionSessionResponse();
      }
      if (name === "activate_project") return textResponse(activationReceipt("synthetic", ROOT));
      if (name === "list_memories") return textResponse(JSON.stringify({ memories: CONTEXT_MEMORIES }));
      if (name === "read_memory") return textResponse(`${args.memory_name} synthetic memory`);
      throw new Error("unexpected_synthetic_serena_operation");
    };
    const listTools = async (timeout) => {
      events.push({ kind: "discover", timeout });
      return currentSessionAdvertisedTools();
    };
    return callback(call, listTools);
  };

  const result = await coordinateContext(contextRequest(), ROOT, {
    canonical: async (path) => path,
    session,
  });

  assert.equal(result.status, "ready");
  assert.equal(result.serena.instructionsLoaded, true);
  assert.deepEqual(result.serena.missingRequiredMemories, []);
  assert.equal(connections, 1);
  assert.deepEqual(events, [
    { kind: "discover", timeout: 300_000 },
    {
      kind: "call",
      name: "initial_instructions",
      argumentNames: [],
      usesExpectedSession: true,
      timeout: 300_000,
    },
    {
      kind: "call",
      name: "activate_project",
      argumentNames: ["project", "session_id"],
      usesExpectedSession: true,
      timeout: 300_000,
    },
    {
      kind: "call",
      name: "list_memories",
      argumentNames: [],
      usesExpectedSession: true,
      timeout: 300_000,
    },
    ...CONTEXT_MEMORIES.map(() => ({
      kind: "call",
      name: "read_memory",
      argumentNames: ["memory_name"],
      usesExpectedSession: true,
      timeout: 300_000,
    })),
  ]);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-nonsecret-session-placeholder/);
});

test("legacy context omits discovery and private arguments while retaining the historical bootstrap order", async () => {
  const events = [];
  let connections = 0;
  const session = async (server, callback) => {
    assert.equal(server, "serena");
    connections += 1;
    return callback(async (name, args, timeout) => {
      events.push({ name, argumentNames: Object.keys(args).sort(), timeout });
      if (name === "activate_project") return textResponse(activationReceipt("legacy", args.project));
      if (name === "initial_instructions") return textResponse("legacy instructions");
      if (name === "list_memories") return textResponse(JSON.stringify({ memories: CONTEXT_MEMORIES }));
      if (name === "read_memory") return textResponse(`${args.memory_name} legacy memory`);
      throw new Error("unexpected_legacy_serena_operation");
    });
  };

  const result = await coordinateContext(contextRequest(), ROOT, {
    canonical: async (path) => path,
    session,
  });

  assert.equal(result.status, "ready");
  assert.equal(connections, 1);
  assert.deepEqual(events, [
    { name: "activate_project", argumentNames: ["project"], timeout: 300_000 },
    { name: "initial_instructions", argumentNames: [], timeout: 300_000 },
    { name: "list_memories", argumentNames: [], timeout: 300_000 },
    ...CONTEXT_MEMORIES.map(() => ({
      name: "read_memory",
      argumentNames: ["memory_name"],
      timeout: 300_000,
    })),
  ]);
});

test("legacy context requires an exact existing-project receipt before memory effects", async () => {
  const receipts = [
    ["exact", activationReceipt("legacy", ROOT), true],
    ["wrong project root", activationReceipt("legacy", `${ROOT}-other`), false],
    ["generic", "legacy activation accepted", false],
    ["newly created", `Created and activated a new project with name 'legacy' at ${ROOT}.`, false],
  ];

  for (const [label, receipt, accepted] of receipts) {
    const calls = [];
    const result = await coordinateContext(contextRequest(), ROOT, {
      canonical: async (path) => path,
      session: async (_server, callback) => callback(async (name, args) => {
        calls.push(name);
        if (name === "activate_project") return textResponse(receipt);
        if (name === "initial_instructions") return textResponse("legacy instructions");
        if (name === "list_memories") return textResponse(JSON.stringify({ memories: CONTEXT_MEMORIES }));
        if (name === "read_memory") return textResponse(`${args.memory_name} legacy memory`);
        throw new Error("unexpected_legacy_receipt_operation");
      }),
    });

    assert.equal(result.status, accepted ? "ready" : "degraded", label);
    assert.deepEqual(
      calls,
      accepted
        ? [
          "activate_project",
          "initial_instructions",
          "list_memories",
          ...CONTEXT_MEMORIES.map(() => "read_memory"),
        ]
        : ["activate_project"],
      label,
    );
    if (accepted) continue;
    assert.equal(result.serena.instructionsLoaded, false, label);
    assert.deepEqual(result.diagnostics, [{
      code: "serena_activation_failed",
      stage: "serena",
      message: "Serena bootstrap did not complete.",
    }], label);
  }
});

test("session schema parsing admits only compact semantics and harmless annotations", () => {
  const legacy = advertisedTools();
  const sessionRequired = advertisedTools({
    sessionArgument: "session_id",
    instructionUsesSession: true,
  });
  const currentSessionRequired = currentSessionAdvertisedTools();
  const expectedCapabilities = {
    sessionRequired: true,
    instructionsFirst: true,
    contextSupported: true,
    lifecycleSupported: true,
  };
  assert.deepEqual(parseSerenaMcpCapabilities(legacy), {
    sessionRequired: false,
    instructionsFirst: false,
    contextSupported: true,
    lifecycleSupported: true,
  });
  assert.deepEqual(parseSerenaMcpCapabilities(sessionRequired), expectedCapabilities);
  assert.deepEqual(parseSerenaMcpCapabilities(currentSessionRequired), expectedCapabilities);

  const annotated = structuredClone(sessionRequired);
  for (const tool of annotated.tools) {
    tool.inputSchema.title = "Synthetic Serena tool";
    tool.inputSchema.description = "Synthetic annotation only.";
    tool.inputSchema.$comment = "Ignored metadata.";
    tool.inputSchema.examples = [];
    const firstProperty = Object.keys(tool.inputSchema.properties)[0];
    tool.inputSchema.properties[firstProperty].title = "Synthetic property";
    tool.inputSchema.properties[firstProperty].default = "ignored";
    tool.inputSchema.properties[firstProperty].deprecated = false;
  }
  assert.deepEqual(parseSerenaMcpCapabilities(annotated), expectedCapabilities);

  const ambiguous = structuredClone(sessionRequired);
  ambiguous.tools[0].inputSchema.properties.sessionId = { type: "string" };
  ambiguous.tools[0].inputSchema.required.push("sessionId");
  const conflictingSessionArguments = structuredClone(sessionRequired);
  delete conflictingSessionArguments.tools[2].inputSchema.properties.session_id;
  conflictingSessionArguments.tools[2].inputSchema.properties.sessionId = { type: "string" };
  conflictingSessionArguments.tools[2].inputSchema.required = ["sessionId"];
  const duplicate = structuredClone(sessionRequired);
  duplicate.tools.push(structuredClone(duplicate.tools[3]));
  const rootCombinator = structuredClone(sessionRequired);
  rootCombinator.tools[0].inputSchema.allOf = [];
  const rootNot = structuredClone(sessionRequired);
  rootNot.tools[0].inputSchema.not = {};
  const propertyConst = structuredClone(sessionRequired);
  propertyConst.tools[0].inputSchema.properties.project.const = "synthetic";
  const malformedKeyword = structuredClone(sessionRequired);
  malformedKeyword.tools[0].inputSchema.additionalProperties = "false";
  const malformed = { tools: "not-an-array" };

  for (const schema of [
    ambiguous,
    conflictingSessionArguments,
    duplicate,
    rootCombinator,
    rootNot,
    propertyConst,
    malformedKeyword,
    malformed,
  ]) {
    let calls = 0;
    assert.equal(parseSerenaMcpCapabilities(schema), null);
    assert.deepEqual(createSerenaMcpSession({
      call: async () => {
        calls += 1;
        return textResponse("unexpected");
      },
      advertisedTools: schema,
    }), {
      success: false,
      code: "serena_protocol_unsupported",
    });
    assert.equal(calls, 0);
  }

  const annotationCalls = [];
  const annotatedSession = createSerenaMcpSession({
    call: async (name) => {
      annotationCalls.push(name);
      return textResponse("unexpected");
    },
    advertisedTools: annotated,
  });
  assert.equal(annotatedSession.success, true);
  assert.deepEqual(annotationCalls, []);
});

test("session initialization carriers distinguish absence from invalid values", () => {
  const sessionRequired = advertisedTools({
    sessionArgument: "session_id",
    instructionUsesSession: true,
  });
  const accessorCarrier = {};
  Object.defineProperty(accessorCarrier, "session_id", {
    enumerable: true,
    get: () => {
      throw new Error("synthetic_initialization_accessor");
    },
  });
  const malformedCarriers = [
    null,
    [],
    "not-an-initialization-carrier",
    { session_id: 7 },
    {
      session_id: NON_SECRET_SESSION_PLACEHOLDER,
      sessionId: NON_SECRET_SESSION_PLACEHOLDER,
    },
    accessorCarrier,
  ];

  for (const initialization of malformedCarriers) {
    let calls = 0;
    const created = createSerenaMcpSession({
      call: async () => {
        calls += 1;
        return textResponse("unexpected");
      },
      advertisedTools: sessionRequired,
      initialization,
    });
    assert.deepEqual(created, {
      success: false,
      code: "serena_session_unavailable",
    });
    assert.equal(calls, 0);
  }
});

test("session preparation requires every session carrier to agree without redispatch", async () => {
  const createPreparation = ({
    initialization,
    response,
    instructionUsesSession = false,
  }) => {
    const calls = [];
    const sessionArgumentsMatch = [];
    const created = createSerenaMcpSession({
      call: async (name, args) => {
        calls.push({ name, argumentNames: Object.keys(args).sort() });
        if (name === "initial_instructions") return response;
        if (name === "list_memories") {
          sessionArgumentsMatch.push(args.session_id === NON_SECRET_SESSION_PLACEHOLDER);
          return textResponse(JSON.stringify({ memories: [] }));
        }
        throw new Error("unexpected_session_preparation_operation");
      },
      advertisedTools: advertisedTools({
        sessionArgument: "session_id",
        instructionUsesSession,
      }),
      ...(initialization === undefined ? {} : { initialization }),
    });
    return { calls, created, sessionArgumentsMatch };
  };
  const jsonCarrier = JSON.stringify({ session_id: NON_SECRET_SESSION_PLACEHOLDER });
  const sdkNormalizedStructuredResponse = () => CallToolResultSchema.parse({
    structuredContent: { session_id: NON_SECRET_SESSION_PLACEHOLDER },
  });
  assert.deepEqual(sdkNormalizedStructuredResponse().content, []);

  for (const [label, response] of [
    ["structured", { structuredContent: { session_id: NON_SECRET_SESSION_PLACEHOLDER } }],
    ["SDK-normalized structured", sdkNormalizedStructuredResponse()],
    ["JSON text", textResponse(jsonCarrier)],
    ["current Serena instruction marker", instructionSessionResponse()],
  ]) {
    const prepared = createPreparation({ response });
    assert.equal(prepared.created.success, true, label);
    assert.deepEqual(await prepared.created.session.prepare(100), {
      success: true,
      instructionsLoaded: true,
    }, label);
    await prepared.created.session.listMemories(100);
    assert.deepEqual(prepared.calls, [
      { name: "initial_instructions", argumentNames: [] },
      { name: "list_memories", argumentNames: ["session_id"] },
    ], label);
    assert.deepEqual(prepared.sessionArgumentsMatch, [true], label);
  }

  for (const [label, response] of [
    [
      "matching text and structured carriers",
      {
        structuredContent: { session_id: NON_SECRET_SESSION_PLACEHOLDER },
        content: textResponse(jsonCarrier).content,
      },
    ],
    ["SDK-normalized structured carrier", sdkNormalizedStructuredResponse()],
  ]) {
    const matching = createPreparation({
      initialization: { session_id: NON_SECRET_SESSION_PLACEHOLDER },
      instructionUsesSession: true,
      response,
    });
    assert.equal(matching.created.success, true, label);
    assert.deepEqual(await matching.created.session.prepare(100), {
      success: true,
      instructionsLoaded: true,
    }, label);
    await matching.created.session.listMemories(100);
    assert.deepEqual(matching.calls, [
      { name: "initial_instructions", argumentNames: ["session_id"] },
      { name: "list_memories", argumentNames: ["session_id"] },
    ], label);
    assert.deepEqual(matching.sessionArgumentsMatch, [true], label);
  }

  const tokenFree = createPreparation({
    initialization: { session_id: NON_SECRET_SESSION_PLACEHOLDER },
    instructionUsesSession: true,
    response: textResponse("Follow the synthetic instructions."),
  });
  assert.equal(tokenFree.created.success, true);
  assert.deepEqual(await tokenFree.created.session.prepare(100), {
    success: true,
    instructionsLoaded: true,
  });

  const absent = createPreparation({
    response: textResponse("Follow the synthetic instructions."),
  });
  assert.equal(absent.created.success, true);
  assert.deepEqual(await absent.created.session.prepare(100), {
    success: false,
    code: "serena_session_unavailable",
  });

  const otherSession = "other-synthetic-nonsecret-session-placeholder";
  const invalidResponses = [
    ["SDK-normalized empty-only content", CallToolResultSchema.parse({})],
    [
      "empty content with token-free structured state",
      {
        structuredContent: {},
        content: [],
      },
    ],
    [
      "sparse content array",
      {
        structuredContent: { session_id: NON_SECRET_SESSION_PLACEHOLDER },
        content: new Array(1),
      },
    ],
    [
      "malformed content block",
      {
        structuredContent: { session_id: NON_SECRET_SESSION_PLACEHOLDER },
        content: [{
          type: "text",
          text: jsonCarrier,
          unexpected: true,
        }],
      },
    ],
    [
      "multiple content blocks",
      {
        structuredContent: { session_id: NON_SECRET_SESSION_PLACEHOLDER },
        content: [
          { type: "text", text: jsonCarrier },
          { type: "text", text: jsonCarrier },
        ],
      },
    ],
    [
      "malformed JSON accompanying structured state",
      {
        structuredContent: { session_id: NON_SECRET_SESSION_PLACEHOLDER },
        content: textResponse(`{"session_id":"${NON_SECRET_SESSION_PLACEHOLDER}"`).content,
      },
    ],
    ["malformed JSON-shaped text", textResponse(`{"session_id":"${NON_SECRET_SESSION_PLACEHOLDER}"`)],
    ["numeric JSON field", textResponse(JSON.stringify({ session_id: 7 }))],
    [
      "malformed structured field with empty content",
      {
        structuredContent: { session_id: 7 },
        content: [],
      },
    ],
    [
      "duplicate JSON field",
      textResponse(`{"session_id":"${NON_SECRET_SESSION_PLACEHOLDER}","session_id":"${NON_SECRET_SESSION_PLACEHOLDER}"}`),
    ],
    [
      "ambiguous JSON fields",
      textResponse(JSON.stringify({
        session_id: NON_SECRET_SESSION_PLACEHOLDER,
        sessionId: NON_SECRET_SESSION_PLACEHOLDER,
      })),
    ],
    [
      "initialization mismatch with empty content",
      {
        structuredContent: { session_id: otherSession },
        content: [],
      },
    ],
    [
      "structured and text mismatch",
      {
        structuredContent: { session_id: NON_SECRET_SESSION_PLACEHOLDER },
        content: textResponse(JSON.stringify({ session_id: otherSession })).content,
      },
    ],
    [
      "instruction marker carrier mismatch",
      {
        ...instructionSessionResponse(),
        structuredContent: instructionSessionResponse(otherSession).structuredContent,
      },
    ],
    [
      "duplicate instruction markers",
      textResponse(`${instructionSessionResponse().content[0].text}\n${instructionSessionResponse().content[0].text}`),
    ],
    [
      "oversized accompanying text",
      {
        structuredContent: { session_id: NON_SECRET_SESSION_PLACEHOLDER },
        content: [{ type: "text", text: "x".repeat(300_001) }],
      },
    ],
  ];

  for (const [label, response] of invalidResponses) {
    const prepared = createPreparation({
      initialization: { session_id: NON_SECRET_SESSION_PLACEHOLDER },
      instructionUsesSession: true,
      response,
    });
    assert.equal(prepared.created.success, true, label);
    const first = await prepared.created.session.prepare(100);
    assert.deepEqual(first, {
      success: false,
      code: "serena_session_unavailable",
    }, label);
    assert.deepEqual(await prepared.created.session.prepare(100), first, label);
    await assert.rejects(
      prepared.created.session.activateProject(ROOT, 100),
      /serena_session_unavailable/,
      label,
    );
    assert.deepEqual(prepared.calls, [{
      name: "initial_instructions",
      argumentNames: ["session_id"],
    }], label);
    assert.doesNotMatch(JSON.stringify(first), /synthetic-nonsecret-session-placeholder/, label);
  }
});

test("session-aware context returns bounded stage diagnostics without retries or private-state disclosure", async () => {
  const scenarios = [
    {
      label: "discovery failure",
      code: "serena_capability_discovery_failed",
      listTools: async () => {
        throw new Error("synthetic_discovery_failure");
      },
      expectedCalls: [],
      instructionsLoaded: false,
    },
    {
      label: "ambiguous schema",
      code: "serena_protocol_unsupported",
      listTools: async () => {
        const schema = advertisedTools({ sessionArgument: "session_id" });
        schema.tools[0].inputSchema.properties.sessionId = { type: "string" };
        schema.tools[0].inputSchema.required.push("sessionId");
        return schema;
      },
      expectedCalls: [],
      instructionsLoaded: false,
    },
    {
      label: "malformed initialization carrier",
      code: "serena_session_unavailable",
      listTools: Object.assign(
        async () => advertisedTools({ sessionArgument: "session_id" }),
        { initialization: [] },
      ),
      expectedCalls: [],
      instructionsLoaded: false,
    },
    {
      label: "malformed instruction carrier",
      code: "serena_session_unavailable",
      listTools: async () => advertisedTools({ sessionArgument: "session_id" }),
      initialResponse: textResponse(`{"session_id":"${NON_SECRET_SESSION_PLACEHOLDER}"`),
      expectedCalls: ["initial_instructions"],
      instructionsLoaded: false,
    },
    {
      label: "inexact activation receipt",
      code: "serena_activation_failed",
      listTools: async () => advertisedTools({ sessionArgument: "session_id" }),
      expectedCalls: ["initial_instructions", "activate_project"],
      instructionsLoaded: true,
    },
  ];

  for (const scenario of scenarios) {
    const calls = [];
    const result = await coordinateContext(contextRequest(), ROOT, {
      canonical: async (path) => path,
      session: async (_server, callback) => callback(async (name, args) => {
        calls.push(name);
        if (name === "initial_instructions") {
          return scenario.initialResponse
            ?? { structuredContent: { session_id: NON_SECRET_SESSION_PLACEHOLDER } };
        }
        if (name === "activate_project") return textResponse("synthetic inexact activation receipt");
        throw new Error("unexpected_stage_operation");
      }, scenario.listTools),
    });

    assert.equal(result.status, "degraded", scenario.label);
    assert.deepEqual(result.diagnostics, [{
      code: scenario.code,
      stage: "serena",
      message: "Serena bootstrap did not complete.",
    }], scenario.label);
    assert.deepEqual(calls, scenario.expectedCalls, scenario.label);
    assert.equal(result.serena.instructionsLoaded, scenario.instructionsLoaded, scenario.label);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-nonsecret-session-placeholder/, scenario.label);
  }
});

test("lifecycle client rejects an exact project mismatch before it prepares a session", async () => {
  const project = createSerenaLifecycleProject({
    projectName: "synthetic-session-project",
    projectPath: "/workspace/synthetic-session-project",
  });
  const otherProject = createSerenaLifecycleProject({
    projectName: "synthetic-other-project",
    projectPath: "/workspace/synthetic-other-project",
  });
  assert.ok(project);
  assert.ok(otherProject);

  let calls = 0;
  const client = createSerenaLifecycleClient({
    call: async () => {
      calls += 1;
      return textResponse("unexpected");
    },
    advertisedTools: advertisedTools({ sessionArgument: "session_id" }),
    project,
    initialization: { session_id: NON_SECRET_SESSION_PLACEHOLDER },
    inspectProject: async () => project,
    inspectMemory: async () => project,
  });

  assert.deepEqual(await client.activate(otherProject), {
    success: false,
    code: "serena_project_mismatch",
  });
  assert.equal(calls, 0);
});

test("session-aware lifecycle persists once, directly reads back, and preserves list/read/write continuity", async () => {
  const project = createSerenaLifecycleProject({
    projectName: "synthetic-session-lifecycle",
    projectPath: "/workspace/synthetic-session-lifecycle",
  });
  assert.ok(project);

  const memories = new Map();
  const calls = [];
  let released = 0;
  const call = async (name, args, timeout) => {
    const usesExpectedSession = name === "initial_instructions"
      ? !Object.hasOwn(args, "session_id")
      : args.session_id === NON_SECRET_SESSION_PLACEHOLDER;
    calls.push({
      name,
      argumentNames: Object.keys(args).sort(),
      usesExpectedSession,
      timeout,
    });
    if (!usesExpectedSession) throw new Error("synthetic_lifecycle_session_mismatch");
    if (name === "initial_instructions") {
      return { structuredContent: { session_id: NON_SECRET_SESSION_PLACEHOLDER } };
    }
    if (name === "activate_project") {
      return textResponse(activationReceipt(project.projectName, project.projectPath));
    }
    if (name === "list_memories") {
      return textResponse(JSON.stringify({ memories: [...memories.keys()] }));
    }
    if (name === "write_memory") {
      memories.set(args.memory_name, args.content);
      return textResponse(`Memory ${args.memory_name} written.`);
    }
    if (name === "read_memory") {
      const content = memories.get(args.memory_name);
      if (typeof content !== "string") throw new Error("synthetic_missing_lifecycle_memory");
      return textResponse(content);
    }
    throw new Error("unexpected_lifecycle_operation");
  };
  const client = createSerenaLifecycleClient({
    call,
    advertisedTools: advertisedTools({ sessionArgument: "session_id" }),
    project,
    inspectProject: async () => project,
    inspectMemory: async () => project,
  });
  const provider = createSerenaLifecycleProvider({
    client,
    project,
    now: () => new Date("2026-10-15T12:00:00.000Z"),
    acquireLease: async () => ({
      release: async () => {
        released += 1;
      },
    }),
  });

  const stored = await provider.persist(lifecycleRequest());
  assert.equal(stored.status, "verified");
  if (stored.status !== "verified") return;
  const reread = await provider.get(stored.reference);

  assert.equal(reread.status, "verified");
  assert.equal(calls.filter(({ name }) => name === "write_memory").length, 1);
  assert.equal(memories.size, 1);
  assert.equal(released, 1);
  assert.deepEqual(calls.map(({ name, argumentNames, usesExpectedSession, timeout }) => ({
    name,
    argumentNames,
    usesExpectedSession,
    timeout,
  })), [
    {
      name: "initial_instructions",
      argumentNames: [],
      usesExpectedSession: true,
      timeout: 300_000,
    },
    {
      name: "activate_project",
      argumentNames: ["project", "session_id"],
      usesExpectedSession: true,
      timeout: 300_000,
    },
    {
      name: "list_memories",
      argumentNames: ["session_id"],
      usesExpectedSession: true,
      timeout: 300_000,
    },
    {
      name: "write_memory",
      argumentNames: ["content", "memory_name", "session_id"],
      usesExpectedSession: true,
      timeout: 300_000,
    },
    {
      name: "read_memory",
      argumentNames: ["memory_name", "session_id"],
      usesExpectedSession: true,
      timeout: 300_000,
    },
    {
      name: "activate_project",
      argumentNames: ["project", "session_id"],
      usesExpectedSession: true,
      timeout: 300_000,
    },
    {
      name: "list_memories",
      argumentNames: ["session_id"],
      usesExpectedSession: true,
      timeout: 300_000,
    },
    {
      name: "read_memory",
      argumentNames: ["memory_name", "session_id"],
      usesExpectedSession: true,
      timeout: 300_000,
    },
  ]);
  assert.doesNotMatch(JSON.stringify({
    stored: stored.status,
    reread: reread.status,
    calls: calls.map(({ name, argumentNames }) => ({ name, argumentNames })),
  }), /synthetic-nonsecret-session-placeholder/);
});

test("session-aware lifecycle never retries an uncertain write dispatch", async () => {
  const project = createSerenaLifecycleProject({
    projectName: "synthetic-uncertain-lifecycle",
    projectPath: "/workspace/synthetic-uncertain-lifecycle",
  });
  assert.ok(project);

  const calls = [];
  const client = createSerenaLifecycleClient({
    call: async (name, args) => {
      calls.push(name);
      const usesExpectedSession = name === "initial_instructions"
        ? !Object.hasOwn(args, "session_id")
        : args.session_id === NON_SECRET_SESSION_PLACEHOLDER;
      if (!usesExpectedSession) throw new Error("synthetic_uncertain_session_mismatch");
      if (name === "initial_instructions") {
        return { structuredContent: { session_id: NON_SECRET_SESSION_PLACEHOLDER } };
      }
      if (name === "activate_project") {
        return textResponse(activationReceipt(project.projectName, project.projectPath));
      }
      if (name === "list_memories") return textResponse(JSON.stringify({ memories: [] }));
      if (name === "write_memory") return textResponse("synthetic uncertain receipt");
      throw new Error("unexpected_uncertain_lifecycle_operation");
    },
    advertisedTools: advertisedTools({ sessionArgument: "session_id" }),
    project,
    inspectProject: async () => project,
    inspectMemory: async () => project,
  });
  const provider = createSerenaLifecycleProvider({
    client,
    project,
    now: () => new Date("2026-10-15T12:00:00.000Z"),
    acquireLease: async () => ({ release: async () => undefined }),
  });

  const result = await provider.persist(lifecycleRequest());

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "serena_memory_write_unknown");
  assert.deepEqual(calls, [
    "initial_instructions",
    "activate_project",
    "list_memories",
    "write_memory",
  ]);
  assert.equal(calls.filter((name) => name === "write_memory").length, 1);
});

test("package-owned delegation bootstrap rejects missing or unsafe fixed checkout configuration", async () => {
  const base = {
    cwd: "/tmp",
    model: {},
    modelRuntime: {},
    sessionManager: {},
  };

  await assert.rejects(
    createMcpChildRuntime({ ...base, tools: [SERENA_BOOTSTRAP_TOOL] }),
    /serena_bootstrap_project_required/,
  );
  await assert.rejects(
    createMcpChildRuntime({
      ...base,
      tools: [],
      serenaBootstrapProject: "/workspace/synthetic-delegated-checkout",
    }),
    /serena_bootstrap_without_tool/,
  );
  await assert.rejects(
    createMcpChildRuntime({
      ...base,
      tools: [SERENA_BOOTSTRAP_TOOL],
      serenaBootstrapProject: "relative-checkout",
    }),
    /serena_bootstrap_project_required/,
  );
});

test("missing listed Serena memories remain missing and never cause a write", async () => {
  const calls = [];
  const result = await coordinateContext(contextRequest(), ROOT, {
    canonical: async (path) => path,
    session: async (_server, callback) => callback(async (name, args) => {
      calls.push(name);
      if (name === "activate_project") return textResponse(activationReceipt("legacy", args.project));
      if (name === "initial_instructions") return textResponse("legacy instructions");
      if (name === "list_memories") return textResponse(JSON.stringify({ memories: ["core"] }));
      if (name === "read_memory" && args.memory_name === "core") return textResponse("core memory");
      throw new Error("unexpected_missing_memory_operation");
    }),
  });

  assert.equal(result.status, "degraded");
  assert.deepEqual(result.serena.missingRequiredMemories, CONTEXT_MEMORIES.slice(1));
  assert.deepEqual(calls, [
    "activate_project",
    "initial_instructions",
    "list_memories",
    "read_memory",
  ]);
  assert.equal(calls.includes("write_memory"), false);
});

test("TEST-101 includes memory_maintenance in standard Serena context hydration", async () => {
  const reads = [];
  const calls = [];
  const result = await coordinateContext(contextRequest(), ROOT, {
    canonical: async (path) => path,
    session: async (_server, callback) => callback(async (name, args) => {
      calls.push(name);
      if (name === "activate_project") return textResponse(activationReceipt("legacy", args.project));
      if (name === "initial_instructions") return textResponse("legacy instructions");
      if (name === "list_memories") {
        return textResponse(JSON.stringify({
          memories: CONTEXT_MEMORIES,
        }));
      }
      if (name === "read_memory") {
        reads.push(args.memory_name);
        return textResponse(`${args.memory_name} memory`);
      }
      throw new Error("unexpected_memory_maintenance_operation");
    }),
  });

  assert.deepEqual({
    memoryMaintenanceRead: reads.includes(MEMORY_MAINTENANCE),
    memoryMaintenanceStatus: result.serena.memories[MEMORY_MAINTENANCE]?.status ?? "absent",
    writes: calls.filter((name) => name === "write_memory").length,
  }, {
    memoryMaintenanceRead: true,
    memoryMaintenanceStatus: "loaded",
    writes: 0,
  });
});
