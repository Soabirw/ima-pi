import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readProjectFile = (relativePath) =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

const securitySkill = readProjectFile("skills/ima-security-guardrails/SKILL.md");
const planPrompt = readProjectFile("prompts/ima:plan.md");

const scenarioOwners = [
  ["malformed $userId", "code-execution"],
  ["unauthorized address-list request", "code-execution"],
  ["unsafe SQL, path, or URL value", "code-execution"],
  ["missing secret required by this API client", "code-execution/startup"],
  ["Cloudflare public endpoint posture", "environmental"],
  ["Cloudflare index or schema provisioning", "environmental"],
  ["BookStack guest-access policy", "environmental"],
  ["monitoring or dashboard availability", "environmental unless required by operation"],
];

test("documents the expected acceptance-criterion owners", () => {
  assert.deepEqual(scenarioOwners, [
    ["malformed $userId", "code-execution"],
    ["unauthorized address-list request", "code-execution"],
    ["unsafe SQL, path, or URL value", "code-execution"],
    ["missing secret required by this API client", "code-execution/startup"],
    ["Cloudflare public endpoint posture", "environmental"],
    ["Cloudflare index or schema provisioning", "environmental"],
    ["BookStack guest-access policy", "environmental"],
    ["monitoring or dashboard availability", "environmental unless required by operation"],
  ]);
});

test("keeps security checks at the operation boundary", () => {
  assert.match(securitySkill, /Never trust your inputs.*actually receives or directly consumes/s);
  assert.match(securitySkill, /not a Story validator or an environment validator/);
  assert.match(securitySkill, /directly receives or consumes the fact/);
  assert.match(securitySkill, /necessary for the operation’s narrow direct execution/);
  assert.match(securitySkill, /authoritative and permitted to verify the fact/);
  assert.match(securitySkill, /must legitimately stop/);
  assert.match(securitySkill, /deployment, preflight, environment administration, startup/);
  assert.match(securitySkill, /Fail closed for an operation-local input or invariant/);
  assert.match(securitySkill, /required configuration and secret presence and shape/);
  assert.match(securitySkill, /responses from APIs the operation calls/);
  assert.match(securitySkill, /sink controls for SQL, shell, paths, URLs, and HTML/);
});

test("requires plans to classify code-execution and environmental criteria", () => {
  assert.match(planPrompt, /## Code-Execution Acceptance Criteria/);
  assert.match(planPrompt, /## Environmental Acceptance Criteria/);
  assert.match(planPrompt, /Include both sections and write `None\.`/);
  assert.match(planPrompt, /Every entry must name its owner and evidence source/);
  assert.match(planPrompt, /explicit runtime non-goal/);
  assert.match(planPrompt, /ima-security-guardrails/);
  assert.match(planPrompt, /non-goal/);
});
