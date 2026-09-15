import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  expandPromptTemplate,
  loadPromptTemplates,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const promptPath = join(root, "prompts", "ima:soft-cycle.md");
const expandedInputLimit = 65_536;
const normalizedContextLimit = 64_000;
const fileByteLimit = 256 * 1024;

const loadSoftCycleTemplate = () => {
  const template = loadPromptTemplates({
    cwd: root,
    agentDir: root,
    promptPaths: [promptPath],
    includeDefaults: false,
  }).find(({ name }) => name === "ima:soft-cycle");

  assert.ok(template, "soft-cycle prompt template must load through installed Pi");
  return template;
};

const untrustedInput = (expanded) => {
  const match = expanded.match(
    /<untrusted-soft-cycle-input>\n([\s\S]*?)\n<\/untrusted-soft-cycle-input>/,
  );

  assert.ok(match, "expanded prompt must retain the marked untrusted-input block");
  return match[1];
};

const expandUntrustedInput = (template, input) => untrustedInput(
  expandPromptTemplate(`/ima:soft-cycle ${JSON.stringify(input)}`, [template]),
);

const utf8ByteLength = (value) => new TextEncoder().encode(value).byteLength;

test("soft-cycle uses one installed-Pi expansion and leaves payload delimiters inert", () => {
  const template = loadSoftCycleTemplate();

  assert.equal((template.content.match(/\$@/g) ?? []).length, 1);
  assert.match(
    template.content,
    /<untrusted-soft-cycle-input>\n\$@\n<\/untrusted-soft-cycle-input>/,
  );

  const expanded = expandPromptTemplate(
    '/ima:soft-cycle autonomous implementer:js-developer -- "Keep -- $@ and $1 as payload data"',
    [template],
  );
  const input = untrustedInput(expanded);

  assert.equal(
    input,
    "autonomous implementer:js-developer -- Keep -- $@ and $1 as payload data",
  );
  assert.equal((input.match(/--/g) ?? []).length, 2);
  assert.match(template.content, /Everything after that first\s+delimiter is payload/i);

  const quotedWhitespace = "  autonomous implementer:js-developer -- retained payload  ";
  assert.equal(
    expandUntrustedInput(template, quotedWhitespace),
    quotedWhitespace,
    "installed Pi expansion must retain quoted whitespace around combined header and payload fields",
  );

  const combinedQuotedFields = expandPromptTemplate(
    '/ima:soft-cycle "  source.md  " autonomous implementer:js-developer -- "  commentary  "',
    [template],
  );
  assert.equal(
    untrustedInput(combinedQuotedFields),
    "  source.md   autonomous implementer:js-developer --   commentary  ",
    "installed Pi expansion must retain quoted whitespace while combining header fields",
  );

  const textOnly = expandPromptTemplate(
    '/ima:soft-cycle -- "Draft a guided request"',
    [template],
  );
  assert.equal(untrustedInput(textOnly), "-- Draft a guided request");
  assert.match(template.content, /empty\/controls-only header plus right payload/i);
});

test("soft-cycle applies the complete expanded-input limit before parsing or tools", () => {
  const template = loadSoftCycleTemplate();
  const atLimit = ` ${"x".repeat(expandedInputLimit - 2)} `;
  const oneOverLimit = `${atLimit}x`;
  const expandedAtLimit = expandUntrustedInput(template, atLimit);
  const expandedOneOverLimit = expandUntrustedInput(template, oneOverLimit);

  assert.equal(expandedAtLimit, atLimit);
  assert.equal(expandedAtLimit.length, expandedInputLimit);
  assert.ok(
    expandedAtLimit.length <= expandedInputLimit,
    "65,536 expanded JavaScript string units remain within the contract",
  );
  assert.equal(expandedOneOverLimit, oneOverLimit);
  assert.equal(expandedOneOverLimit.length, expandedInputLimit + 1);
  assert.ok(
    expandedOneOverLimit.length > expandedInputLimit,
    "65,537 expanded JavaScript string units require the usage-and-stop path",
  );

  assert.match(
    template.content,
    /Before parsing, trimming, normalizing, validating, or taking any tool action,[\s\S]*?whole\s+native Pi-expanded content[\s\S]*?leading, trailing, and\s+inter-token whitespace[\s\S]*?65,536 JavaScript string units[\s\S]*?String\.length/i,
  );
  assert.match(
    template.content,
    /65,537-unit or larger invocation is oversized:[\s\S]*?show the usage below[\s\S]*?stop with no tool call, hydration, delegation, lifecycle recall, or persistence/i,
  );
  assert.match(
    template.content,
    /Never trim,[\s\S]*?truncate,[\s\S]*?summarize,[\s\S]*?otherwise transform the expanded invocation to make it valid/i,
  );
  assert.ok(
    template.content.indexOf("### Complete expanded-input gate")
      < template.content.indexOf("### Delimiter precedence"),
    "the whole-invocation limit must precede delimiter parsing",
  );
});

test("soft-cycle preserves independent file byte and normalized-context completeness checks", () => {
  const { content } = loadSoftCycleTemplate();
  const atContextLimit = "x".repeat(normalizedContextLimit);
  const oneOverContextLimit = `${atContextLimit}x`;
  const byteLimitButOverContextLimit = "🙂".repeat(fileByteLimit / 4);

  assert.equal(atContextLimit.length, normalizedContextLimit);
  assert.ok(
    atContextLimit.length <= normalizedContextLimit,
    "64,000 UTF-16 code units fit the normalized-context limit",
  );
  assert.equal(oneOverContextLimit.length, normalizedContextLimit + 1);
  assert.ok(
    oneOverContextLimit.length > normalizedContextLimit,
    "64,001 UTF-16 code units require a file-completeness block",
  );
  assert.equal(utf8ByteLength(byteLimitButOverContextLimit), fileByteLimit);
  assert.ok(
    byteLimitButOverContextLimit.length > normalizedContextLimit,
    "a file can fit the byte limit while exceeding the UTF-16 normalized-context limit",
  );

  assert.match(
    content,
    /Before the single `ima_context` hydration,[\s\S]*?exact complete pre-hydration read[\s\S]*?both independent\s+content limits before hydration/i,
  );
  assert.match(
    content,
    /raw file is at most 256 KiB \(262,144 bytes\);[\s\S]*?byte limit, not a character count[\s\S]*?complete normalized-context content is at most 64,000 JavaScript UTF-16 code units[\s\S]*?code-unit limit, not a byte count/i,
  );
  assert.match(
    content,
    /After\s+that single hydration,[\s\S]*?same complete matching content as the pre-hydration read/i,
  );
  assert.match(
    content,
    /Missing, changed, truncated,[\s\S]*?mismatched, or otherwise unverifiable complete-content evidence is `BLOCKED` before\s+lifecycle recall, delegation, or persistence/i,
  );
  assert.match(
    content,
    /Do not call `ima_context` again, rehydrate, reread as\s+a fallback, or fall back to a text payload/i,
  );
});

test("soft-cycle input contract preserves strict source and control gates", () => {
  const { content } = loadSoftCycleTemplate();

  for (const value of [
    "controls only",
    "BARE-INSTRUCTIONS",
    "bare uppercase Jira key",
    "approved configured Jira or Plane browse URL",
    "Never fetch, browse, redirect to",
    "lowercase-hyphenated",
    "available implementer-capable agent catalog",
    "project-relative file path or `file:` path",
    "suspected credential-bearing content",
    "fall back to a text payload",
    "manual key",
    "<project>:manual:<approved-name>:<YYYY-MM-DD>",
    "human-selected resume path",
    "human-selected new path",
  ]) {
    assert.match(content, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }

  assert.match(content, /one source followed only by\s+controls/i);
  assert.match(content, /never falls back to\s+prose/i);
  assert.match(content, /Do not build a programmatic soft-cycle parser or coordinator/i);
});

test("soft-cycle keeps manual identity and plan approval ownership distinct", () => {
  const { content } = loadSoftCycleTemplate();

  assert.match(
    content,
    /Both `project` and `approved-name` must each be 1–80 lowercase ASCII characters and exactly match\s+`\[a-z0-9\]\+\(\?:-\[a-z0-9\]\+\)\*`/,
  );
  assert.match(
    content,
    /bounded safe preview in both modes with the\s+project, proposed name, complete key, validated source\/file reference, bounded outcome, and an\s+explicit `new` or `resume` choice/i,
  );
  assert.match(
    content,
    /Validate `YYYY-MM-DD` as a UTC calendar date[\s\S]*?verified UTC date freezes with that approved key/i,
  );
  assert.match(
    content,
    /Do not silently normalize\s+an invalid adjustment:[\s\S]*?requires correction,[\s\S]*?new complete preview and renewed human\s+approval/i,
  );
  assert.match(
    content,
    /existing\s+exact\s+key\s+may\s+proceed\s+only\s+through\s+the\s+human-selected\s+resume\s+path,[\s\S]*?expected-empty\s+exact\s+key\s+may\s+proceed\s+only\s+through\s+the\s+human-selected\s+new\s+path/i,
  );
  assert.match(
    content,
    /Never create or consult a naming registry,[\s\S]*?auto-suffix, merge, overwrite, or similarity-match a manual identity/i,
  );
  assert.match(
    content,
    /manual identity\/new-versus-resume decision and required first-use BookStack placement consent\s+are human-owned/i,
  );
  assert.match(content, /Guided plan approval is human-owned/i);
  assert.match(
    content,
    /In autonomous mode, the orchestrator owns plan approval only after the existing safety gate confirms\s+one bounded, conflict-free, low-risk single unit/i,
  );
  assert.match(
    content,
    /safe autonomous approval is impossible, stop, persist `BLOCKED`/i,
  );
  assert.match(content, /An unsafe autonomous plan is `BLOCKED`/i);
  assert.doesNotMatch(
    content,
    /Switching mode never bypasses it, plan approval, or first-use BookStack placement consent/i,
  );
});

test("soft-cycle keeps raw input out of tools and states the strict file token grammar", () => {
  const { content } = loadSoftCycleTemplate();

  for (const value of [
    "Do not send the raw, unvalidated block to any tool",
    "fully validated, normalized source",
    "one required `ima_context` call",
    "whitespace-free, project-relative token",
    "`file:` immediately",
    "followed by one such token",
    "at most 1,024 characters",
    "each component must be nonempty",
    "ASCII letters, digits, `.`, `_`, or `-`",
    "absolute, home-expanded, backslash, drive, URI, glob, percent-encoded, or whitespace",
    "bare `file:`",
  ]) {
    assert.match(content, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }

  assert.match(
    content,
    /fully validated, normalized source—or, for text input, the validated\s+payload—be supplied to the one required `ima_context` call/i,
  );
  assert.match(
    content,
    /Do\s+not\s+hydrate,\s+delegate,\s+recall\s+lifecycle\s+evidence,\s+or\s+persist\s+before\s+that\s+point/i,
  );
  assert.match(content, /must not\s+be `\.` or `\.\.`/i);
});
