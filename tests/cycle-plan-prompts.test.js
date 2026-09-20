import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("manual planning requires a reusable canonical plan outcome marker", async () => {
  const prompt = await read("prompts/ima:plan.md");
  assert.match(prompt, /Every saved plan artifact, whether manual or cycle-dispatched/);
  assert.match(prompt, /ima-cycle outcome: phase=plan; outcome=APPROVED/);
  assert.match(prompt, /does not start a cycle, grant autonomous authority, or bypass the human approval gate/);
});

test("implementation prompts require the original imported plan contract", async () => {
  for (const path of [
    "prompts/ima:implement.md",
    "prompts/ima:implement-js.md",
    "prompts/ima:implement-wp.md",
  ]) {
    const prompt = await read(path);
    assert.match(prompt, /approvedPlanArtifactId/);
    assert.match(prompt, /approvedPlanRecordKey/);
    assert.match(prompt, /approval receipt alone is not/);
    assert.match(prompt, /ima_lifecycle_recall[\s\S]*?ima_lifecycle_get/);
    assert.match(prompt, /(?:public lifecycle read pair|public pair)[\s\S]*?checkout-pin authority/i);
    assert.match(prompt, /(?:never\s+retrieve\s+directly\s+through\s+Tier-1 Qdrant|callers\s+never\s+select\s+providers)/i);
    assert.match(prompt, /(?:never|no)[^.\n]*provider-native/i);
    assert.match(prompt, /(?:never|no)[^.\n]*ima_corpus_\*/i);
  }
});

test("lifecycle guidance documents marker-free legacy confirmation boundaries", async () => {
  const skill = await read("skills/ima-lifecycle-contract/SKILL.md");
  assert.match(skill, /## Manual-plan reuse/);
  assert.match(skill, /reference—not embed—the original serialized plan/);
  assert.match(skill, /confirmation references never chain/);
});
