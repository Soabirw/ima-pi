import assert from "node:assert/strict";
import test from "node:test";
import {
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_DIGEST,
  VECTOR_NAME,
  VECTOR_SIZE,
  classifyTransportError,
  corpusFailure,
} from "../lib/qdrant-corpus.ts";
import { requestJson } from "../lib/qdrant-http-boundary.ts";
import { createQdrantCorpusClient } from "../lib/qdrant-http.ts";
import { corpusPreflight, preflightOutcome } from "../lib/vestige-migrate-dry-run.ts";

const environment = {
  IMA_QDRANT_URL: "http://qdrant.test",
  IMA_OLLAMA_URL: "http://ollama.test",
};

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", ...headers },
});

const collection = () => ({
  result: {
    config: {
      params: {
        vectors: {
          [VECTOR_NAME]: { size: VECTOR_SIZE, distance: "Cosine" },
        },
      },
    },
    payload_schema: {},
  },
});

const successfulResponse = (request) => {
  if (request.hostname === "qdrant.test" && request.pathname === "/") {
    return json({ version: "1.17.1" });
  }
  if (request.hostname === "qdrant.test") return json(collection());
  if (request.hostname === "ollama.test" && request.pathname === "/api/tags") {
    return json({ models: [{ name: EMBEDDING_MODEL, digest: EMBEDDING_MODEL_DIGEST }] });
  }
  throw new Error(`unexpected request: ${request.pathname}`);
};

const failure = (code, context) => corpusFailure(code, context);

const transportError = (code, message) =>
  Object.assign(new Error(message), { cause: { code } });

const snapshotRequest = (fetcher, maxAttempts) => requestJson({
  fetcher,
  endpoint: environment.IMA_QDRANT_URL,
  path: "collections/ima-institutional-memory/snapshots",
  method: "POST",
  body: {},
  timeoutMs: 100,
  maximumResponseBytes: 1_024,
  unavailableCode: "qdrant_unavailable",
  operation: "institutional_collection",
  ...(maxAttempts === undefined ? {} : { maxAttempts }),
});

test("transport classification uses only fixed allow-listed causes", () => {
  for (const [code, expected] of [
    ["ECONNREFUSED", "transport_connect"],
    ["ECONNRESET", "transport_reset"],
    ["UND_ERR_SOCKET", "transport_reset"],
    ["other side closed", "transport_reset"],
    ["ECONNABORTED", "transport_closed"],
    ["premature close", "transport_closed"],
  ]) {
    assert.equal(classifyTransportError(transportError(code, "classification-secret")), expected);
  }
  assert.equal(classifyTransportError(new Error("classification-secret")), "transport_other");
});

test("corpus failures retain only allow-listed diagnostic context", () => {
  const valid = failure("qdrant_unavailable", {
    operation: "institutional_collection",
    cause: "http_status",
    httpStatus: 503,
  });
  assert.deepEqual(valid.error.context, {
    operation: "institutional_collection",
    cause: "http_status",
    httpStatus: 503,
  });

  const rejected = failure("qdrant_unavailable", {
    operation: "https://secret.example",
    cause: "transport",
  });
  assert.equal(rejected.error.context, undefined);
  assert.doesNotMatch(JSON.stringify(rejected), /secret/);
});

test("preflight classifies invalid endpoint configuration without exposing its value", async () => {
  const secret = "file:///operator-secret";
  let calls = 0;
  const client = createQdrantCorpusClient({
    env: { IMA_QDRANT_URL: secret, IMA_OLLAMA_URL: "http://ollama.test" },
    fetch: async (input) => {
      calls += 1;
      return successfulResponse(new URL(String(input)));
    },
  });

  const result = await client.preflight();
  assert.equal(result.success, true);
  assert.deepEqual(result.data.endpointConfiguration, failure("qdrant_unavailable", {
    operation: "endpoint_configuration",
    cause: "invalid_configuration",
  }));
  assert.deepEqual(result.data.qdrantServiceAndVersion, failure("qdrant_unavailable", {
    operation: "endpoint_configuration",
    cause: "invalid_configuration",
  }));
  assert.equal(result.data.ollamaEmbeddingModel.success, true);
  assert.deepEqual(result.data.institutionalCollection, failure("qdrant_unavailable", {
    operation: "endpoint_configuration",
    cause: "invalid_configuration",
  }));
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /operator-secret|file:/);
});

test("preflight keeps Ollama and collection checks independent of a Qdrant transport failure", async () => {
  const secret = "transport-secret";
  const calls = [];
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async (input) => {
      const request = new URL(String(input));
      calls.push(`${request.hostname}${request.pathname}`);
      if (request.hostname === "qdrant.test" && request.pathname === "/") {
        throw new Error(secret);
      }
      return successfulResponse(request);
    },
  });

  const result = await client.preflight();
  assert.equal(result.success, true);
  assert.deepEqual(result.data.qdrantServiceAndVersion, failure("qdrant_unavailable", {
    operation: "qdrant_version",
    cause: "transport_other",
  }));
  assert.equal(result.data.ollamaEmbeddingModel.success, true);
  assert.equal(result.data.institutionalCollection.success, true);
  assert.deepEqual(calls.sort(), [
    "ollama.test/api/tags",
    "qdrant.test/",
    "qdrant.test/collections/ima-institutional-memory",
  ]);
  assert.doesNotMatch(JSON.stringify(result), /transport-secret|qdrant\.test/);
});

test("preflight distinguishes Qdrant timeouts without exposing thrown transport text", async () => {
  const secret = "timeout-secret";
  const client = createQdrantCorpusClient({
    env: environment,
    timeoutMs: 5,
    fetch: async (input, init = {}) => {
      const request = new URL(String(input));
      if (request.hostname === "qdrant.test" && request.pathname === "/") {
        return new Promise((_resolve, reject) => {
          const abort = () => reject(new Error(secret));
          if (init.signal?.aborted) abort();
          else init.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return successfulResponse(request);
    },
  });

  const result = await client.preflight();
  assert.equal(result.success, true);
  assert.deepEqual(result.data.qdrantServiceAndVersion, failure("qdrant_unavailable", {
    operation: "qdrant_version",
    cause: "timeout",
  }));
  assert.equal(result.data.ollamaEmbeddingModel.success, true);
  assert.equal(result.data.institutionalCollection.success, true);
  assert.doesNotMatch(JSON.stringify(result), /timeout-secret/);
});

test("preflight reports a bounded institutional collection HTTP failure", async () => {
  const secret = "body-secret";
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async (input) => {
      const request = new URL(String(input));
      if (request.hostname === "qdrant.test" && request.pathname.includes("collections/")) {
        return new Response(secret, { status: 503 });
      }
      return successfulResponse(request);
    },
  });

  const result = await client.preflight();
  assert.equal(result.success, true);
  assert.deepEqual(result.data.institutionalCollection, failure("qdrant_unavailable", {
    operation: "institutional_collection",
    cause: "http_status",
    httpStatus: 503,
  }));
  assert.doesNotMatch(JSON.stringify(result), /body-secret/);
});

test("preflight identifies malformed and oversized responses without provider content", async () => {
  const secret = "response-secret";
  const responses = [
    () => new Response(secret, { status: 200 }),
    () => new Response(JSON.stringify({ version: "1.17.1" }), {
      status: 200,
      headers: { "content-length": "1024" },
    }),
  ];

  for (const response of responses) {
    const client = createQdrantCorpusClient({
      env: environment,
      maxResponseBytes: 64,
      fetch: async () => response(),
    });
    const result = await client.preflight();
    assert.equal(result.success, true);
    assert.deepEqual(result.data.qdrantServiceAndVersion, failure("response_invalid", {
      operation: "qdrant_version",
      cause: "invalid_response",
    }));
    assert.doesNotMatch(JSON.stringify(result), /response-secret/);
  }
});

test("preflight accepts only bounded complete Qdrant versions", async () => {
  const preflightForVersion = async (version) => {
    const client = createQdrantCorpusClient({
      env: environment,
      fetch: async (input) => {
        const request = new URL(String(input));
        return request.hostname === "qdrant.test" && request.pathname === "/"
          ? json({ version })
          : successfulResponse(request);
      },
    });
    return client.preflight();
  };

  const valid = await preflightForVersion("1.17.1");
  assert.equal(valid.success, true);
  assert.deepEqual(valid.data.qdrantServiceAndVersion, { success: true, data: "1.17.1" });

  const belowMinimum = await preflightForVersion("1.15.9");
  assert.equal(belowMinimum.success, true);
  assert.deepEqual(belowMinimum.data.qdrantServiceAndVersion, failure("qdrant_version_unsupported", {
    operation: "qdrant_version",
    cause: "incompatible",
  }));

  for (const version of [
    "1.17.1-version-secret",
    "1.17.1-beta",
    "1.17.1\0",
    "1.17.1.0",
    `1.${"9".repeat(10)}.1`,
    "9".repeat(33),
  ]) {
    const result = await preflightForVersion(version);
    assert.equal(result.success, true);
    assert.deepEqual(result.data.qdrantServiceAndVersion, failure("response_invalid", {
      operation: "qdrant_version",
      cause: "invalid_response",
    }));
    assert.equal(preflightOutcome(corpusPreflight(result.data).checks), "NOT_READY");
    assert.equal(JSON.stringify(result).includes(version), false);
  }
});

test("caller cancellation remains aborted and performs no diagnostic request", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async () => {
      calls += 1;
      return json({});
    },
  });

  assert.deepEqual(await client.preflight(controller.signal), failure("aborted"));
  assert.equal(calls, 0);
});

test("defaults a pre-send reset to one attempt", async () => {
  const secret = "default-retry-secret";
  let calls = 0;
  const result = await snapshotRequest(async () => {
    calls += 1;
    throw transportError("ECONNRESET", secret);
  });

  assert.deepEqual(result, failure("qdrant_unavailable", {
    operation: "institutional_collection",
    cause: "transport_reset",
  }));
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /default-retry-secret|qdrant\.test/);
});

test("retries one pre-send reset only with maxAttempts two", async () => {
  const secret = "retry-secret";
  let calls = 0;
  const result = await snapshotRequest(async () => {
    calls += 1;
    if (calls === 1) throw transportError("ECONNRESET", secret);
    return json({ result: "recovered" });
  }, 2);

  assert.deepEqual(result, {
    success: true,
    data: { status: 200, body: { result: "recovered" } },
  });
  assert.equal(calls, 2);
  assert.doesNotMatch(JSON.stringify(result), /retry-secret|qdrant\.test/);
});

test("maxAttempts one returns a precise connection cause without retrying", async () => {
  const secret = "connect-secret";
  let calls = 0;
  const result = await snapshotRequest(async () => {
    calls += 1;
    throw transportError("ECONNREFUSED", secret);
  }, 1);

  assert.deepEqual(result, failure("qdrant_unavailable", {
    operation: "institutional_collection",
    cause: "transport_connect",
  }));
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /connect-secret|qdrant\.test/);
});

test("invalid maxAttempts falls back to one attempt", async () => {
  const secret = "invalid-retry-secret";
  let calls = 0;
  const result = await snapshotRequest(async () => {
    calls += 1;
    throw transportError("ECONNRESET", secret);
  }, 3);

  assert.deepEqual(result, failure("qdrant_unavailable", {
    operation: "institutional_collection",
    cause: "transport_reset",
  }));
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /invalid-retry-secret|qdrant\.test/);
});

test("does not retry a response-body transport failure", async () => {
  const secret = "body-transport-secret";
  let calls = 0;
  const body = new ReadableStream({
    start(controller) {
      controller.error(transportError("ECONNRESET", secret));
    },
  });
  const result = await snapshotRequest(async () => {
    calls += 1;
    return new Response(body, { status: 200 });
  });

  assert.deepEqual(result, failure("qdrant_unavailable", {
    operation: "institutional_collection",
    cause: "transport_reset",
  }));
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /body-transport-secret|qdrant\.test/);
});
