import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const skills = ["js-fp-api", "js-fp-react", "js-fp-vue", "js-fp-wordpress", "jquery", "playwright", "unit-testing"];
const assets = [
  "skills/js-fp-api/SKILL.md", "skills/js-fp-api/examples/crud-endpoint.js", "skills/js-fp-api/references/middleware-patterns.md", "skills/js-fp-api/references/security-sql.md", "skills/js-fp-api/references/validation-patterns.md",
  "skills/js-fp-react/SKILL.md", "skills/js-fp-react/examples/ProductCard.tsx", "skills/js-fp-react/references/hooks-advanced.md", "skills/js-fp-react/references/performance-patterns.md",
  "skills/js-fp-vue/SKILL.md", "skills/js-fp-vue/references/complete-examples.md", "skills/js-fp-vue/references/composables-advanced.md", "skills/js-fp-vue/references/reactivity-patterns.md", "skills/js-fp-vue/references/testing.md",
  "skills/js-fp-wordpress/SKILL.md", "skills/js-fp-wordpress/references/ajax-patterns.md", "skills/js-fp-wordpress/references/event-patterns.md", "skills/js-fp-wordpress/references/wp-integration.md",
  "skills/jquery/SKILL.md",
  "skills/playwright/SKILL.md", "skills/playwright/references/accessibility-testing.md", "skills/playwright/references/ci-cd.md", "skills/playwright/references/network-mocking.md", "skills/playwright/references/visual-regression.md",
  "skills/unit-testing/SKILL.md", "skills/unit-testing/references/mock-patterns.md", "skills/unit-testing/references/tdd-workflow.md", "skills/unit-testing/references/test-strategy.md",
];
const read = (file) => readFile(join(root, file), "utf8");
const mustContain = (content, markers, label) => markers.forEach((marker) => assert.match(content, marker, `${label} must retain ${marker}`));
const localMarkdownTargets = (content) => [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
  .map(([, target]) => target.trim().split("#", 1)[0])
  .filter((target) => target && !target.includes("$") && !/^(?:[a-z]+:|\/)/i.test(target));

test("JavaScript and testing skills have matching frontmatter and packaged assets", async () => {
  await Promise.all(assets.map((asset) => access(join(root, asset))));
  for (const name of skills) {
    const content = await read(`skills/${name}/SKILL.md`);
    assert.match(content, new RegExp(`^---\\nname: ?["']?${name}["']?`, "m"));
    assert.match(content, /^description:\s*\S/m, `${name} needs a description`);
  }
});

test("copied Markdown links resolve within the package", async () => {
  const markdown = assets.filter((asset) => asset.endsWith(".md"));
  for (const file of markdown) {
    const directory = dirname(file);
    await Promise.all(localMarkdownTargets(await read(file)).map((target) => access(resolve(root, directory, target))));
  }
});

test("JavaScript framework, browser, API, and testing guidance retains its boundaries", async () => {
  mustContain(await read("skills/js-fp-api/SKILL.md"), [/parameterized queries/i, /validate/i, /Middleware Dependency Injection/i, /Pure calculation.*no side effects/is, /Never use string concatenation for SQL/i], "API");
  mustContain(await read("skills/js-fp-react/SKILL.md"), [/Pure Component.*Custom Hook/is, /HOC for Dependency Injection/i, /Composition/i, /Premature memoization/i], "React");
  mustContain(await read("skills/js-fp-vue/SKILL.md"), [/Composable/i, /Pure.*component/is, /Reactive vs\. Ref/i, /Testing composables/i], "Vue");
  mustContain(await read("skills/js-fp-wordpress/SKILL.md"), [/jQuery IS native/i, /Bootstrap/i, /AJAX/i, /event delegation/i, /Pure Business Logic/i], "WordPress");
  mustContain(await read("skills/jquery/SKILL.md"), [/already loaded/i, /event delegation/i, /IIFE Wrapper/i, /Pure Logic Extraction/i], "jQuery");
  mustContain(await read("skills/playwright/SKILL.md"), [/browser/i, /accessibility/i, /Network Mocking/i, /Visual Regression/i, /Fixtures/i, /unit/i], "Playwright");
  mustContain(await read("skills/unit-testing/SKILL.md"), [/Pure functions/i, /route to domain skill/i, /Test behavior, not implementation/i, /Extract pure logic/i, /Mock only boundaries/i], "unit testing");
});
