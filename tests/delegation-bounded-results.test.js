import assert from "node:assert/strict";
import test from "node:test";
import {
  boundDelegationSummary,
  buildDelegationToolPayload,
  createDelegationResult,
  DELEGATION_RESULT_MAX_BYTES,
  DELEGATION_RESULT_MAX_LINES,
  DELEGATION_SUMMARY_MAX_BYTES,
  DELEGATION_SUMMARY_MAX_LINES,
} from "../lib/ima-delegation.ts";

const countLines = (text) => text ? text.split(/\r\n|\r|\n/).length : 0;

const session = (id, resumeReference = id) => ({
  id,
  file: `/sessions/${id}.jsonl`,
  resumeReference,
});

const result = (id, report, overrides = {}) => createDelegationResult({
  id,
  status: "succeeded",
  attempts: 1,
  provider: "provider",
  model: "model",
  report,
  session: session(id),
  ...overrides,
});

test("preserves reports at exact line and byte boundaries", () => {
  const exactLines = Array.from({ length: DELEGATION_SUMMARY_MAX_LINES }, () => "line").join("\n");
  const lineBoundary = boundDelegationSummary(exactLines);
  assert.equal(lineBoundary.summary, exactLines);
  assert.equal(lineBoundary.truncated, false);
  assert.equal(lineBoundary.lines, DELEGATION_SUMMARY_MAX_LINES);

  const exactBytes = "a".repeat(DELEGATION_SUMMARY_MAX_BYTES);
  const byteBoundary = boundDelegationSummary(exactBytes);
  assert.equal(byteBoundary.summary, exactBytes);
  assert.equal(byteBoundary.truncated, false);
  assert.equal(byteBoundary.bytes, DELEGATION_SUMMARY_MAX_BYTES);

  const exactCarriageReturns = Array.from({ length: DELEGATION_SUMMARY_MAX_LINES }, () => "line").join("\r");
  const carriageReturnBoundary = boundDelegationSummary(exactCarriageReturns);
  assert.equal(carriageReturnBoundary.summary, exactCarriageReturns);
  assert.equal(carriageReturnBoundary.truncated, false);
  assert.equal(carriageReturnBoundary.lines, DELEGATION_SUMMARY_MAX_LINES);
  assert.equal(carriageReturnBoundary.bytes, Buffer.byteLength(exactCarriageReturns, "utf8"));

  const exactCrLf = ["first", "second", "third"].join("\r\n");
  const crLfBoundary = boundDelegationSummary(exactCrLf);
  assert.equal(crLfBoundary.summary, exactCrLf);
  assert.equal(crLfBoundary.truncated, false);
  assert.equal(crLfBoundary.lines, 3);
});

test("bounds line and UTF-8 byte overflows with one safe session-pointer notice", () => {
  const overLines = Array.from({ length: DELEGATION_SUMMARY_MAX_LINES + 1 }, () => "line").join("\n");
  const lineResult = boundDelegationSummary(overLines);
  assert.equal(lineResult.truncated, true);
  assert.ok(countLines(lineResult.summary) <= DELEGATION_SUMMARY_MAX_LINES);
  assert.ok(Buffer.byteLength(lineResult.summary, "utf8") <= DELEGATION_SUMMARY_MAX_BYTES);
  assert.match(lineResult.summary, /structured child-session pointer.*when available/);
  assert.doesNotMatch(lineResult.summary, /\/sessions\//);

  const overCarriageReturns = Array.from({ length: DELEGATION_SUMMARY_MAX_LINES + 1 }, () => "line").join("\r");
  const carriageReturnResult = boundDelegationSummary(overCarriageReturns);
  assert.equal(carriageReturnResult.truncated, true);
  assert.equal(carriageReturnResult.lines, DELEGATION_SUMMARY_MAX_LINES + 1);
  assert.equal(carriageReturnResult.bytes, Buffer.byteLength(overCarriageReturns, "utf8"));
  assert.ok(countLines(carriageReturnResult.summary) <= DELEGATION_SUMMARY_MAX_LINES);
  assert.ok(Buffer.byteLength(carriageReturnResult.summary, "utf8") <= DELEGATION_SUMMARY_MAX_BYTES);
  assert.equal(new TextDecoder().decode(Buffer.from(carriageReturnResult.summary, "utf8")), carriageReturnResult.summary);

  const overCrLf = Array.from({ length: DELEGATION_SUMMARY_MAX_LINES + 1 }, () => "line").join("\r\n");
  const crLfResult = boundDelegationSummary(overCrLf);
  assert.equal(crLfResult.truncated, true);
  assert.equal(crLfResult.lines, DELEGATION_SUMMARY_MAX_LINES + 1);
  assert.ok(countLines(crLfResult.summary) <= DELEGATION_SUMMARY_MAX_LINES);
  assert.ok(Buffer.byteLength(crLfResult.summary, "utf8") <= DELEGATION_SUMMARY_MAX_BYTES);

  const unicode = "😀".repeat(DELEGATION_SUMMARY_MAX_BYTES);
  const byteResult = boundDelegationSummary(unicode);
  assert.equal(byteResult.truncated, true);
  assert.ok(Buffer.byteLength(byteResult.summary, "utf8") <= DELEGATION_SUMMARY_MAX_BYTES);
  assert.equal(new TextDecoder().decode(Buffer.from(byteResult.summary, "utf8")), byteResult.summary);
});

test("projects verified and unverified reports without public raw-report fields", () => {
  const verified = result("verified", "## Files\nlib/ima-delegation.ts\n\n## Verification\npassed");
  assert.equal(verified.summaryTruncated, false);
  assert.equal(verified.summary, "## Files\nlib/ima-delegation.ts\n\n## Verification\npassed");
  assert.equal(verified.summaryBytes, Buffer.byteLength(verified.summary, "utf8"));
  assert.deepEqual(verified.session, session("verified"));
  assert.equal(Object.hasOwn(verified, "report"), false);
  assert.equal(Object.hasOwn(verified, "unverifiedReport"), false);

  const unverified = createDelegationResult({
    id: "unverified",
    status: "failed",
    attempts: 1,
    error: "runtime_identity_mismatch",
    failure: "agent-contract",
    report: "Child prose remains unverified.",
    unverifiedReason: "runtime_identity_mismatch",
    session: session("unverified", null),
  });
  assert.equal(unverified.summary, "Child prose remains unverified.");
  assert.equal(unverified.unverifiedReason, "runtime_identity_mismatch");
  assert.deepEqual(unverified.session, session("unverified", null));

  const incompletePointer = createDelegationResult({
    id: "incomplete-pointer",
    status: "failed",
    report: "x".repeat(DELEGATION_SUMMARY_MAX_BYTES * 2),
    session: { id: "only-id" },
  });
  assert.equal(incompletePointer.session, null);
  assert.equal(incompletePointer.summaryTruncated, true);
  assert.ok(Buffer.byteLength(incompletePointer.summary, "utf8") <= DELEGATION_SUMMARY_MAX_BYTES);
  assert.ok(countLines(incompletePointer.summary) <= DELEGATION_SUMMARY_MAX_LINES);
  assert.match(incompletePointer.summary, /when available/);
  assert.doesNotMatch(incompletePointer.summary, /\/sessions\//);
});

test("preserves resume references only for verified successful results", () => {
  const cases = [
    { id: "failed", status: "failed" },
    { id: "cancelled", status: "cancelled" },
    { id: "unverified", status: "succeeded", unverifiedReason: "runtime_identity_mismatch" },
  ];
  for (const input of cases) {
    const projected = createDelegationResult({
      ...input,
      attempts: 1,
      report: "Terminal report.",
      session: session(input.id, "resume-me"),
    });
    assert.deepEqual(projected.session, {
      id: input.id,
      file: `/sessions/${input.id}.jsonl`,
      resumeReference: null,
    });
  }

  const verified = createDelegationResult({
    id: "verified-success",
    status: "succeeded",
    attempts: 1,
    report: "Terminal report.",
    session: session("verified-success", "resume-me"),
  });
  assert.equal(verified.session?.resumeReference, "resume-me");
});

test("keeps four escaped child summaries valid and within Pi's aggregate ceiling", () => {
  const escapedReport = Array.from(
    { length: DELEGATION_SUMMARY_MAX_LINES },
    () => '"\\\u2028'.repeat(100),
  ).join("\n");
  const results = Array.from({ length: 4 }, (_, index) => result(`child-${index}`, escapedReport));
  const payload = buildDelegationToolPayload({
    status: "succeeded",
    results,
    report: { state: "succeeded" },
  });
  const parsed = JSON.parse(payload.serialized);

  assert.equal(payload.overflow, false);
  assert.ok(Buffer.byteLength(payload.serialized, "utf8") <= DELEGATION_RESULT_MAX_BYTES);
  assert.equal(payload.serialized.includes("\n"), false);
  assert.equal(payload.serialized.includes("\u2028"), false);
  assert.match(payload.serialized, /\\u2028/);
  assert.ok(parsed.results.some((child, index) => Buffer.byteLength(child.summary, "utf8") < Buffer.byteLength(results[index].summary, "utf8")));
  assert.deepEqual(parsed.results.map((child) => child.id), ["child-0", "child-1", "child-2", "child-3"]);
  assert.deepEqual(parsed.results.map((child) => child.session.id), ["child-0", "child-1", "child-2", "child-3"]);
  assert.ok(parsed.results.every((child) => child.summaryTruncated));
  assert.ok(parsed.results.every((child) => !Object.hasOwn(child, "report") && !Object.hasOwn(child, "unverifiedReport")));
  assert.ok(parsed.results.reduce((total, child) => total + countLines(child.summary), 0) <= DELEGATION_RESULT_MAX_LINES);
});

test("fails closed when child result metadata alone exceeds the aggregate ceiling", () => {
  const oversized = "x".repeat(DELEGATION_RESULT_MAX_BYTES);
  const payload = buildDelegationToolPayload({
    status: "failed",
    results: [{ id: "child", status: "failed", attempts: 1, error: oversized, session: null }],
    report: { state: "failed" },
  });
  const parsed = JSON.parse(payload.serialized);

  assert.equal(payload.overflow, true);
  assert.equal(parsed.error, "delegation_result_overflow");
  assert.equal(payload.serialized.includes(oversized), false);
  assert.ok(Buffer.byteLength(payload.serialized, "utf8") <= DELEGATION_RESULT_MAX_BYTES);
});

test("fails closed when the parent report cannot fit the aggregate ceiling", () => {
  const payload = buildDelegationToolPayload({
    status: "succeeded",
    results: [],
    report: { oversized: "x".repeat(DELEGATION_RESULT_MAX_BYTES) },
  });
  const parsed = JSON.parse(payload.serialized);

  assert.equal(payload.overflow, true);
  assert.equal(parsed.status, "failed");
  assert.equal(parsed.error, "delegation_result_overflow");
  assert.deepEqual(parsed.results, []);
  assert.ok(Buffer.byteLength(payload.serialized, "utf8") <= DELEGATION_RESULT_MAX_BYTES);
});
