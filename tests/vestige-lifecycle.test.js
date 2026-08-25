import assert from "node:assert/strict";
import test from "node:test";
import { LIFECYCLE_ARTIFACT_MAXIMUM } from "../lib/ima-context.ts";
import {
  buildLifecycleDiscoveryArguments,
  parseLifecycleCandidateIds,
  readBoundedLifecycleArtifact,
  retrieveBoundedLifecycleArtifacts,
} from "../lib/vestige-lifecycle.ts";

const candidateId = (index) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

test("builds brief precise lifecycle discovery arguments", () => {
  assert.deepEqual(
    buildLifecycleDiscoveryArguments("ima-pi:taskwarrior:ima-pi:task", false),
    {
      query: "ima-pi:taskwarrior:ima-pi:task",
      mode: "lookup",
      retrieval_mode: "precise",
      detail_level: "brief",
      concrete: false,
      limit: 10,
      token_budget: 1_000,
    },
  );
});

test("parses only valid deduplicated candidate IDs within the bounded limit", () => {
  const candidates = Array.from({ length: 12 }, (_, index) => candidateId(index));
  const result = parseLifecycleCandidateIds({
    isError: false,
    structuredContent: {
      results: [
        { id: candidates[0] },
        { node: { id: candidates[1] } },
        { id: candidates[0].toUpperCase() },
        { id: "not-a-uuid" },
        ...candidates.slice(2).map((id) => ({ memory: { id } })),
      ],
    },
  });

  assert.deepEqual(result, candidates.slice(0, 10));
  assert.equal(parseLifecycleCandidateIds({ isError: true, structuredContent: { results: [] } }), null);
});

test("skips malformed, failed, and oversized candidates while preserving later bounded records", async () => {
  const failedId = candidateId(1);
  const malformedId = candidateId(2);
  const oversizedId = candidateId(3);
  const usableId = candidateId(4);
  const calls = [];
  const result = await retrieveBoundedLifecycleArtifacts({
    query: "ima-pi:taskwarrior:ima-pi:task",
    discover: async (arguments_) => {
      calls.push(["recall", arguments_]);
      return {
        isError: false,
        structuredContent: {
          results: [
            { id: failedId },
            { id: malformedId },
            { id: oversizedId },
            { id: usableId },
          ],
        },
      };
    },
    read: async (id) => {
      calls.push(["memory", id]);
      if (id === failedId) throw new Error("Connection closed");
      if (id === malformedId) {
        return {
          isError: false,
          structuredContent: {
            action: "memory",
            found: true,
            node: { id, content: "wrong action" },
          },
        };
      }
      if (id === oversizedId) {
        return {
          isError: false,
          structuredContent: {
            action: "get",
            found: true,
            node: { id, content: "x".repeat(LIFECYCLE_ARTIFACT_MAXIMUM + 1) },
          },
        };
      }
      return {
        isError: false,
        structuredContent: {
          action: "get",
          found: true,
          node: { id, content: "bounded artifact" },
        },
      };
    },
  });

  assert.deepEqual(result, {
    isError: false,
    structuredContent: { results: [{ id: usableId, content: "bounded artifact" }] },
  });
  assert.deepEqual(calls.map(([tool, value]) => [tool, typeof value === "string" ? value : value.query]), [
    ["recall", "ima-pi:taskwarrior:ima-pi:task"],
    ["memory", failedId],
    ["memory", malformedId],
    ["memory", oversizedId],
    ["memory", usableId],
  ]);
});

test("requires explicit successful get metadata before returning an exact artifact", async () => {
  const id = candidateId(4);
  const node = { id, content: "bounded artifact" };
  const invalidResponses = [
    { found: false, node },
    { found: true, node },
    { action: "memory", found: true, node },
    { action: "get", found: true, memory: node },
    { action: "get", node }
  ];

  for (const structuredContent of invalidResponses) {
    const result = await readBoundedLifecycleArtifact({
      id,
      read: async () => ({ isError: false, structuredContent }),
    });
    assert.equal(result, null);
  }

  const result = await readBoundedLifecycleArtifact({
    id,
    read: async () => ({
      isError: false,
      structuredContent: { action: "get", found: true, node },
    }),
  });
  assert.deepEqual(result, node);
});

test("requires an exact memory ID and does not retry a failed exact read", async () => {
  const requestedId = candidateId(4);
  const returnedId = candidateId(5);
  let attempts = 0;
  const result = await readBoundedLifecycleArtifact({
    id: requestedId,
    read: async () => {
      attempts += 1;
      return {
        isError: false,
        structuredContent: {
          action: "get",
          found: true,
          node: { id: returnedId, content: "wrong node" },
        },
      };
    },
  });

  assert.equal(result, null);
  assert.equal(attempts, 1);
});
