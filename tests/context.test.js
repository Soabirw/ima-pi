import assert from "node:assert/strict";
import test from "node:test";
import { derivePhaseContext, evaluateSerenaBootstrap, normalizeSourcePayload, normalizeSourceReference, sanitizeContextError, validateContextRequest } from "../lib/ima-context.ts";

const sources = [{ type: "jira", key: "FNR-3016" }, { type: "taskwarrior", project: "FNR-3007", uuid: "689fa7ac-84b7-42d0-8912-b8ef76041370" }, { type: "file", path: "README.md" }, { type: "vestige", id: "7027acec-43d3-4fa4-83ec-16e993551720" }, { type: "text", title: "Brief", content: "Approved outcome" }];
test("validates each closed context source and rejects ambiguous input", () => {
  for (const source of sources) assert.equal(validateContextRequest({ source }).valid, true);
  for (const source of [{ type: "jira", key: "not-a-key" }, { type: "taskwarrior", project: "x", uuid: "x" }, { type: "shell", command: "rm" }, { type: "text", title: "", content: "x" }]) assert.equal(validateContextRequest({ source }).valid, false);
});
test("normalizes direct and hydrated sources into the common source shape", () => {
  const direct = normalizeSourcePayload({ source: sources[4], payload: null });
  const hydrated = normalizeSourcePayload({ source: sources[0], payload: { key: "FNR-3016", title: "Integrations", content: "Description", references: ["https://example.test"] } });
  assert.deepEqual(direct, { type: "text", key: "Brief", title: "Brief", content: "Approved outcome", references: ["Text:Brief"] });
  assert.equal(hydrated.type, "jira"); assert.deepEqual(hydrated.references, ["Jira:FNR-3016", "https://example.test"]);
  assert.equal(normalizeSourceReference(sources[1]), "Taskwarrior:FNR-3007:689fa7ac-84b7-42d0-8912-b8ef76041370");
});
test("Serena evidence explicitly distinguishes missing and failed memories", () => {
  const bootstrap = evaluateSerenaBootstrap({ activated: true, instructionsLoaded: true, memoryListLoaded: true, memories: { core: "Core", conventions: null, tech_stack: "failed" } });
  assert.equal(bootstrap.memories.core.status, "loaded"); assert.equal(bootstrap.memories.conventions.status, "missing"); assert.equal(bootstrap.memories.tech_stack.status, "failed");
  assert.deepEqual(bootstrap.missingRequiredMemories, ["conventions", "tech_stack", "suggested_commands", "task_completion"]);
});
test("derives ready, degraded, and failed contexts without mutating inputs", () => {
  const source = normalizeSourcePayload({ source: sources[4], payload: null });
  const ready = evaluateSerenaBootstrap({ activated: true, instructionsLoaded: true, memoryListLoaded: true, memories: Object.fromEntries(["core", "conventions", "tech_stack", "suggested_commands", "task_completion"].map((name) => [name, name])) });
  assert.equal(derivePhaseContext({ cwd: "/repo", serenaProjectPath: "/repo", source, serena: ready }).status, "ready");
  assert.equal(derivePhaseContext({ cwd: "/repo", serenaProjectPath: "/repo", source, serena: { ...ready, missingRequiredMemories: ["core"] } }).status, "degraded");
  assert.equal(derivePhaseContext({ cwd: "/repo", serenaProjectPath: "/repo", source: null, serena: ready }).status, "failed");
});
test("sanitization never echoes external secrets", () => assert.deepEqual(sanitizeContextError("source_failed", "token=secret"), { code: "source_failed", message: "Context integration failed: source_failed." }));
