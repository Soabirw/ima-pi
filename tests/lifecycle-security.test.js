import assert from "node:assert/strict";
import test from "node:test";
import {
  createLifecycleContentAdjudicator,
  screenLifecycleContent,
} from "../lib/ima-lifecycle-security.ts";

const warningRequest = (artifact = "Bearer test-token-value") => ({
  type: "implementation",
  identity: {
    project: "ima-pi",
    lifecycleKey: "ima-pi:plane:ima:SKYNET-237",
    lifecycleRootMemoryId: "00000000-0000-5000-8000-000000000237",
    taskwarriorProject: "",
    taskwarriorTask: "",
    taskwarriorUuid: "",
    jiraKey: "",
    planeWorkspace: "ima",
    planeWorkItem: "SKYNET-237",
    sourceRefs: ["plane:ima:SKYNET-237"],
    priorArtifactIds: [],
  },
  summary: "Implementation content screening is ready for review.",
  artifact,
  provider: "qdrant",
});

test("allows ordinary conceptual security prose and explicit non-value placeholders", () => {
  const cases = [
    "The API accepts bearer tokens and never logs credential values.",
    "Authorization: Bearer <access-token>",
    "Authorization: Basic <credentials>",
    "Bearer ${tokenId}:${tokenSecret}",
    "API key: [redacted]",
  ];

  for (const artifact of cases) {
    assert.deepEqual(screenLifecycleContent(warningRequest(artifact)), {
      tier: "allow",
      findings: [],
    }, artifact);
  }
});

test("allows bounded conceptual Bearer scheme prose without treating it as a value", () => {
  for (const artifact of [
    "The Bearer authentication scheme is documented for this API.",
    "Use the Bearer scheme when describing the authentication model.",
    "The Basic authentication scheme is documented for this API.",
    "Basic authentication is documented for this API.",
    "Basic enabled authentication remains available.",
  ]) {
    assert.deepEqual(screenLifecycleContent(warningRequest(artifact)), {
      tier: "allow",
      findings: [],
    }, artifact);
  }
});

test("allows exact comma-delimited lowercase bearer-role prose without weakening blocks", () => {
  const exactText = "AC1: HTTPS, query-token webhook, bearer administrator, internal coordinator...";
  assert.deepEqual(screenLifecycleContent(warningRequest(exactText)), {
    tier: "allow",
    findings: [],
  });
  assert.deepEqual(screenLifecycleContent({
    ...warningRequest("Ordinary artifact."),
    summary: exactText,
  }), {
    tier: "allow",
    findings: [],
  });

  for (const artifact of [
    "Bearer administrator, internal coordinator...",
    "bearer admin-token, internal coordinator...",
    "bearer administrator",
    "Authorization: bearer administrator, internal coordinator...",
    "token: bearer administrator, internal coordinator...",
    `${exactText}; token=not-a-placeholder`,
  ]) {
    const screening = screenLifecycleContent(warningRequest(artifact));
    assert.equal(screening.tier, "block", artifact);
    assert.doesNotMatch(JSON.stringify(screening), /administrator|not-a-placeholder/, artifact);
  }
});

test("keeps populated headers, standalone values, and mixed definite material blocked", () => {
  const cases = [
    ["Authorization: Bearer authentication scheme", "bearer_credential"],
    ["Authorization: Basic opaque-value", "basic_credential"],
    ["Basic QmFzaWM6dGVzdA==", "basic_credential"],
    ["Bearer opaque-value", "bearer_credential"],
    ["Bearer authentication value", "bearer_credential"],
    ["ghp_AAAAAAAAAAAAAAAAAAAA", "token_signature"],
    ["Bearer authentication scheme; token=not-a-placeholder", "credential_assignment"],
  ];

  for (const [artifact, category] of cases) {
    const screening = screenLifecycleContent(warningRequest(artifact));
    assert.equal(screening.tier, "block", artifact);
    assert.equal(screening.findings[0].category, category, artifact);
    assert.doesNotMatch(JSON.stringify(screening), /opaque-value|not-a-placeholder/, artifact);
  }
});

test("recognizes full padded Basic candidates at explicit trailing delimiters", () => {
  const fixture = "QmFzaWM6dGVzdA==";
  for (const suffix of ["", ".", "`", " ", ",", ")"]) {
    const screening = screenLifecycleContent(warningRequest(`Basic ${fixture}${suffix}`));
    assert.deepEqual(screening, {
      tier: "block",
      findings: [{
        category: "basic_credential",
        field: "artifact",
        index: null,
        line: 1,
        column: 1,
      }],
    }, suffix || "end");
    assert.doesNotMatch(JSON.stringify(screening), /QmFzaWM6dGVzdA==/, suffix || "end");
  }
});

test("returns safe warning locations for synthetic bearer markers across bounded input fields", () => {
  const input = warningRequest();
  input.identity.sourceRefs = ["Bearer synthetic-reference"];
  const screening = screenLifecycleContent(input);

  assert.deepEqual(screening, {
    tier: "warn",
    findings: [
      {
        category: "synthetic_bearer",
        field: "identity.sourceRefs",
        index: 0,
        line: 1,
        column: 1,
      },
      {
        category: "synthetic_bearer",
        field: "artifact",
        index: null,
        line: 1,
        column: 1,
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(screening), /synthetic-reference|test-token-value/);
});

test("screens bounded routed-size content beyond 128,000 characters without truncation", () => {
  const prefix = "x".repeat(130_000);
  const warning = screenLifecycleContent(warningRequest(`${prefix} Bearer test-token-value`));
  assert.equal(warning.tier, "warn");
  assert.deepEqual(warning.findings.map(({ category, field }) => ({ category, field })), [
    { category: "synthetic_bearer", field: "artifact" },
  ]);

  const definite = screenLifecycleContent(warningRequest(`${prefix} token=not-a-placeholder`));
  assert.equal(definite.tier, "block");
  assert.equal(definite.findings[0].category, "credential_assignment");
  assert.doesNotMatch(JSON.stringify(definite), /not-a-placeholder/);

  const unsupported = screenLifecycleContent(warningRequest("x".repeat(160_001)));
  assert.deepEqual(unsupported, {
    tier: "block",
    findings: [{
      category: "unsupported_size",
      field: "artifact",
      index: null,
      line: 1,
      column: 1,
    }],
  });
});

test("fails closed when warning findings exceed the disclosed bound", () => {
  const warningLines = (count) => Array.from(
    { length: count },
    (_unused, index) => `Bearer test-warning-${index + 1}`,
  ).join("\n");
  const withinBound = screenLifecycleContent(warningRequest(warningLines(16)));
  assert.equal(withinBound.tier, "warn");
  assert.equal(withinBound.findings.length, 16);

  const overflow = screenLifecycleContent(warningRequest(warningLines(17)));
  assert.deepEqual(overflow, {
    tier: "block",
    findings: [{
      category: "finding_overflow",
      field: "artifact",
      index: null,
      line: 17,
      column: 1,
    }],
  });

  const definiteAfterWarnings = screenLifecycleContent(warningRequest([
    warningLines(17),
    "token=not-a-placeholder",
  ].join("\n")));
  assert.equal(definiteAfterWarnings.tier, "block");
  assert.equal(definiteAfterWarnings.findings[0].category, "credential_assignment");
});

test("uses block over warn and never reflects scanned content", () => {
  const screening = screenLifecycleContent(warningRequest([
    "# Implementation",
    "",
    "Bearer test-token-value",
    "-----BEGIN PRIVATE KEY-----",
  ].join("\n")));

  assert.deepEqual(screening, {
    tier: "block",
    findings: [
      {
        category: "private_key",
        field: "artifact",
        index: null,
        line: 4,
        column: 1,
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(screening), /test-token-value|PRIVATE KEY/);
});

test("blocks accessor-backed lifecycle content before it can reach validation", () => {
  const input = warningRequest("Ordinary lifecycle content.");
  let accessed = false;
  Object.defineProperty(input.identity, "sourceRefs", {
    enumerable: true,
    get: () => {
      accessed = true;
      return ["Bearer test-token-value"];
    },
  });

  assert.deepEqual(screenLifecycleContent(input), {
    tier: "block",
    findings: [{
      category: "unsafe_input",
      field: "identity.sourceRefs",
      index: null,
      line: 1,
      column: 1,
    }],
  });
  assert.equal(accessed, false);
});

test("blocks definite credential assignments before adjudication", () => {
  const screening = screenLifecycleContent(warningRequest("token=not-a-placeholder"));

  assert.deepEqual(screening, {
    tier: "block",
    findings: [
      {
        category: "credential_assignment",
        field: "artifact",
        index: null,
        line: 1,
        column: 1,
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(screening), /not-a-placeholder/);
});

test("binds one opaque pending adjudication to its owner, checkout, and stored operation", () => {
  let now = 100;
  const adjudicator = createLifecycleContentAdjudicator({
    now: () => now,
    createId: () => "00000000-0000-4000-8000-000000000237",
    maximumPending: 1,
    ttlMs: 50,
  });
  const operation = { kind: "write", request: warningRequest() };
  const pending = adjudicator.begin({
    owner: "session:owner-237",
    checkout: "checkout:ima-pi",
    operation,
  });
  assert.deepEqual(pending, {
    status: "pending",
    handle: "00000000-0000-4000-8000-000000000237",
  });
  assert.deepEqual(adjudicator.begin({
    owner: "session:owner-237",
    checkout: "checkout:ima-pi",
    operation,
  }), { status: "conflict" });
  assert.deepEqual(adjudicator.begin({
    owner: "session:other-owner",
    checkout: "checkout:other",
    operation,
  }), { status: "capacity" });

  if (pending.status !== "pending") throw new Error("pending fixture is invalid");
  assert.deepEqual(adjudicator.claim({
    handle: pending.handle,
    owner: "session:other-owner",
    checkout: "checkout:ima-pi",
  }), { status: "mismatch" });
  assert.deepEqual(adjudicator.claim({
    handle: pending.handle,
    owner: "session:owner-237",
    checkout: "checkout:ima-pi",
  }), { status: "missing" });

  now += 1;
  const next = adjudicator.begin({
    owner: "session:owner-237",
    checkout: "checkout:ima-pi",
    operation,
  });
  assert.equal(next.status, "pending");
  if (next.status !== "pending") throw new Error("pending fixture is invalid");
  const continued = adjudicator.claim({
    handle: next.handle,
    owner: "session:owner-237",
    checkout: "checkout:ima-pi",
  });
  assert.equal(continued.status, "claimed");
  if (continued.status === "claimed") {
    assert.deepEqual(continued.operation, operation);
    assert.notEqual(continued.operation, operation);
  }
});

test("covers claim expiry and atomic replay without request resubmission", () => {
  let now = 0;
  let sequence = 0;
  const adjudicator = createLifecycleContentAdjudicator({
    now: () => now,
    createId: () => `00000000-0000-4000-8000-${String(sequence += 1).padStart(12, "0")}`,
    ttlMs: 10,
  });
  const operation = { kind: "read-recall", request: { lifecycleKey: "ima-pi:plane:ima:SKYNET-237" } };
  const begin = () => adjudicator.begin({
    owner: "session:owner-237",
    checkout: "checkout:ima-pi",
    operation,
  });
  const claim = (handle) => adjudicator.claim({
    handle,
    owner: "session:owner-237",
    checkout: "checkout:ima-pi",
  });

  const claimed = begin();
  assert.equal(claimed.status, "pending");
  if (claimed.status === "pending") assert.equal(claim(claimed.handle).status, "claimed");
  if (claimed.status === "pending") assert.deepEqual(claim(claimed.handle), { status: "missing" });

  const expired = begin();
  assert.equal(expired.status, "pending");
  now = 10;
  if (expired.status === "pending") assert.deepEqual(claim(expired.handle), { status: "expired" });
});
