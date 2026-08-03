import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const skills = ["php-fp-wordpress", "phpunit-wp", "wp-ddev", "ima-bootstrap", "livecanvas", "ima-forms-expert", "php-authnet"];
const assets = [
  "skills/php-fp-wordpress/SKILL.md", "skills/php-fp-wordpress/references/fp-patterns.md", "skills/php-fp-wordpress/references/plugin-architecture.md", "skills/php-fp-wordpress/references/security-examples.md", "skills/php-fp-wordpress/references/testing-strategy.md",
  "skills/phpunit-wp/SKILL.md",
  "skills/wp-ddev/SKILL.md", "skills/wp-ddev/references/ddev-commands.md", "skills/wp-ddev/references/wp-cli-reference.md",
  "skills/ima-bootstrap/SKILL.md", "skills/ima-bootstrap/references/bootstrap-patterns.md", "skills/ima-bootstrap/references/ima-brand.md", "skills/ima-bootstrap/references/theme-integration.md",
  "skills/livecanvas/SKILL.md", "skills/livecanvas/references/livecanvas-features.md", "skills/livecanvas/references/loops-and-logic.md", "skills/livecanvas/references/picostrap.md",
  "skills/ima-forms-expert/SKILL.md", "skills/ima-forms-expert/references/container-components.md", "skills/ima-forms-expert/references/examples.md", "skills/ima-forms-expert/references/field-components.md", "skills/ima-forms-expert/references/form-factory.md", "skills/ima-forms-expert/references/quick-reference.md", "skills/ima-forms-expert/references/validation-engine.md",
  "skills/php-authnet/SKILL.md", "skills/php-authnet/references/api-reference.md", "skills/php-authnet/references/sandbox-testing.md",
];
const read = (file) => readFile(join(root, file), "utf8");
const mustContain = (content, markers, label) => markers.forEach((marker) => assert.match(content, marker, `${label} must retain ${marker}`));
const localMarkdownTargets = (content) => [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
  .map(([, target]) => target.trim().split("#", 1)[0])
  .filter((target) => target && !target.includes("$") && !/^(?:[a-z]+:|\/)/i.test(target));

test("WordPress, PHP, and IMA skills have matching frontmatter and packaged assets", async () => {
  await Promise.all(assets.map((asset) => access(join(root, asset))));
  for (const name of skills) {
    const content = await read(`skills/${name}/SKILL.md`);
    assert.match(content, new RegExp(`^---\\nname: ?["']?${name}["']?`, "m"));
    assert.match(content, /^description:\s*\S/m, `${name} needs a description`);
  }
});

test("copied WordPress and PHP Markdown links resolve within the package", async () => {
  for (const file of assets.filter((asset) => asset.endsWith(".md"))) {
    const directory = dirname(file);
    await Promise.all(localMarkdownTargets(await read(file)).map((target) => access(resolve(root, directory, target))));
  }
});

test("WordPress, PHP, and IMA guidance retains domain and security boundaries", async () => {
  mustContain(await read("skills/php-fp-wordpress/SKILL.md"), [/current_user_can\(\)/, /wp_verify_nonce\(\)/, /Sanitize ALL user input/i, /Escape ALL output by context/i, /\$wpdb->prepare\(\)/], "PHP FP WordPress");
  mustContain(await read("skills/phpunit-wp/SKILL.md"), [/Test pure functions/i, /Integration tests/i, /Mocks.*Minimal/is, /environment/i, /production database/i], "PHPUnit WordPress");
  mustContain(await read("skills/wp-ddev/SKILL.md"), [/ddev wp/, /\.ddev\/config\.yaml/, /backup|snapshot/i, /dry-run/i, /credential/i], "WP-DDEV");
  mustContain(await read("skills/ima-bootstrap/SKILL.md"), [/Bootstrap 5\.3/, /Picostrap/i, /SCSS/i, /responsive/i, /WordPress.*child theme/is], "IMA Bootstrap");
  mustContain(await read("skills/livecanvas/SKILL.md"), [/Loops & Logic/i, /shortcode/i, /<tangible>/i, /ACF/i, /PicoStrap/i], "LiveCanvas");
  mustContain(await read("skills/ima-forms-expert/SKILL.md"), [/Validators at registration/i, /Template IS definition/i, /Nonce/i, /sanitization/i, /escaping/i], "IMA Forms");
  mustContain(await read("skills/php-authnet/SKILL.md"), [/sandbox/i, /Accept\.js/i, /server never sees raw card numbers/i, /webhook/i, /Nonces valid/i, /production/i], "Authorize.Net");
  mustContain(await read("skills/php-authnet/references/api-reference.md"), [/string \$raw_body/, /hash_hmac\('sha512', \$raw_body/, /hash_equals/, /notificationId/, /get_transient\(\$idempotency_key\)/, /set_transient\(\$idempotency_key, true, 3 \* DAY_IN_SECONDS\)/], "Authorize.Net webhook contract");
  mustContain(await read("skills/php-authnet/references/sandbox-testing.md"), [/test_validate_signature_valid/, /test_validate_signature_invalid/], "Authorize.Net webhook tests");
});

test("FNR-3029 packages the DDEV path without packaging deprecated wp-local", async () => {
  assert.equal(assets.some((asset) => asset.includes("wp-local")), false);
  await assert.rejects(access(join(root, "skills", "wp-local")));
  const readme = await read("README.md");
  assert.match(readme, /DDEV.*supported local WordPress environment/is);
  assert.match(readme, /LocalWP.*deprecated.*not packaged/is);
});
