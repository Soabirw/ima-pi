import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");

const runPi = (args, options) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn("pi", args, { ...options, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`pi exited with code ${code} and signal ${signal}`));
    });
  });

const extension = (command, body = "") => `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
${body}
export default function (pi: ExtensionAPI) {
  pi.registerCommand("${command}", {
    description: "Discovery test command",
    handler: async () => {},
  });
}
`;

test("package exposes namespaced extension, prompt, and skill commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ima-pi-package-"));
  const resultPath = join(directory, "result.json");

  await runPi(["--no-session", "-e", root, "-p", "/ima:probe package"], {
    cwd: root,
    env: { ...process.env, IMA_PI_PROBE_RESULT: resultPath },
  });

  const result = JSON.parse(await readFile(resultPath, "utf8"));
  const commands = new Map(result.commands.map((command) => [command.name, command]));

  assert.equal(result.args, "package");
  assert.equal(commands.get("ima:probe")?.source, "extension");
  assert.equal(commands.get("ima:delegate-probe")?.source, "extension");
  assert.equal(commands.get("ima:control-probe")?.source, "extension");
  assert.equal(commands.get("ima:profile")?.source, "extension");
  assert.equal(commands.get("ima:prompt")?.source, "prompt");
  for (const [name, description] of [["serena-bootstrap", "Serena project instructions"], ["vestige-bootstrap", "Vestige.*without mutation"], ["ship-it", "Prepare and validate staging release branches"], ["memorize", "stable project fact"], ["preflight", "read-only Pi and IMA diagnostic"], ["migrate", "legacy configuration"], ["brainstorm", "product requirements"], ["decompose", "two-tier delivery units"], ["plan", "technical implementation contract"], ["architect", "bounded evidence-oriented architecture assessment"], ["investigate", "Investigate and trace a problem without applying a fix"], ["instruct", "Research and teach what the user should do and why"], ["prompt-start", "Turn rough context into a clear prompt for a dedicated workflow"], ["test", "formal test phase"], ["review", "independent product-read-only review"], ["review-verify", "Verify exactly one review finding"], ["document", "documentation and learning closeout"], ["ui-ux-review", "read-only UI/UX review"], ["design-to-code", "WordPress and Bootstrap design-to-code"], ["medical-research", "current primary-source verification"], ["patristic-research", "early Christianity through Augustine"]]) {
    assert.equal(commands.get(`ima:${name}`)?.source, "prompt");
    assert.equal(commands.get(`ima:${name}`)?.origin, "package");
    assert.match(await readFile(join(root, "prompts", `ima:${name}.md`), "utf8"), new RegExp(description, "i"));
  }
  for (const name of ["ima-pi-probe", "ima-medical-research", "patristic-researcher", "ima-brand", "ima-copywriting", "ima-editorial-scorecard", "ima-editorial-workflow", "ima-email-creator", "architect", "functional-programmer", "js-fp", "php-fp", "py-fp", "ruby-fp", "rg", "ima-git", "gh-cli", "tea-gitea", "js-fp-api", "js-fp-react", "js-fp-vue", "js-fp-wordpress", "jquery", "playwright", "unit-testing", "php-fp-wordpress", "phpunit-wp", "wp-ddev", "ima-bootstrap", "livecanvas", "ima-forms-expert", "php-authnet", "mcp-serena", "mcp-vestige", "mcp-qdrant", "mcp-atlassian", "mcp-taskwarrior", "mcp-context7", "mcp-tavily", "mcp-fetch", "mcp-sequential-thinking", "mcp-chrome-devtools", "pi-preflight", "pi-doc-guide", "ima-pi-guide"]) {
    const skill = commands.get(`skill:${name}`);
    assert.equal(skill?.source, "skill");
    assert.equal(skill?.origin, "top-level");
  }
});

test("package ships integrations extension with both production tool registrations", async () => {
  const integrations = await readFile(join(root, "extensions", "integrations.ts"), "utf8");
  assert.match(integrations, /registerTool\(\{ name: "ima_context"/);
  assert.match(integrations, /registerTool\(\{ name: "ima_lifecycle"/);
  assert.equal((await readFile(join(root, "extensions", "gateway-probe.ts"), "utf8")).includes("ima:gateway-probe"), true);
});

test("Pi discovers package, user, and trusted project resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ima-pi-scopes-"));
  const agentDir = join(directory, "agent");
  const projectDir = join(directory, "project");
  const resultPath = join(directory, "catalog.json");

  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(join(projectDir, ".pi", "extensions"), { recursive: true });

  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [root] }),
  );
  await writeFile(
    join(agentDir, "extensions", "user.ts"),
    extension("ima:user-probe"),
  );
  await writeFile(
    join(projectDir, ".pi", "extensions", "project.ts"),
    `
import { writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerCommand("ima:project-probe", {
    description: "Discovery test command",
    handler: async () => {},
  });
  pi.registerCommand("ima:catalog", {
    description: "Write the command catalog",
    handler: async () => {
      await writeFile(process.env.IMA_PI_CATALOG_RESULT!, JSON.stringify(pi.getCommands(), null, 2));
    },
  });
}
`,
  );

  await runPi(["--no-session", "--approve", "-p", "/ima:catalog"], {
    cwd: projectDir,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      IMA_PI_CATALOG_RESULT: resultPath,
    },
  });

  const commands = JSON.parse(await readFile(resultPath, "utf8"));
  const byName = new Map(commands.map((command) => [command.name, command]));

  assert.deepEqual(
    {
      package: byName.get("ima:probe")?.sourceInfo,
      user: byName.get("ima:user-probe")?.sourceInfo,
      project: byName.get("ima:project-probe")?.sourceInfo,
    },
    {
      package: {
        path: join(root, "extensions", "discovery-probe.ts"),
        source: root,
        scope: "user",
        origin: "package",
        baseDir: root,
      },
      user: {
        path: join(agentDir, "extensions", "user.ts"),
        source: "auto",
        scope: "user",
        origin: "top-level",
        baseDir: agentDir,
      },
      project: {
        path: join(projectDir, ".pi", "extensions", "project.ts"),
        source: "auto",
        scope: "project",
        origin: "top-level",
        baseDir: join(projectDir, ".pi"),
      },
    },
  );
});


test("Pi prompt collisions prefer user over package and project over user", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ima-pi-prompt-precedence-"));
  const agentDir = join(directory, "agent");
  const projectDir = join(directory, "project");
  const userResultPath = join(directory, "user-catalog.json");
  const projectResultPath = join(directory, "project-catalog.json");
  const userPromptPath = join(agentDir, "prompts", "ima:prompt.md");
  const projectPromptPath = join(projectDir, ".pi", "prompts", "ima:prompt.md");

  await mkdir(dirname(userPromptPath), { recursive: true });
  await mkdir(dirname(projectPromptPath), { recursive: true });
  await mkdir(join(projectDir, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [root] }),
  );
  await writeFile(
    userPromptPath,
    "---\ndescription: User prompt override\n---\nUser prompt body\n",
  );
  await writeFile(
    join(projectDir, ".pi", "extensions", "catalog.ts"),
    `
import { writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerCommand("ima:catalog", {
    description: "Write the command catalog",
    handler: async () => {
      await writeFile(process.env.IMA_PI_CATALOG_RESULT!, JSON.stringify(pi.getCommands(), null, 2));
    },
  });
}
`,
  );

  await runPi(["--no-session", "--approve", "-p", "/ima:catalog"], {
    cwd: projectDir,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      IMA_PI_CATALOG_RESULT: userResultPath,
    },
  });

  const userCommands = JSON.parse(await readFile(userResultPath, "utf8"));
  const userPrompts = userCommands.filter((command) => command.name === "ima:prompt");

  assert.equal(userPrompts.length, 1);
  assert.equal(userPrompts[0].description, "User prompt override");
  assert.deepEqual(userPrompts[0].sourceInfo, {
    path: userPromptPath,
    source: "auto",
    scope: "user",
    origin: "top-level",
    baseDir: agentDir,
  });

  await writeFile(
    projectPromptPath,
    "---\ndescription: Project prompt override\n---\nProject prompt body\n",
  );
  await runPi(["--no-session", "--approve", "-p", "/ima:catalog"], {
    cwd: projectDir,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      IMA_PI_CATALOG_RESULT: projectResultPath,
    },
  });

  const projectCommands = JSON.parse(await readFile(projectResultPath, "utf8"));
  const projectPrompts = projectCommands.filter((command) => command.name === "ima:prompt");

  assert.equal(projectPrompts.length, 1);
  assert.equal(projectPrompts[0].description, "Project prompt override");
  assert.deepEqual(projectPrompts[0].sourceInfo, {
    path: projectPromptPath,
    source: "auto",
    scope: "project",
    origin: "top-level",
    baseDir: join(projectDir, ".pi"),
  });
});
