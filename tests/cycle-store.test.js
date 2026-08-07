import assert from "node:assert/strict";
import test from "node:test";
import { createCycleState, normalizeCycleSource } from "../lib/ima-cycle.ts";
import {
  CYCLE_STORE_DIRNAME,
  CYCLE_STORE_FILENAME,
  cycleStorePaths,
  parseCycleRecord,
  selectProjectRoot,
  serializeCycleRecord,
} from "../lib/ima-cycle-store.ts";

const at = "2026-08-07T02:30:00.000Z";
const source = normalizeCycleSource("FNR-3036");

test("serializes and parses a valid durable cycle record", () => {
  const state = createCycleState(source, { timestamp: at, mode: "autonomous" });

  assert.deepEqual(parseCycleRecord(serializeCycleRecord(state)), state);
});

test("rejects malformed and invalid durable cycle records", () => {
  assert.equal(parseCycleRecord("{"), null);
  assert.equal(parseCycleRecord(JSON.stringify({ schemaVersion: 1, state: { schemaVersion: 1 } })), null);
});

test("rejects undeclared state fields while preserving current and legacy records", () => {
  const state = createCycleState(source, { timestamp: at });
  const unexpected = { ...state, unbounded: true };
  assert.equal(parseCycleRecord(JSON.stringify({ schemaVersion: 1, state: unexpected })), null);
  assert.throws(() => serializeCycleRecord(unexpected), /cycle_state_invalid/);

  const legacy = { ...state };
  delete legacy.implementationMode;
  delete legacy.mode;
  const parsedLegacy = parseCycleRecord(JSON.stringify({ schemaVersion: 1, state: legacy }));
  assert.equal(parsedLegacy?.implementationMode, "js");
  assert.equal(parsedLegacy?.mode, "guided");

  const record = JSON.parse(serializeCycleRecord(state));
  assert.deepEqual(Object.keys(record.state).sort(), ["blockers", "evidence", "implementationMode", "lifecycleKey", "mode", "phase", "reviewAttempts", "reviewCap", "schemaVersion", "source", "status", "updatedAt"].sort());
});

test("builds durable cycle store paths", () => {
  const paths = cycleStorePaths("/workspace/ima-pi");

  assert.equal(paths.dir, `/workspace/ima-pi/${CYCLE_STORE_DIRNAME}`);
  assert.equal(paths.file, `/workspace/ima-pi/${CYCLE_STORE_DIRNAME}/${CYCLE_STORE_FILENAME}`);
  assert.equal(paths.gitignore, `/workspace/ima-pi/${CYCLE_STORE_DIRNAME}/.gitignore`);
});

test("selects the nearest marked project root or preserves the cwd", () => {
  assert.equal(selectProjectRoot("/workspace/ima-pi/extensions", [
    { dir: "/workspace", hasMarker: true },
    { dir: "/workspace/ima-pi", hasMarker: true },
  ]), "/workspace/ima-pi");
  assert.equal(selectProjectRoot("/workspace/scratch", [{ dir: "/workspace/ima-pi", hasMarker: true }]), "/workspace/scratch");
});
