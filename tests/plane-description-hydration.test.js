import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { coordinateContext } from "../extensions/integrations.ts";
import { runPlaneApi } from "../skills/plane-api/scripts/plane-api.mjs";

const API_KEY = "synthetic-plane-api-key";
const BASE_URL = "https://plane.internal.example";
const SOURCE = { type: "plane", workspace: "ima", project: "SKYNET", sequenceId: 190 };
const REFERENCE = "plane:ima:SKYNET-190";
const WORK_ITEM_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const STATE_ID = "33333333-3333-4333-8333-333333333333";
const STANDARD_MEMORIES = ["core", "conventions", "tech_stack", "suggested_commands", "task_completion", "memory_maintenance"];

const rawWorkItem = (overrides = {}) => ({
  id: WORK_ITEM_ID,
  project: PROJECT_ID,
  sequence_id: 190,
  name: "HTML-only Plane item",
  description_html: "<p>Problem<br>Preserve <strong>requirements</strong>.</p><ul><li>One</li><li><a href=\"https://example.test\">Read context</a></li></ul>",
  state: STATE_ID,
  priority: "medium",
  assignees: [],
  labels: [],
  ...overrides,
});

const jsonResponse = (data) => ({ ok: true, status: 200, json: async () => data });

const descriptionWithSerializedByteLength = (target) => {
  const quoteCount = Math.floor((target - 2) / 2);
  const literalByteCount = target - 2 - quoteCount * 2;
  const description = "\"".repeat(quoteCount) + "x".repeat(literalByteCount);
  assert.equal(Buffer.byteLength(JSON.stringify(description), "utf8"), target);
  return description;
};

const rawWorkItemForContextByteLength = (target) => {
  const description = descriptionWithSerializedByteLength(60_000);
  const emptyNameContent = JSON.stringify({
    name: "",
    description,
    state: STATE_ID,
    reference: REFERENCE,
  });
  const nameLength = target - Buffer.byteLength(emptyNameContent, "utf8");
  assert.ok(nameLength > 0);

  const name = "N".repeat(nameLength);
  const content = JSON.stringify({
    name,
    description,
    state: STATE_ID,
    reference: REFERENCE,
  });
  assert.equal(Buffer.byteLength(content, "utf8"), target);
  return {
    description,
    rawWorkItem: rawWorkItem({
      name,
      description_stripped: description,
      description_html: undefined,
    }),
  };
};

const outputWriter = () => {
  let output = "";
  return {
    writer: { write: (chunk) => { output += chunk; } },
    output: () => output,
  };
};

const serenaActivationReceipt = (projectPath) =>
  `The project with name 'synthetic' at ${projectPath} is activated.`;

const serenaSession = async (server, callback) => {
  assert.equal(server, "serena");
  return callback(async (name, args) => {
    if (name === "activate_project") {
      return { content: [{ type: "text", text: serenaActivationReceipt(args.project) }] };
    }
    if (name === "initial_instructions") return { content: [{ type: "text", text: "instructions" }] };
    if (name === "list_memories") return { content: [{ type: "text", text: JSON.stringify({ memories: STANDARD_MEMORIES }) }] };
    if (name === "read_memory") return { content: [{ type: "text", text: `${args.memory_name} memory` }] };
    throw new Error(`unexpected Serena call ${name}`);
  });
};

const runRealPlaneGet = ({ response, captured = [] }) => async (program, args) => {
  assert.equal(program, "node");
  assert.match(args[0], /skills\/plane-api\/scripts\/plane-api\.mjs$/);
  assert.deepEqual(args.slice(1), ["plane:get", REFERENCE]);

  const stdout = outputWriter();
  const stderr = outputWriter();
  const exitCode = await runPlaneApi({
    argv: args.slice(1),
    env: { PLANE_BASE_URL: BASE_URL, PLANE_API_KEY: API_KEY },
    stdout: stdout.writer,
    stderr: stderr.writer,
    fetchImpl: async (_url, options) => {
      captured.push(options);
      return jsonResponse(response);
    },
  });

  return { exitCode, stdout: stdout.output(), stderr: stderr.output() };
};

const contextFromRealPlaneGet = async (response, captured = []) => {
  const run = runRealPlaneGet({ response, captured });
  return coordinateContext(
    { source: SOURCE },
    "/repo",
    {
      canonical: async (path) => path,
      session: serenaSession,
      run: async (program, args) => {
        const result = await run(program, args);
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(result.stderr, "");
        return JSON.parse(result.stdout);
      },
    },
  );
};

test("hydrates an HTML-only Plane response through the real helper contract", async () => {
  const requests = [];
  const result = await contextFromRealPlaneGet(rawWorkItem(), requests);

  assert.equal(result.status, "ready");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].redirect, "error");
  const content = JSON.parse(result.source.content);
  assert.equal(content.description, "Problem\nPreserve requirements.\n\n * One\n * Read context");
  assert.equal(content.description.includes("https://"), false);
  assert.equal(content.description.includes("<"), false);
});

test("does not hydrate unsupported HTML or expose source content", async () => {
  const stdout = outputWriter();
  const stderr = outputWriter();
  const exitCode = await runPlaneApi({
    argv: ["plane:get", REFERENCE],
    env: { PLANE_BASE_URL: BASE_URL, PLANE_API_KEY: API_KEY },
    stdout: stdout.writer,
    stderr: stderr.writer,
    fetchImpl: async () => jsonResponse(rawWorkItem({ description_html: "<script>source-secret</script>" })),
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.output(), "");
  assert.deepEqual(JSON.parse(stderr.output()), {
    success: false,
    error: {
      code: "DESCRIPTION_ERROR",
      message: "Plane description could not be represented safely.",
    },
  });
  assert.equal(stderr.output().includes("source-secret"), false);

  const result = await coordinateContext(
    { source: SOURCE },
    "/repo",
    {
      canonical: async (path) => path,
      session: serenaSession,
      run: async () => JSON.parse(stderr.output()),
    },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.source, null);
  assert.equal(JSON.stringify(result).includes("source-secret"), false);
});

test("does not certify empty HTML with binary content as a usable source", async () => {
  for (const descriptionHtml of ["<p> </p>", "<!-- no content -->"]) {
    const stdout = outputWriter();
    const stderr = outputWriter();
    const exitCode = await runPlaneApi({
      argv: ["plane:get", REFERENCE],
      env: { PLANE_BASE_URL: BASE_URL, PLANE_API_KEY: API_KEY },
      stdout: stdout.writer,
      stderr: stderr.writer,
      fetchImpl: async () => jsonResponse(rawWorkItem({
        description_html: descriptionHtml,
        description_binary: "source-secret",
      })),
    });

    assert.equal(exitCode, 1);
    assert.equal(stdout.output(), "");
    assert.equal(JSON.parse(stderr.output()).error.code, "DESCRIPTION_ERROR");
    assert.equal(stderr.output().includes("source-secret"), false);

    const result = await coordinateContext(
      { source: SOURCE },
      "/repo",
      {
        canonical: async (path) => path,
        session: serenaSession,
        run: async () => JSON.parse(stderr.output()),
      },
    );
    assert.equal(result.status, "failed");
    assert.equal(result.source, null);
    assert.equal(JSON.stringify(result).includes("source-secret"), false);
  }
});

test("enforces the complete Plane context byte boundary after real helper normalization", async () => {
  const normalDescription = descriptionWithSerializedByteLength(60_000);
  const normalTitleResult = await contextFromRealPlaneGet(rawWorkItem({
    description_stripped: normalDescription,
    description_html: undefined,
  }));
  assert.equal(normalTitleResult.status, "ready");
  assert.equal(JSON.parse(normalTitleResult.source.content).description, normalDescription);

  for (const target of [63_999, 64_000, 64_001]) {
    const { description, rawWorkItem: response } = rawWorkItemForContextByteLength(target);
    const result = await contextFromRealPlaneGet(response);

    if (target <= 64_000) {
      assert.equal(result.status, "ready");
      assert.equal(Buffer.byteLength(result.source.content, "utf8"), target);
      assert.equal(JSON.parse(result.source.content).description, description);
    } else {
      assert.equal(result.status, "failed");
      assert.equal(result.source, null);
    }
  }
});
