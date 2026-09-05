import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const skills = [
  "architect",
  "functional-programmer",
  "js-fp",
  "php-fp",
  "py-fp",
  "ruby-fp",
  "rg",
  "ima-git",
  "gh-cli",
  "tea-gitea",
];
const read = (path) => readFile(join(root, path), "utf8");
const mustContain = (content, markers, label) =>
  markers.forEach((marker) =>
    assert.match(content, marker, `${label} must retain ${marker}`),
  );
const localMarkdownTargets = (content) =>
  [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map(([, target]) => target.trim().split("#", 1)[0])
    .filter((target) => target && !target.includes("$") && !/^(?:[a-z]+:|\/)/i.test(target));

test("core skills have matching frontmatter and meaningful descriptions", async () => {
  for (const name of skills) {
    const content = await read(`skills/${name}/SKILL.md`);
    assert.match(content, new RegExp(`^---\\nname: ?["']?${name}["']?`, "m"));
    assert.match(content, /^description:/m);
  }
});

test("core architecture and FP guidance retains its safety boundaries", async () => {
  mustContain(await read("skills/architect/SKILL.md"), [
    /Simple > Complex/,
    /Evidence > Assumptions/,
    /Composition > Inheritance/,
    /migration path/i,
  ], "architect");
  mustContain(await read("skills/functional-programmer/SKILL.md"), [
    /Pure Functions/,
    /Immutability/,
    /Pure core.*impure shell/is,
    /Never.*custom.*pipe.*compose.*curry.*monad/is,
  ], "functional-programmer");
  mustContain(await read("skills/js-fp/SKILL.md"), [
    /Native function calls/,
    /pure functions/i,
    /side effects/i,
    /Security boundaries/,
    /All boundary data is untrusted/i,
  ], "js-fp");
  mustContain(await read("skills/php-fp/SKILL.md"), [
    /native early returns/i,
    /pure/i,
    /side effects/i,
    /PDO prepared statements/i,
    /contextual output encoding/i,
    /fail closed/i,
  ], "php-fp");
  mustContain(await read("skills/py-fp/SKILL.md"), [
    /Pythonic/,
    /itertools|functools/,
    /side effects/i,
    /Security boundary reference/,
    /references\/security\.md/,
  ], "py-fp");
  mustContain(await read("skills/ruby-fp/SKILL.md"), [
    /Enumerable/,
    /Functional Core \/ Imperative Shell/,
    /freeze/,
    /Open3\.capture3/,
    /ima-security-guardrails/,
  ], "ruby-fp");
});

test("language support assets and Ruby repairs are packaged", async () => {
  const assets = [
    "skills/js-fp/core-principles.md",
    "skills/js-fp/references/anti-patterns.md",
    "skills/js-fp/references/performance-patterns.md",
    "skills/js-fp/references/testing-patterns.md",
    "skills/js-fp/examples/pure-functions.js",
    "skills/js-fp/examples/tests/pure-functions.test.js",
    "skills/php-fp/references/core-principles.md",
    "skills/php-fp/references/testing-patterns.md",
    "skills/php-fp/examples/pure-functions.php",
    "skills/php-fp/examples/tests/PureFunctionsTest.php",
    "skills/py-fp/references/core-principles.md",
    "skills/py-fp/references/security.md",
    "skills/py-fp/references/testing-patterns.md",
    "skills/py-fp/examples/pure-functions.py",
    "skills/py-fp/examples/tests/test_pure_functions.py",
    "skills/ruby-fp/references/patterns.md",
    "skills/ruby-fp/references/security.md",
  ];

  await Promise.all(assets.map((asset) => access(join(root, asset))));
  const pythonSecurity = await read("skills/py-fp/references/security.md");
  mustContain(pythonSecurity, [
    /subprocess\.run/,
    /shell=False/,
    /yaml\.safe_load/,
    /parameter/i,
    /resolve_approved_path/,
    /CONVERT_EXECUTABLE/,
    /ALLOWED_IMAGE_SUFFIXES/,
    /Option-like file names/,
    /Conversion failed/,
    /approved absolute paths/i,
  ], "Python security");
  assert.doesNotMatch(
    pythonSecurity,
    /\["convert", input_filename, output_filename\]/,
    "Python subprocess example must not pass raw file names to convert",
  );
  mustContain(await read("skills/ruby-fp/references/patterns.md"), [
    /lazy/,
    /Proc#curry/,
    /memoization/i,
    /Pipeline/,
    /custom `pipe`/,
  ], "Ruby patterns");
  mustContain(await read("skills/ruby-fp/references/security.md"), [
    /exec_params|bind/i,
    /Open3\.capture3/,
    /allowlists/i,
    /symlink/i,
    /ENV\.fetch/,
    /JSON\.parse/,
    /IMA security guardrails/i,
  ], "Ruby security");
});

test("FNR-3027 local Markdown links resolve within packaged skills", async () => {
  for (const name of skills) {
    const file = `skills/${name}/SKILL.md`;
    const content = await read(file);
    await Promise.all(
      localMarkdownTargets(content).map((target) =>
        access(resolve(root, dirname(file), target)),
      ),
    );
  }
});

test("search and source-control skill routing remains explicit", async () => {
  mustContain(await read("skills/rg/SKILL.md"), [
    /Use `rg` instead of `grep` or `find -name`/,
    /\.gitignore/,
    /-t ts/,
    /-g "\*\.vue"/,
  ], "rg");
  mustContain(await read("skills/gh-cli/SKILL.md"), [
    /GitHub CLI/,
    /NOT for Gitea.*tea-gitea/is,
    /--json/,
  ], "gh-cli");
  mustContain(await read("skills/tea-gitea/SKILL.md"), [
    /Gitea/,
    /Use `gh` only for GitHub/,
    /tea login list/,
  ], "tea-gitea");
  mustContain(await read("skills/ima-git/SKILL.md"), [
    /release\/\*/,
    /immutable/,
    /Never force-push/,
    /dry-run/,
    /human owns actual deployment/i,
  ], "ima-git");
});
