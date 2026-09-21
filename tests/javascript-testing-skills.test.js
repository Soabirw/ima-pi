import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const skills = [
  "js-fp-api",
  "js-fp-react",
  "js-fp-vue",
  "js-fp-wordpress",
  "jquery",
  "playwright",
  "unit-testing",
];
const assets = [
  "skills/js-fp-api/SKILL.md",
  "skills/js-fp-api/examples/crud-endpoint.js",
  "skills/js-fp-api/references/middleware-patterns.md",
  "skills/js-fp-api/references/security-sql.md",
  "skills/js-fp-api/references/validation-patterns.md",
  "skills/js-fp-react/SKILL.md",
  "skills/js-fp-react/examples/ProductCard.tsx",
  "skills/js-fp-react/references/hooks-advanced.md",
  "skills/js-fp-react/references/performance-patterns.md",
  "skills/js-fp-vue/SKILL.md",
  "skills/js-fp-vue/references/complete-examples.md",
  "skills/js-fp-vue/references/composables-advanced.md",
  "skills/js-fp-vue/references/reactivity-patterns.md",
  "skills/js-fp-vue/references/testing.md",
  "skills/js-fp-wordpress/SKILL.md",
  "skills/js-fp-wordpress/references/ajax-patterns.md",
  "skills/js-fp-wordpress/references/event-patterns.md",
  "skills/js-fp-wordpress/references/wp-integration.md",
  "skills/jquery/SKILL.md",
  "skills/playwright/SKILL.md",
  "skills/playwright/references/accessibility-testing.md",
  "skills/playwright/references/ci-cd.md",
  "skills/playwright/references/network-mocking.md",
  "skills/playwright/references/visual-regression.md",
  "skills/unit-testing/SKILL.md",
  "skills/unit-testing/references/mock-patterns.md",
  "skills/unit-testing/references/tdd-workflow.md",
  "skills/unit-testing/references/test-strategy.md",
];
const read = (file) => readFile(join(root, file), "utf8");
const mustContain = (content, markers, label) =>
  markers.forEach((marker) =>
    assert.match(content, marker, `${label} must retain ${marker}`),
  );
const localMarkdownTargets = (content) =>
  [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
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
    await Promise.all(
      localMarkdownTargets(await read(file)).map((target) =>
        access(resolve(root, directory, target)),
      ),
    );
  }
});

test("JavaScript framework, browser, API, and testing guidance retains its boundaries", async () => {
  const apiSkill = await read("skills/js-fp-api/SKILL.md");
  mustContain(apiSkill, [
    /parameterized queries/i,
    /validate/i,
    /Middleware Dependency Injection/i,
    /Pure calculation.*no side effects/is,
    /Never use string concatenation for SQL/i,
    /Security boundary contract/i,
    /LIKE.*value/is,
    /Fail closed/i,
    /SELECT id, from_address, timestamp/i,
    /toEventResponse/,
    /fromAddress/,
    /Invalid domain/,
    /Unable to load events/,
    /events-query-failed/,
  ], "API");
  assert.doesNotMatch(
    apiSkill,
    /SELECT \* FROM \$\{table\}/,
    "API route example must select a fixed response shape",
  );
  assert.doesNotMatch(
    apiSkill,
    /error\.message.*error\.status/is,
    "API route example must not expose exception details or statuses",
  );
  assert.ok(
    apiSkill.includes(`const logUnexpectedQueryFailure = (logger) => {
  try {
    logger?.error?.({ event: 'events-query-failed' })
  } catch {
    // Diagnostics must not replace the bounded API response.
  }
}`),
    "API diagnostics must contain logger failures",
  );
  assert.match(
    apiSkill,
    /catch \{\s*logUnexpectedQueryFailure\(c\.logger\)\s*return c\.json\(unexpectedErrorResponse, 500\)/s,
    "API route must log safely before returning its fixed 500 response",
  );
  assert.doesNotMatch(
    apiSkill,
    /const logUnexpectedQueryFailure = \(logger\) =>\s*logger\?\.error\(/,
    "API diagnostics must not let logger errors replace the fixed 500 response",
  );
  assert.doesNotMatch(
    apiSkill,
    /const processData.*\{\s*\.\.\.r/is,
    "API route example must not spread database rows into JSON",
  );
  mustContain(await read("skills/js-fp-api/references/security-sql.md"), [
    /LIKE values stay values/i,
    /Allowlist SQL structure/i,
    /custom curry/i,
  ], "API SQL reference");
  mustContain(await read("skills/js-fp-api/references/validation-patterns.md"), [
    /Validation is one boundary control/i,
    /does not.*authorize.*parameterize.*encode/is,
  ], "API validation reference");
  mustContain(await read("skills/js-fp-react/SKILL.md"), [
    /Pure Component.*Custom Hook/is,
    /HOC for Dependency Injection/i,
    /Composition/i,
    /Premature memoization/i,
    /dangerouslySetInnerHTML/,
    /href/,
    /server-side authorization/i,
  ], "React");
  mustContain(await read("skills/js-fp-vue/SKILL.md"), [
    /Composable/i,
    /Pure.*component/is,
    /Reactive vs\. Ref/i,
    /Testing composables/i,
    /v-html/,
    /:href/,
    /server/i,
  ], "Vue");
  mustContain(await read("skills/js-fp-wordpress/SKILL.md"), [
    /jQuery IS native/i,
    /Bootstrap/i,
    /AJAX/i,
    /event delegation/i,
    /Pure Business Logic/i,
    /Browser security boundaries/i,
    /enqueue dependency/i,
    /XSS sinks/i,
  ], "WordPress");
  mustContain(await read("skills/jquery/SKILL.md"), [
    /already loaded/i,
    /event delegation/i,
    /IIFE Wrapper/i,
    /Pure Logic Extraction/i,
    /XSS sinks/i,
    /URL scheme\s+and destination/i,
  ], "jQuery");
  const playwrightSkill = await read("skills/playwright/SKILL.md");
  mustContain(playwrightSkill, [
    /browser/i,
    /accessibility/i,
    /Network Mocking/i,
    /Visual Regression/i,
    /Fixtures/i,
    /unit/i,
    /Security scenarios/i,
    /unauthenticated/i,
    /escaped text/i,
    /bounded visible state/i,
    /playwright\/\.auth\/user\.json/,
    /\.gitignore/,
    /playwright\/\.auth\//,
    /least-privileged/i,
    /reports or CI test artifacts/i,
    /rotate or revoke/i,
  ], "Playwright");
  assert.doesNotMatch(
    playwrightSkill,
    /path:\s*['"]auth\/user\.json['"]/,
    "Playwright auth state must use the ignored auth directory",
  );
  assert.doesNotMatch(
    playwrightSkill,
    /storageState:\s*['"]auth\/user\.json['"]/,
    "Playwright fixture must use the ignored auth directory",
  );
  mustContain(await read("skills/unit-testing/SKILL.md"), [
    /Pure functions/i,
    /route to domain skill/i,
    /Test behavior, not implementation/i,
    /Extract pure logic/i,
    /Mock only boundaries/i,
    /Security-negative test selection/i,
    /authorization/i,
    /actual SQL, command, HTML, URL, or path sink/i,
  ], "unit testing");
  mustContain(await read("skills/unit-testing/references/test-strategy.md"), [
    /Security evidence is sink-aware/i,
    /adversarial/i,
    /fail-closed/i,
  ], "unit-test strategy");
});

test("testing guidance preserves the provider-free core-suite boundary", async () => {
  const [unitTesting, playwright, patterns] = await Promise.all([
    read("skills/unit-testing/SKILL.md"),
    read("skills/playwright/SKILL.md"),
    read("skills/js-fp/references/testing-patterns.md"),
  ]);

  mustContain(unitTesting, [
    /Provider-free core suite policy/i,
    /npm test/,
    /tests\/fixtures\/deny-live-fetch\.js/,
    /tests\/live\//,
    /fixed, secret-free error/i,
    /in-memory `globalThis\.fetch`/i,
    /non-secret variables/i,
    /OPENAI_API_KEY/,
    /No\s+\*\*platform binding\*\* is introduced/i,
  ], "unit-testing provider-free core policy");
  mustContain(playwright, [
    /optional browser\/E2E layer/i,
    /does not expand `npm test`/i,
    /in-memory routes or injected fetch stubs/i,
    /BASE_URL.*platform binding/is,
    /credentials are \*\*secrets\*\*/i,
    /auth state is a \*\*local-only value\*\*/i,
  ], "Playwright provider-free boundary");
  mustContain(patterns, [
    /provider-free core suite policy/i,
    /in-memory fetch stubs/i,
    /tests\/live\//,
    /non-secret variable/i,
    /credentials are \*\*secrets\*\*/i,
  ], "JavaScript provider-free boundary");
});
