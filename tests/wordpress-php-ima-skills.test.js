import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const skills = [
  "php-fp-wordpress",
  "phpunit-wp",
  "wp-ddev",
  "ima-bootstrap",
  "livecanvas",
  "ima-forms-expert",
  "php-authnet",
];
const assets = [
  "skills/php-fp-wordpress/SKILL.md",
  "skills/php-fp-wordpress/references/fp-patterns.md",
  "skills/php-fp-wordpress/references/plugin-architecture.md",
  "skills/php-fp-wordpress/references/security-examples.md",
  "skills/php-fp-wordpress/references/testing-strategy.md",
  "skills/phpunit-wp/SKILL.md",
  "skills/phpunit-wp/references/security-testing.md",
  "skills/wp-ddev/SKILL.md",
  "skills/wp-ddev/references/ddev-commands.md",
  "skills/wp-ddev/references/wp-cli-reference.md",
  "skills/ima-bootstrap/SKILL.md",
  "skills/ima-bootstrap/references/bootstrap-patterns.md",
  "skills/ima-bootstrap/references/ima-brand.md",
  "skills/ima-bootstrap/references/theme-integration.md",
  "skills/livecanvas/SKILL.md",
  "skills/livecanvas/references/livecanvas-features.md",
  "skills/livecanvas/references/loops-and-logic.md",
  "skills/livecanvas/references/picostrap.md",
  "skills/ima-forms-expert/SKILL.md",
  "skills/ima-forms-expert/references/container-components.md",
  "skills/ima-forms-expert/references/examples.md",
  "skills/ima-forms-expert/references/field-components.md",
  "skills/ima-forms-expert/references/form-factory.md",
  "skills/ima-forms-expert/references/quick-reference.md",
  "skills/ima-forms-expert/references/validation-engine.md",
  "skills/php-authnet/SKILL.md",
  "skills/php-authnet/references/api-reference.md",
  "skills/php-authnet/references/webhook-security.md",
  "skills/php-authnet/references/sandbox-testing.md",
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
    await Promise.all(
      localMarkdownTargets(await read(file)).map((target) =>
        access(resolve(root, directory, target)),
      ),
    );
  }
});

test("WordPress, PHP, and IMA guidance retains domain and security boundaries", async () => {
  mustContain(await read("skills/php-fp-wordpress/SKILL.md"), [
    /Boundary control matrix/i,
    /current_user_can\(\)/,
    /wp_verify_nonce\(\)/,
    /Sanitize ALL\s+user input/i,
    /Escape ALL\s+output by context/i,
    /\$wpdb->prepare\(\)/,
    /Intentionally public handlers/i,
    /permission_callback/,
    /wp_handle_upload\(\)/,
    /wp_safe_redirect\(\)/,
    /outbound HTTP/i,
  ], "PHP FP WordPress");
  mustContain(await read("skills/php-fp-wordpress/references/security-examples.md"), [
    /Cumulative Boundaries/,
    /wp_ajax_nopriv_/,
    /permission_callback/,
    /wp_handle_upload/,
    /SSRF/i,
    /supply.chain/i,
    /wp_kses_post\(\).*not.*generally safe/is,
  ], "WordPress security examples");
  mustContain(await read("skills/php-fp-wordpress/references/testing-strategy.md"), [
    /sink-free/i,
    /\$wpdb->prepare\(\)/,
    /Risk-appropriate negative cases/i,
  ], "WordPress testing strategy");
  mustContain(await read("skills/phpunit-wp/SKILL.md"), [
    /Test pure functions/i,
    /Integration tests/i,
    /Mocks.*Minimal/is,
    /environment/i,
    /production database/i,
    /Negative security gates/i,
    /security-testing\.md/,
  ], "PHPUnit WordPress");
  mustContain(await read("skills/phpunit-wp/references/security-testing.md"), [
    /Missing or invalid nonce/i,
    /denied resource capability/i,
    /\$wpdb->prepare\(\)/,
    /Output and URL sinks/i,
    /fail.closed/i,
  ], "PHPUnit security testing");
  mustContain(await read("skills/wp-ddev/SKILL.md"), [
    /ddev wp/,
    /\.ddev\/config\.yaml/,
    /backup|snapshot/i,
    /dry-run/i,
    /credential/i,
    /shell history/i,
    /destructive/i,
  ], "WP-DDEV");
  mustContain(await read("skills/ima-bootstrap/SKILL.md"), [
    /Bootstrap 5\.3/,
    /Picostrap/i,
    /SCSS/i,
    /responsive/i,
    /WordPress.*child theme/is,
    /not security controls/i,
  ], "IMA Bootstrap");
  mustContain(await read("skills/livecanvas/SKILL.md"), [
    /Loops & Logic/i,
    /shortcode/i,
    /<tangible>/i,
    /ACF/i,
    /PicoStrap/i,
    /Dynamic output security/i,
  ], "LiveCanvas");
  const formsSkill = await read("skills/ima-forms-expert/SKILL.md");
  mustContain(formsSkill, [
    /Validators at registration/i,
    /Template IS definition/i,
    /Nonce/i,
    /sanitization/i,
    /escaping/i,
    /Security boundary rules/i,
    /fail\s+closed/i,
    /unset\(\$form_input\['nonce'\], \$form_input\['action'\]\)/,
    /registered-field projection/i,
    /Optional registered fields\s+may be absent/i,
    /duplicate scalar values/i,
  ], "IMA Forms");
  const formsValidation = await read(
    "skills/ima-forms-expert/references/validation-engine.md",
  );
  mustContain(formsValidation, [
    /Security boundary contract/i,
    /does not replace capability authorization/i,
    /registered-field business-data\s+projection/i,
    /transport metadata/i,
    /Required registered fields must be present and valid/i,
    /Optional registered fields may be absent/i,
    /Unregistered values are\s+omitted/i,
    /upstream parser must\s+preserve and reject/i,
  ], "IMA Forms validation engine");
  assert.doesNotMatch(
    formsValidation,
    /Treat missing, duplicate, malformed, or unregistered field data as invalid/,
    "IMA Forms must not promise unsupported duplicate handling",
  );
  const authnetSkill = await read("skills/php-authnet/SKILL.md");
  mustContain(authnetSkill, [
    /sandbox/i,
    /Accept\.js/i,
    /server never sees raw card numbers/i,
    /webhook/i,
    /Nonces valid/i,
    /production/i,
    /ima-security-guardrails/i,
    /webhook-security\.md/,
    /legacy\/non-production/i,
    /durable atomic/i,
  ], "Authorize.Net");
  assert.doesNotMatch(
    authnetSkill,
    /webhook reference already covers HMAC.*idempotency/is,
    "Authorize.Net must not certify transient deduplication as idempotency",
  );
  mustContain(await read("skills/php-authnet/references/api-reference.md"), [
    /string \$raw_body/,
    /hash_hmac\('sha512', \$raw_body/,
    /hash_equals/,
    /notificationId/,
  ], "Authorize.Net HMAC contract");
  mustContain(await read("skills/php-authnet/references/webhook-security.md"), [
    /notificationId/,
    /unique.*notification_id/is,
    /claimAtomically/,
    /committed/,
    /retryable/,
    /idempotencyKey/,
    /legacy\/non-production/i,
  ], "Authorize.Net webhook security");
  mustContain(await read("skills/php-authnet/references/sandbox-testing.md"), [
    /test_validate_signature_valid/,
    /test_validate_signature_invalid/,
  ], "Authorize.Net webhook tests");
});

test("FNR-3029 packages the DDEV path without packaging deprecated wp-local", async () => {
  assert.equal(assets.some((asset) => asset.includes("wp-local")), false);
  await assert.rejects(access(join(root, "skills", "wp-local")));
  const readme = await read("README.md");
  assert.match(readme, /DDEV.*supported local WordPress environment/is);
  assert.match(readme, /LocalWP.*deprecated.*not packaged/is);
});
