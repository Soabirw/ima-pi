import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFile(resolve(root, path), "utf8");

const has = (content, marker) => assert.ok(content.includes(marker), marker);

test("delegated-Bash skill defines observable sequencing and accurate shell semantics", async () => {
  const content = await read("skills/ima-delegated-bash/SKILL.md");

  for (const marker of [
    "Use one logical command per delegated Bash call.",
    "Await each call and inspect a successful result before issuing a dependent call.",
    "Prefer native `read`, search, `edit`, and `write` tools",
    "Use repository-relative delegated paths only; do not use absolute or `./` paths.",
    "`&&` runs its right-hand command only when the left-hand command succeeds.",
    "`;` starts the next command after the preceding command finishes; it does not itself require success.",
    "`&` backgrounds the preceding job, allowing the shell to continue without waiting for it.",
    "Those are normal shell semantics.",
    "They are not a delegated authorization sequence",
    "Do not use separators, backgrounding, pipes, command/process substitutions, redirects, shell wrappers, alternate shells, or indirect execution",
    "report the exact unrun verification and reason to the parent",
    "The adapter remains authoritative",
    "neither expands an allowlist nor permits an otherwise denied command",
  ]) has(content, marker);
});

test("delegation contract requires the same deterministic guidance for fresh and continued children", async () => {
  const content = await read("skills/ima-delegation-contract/SKILL.md");

  for (const marker of [
    "When a child's resolved tools include `bash` or `test`",
    "both fresh and continued prompts, including trusted custom definitions",
    "Require one logical Bash command per call",
    "`&&` conditionally runs its right side",
    "`;` does not require success",
    "`&` backgrounds work",
    "Prompt guidance is a deterministic instruction contract, not proof of universal model compliance",
    "supplements and never replaces adapter ownership, authorization, and fail-closed enforcement",
  ]) has(content, marker);
});
