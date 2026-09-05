import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");

test("discovers exactly one package notification extension with its expected handlers", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "ima-notifications-agent-"));
  const settingsManager = SettingsManager.inMemory({ packages: [root] });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
  });

  try {
    await loader.reload();
    const extensionsResult = loader.getExtensions();
    const notifications = extensionsResult.extensions.filter(
      (extension) => extension.path.endsWith(join("extensions", "notifications.ts")),
    );

    assert.equal(notifications.length, 1);
    assert.deepEqual(notifications[0].sourceInfo, {
      path: join(root, "extensions", "notifications.ts"),
      source: root,
      scope: "user",
      origin: "package",
      baseDir: root,
    });
    assert.deepEqual([...notifications[0].handlers.keys()], [
      "session_start",
      "agent_start",
      "input",
      "before_agent_start",
      "agent_settled",
      "ui_prompt_start",
      "ui_prompt_end",
      "session_tree",
      "session_shutdown",
    ]);
    assert.equal(
      extensionsResult.extensions.some(
        (extension) => extension.path.endsWith(
          join("tests", "fixtures", "notifications-prompts.ts"),
        ),
      ),
      false,
    );
    assert.deepEqual(extensionsResult.errors, []);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
