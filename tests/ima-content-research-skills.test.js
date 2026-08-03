import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const newSkills = ["ima-brand", "ima-copywriting", "ima-editorial-scorecard", "ima-editorial-workflow", "ima-email-creator"];
const assets = [
  "skills/ima-brand/SKILL.md", "skills/ima-brand/references/brand-identity.md", "skills/ima-brand/references/digital-standards.md", "skills/ima-brand/references/visual-system.md",
  "skills/ima-copywriting/SKILL.md", "skills/ima-copywriting/references/format-blog-post.md", "skills/ima-copywriting/references/format-fundraising-email.md", "skills/ima-copywriting/references/format-newsletter.md", "skills/ima-copywriting/references/format-op-ed.md", "skills/ima-copywriting/references/format-press-release.md", "skills/ima-copywriting/references/format-social-media.md", "skills/ima-copywriting/references/format-webinar-email.md", "skills/ima-copywriting/references/ima-copy-frameworks.md", "skills/ima-copywriting/references/ima-transitions.md",
  "skills/ima-editorial-scorecard/SKILL.md", "skills/ima-editorial-scorecard/references/format-expectations.md", "skills/ima-editorial-scorecard/references/scoring-rubrics.md",
  "skills/ima-editorial-workflow/SKILL.md",
  "skills/ima-email-creator/SKILL.md", "skills/ima-email-creator/assets/base-template.html", "skills/ima-email-creator/references/drip-sequence.md", "skills/ima-email-creator/references/email-css-safe.md", "skills/ima-email-creator/references/espocrm-compat.md", "skills/ima-email-creator/references/newsletter-layout.md", "skills/ima-email-creator/references/wp-transactional.md", "skills/ima-email-creator/scripts/css-inliner.py", "skills/ima-email-creator/scripts/espocrm-prep.py", "skills/ima-email-creator/scripts/requirements.txt",
];
const researchTargets = ["skills/ima-medical-research/SKILL.md", "prompts/ima:medical-research.md", "skills/patristic-researcher/SKILL.md", "prompts/ima:patristic-research.md", "skills/patristic-researcher/references/Patristic-Quick-Reference.md", "skills/patristic-researcher/references/Index-NT-Epistles.md", "skills/patristic-researcher/references/Index-Apostolic-Fathers.md", "skills/patristic-researcher/references/Index-Ante-Nicene.md", "skills/patristic-researcher/references/Index-Nicene-Post-Nicene.md"];
const read = (file) => readFile(join(root, file), "utf8");
const mustContain = (content, markers, label) => markers.forEach((marker) => assert.match(content, marker, `${label} must retain ${marker}`));
const localMarkdownTargets = (content) => [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
  .map(([, target]) => target.trim().split("#", 1)[0])
  .filter((target) => target && !target.includes("$") && !/^(?:[a-z]+:|\/)/i.test(target));

test("IMA content skills have complete packaged assets and matching frontmatter", async () => {
  await Promise.all([...assets, ...researchTargets].map((asset) => access(join(root, asset))));
  for (const name of newSkills) {
    const content = await read(`skills/${name}/SKILL.md`);
    assert.match(content, new RegExp(`^---\\nname: ?["']?${name}["']?`, "m"));
    assert.match(content, /^description:\s*\S/m, `${name} needs a description`);
  }
});

test("new IMA content Markdown links resolve within the package", async () => {
  for (const file of assets.filter((asset) => asset.endsWith(".md"))) {
    const directory = dirname(file);
    await Promise.all(localMarkdownTargets(await read(file)).map((target) => access(resolve(root, directory, target))));
  }
});

test("brand, copywriting, and editorial guidance retains its core contracts", async () => {
  mustContain(await read("skills/ima-brand/SKILL.md"), [/Honest Medicine™/, /visual/i, /digital/i, /voice|tone/i, /terminology/i], "brand");
  mustContain(await read("skills/ima-copywriting/SKILL.md"), [/evidence.first/i, /solution.oriented/i, /independent/i, /plain.language/i, /reader.*ally/i, /AI tells/i, /CTA/i, /framework/i, /transition/i], "copywriting");
  mustContain(await read("skills/ima-editorial-scorecard/SKILL.md"), [/Brand Voice/i, /Evidence Quality/i, /Audience Clarity/i, /Structural Craft/i, /CTA Effectiveness/i, /letter grade/i, /What.s Working/i, /Priority Fixes/i, /trademark|disclaimer/i], "editorial scorecard");
  mustContain(await read("skills/ima-editorial-workflow/SKILL.md"), [/PLAN → WRITE → REVIEW → APPROVE → LEARN/, /ima-brand/i, /ima-copywriting/i, /ima-editorial-scorecard/i, /\/skill:ima-editorial-workflow/, /explicit approval/i], "editorial workflow");
});

test("email assets preserve opt-in helper contracts and safety boundaries", async () => {
  const skill = await read("skills/ima-email-creator/SKILL.md");
  mustContain(skill, [/assets\/base-template\.html/, /references\/drip-sequence\.md/, /references\/email-css-safe\.md/, /references\/espocrm-compat\.md/, /references\/newsletter-layout\.md/, /references\/wp-transactional\.md/, /transform markup but do not sanitize hostile HTML/i, /Never embed credentials, recipient data, or tokens/i, /Do not install dependencies automatically/i]);
  mustContain(await read("skills/ima-email-creator/scripts/css-inliner.py"), [/import premailer/, /parser\.add_argument\("input"/, /--out/], "CSS inliner");
  mustContain(await read("skills/ima-email-creator/scripts/espocrm-prep.py"), [/BeautifulSoup/, /parser\.add_argument\("input"/, /--out/], "EspoCRM helper");
  mustContain(await read("skills/ima-email-creator/scripts/requirements.txt"), [/premailer/i, /beautifulsoup4/i], "email requirements");
});

test("FNR-3023 research mappings retain source and safety boundaries", async () => {
  assert.equal(await read("skills/ima-researcher/SKILL.md").catch(() => null), null, "do not duplicate ima-researcher");
  mustContain(await read("skills/ima-medical-research/SKILL.md"), [/ima-research/, /Never silently use `ima-knowledge`/, /PICO/, /funding and conflicts/i, /Emergency symptoms/, /Do not diagnose, prescribe.*dosing.*medication changes/is, /educational purposes only/i], "medical research");
  mustContain(await read("skills/patristic-researcher/SKILL.md"), [/AD 30–430.*Augustine/i, /collection `theology`/, /metadata\.collection: fathers/, /metadata\.era: patristic/, /never as verified quotations/i, /primary repositories/i, /anachronism/i, /thin, late, disputed, or inconclusive/i], "patristic research");
});

test("README and foundation document provide the approved seven-capability mapping", async () => {
  const readme = await read("README.md");
  mustContain(readme, [/\/skill:ima-brand/, /\/skill:ima-copywriting/, /\/skill:ima-editorial-scorecard/, /\/skill:ima-editorial-workflow/, /\/skill:ima-email-creator/, /\/skill:ima-medical-research/, /\/ima:medical-research/, /\/skill:patristic-researcher/, /\/ima:patristic-research/, /editorial.*scorecard.*\/ima:scorecard/is, /FNR-3031\.md/], "README");
  const foundation = await read("docs/foundation/FNR-3031.md");
  mustContain(foundation, [/ima-brand/, /ima-copywriting/, /ima-editorial-scorecard/, /ima-editorial-workflow/, /ima-email-creator/, /ima-medical-research/, /patristic-researcher/, /rollback/i], "FNR-3031 documentation");
});

test("email helpers and distribution assets enforce the reviewed contracts", async (t) => {
  const [espocrm, inliner, template, skill, drip, newsletter, compat, foundation] = await Promise.all([
    read("skills/ima-email-creator/scripts/espocrm-prep.py"),
    read("skills/ima-email-creator/scripts/css-inliner.py"),
    read("skills/ima-email-creator/assets/base-template.html"),
    read("skills/ima-email-creator/SKILL.md"),
    read("skills/ima-email-creator/references/drip-sequence.md"),
    read("skills/ima-email-creator/references/newsletter-layout.md"),
    read("skills/ima-email-creator/references/espocrm-compat.md"),
    read("docs/foundation/FNR-3031.md"),
  ]);
  assert.match(espocrm, /soup\.new_tag\("div"\)/);
  assert.match(espocrm, /wrapper\["style"\] = style/);
  assert.match(espocrm, /child\.extract\(\)/);
  assert.match(inliner, /def reject_external_css_sources/);
  assert.match(inliner, /allow_network=False/);
  assert.match(inliner, /allow_loading_external_files=False/);
  assert.match(inliner, /except ValueError as error/);
  assert.doesNotMatch(template, /\{\{[^}]+\}\}/);
  mustContain(template, [/__SUBJECT__/, /__UTM_CAMPAIGN__/, /__SECTION_IMAGE_URL__/, /\{Person\.firstName\}/, /\{optOutLink\}/], "email template token classes");
  for (const content of [skill, drip, newsletter, compat, foundation]) {
    assert.doesNotMatch(content, /python3 scripts\//, "documented helper paths must resolve from repository root");
  }
  mustContain(skill, [/external stylesheet links.*external CSS/is, /self-contained CSS/i, /approved HTTPS/i], "email skill security boundaries");
  assert.match(newsletter, /__UTM_CAMPAIGN__/);
  assert.match(foundation, /parser-owned wrapper/i);

  const { spawnSync } = await import("node:child_process");
  const available = spawnSync("python3", ["-c", "import bs4, premailer"], { encoding: "utf8" });
  if (available.status !== 0) return t.skip("optional Python email dependencies are unavailable");
  const script = `
import importlib.util
from pathlib import Path
root = Path(${JSON.stringify(root)})
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, root / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
espocrm = load("espocrm", "skills/ima-email-creator/scripts/espocrm-prep.py")
inliner = load("inliner", "skills/ima-email-creator/scripts/css-inliner.py")
from bs4 import BeautifulSoup
wrapped = espocrm.extract_body_content('<html><body style="font-family: &quot;Lato&quot;; color: red"><p data-x="1">Child</p></body></html>')
soup = BeautifulSoup(wrapped, "html.parser")
assert soup.div and soup.div.attrs == {"style": 'font-family: "Lato"; color: red'} and soup.p.string == "Child"
for html in ['<link rel="stylesheet" href="https://example.test/x.css">', '<style>@import url(https://example.test/x.css)</style>', '<p style="background:url(//example.test/x)">x</p>', '<p style="background:url(/tmp/x)">x</p>', '<p style="background:url(data:text/plain,x)">x</p>']:
    try: inliner.reject_external_css_sources(html)
    except ValueError: pass
    else: raise AssertionError(html)
assert "style=" in inliner.inline_css("<style>p { color: red; }</style><p>Safe</p>")
`;
  const result = spawnSync("python3", ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("editorial skills advertise only discovered skill invocations", async () => {
  for (const file of ["skills/ima-editorial-scorecard/SKILL.md", "skills/ima-editorial-workflow/SKILL.md"]) {
    const content = await read(file);
    assert.match(content, /\/skill:ima-editorial-(?:scorecard|workflow)/);
    assert.doesNotMatch(content, /(^|[^\w:])\/(?:scorecard|write|rewrite|social|brainstorm)(?=[^\w-]|$)/m);
  }
});
