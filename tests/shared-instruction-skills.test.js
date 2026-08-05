import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const skills = ["ima-memory-workflow", "ima-security-guardrails", "ima-vision-handoff", "ima-delegation-contract"];
const read = (path) => readFile(join(root, path), "utf8");
const mustContain = (content, markers, label) => markers.forEach((marker) => assert.match(content, marker, `${label} must retain ${marker}`));
const localMarkdownTargets = (content) => [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
  .map(([, target]) => target.trim().split("#", 1)[0])
  .filter((target) => target && !target.includes("$") && !/^(?:[a-z]+:|\/)/i.test(target));

const forbiddenGooseTerms = /sub_recipes|\.eta|ima-mcp serena/i;

test("shared instruction skills have valid package metadata and local links", async () => {
  for (const name of skills) {
    const file = `skills/${name}/SKILL.md`;
    const content = await read(file);
    assert.match(content, new RegExp(`^---\\nname: ?["']?${name}["']?`, "m"));
    assert.match(content, /^description:\s*\S/m);
    assert.doesNotMatch(content, forbiddenGooseTerms, `${name} must stay Pi-native`);
    await Promise.all(localMarkdownTargets(content).map((target) => access(resolve(root, dirname(file), target))));
  }
});

test("shared instruction skills retain their bounded contracts", async () => {
  const [memory, security, vision, delegation] = await Promise.all(skills.map((name) => read(`skills/${name}/SKILL.md`)));

  mustContain(memory, [/ima_context/, /Vestige/, /Qdrant/, /ima_lifecycle/, /lifecycle key/i], "memory workflow");
  mustContain(security, [/wp_verify_nonce\(\)|check_ajax_referer\(\)/, /current_user_can\(\)/, /->prepare\(\)/, /sanitize_text_field\(\)/, /esc_html\(\)/, /declare\(strict_types=1\)/, /parameterized-query/i, /pipe\(\).*compose\(.*curry/is], "security guardrails");
  mustContain(vision, [/ima_delegate/, /vision-handoff/, /imagePaths/, /evidence-only/i, /smallest concrete replacement/i], "vision handoff");
  mustContain(delegation, [/ima_delegate/, /one to four/i, /self-contained/i, /writeScope/, /Retry at most once/i], "delegation contract");
});

test("shared instruction wiring documents dispositions and references the vision skill", async () => {
  const [wiring, agent] = await Promise.all([
    read("docs/foundation/prompt-restoration-shared-instructions.md"),
    read("agents/vision-handoff.md"),
  ]);

  for (const name of skills) assert.match(wiring, new RegExp(`\\b${name}\\b`));
  mustContain(wiring, [/Practitioner persona and MOIM/, /functional-programmer/, /js-fp/, /No prompt body is changed by this unit/], "wiring document");
  assert.match(agent, /^skills: \[ima-vision-handoff\]$/m);
  assert.doesNotMatch(agent, /vision_handoff/);
});
