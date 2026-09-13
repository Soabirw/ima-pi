import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createSerenaLifecycleClient,
  createSerenaLifecycleProjectInspection,
  supportsSerenaLifecycleToolSchemas,
} from "../lib/serena-lifecycle-client.ts";
import { createSerenaLifecycleProvider } from "../lib/serena-lifecycle.ts";
import {
  createSerenaLifecycleProject,
  serenaLifecycleMemoryName,
} from "../lib/serena-lifecycle-record.ts";

const project = (() => {
  const value = createSerenaLifecycleProject({
    projectName: "synthetic-serena-project",
    projectPath: "/workspace/synthetic-serena-project",
  });
  assert.ok(value);
  return value;
})();
const lifecycleKey = "synthetic-project:plane:ima:TEST-1500";
const memoryName = serenaLifecycleMemoryName({
  lifecycleKey,
  phase: "plan",
  artifactId: "00000000-0000-5000-8000-000000001500",
});
const alternateMemoryName = serenaLifecycleMemoryName({
  lifecycleKey,
  phase: "implementation",
  artifactId: "00000000-0000-5000-8000-000000001501",
});
assert.ok(memoryName);
assert.ok(alternateMemoryName);

const success = (data) => ({ success: true, data });
const settledWrite = () => ({
  success: true,
  data: undefined,
  dispatch: "dispatched",
  settlement: "settled",
});
const preDispatchWriteFailure = (code = "serena_memory_write_unknown") => ({
  success: false,
  code,
  dispatch: "not_dispatched",
  settlement: "not_dispatched",
});
const dispatchedUnknown = (code = "serena_memory_write_unknown") => ({
  success: false,
  code,
  dispatch: "dispatched",
  settlement: "unknown",
});
const textResponse = (text, options = {}) => ({
  content: [{ type: "text", text }],
  ...options,
});
const advertisedTools = () => ({
  tools: [
    {
      name: "activate_project",
      inputSchema: {
        type: "object",
        properties: { project: { type: "string" } },
        required: ["project"],
      },
    },
    {
      name: "list_memories",
      inputSchema: {
        type: "object",
        properties: { topic: { type: "string" } },
        required: [],
      },
    },
    {
      name: "read_memory",
      inputSchema: {
        type: "object",
        properties: { memory_name: { type: "string" } },
        required: ["memory_name"],
      },
    },
    {
      name: "write_memory",
      inputSchema: {
        type: "object",
        properties: {
          memory_name: { type: "string" },
          content: { type: "string" },
          max_chars: { type: "integer" },
        },
        required: ["memory_name", "content"],
      },
    },
  ],
});

const activationReceipt = (value = project) =>
  `The project with name '${value.projectName}' at ${value.projectPath} is activated.`;
const activationReceiptWithInformation = (value = project) => [
  activationReceipt(value),
  "File encoding: utf-8.",
  JSON.stringify({ memories: [] }),
].join("\n");
const createdProjectReceipt = (value = project) =>
  `Created and activated a new project with name '${value.projectName}' at ${value.projectPath}.`;

const createClient = (options = {}) => {
  const clientProject = options.project ?? project;
  const calls = [];
  const inspectorCalls = [];
  const memoryInspectorCalls = [];
  const call = async (name, args, timeout) => {
    calls.push({ name, args: structuredClone(args), timeout });
    if (options.call) return options.call({ name, args, timeout, calls });
    if (name === "activate_project") return textResponse(activationReceiptWithInformation(clientProject));
    if (name === "list_memories") {
      return textResponse(JSON.stringify({
        memories: [memoryName, "core", "preferences"],
        read_only_memories: ["immutable"],
      }));
    }
    if (name === "read_memory") return textResponse("synthetic lifecycle record");
    if (name === "write_memory") return textResponse(`Memory ${args.memory_name} written.`);
    throw new Error(`unexpected tool ${name}`);
  };
  const inspectProject = async (value, signal) => {
    inspectorCalls.push({ value: structuredClone(value), signal });
    return options.inspectProject
      ? options.inspectProject(value, signal)
      : structuredClone(clientProject);
  };
  const inspectMemory = async (value, inspection, signal) => {
    memoryInspectorCalls.push({
      value: structuredClone(value),
      inspection: structuredClone(inspection),
      signal,
    });
    return options.inspectMemory
      ? options.inspectMemory(value, inspection, signal)
      : structuredClone(clientProject);
  };
  return {
    client: createSerenaLifecycleClient({
      call,
      advertisedTools: options.advertisedTools ?? advertisedTools(),
      project: clientProject,
      inspectProject,
      inspectMemory,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    }),
    calls,
    inspectorCalls,
    memoryInspectorCalls,
  };
};

const globalConfiguration = ({ projectPath, ignored = [], layout = "$projectDir/.serena", includeIgnored = true }) => [
  `project_serena_folder_location: ${JSON.stringify(layout)}`,
  "projects:",
  `  - ${JSON.stringify(projectPath)}`,
  ...(includeIgnored
    ? ignored.length === 0
      ? ["ignored_memory_patterns: []"]
      : ["ignored_memory_patterns:", ...ignored.map((pattern) => `  - ${JSON.stringify(pattern)}`)]
    : []),
  "",
].join("\n");

const projectConfiguration = ({ projectName, ignored = [], layout, includeIgnored = true }) => [
  `project_name: ${JSON.stringify(projectName)}`,
  ...(layout === undefined ? [] : [`project_serena_folder_location: ${JSON.stringify(layout)}`]),
  ...(includeIgnored
    ? ignored.length === 0
      ? ["ignored_memory_patterns: []"]
      : ["ignored_memory_patterns:", ...ignored.map((pattern) => `  - ${JSON.stringify(pattern)}`)]
    : []),
  "",
].join("\n");

const createInspectionFixture = async (t, options = {}) => {
  const root = await mkdtemp(join(tmpdir(), "ima-serena-lifecycle-"));
  const home = join(root, "home");
  const projectPath = join(root, "project");
  const projectName = "local-serena-project";
  const managedDirectory = join(projectPath, ".serena");
  const memoriesDirectory = join(managedDirectory, "memories");
  const globalConfigurationPath = join(home, ".serena", "serena_config.yml");
  const projectConfigurationPath = join(managedDirectory, "project.yml");
  const inspectedProject = createSerenaLifecycleProject({ projectName, projectPath });
  assert.ok(inspectedProject);

  await mkdir(join(home, ".serena"), { recursive: true });
  await mkdir(memoriesDirectory, { recursive: true });
  await writeFile(globalConfigurationPath, globalConfiguration({
    projectPath,
    ignored: options.globalIgnored ?? [],
    layout: options.layout,
    includeIgnored: options.includeGlobalIgnored ?? true,
  }), "utf8");
  await writeFile(projectConfigurationPath, projectConfiguration({
    projectName,
    ignored: options.projectIgnored ?? [],
    layout: options.projectLayout,
    includeIgnored: options.includeProjectIgnored ?? true,
  }), "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));

  return {
    root,
    home,
    project: inspectedProject,
    managedDirectory,
    memoriesDirectory,
    globalConfigurationPath,
    projectConfigurationPath,
    inspection: createSerenaLifecycleProjectInspection({ home: () => home }),
  };
};

const clientForInspection = (inspection, inspectedProject, options = {}) => createClient({
  ...options,
  project: inspectedProject,
  inspectProject: inspection.inspectProject,
  inspectMemory: inspection.inspectMemory,
});

test("REVIEW-001 uses the advertised compact Serena schema, exact arguments and receipts, and both listing categories", async () => {
  assert.equal(supportsSerenaLifecycleToolSchemas(advertisedTools()), true);
  const fake = createClient();

  assert.deepEqual(await fake.client.activate(structuredClone(project)), success(project));
  assert.deepEqual(await fake.client.listMemoryNames(), success([
    memoryName,
    "core",
    "preferences",
    "immutable",
  ]));
  assert.deepEqual(await fake.client.readMemory(memoryName), success("synthetic lifecycle record"));
  assert.deepEqual(await fake.client.writeMemory({
    memoryName,
    content: "synthetic lifecycle record",
  }), settledWrite());

  assert.deepEqual(fake.inspectorCalls.map(({ value }) => value), [project, project]);
  assert.deepEqual(fake.memoryInspectorCalls.map(({ inspection }) => inspection), [
    { memoryName, allowMissing: false },
    { memoryName, allowMissing: true },
  ]);
  assert.deepEqual(fake.calls, [
    { name: "activate_project", args: { project: project.projectPath }, timeout: 300_000 },
    { name: "list_memories", args: {}, timeout: 300_000 },
    { name: "read_memory", args: { memory_name: memoryName }, timeout: 300_000 },
    {
      name: "write_memory",
      args: { memory_name: memoryName, content: "synthetic lifecycle record" },
      timeout: 300_000,
    },
  ]);
});

test("REVIEW-001 rejects legacy, incomplete, paged, and ambiguous advertised schemas before MCP effects", async () => {
  const legacyRead = advertisedTools();
  legacyRead.tools[2].inputSchema = {
    type: "object",
    properties: { memory_file_name: { type: "string" } },
    required: ["memory_file_name"],
  };
  const missingTopic = advertisedTools();
  missingTopic.tools[1].inputSchema.properties = {};
  const missingMaxChars = advertisedTools();
  delete missingMaxChars.tools[3].inputSchema.properties.max_chars;
  const duplicateWrite = advertisedTools();
  duplicateWrite.tools.push(structuredClone(duplicateWrite.tools[3]));
  const paged = { ...advertisedTools(), nextCursor: "unexpected-continuation" };

  for (const schema of [
    { tools: advertisedTools().tools.slice(0, 3) },
    legacyRead,
    missingTopic,
    missingMaxChars,
    duplicateWrite,
    paged,
    { tools: "not-an-array" },
  ]) {
    assert.equal(supportsSerenaLifecycleToolSchemas(schema), false);
    const fake = createClient({ advertisedTools: schema });
    const result = await fake.client.activate(project);
    assert.deepEqual(result, { success: false, code: "serena_protocol_unsupported" });
    assert.equal(fake.calls.length, 0);
    assert.equal(fake.inspectorCalls.length, 0);
  }
});

test("REVIEW-001 accepts all native listing category combinations and rejects malformed listings", async () => {
  const supportedListings = [
    ["no categories", {}, []],
    ["writable only", { memories: [memoryName] }, [memoryName]],
    ["read-only only", { read_only_memories: ["immutable"] }, ["immutable"]],
    [
      "both categories",
      { memories: [memoryName, "core"], read_only_memories: ["immutable"] },
      [memoryName, "core", "immutable"],
    ],
  ];
  for (const [label, listing, expected] of supportedListings) {
    const fake = createClient({ call: () => textResponse(JSON.stringify(listing)) });
    assert.deepEqual(await fake.client.listMemoryNames(), success(expected), label);
  }

  const tooManyWritable = Array.from({ length: 10_001 }, (_, index) => `writable-${index}`);
  const combinedWritable = Array.from({ length: 5_001 }, (_, index) => `writable-${index}`);
  const combinedReadOnly = Array.from({ length: 5_000 }, (_, index) => `read-only-${index}`);
  const cases = [
    ["legacy raw array", textResponse(JSON.stringify([memoryName]))],
    ["unknown listing field", textResponse(JSON.stringify({ memories: [], extra: [] }))],
    ["malformed writable array", textResponse(JSON.stringify({ memories: "no" }))],
    ["malformed read-only array", textResponse(JSON.stringify({ read_only_memories: "no" }))],
    ["empty memory name", textResponse(JSON.stringify({ memories: [""] }))],
    ["unsafe memory name", textResponse(JSON.stringify({ memories: ["unsafe\u0000memory"] }))],
    ["duplicate writable memories", textResponse(JSON.stringify({ memories: [memoryName, memoryName] }))],
    ["duplicate read-only memories", textResponse(JSON.stringify({
      read_only_memories: [memoryName, memoryName],
    }))],
    ["cross-category duplicate", textResponse(JSON.stringify({
      memories: [memoryName],
      read_only_memories: [memoryName],
    }))],
    ["writable category overflow", textResponse(JSON.stringify({ memories: tooManyWritable }))],
    ["combined category overflow", textResponse(JSON.stringify({
      memories: combinedWritable,
      read_only_memories: combinedReadOnly,
    }))],
    ["multiple text blocks", { content: [{ type: "text", text: "{}" }, { type: "text", text: "{}" }] }],
    ["MCP error", textResponse("{}", { isError: true })],
    ["unexpected response field", {
      content: [{ type: "text", text: "{}" }],
      secret: "token=do-not-return",
    }],
  ];
  for (const [label, response] of cases) {
    const fake = createClient({ call: () => response });
    const result = await fake.client.listMemoryNames();
    assert.deepEqual(result, {
      success: false,
      code: "serena_memory_listing_unverifiable",
    }, label);
    assert.doesNotMatch(JSON.stringify(result), /token=|secret/i, label);
  }
});

test("REVIEW-001 accepts only the exact existing-project activation first line", async () => {
  const accepted = createClient({
    call: () => textResponse(activationReceiptWithInformation()),
  });
  assert.deepEqual(await accepted.client.activate(project), success(project));

  const wrongName = { ...project, projectName: "other-serena-project" };
  const wrongPath = { ...project, projectPath: "/workspace/other-serena-project" };
  const cases = [
    ["wrong project name", textResponse(activationReceipt(wrongName))],
    ["wrong project path", textResponse(activationReceipt(wrongPath))],
    ["newly-created project receipt", textResponse(createdProjectReceipt())],
    ["prefixed first-line lookalike", textResponse(`Notice: ${activationReceipt()}\nFile encoding: utf-8.`)],
    ["suffixed first-line lookalike", textResponse(`${activationReceipt()} Existing project.\nFile encoding: utf-8.`)],
    ["MCP error", textResponse(activationReceiptWithInformation(), { isError: true })],
  ];
  for (const [label, response] of cases) {
    const fake = createClient({ call: () => response });
    assert.deepEqual(await fake.client.activate(project), {
      success: false,
      code: "serena_project_unavailable",
    }, label);
  }
});

test("REVIEW-001 composes real client and provider without filesystem or live network over empty and read-only listings", async () => {
  const writable = new Map();
  const readOnly = new Map();
  const calls = [];
  const readResponses = [];
  const listings = [];
  const projectInspections = [];
  const memoryInspections = [];
  const leasedProjects = [];
  let clockCalls = 0;
  let releaseCalls = 0;

  const call = async (name, args, timeout) => {
    calls.push({ name, args: structuredClone(args), timeout });
    if (name === "activate_project") return textResponse(activationReceiptWithInformation());
    if (name === "list_memories") {
      const listing = readOnly.size === 0
        ? "{}"
        : JSON.stringify({ read_only_memories: [...readOnly.keys()] });
      listings.push(listing);
      return textResponse(listing);
    }
    if (name === "write_memory") {
      if (typeof args.memory_name !== "string" || typeof args.content !== "string") {
        throw new Error("invalid synthetic write arguments");
      }
      writable.set(args.memory_name, args.content);
      return textResponse(`Memory ${args.memory_name} written.`);
    }
    if (name === "read_memory") {
      const content = writable.has(args.memory_name)
        ? writable.get(args.memory_name)
        : readOnly.get(args.memory_name);
      if (typeof content !== "string") throw new Error("synthetic memory unavailable");
      readResponses.push({ memoryName: args.memory_name, content });
      return textResponse(content);
    }
    throw new Error(`unexpected synthetic tool ${name}`);
  };
  const inspectProject = async (value) => {
    projectInspections.push(structuredClone(value));
    return structuredClone(project);
  };
  const inspectMemory = async (_value, inspection) => {
    memoryInspections.push(structuredClone(inspection));
    return structuredClone(project);
  };
  const createRealClient = () => createSerenaLifecycleClient({
    call,
    advertisedTools: advertisedTools(),
    project,
    inspectProject,
    inspectMemory,
  });
  const createProvider = () => createSerenaLifecycleProvider({
    client: createRealClient(),
    project,
    now: () => {
      clockCalls += 1;
      return new Date("2026-10-15T12:00:00.000Z");
    },
    acquireLease: async (value) => {
      leasedProjects.push(structuredClone(value));
      return {
        release: async () => {
          releaseCalls += 1;
        },
      };
    },
  });
  const request = {
    type: "implementation",
    identity: {
      project: "ima-pi",
      lifecycleKey: "ima-pi:plane:ima:SKYNET-210",
      lifecycleRootMemoryId: "",
      taskwarriorProject: "",
      taskwarriorTask: "",
      taskwarriorUuid: "",
      jiraKey: "",
      planeWorkspace: "ima",
      planeWorkItem: "SKYNET-210",
      sourceRefs: ["plane:ima:SKYNET-210"],
      priorArtifactIds: ["46b08007-e96c-5112-8b3d-5bfdb3e63793"],
    },
    summary: "Synthetic real-client Serena compatibility evidence remains exact.",
    artifact: "# Synthetic acceptance\n\nNo filesystem or live network is used by this test.",
  };

  const firstProvider = createProvider();
  const stored = await firstProvider.persist(request);
  assert.equal(stored.status, "verified");
  assert.equal(stored.disposition, "stored");
  assert.deepEqual(listings, ["{}"]);
  const write = calls.find(({ name }) => name === "write_memory");
  assert.ok(write);
  const serialized = writable.get(stored.memoryName);
  assert.equal(typeof serialized, "string");
  assert.deepEqual(write.args, {
    memory_name: stored.memoryName,
    content: serialized,
  });
  assert.deepEqual(readResponses, [{ memoryName: stored.memoryName, content: serialized }]);

  readOnly.set(stored.memoryName, serialized);
  writable.delete(stored.memoryName);
  const freshProvider = createProvider();
  const retrieved = await freshProvider.get(structuredClone(stored.reference));
  assert.equal(retrieved.status, "verified");
  assert.equal(retrieved.disposition, "unchanged");
  assert.deepEqual(retrieved.reference, stored.reference);
  assert.equal(retrieved.recordKey, stored.recordKey);
  assert.equal(retrieved.artifact, stored.artifact);
  assert.deepEqual(listings, [
    "{}",
    JSON.stringify({ read_only_memories: [stored.memoryName] }),
  ]);
  assert.deepEqual(calls.map(({ name }) => name), [
    "activate_project",
    "list_memories",
    "write_memory",
    "read_memory",
    "activate_project",
    "list_memories",
    "read_memory",
  ]);
  assert.equal(calls.filter(({ name }) => name === "write_memory").length, 1);
  assert.equal(writable.has(stored.memoryName), false);
  assert.equal(readOnly.get(stored.memoryName), serialized);
  assert.equal(clockCalls, 1);
  assert.deepEqual(leasedProjects, [project]);
  assert.equal(releaseCalls, 1);
  assert.deepEqual(projectInspections, [project, project, project, project]);
  assert.deepEqual(memoryInspections, [
    { memoryName: stored.memoryName, allowMissing: true },
    { memoryName: stored.memoryName, allowMissing: false },
    { memoryName: stored.memoryName, allowMissing: false },
  ]);
});

test("requires an existing exact project and returns bounded failures for unavailable inspection or activation", async () => {
  const differentProject = createSerenaLifecycleProject({
    projectName: "other-project",
    projectPath: "/workspace/other-project",
  });
  assert.ok(differentProject);

  const mismatch = createClient();
  assert.deepEqual(await mismatch.client.activate(differentProject), {
    success: false,
    code: "serena_project_mismatch",
  });
  assert.equal(mismatch.inspectorCalls.length, 0);
  assert.equal(mismatch.calls.length, 0);

  const absent = createClient({ inspectProject: async () => null });
  assert.deepEqual(await absent.client.activate(project), {
    success: false,
    code: "serena_project_unavailable",
  });
  assert.equal(absent.calls.length, 0);

  const mismatchedInspection = createClient({ inspectProject: async () => differentProject });
  assert.deepEqual(await mismatchedInspection.client.activate(project), {
    success: false,
    code: "serena_project_unavailable",
  });
  assert.equal(mismatchedInspection.calls.length, 0);

  const unavailable = createClient({
    call: () => { throw new Error("token=synthetic-project-secret"); },
  });
  const result = await unavailable.client.activate(project);
  assert.deepEqual(result, { success: false, code: "serena_project_unavailable" });
  assert.doesNotMatch(JSON.stringify(result), /secret|token=/i);
});

test("TEST-002 fails closed for hostile inspected project evidence before activation", async () => {
  let inspectedProjectReads = 0;
  const fake = createClient({
    inspectProject: async () => {
      const hostile = {};
      Object.defineProperty(hostile, "projectName", {
        enumerable: true,
        get: () => {
          inspectedProjectReads += 1;
          throw new Error("hostile inspected project accessor");
        },
      });
      return hostile;
    },
  });

  const result = await fake.client.activate(project);
  assert.deepEqual(result, { success: false, code: "serena_project_unavailable" });
  assert.equal(inspectedProjectReads, 0);
  assert.equal(fake.calls.length, 0);
});

test("honours cancellation before and during external client I/O without a later operation", async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  const before = createClient();
  assert.deepEqual(await before.client.activate(project, preAborted.signal), {
    success: false,
    code: "aborted",
  });
  assert.equal(before.inspectorCalls.length, 0);
  assert.equal(before.calls.length, 0);

  const during = new AbortController();
  const fake = createClient({
    call: ({ name }) => {
      during.abort();
      return textResponse(name === "list_memories" ? JSON.stringify({ memories: [] }) : activationReceipt());
    },
  });
  assert.deepEqual(await fake.client.listMemoryNames(during.signal), {
    success: false,
    code: "aborted",
  });
  assert.deepEqual(fake.calls.map(({ name }) => name), ["list_memories"]);
});

test("REVIEW-003 marks cancellation or failure after write dispatch as unsettled", async () => {
  const controller = new AbortController();
  const cancelled = createClient({
    call: ({ name, args }) => {
      if (name === "write_memory") controller.abort();
      return textResponse(`Memory ${args.memory_name} written.`);
    },
  });
  assert.deepEqual(await cancelled.client.writeMemory({
    memoryName,
    content: "bounded content",
  }, controller.signal), dispatchedUnknown("aborted"));
  assert.equal(cancelled.calls.filter(({ name }) => name === "write_memory").length, 1);

  const failed = createClient({
    call: ({ name }) => {
      if (name === "write_memory") throw new Error("token=synthetic-write-secret");
      return textResponse(activationReceipt());
    },
  });
  const unknown = await failed.client.writeMemory({ memoryName, content: "bounded content" });
  assert.deepEqual(unknown, dispatchedUnknown());
  assert.equal(failed.calls.filter(({ name }) => name === "write_memory").length, 1);
  assert.doesNotMatch(JSON.stringify(unknown), /secret|token=/i);
});

test("bounds read and pre-dispatch write failures without calling MCP again", async () => {
  const read = createClient({
    call: ({ name }) => name === "read_memory"
      ? textResponse("x".repeat(200_001))
      : textResponse(activationReceipt()),
  });
  assert.deepEqual(await read.client.readMemory(memoryName), {
    success: false,
    code: "serena_memory_read_unverifiable",
  });
  assert.deepEqual(await read.client.readMemory("core"), {
    success: false,
    code: "serena_memory_read_unverifiable",
  });
  assert.equal(read.calls.length, 1);

  const writes = createClient();
  const invalid = await writes.client.writeMemory({ memoryName: "core", content: "bounded content" });
  assert.deepEqual(invalid, preDispatchWriteFailure());
  assert.equal(writes.calls.filter(({ name }) => name === "write_memory").length, 0);

  const unavailable = createClient({ inspectMemory: async () => null });
  assert.deepEqual(await unavailable.client.writeMemory({
    memoryName,
    content: "bounded content",
  }), preDispatchWriteFailure());
  assert.equal(unavailable.calls.length, 0);
});

test("TEST-001 fails closed for accessor-backed write input without calling MCP", async () => {
  const fake = createClient();
  let memoryNameReads = 0;
  const hostile = {};
  Object.defineProperty(hostile, "memoryName", {
    enumerable: true,
    get: () => {
      memoryNameReads += 1;
      throw new Error("hostile memory name accessor");
    },
  });
  Object.defineProperty(hostile, "content", {
    enumerable: true,
    get: () => "synthetic content",
  });

  const result = await fake.client.writeMemory(hostile);
  assert.deepEqual(result, preDispatchWriteFailure());
  assert.equal(memoryNameReads, 0);
  assert.equal(fake.calls.length, 0);
});

test("REVIEW-002 accepts only the default local layout, including absent write targets", async (t) => {
  const fixture = await createInspectionFixture(t, {
    includeGlobalIgnored: false,
    includeProjectIgnored: false,
  });
  const targetPath = join(fixture.memoriesDirectory, `${memoryName}.md`);
  await writeFile(targetPath, "stored lifecycle memory", "utf8");
  const fake = clientForInspection(fixture.inspection, fixture.project);

  assert.deepEqual(await fake.client.activate(fixture.project), success(fixture.project));
  assert.deepEqual(await fake.client.readMemory(memoryName), success("synthetic lifecycle record"));
  assert.deepEqual(await fake.client.readMemory(alternateMemoryName), {
    success: false,
    code: "serena_memory_read_unavailable",
  });
  assert.deepEqual(await fake.client.writeMemory({
    memoryName: alternateMemoryName,
    content: "new lifecycle memory",
  }), settledWrite());
  assert.deepEqual(fake.calls.map(({ name }) => name), [
    "activate_project",
    "read_memory",
    "write_memory",
  ]);
  await assert.rejects(lstat(join(fixture.memoriesDirectory, `${alternateMemoryName}.md`)), {
    code: "ENOENT",
  });
});

test("REVIEW-002 and REVIEW-005 reject alternative roots and malformed or active global/project filters before writes", async (t) => {
  const scenarios = [
    {
      label: "alternative global data root",
      setup: async (fixture) => writeFile(fixture.globalConfigurationPath, globalConfiguration({
        projectPath: fixture.project.projectPath,
        layout: "/central/serena-data",
      }), "utf8"),
    },
    {
      label: "alternative project data root",
      setup: async (fixture) => writeFile(fixture.projectConfigurationPath, projectConfiguration({
        projectName: fixture.project.projectName,
        layout: "/central/serena-data",
      }), "utf8"),
    },
    {
      label: "global ignored filter",
      setup: async (fixture) => writeFile(fixture.globalConfigurationPath, globalConfiguration({
        projectPath: fixture.project.projectPath,
        ignored: ["ima-serena-lifecycle-v1-.*"],
      }), "utf8"),
    },
    {
      label: "project ignored filter",
      setup: async (fixture) => writeFile(fixture.projectConfigurationPath, projectConfiguration({
        projectName: fixture.project.projectName,
        ignored: ["ima-serena-lifecycle-v1-.*"],
      }), "utf8"),
    },
    {
      label: "malformed global ignored filter",
      setup: async (fixture) => writeFile(fixture.globalConfigurationPath, [
        "project_serena_folder_location: \"$projectDir/.serena\"",
        "projects:",
        `  - ${JSON.stringify(fixture.project.projectPath)}`,
        "ignored_memory_patterns: not-a-list",
        "",
      ].join("\n"), "utf8"),
    },
    {
      label: "malformed project ignored filter",
      setup: async (fixture) => writeFile(fixture.projectConfigurationPath, [
        `project_name: ${JSON.stringify(fixture.project.projectName)}`,
        "ignored_memory_patterns: not-a-list",
        "",
      ].join("\n"), "utf8"),
    },
  ];

  for (const scenario of scenarios) {
    const fixture = await createInspectionFixture(t);
    await scenario.setup(fixture);
    const fake = clientForInspection(fixture.inspection, fixture.project);
    assert.deepEqual(await fake.client.activate(fixture.project), {
      success: false,
      code: "serena_project_unavailable",
    }, scenario.label);
    assert.deepEqual(await fake.client.writeMemory({
      memoryName,
      content: "rejected before dispatch",
    }), preDispatchWriteFailure(), scenario.label);
    const provider = createSerenaLifecycleProvider({
      client: fake.client,
      project: fixture.project,
      acquireLease: async () => null,
    });
    const recalled = await provider.recall({ lifecycleKey, limit: 1 });
    assert.equal(recalled.status, "blocked", scenario.label);
    assert.equal(recalled.code, "serena_project_unavailable", scenario.label);
    assert.equal(fake.calls.length, 0, scenario.label);
  }
});

test("REVIEW-002 rejects symlinked and missing memories directories and symlinked or inaccessible targets without MCP writes", async (t) => {
  const symlinkDirectory = await createInspectionFixture(t);
  const backingDirectory = `${symlinkDirectory.memoriesDirectory}-backing`;
  await rename(symlinkDirectory.memoriesDirectory, backingDirectory);
  await symlink(backingDirectory, symlinkDirectory.memoriesDirectory, "dir");
  const directoryClient = clientForInspection(symlinkDirectory.inspection, symlinkDirectory.project);
  assert.deepEqual(await directoryClient.client.writeMemory({
    memoryName,
    content: "blocked",
  }), preDispatchWriteFailure());
  assert.equal(directoryClient.calls.length, 0);

  const missingDirectory = await createInspectionFixture(t);
  await rm(missingDirectory.memoriesDirectory, { recursive: true, force: true });
  const missingClient = clientForInspection(missingDirectory.inspection, missingDirectory.project);
  assert.deepEqual(await missingClient.client.writeMemory({
    memoryName,
    content: "blocked",
  }), preDispatchWriteFailure());
  assert.equal(missingClient.calls.length, 0);

  const symlinkTarget = await createInspectionFixture(t);
  const targetPath = join(symlinkTarget.memoriesDirectory, `${memoryName}.md`);
  const backingTarget = join(symlinkTarget.root, "backing-memory.md");
  await writeFile(backingTarget, "backing", "utf8");
  await symlink(backingTarget, targetPath, "file");
  const targetClient = clientForInspection(symlinkTarget.inspection, symlinkTarget.project);
  assert.deepEqual(await targetClient.client.readMemory(memoryName), {
    success: false,
    code: "serena_memory_read_unavailable",
  });
  assert.deepEqual(await targetClient.client.writeMemory({
    memoryName,
    content: "blocked",
  }), preDispatchWriteFailure());
  assert.equal(targetClient.calls.length, 0);

  const inaccessibleTarget = await createInspectionFixture(t);
  const inaccessiblePath = join(inaccessibleTarget.memoriesDirectory, `${memoryName}.md`);
  const inaccessibleInspection = createSerenaLifecycleProjectInspection({
    home: () => inaccessibleTarget.home,
    lstat: async (path) => {
      if (path === inaccessiblePath) {
        const error = new Error("inaccessible target");
        error.code = "EACCES";
        throw error;
      }
      return lstat(path);
    },
  });
  const inaccessibleClient = clientForInspection(inaccessibleInspection, inaccessibleTarget.project);
  assert.deepEqual(await inaccessibleClient.client.writeMemory({
    memoryName,
    content: "blocked",
  }), preDispatchWriteFailure());
  assert.equal(inaccessibleClient.calls.length, 0);
});

test("REVIEW-002 rejects memories-directory and memory-target replacement races without MCP writes", async (t) => {
  const replacedDirectory = await createInspectionFixture(t);
  let directoryReplaced = false;
  const directoryInspection = createSerenaLifecycleProjectInspection({
    home: () => replacedDirectory.home,
    lstat: async (path) => {
      const entry = await lstat(path);
      if (path === replacedDirectory.memoriesDirectory && !directoryReplaced) {
        directoryReplaced = true;
        await rename(path, `${path}-replaced`);
        await mkdir(path);
      }
      return entry;
    },
  });
  const directoryClient = clientForInspection(directoryInspection, replacedDirectory.project);
  assert.deepEqual(await directoryClient.client.writeMemory({
    memoryName,
    content: "blocked",
  }), preDispatchWriteFailure());
  assert.equal(directoryClient.calls.length, 0);

  const replacedTarget = await createInspectionFixture(t);
  const targetPath = join(replacedTarget.memoriesDirectory, `${memoryName}.md`);
  await writeFile(targetPath, "first", "utf8");
  let targetReplaced = false;
  const targetInspection = createSerenaLifecycleProjectInspection({
    home: () => replacedTarget.home,
    lstat: async (path) => {
      const entry = await lstat(path);
      if (path === targetPath && !targetReplaced) {
        targetReplaced = true;
        await rename(path, `${path}-replaced`);
        await writeFile(path, "second", "utf8");
      }
      return entry;
    },
  });
  const targetClient = clientForInspection(targetInspection, replacedTarget.project);
  assert.deepEqual(await targetClient.client.readMemory(memoryName), {
    success: false,
    code: "serena_memory_read_unavailable",
  });
  assert.equal(targetClient.calls.length, 0);
});
