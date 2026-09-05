import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadNotificationConfig,
  MAX_NOTIFICATION_CONFIG_BYTES,
} from "../extensions/notifications.ts";

const createFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-notifications-config-"));
  const packageBasePath = join(root, "package", "config");
  const userBasePath = join(root, "agent", "ima");
  const paths = {
    packageBasePath,
    packageConfigPath: join(packageBasePath, "notifications.json"),
    userBasePath,
    userConfigPath: join(userBasePath, "notifications.json"),
  };

  await Promise.all([
    mkdir(packageBasePath, { recursive: true }),
    mkdir(userBasePath, { recursive: true }),
  ]);

  return { root, paths };
};

const withFixture = async (callback) => {
  const fixture = await createFixture();
  try {
    await callback(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
};

const writeJson = (path, value) => writeFile(path, JSON.stringify(value), "utf8");

const writeBundledDefault = ({ paths }) =>
  writeJson(paths.packageConfigPath, { enable: true });

test("uses the bundled default when the optional user file is absent", async () => {
  await withFixture(async (fixture) => {
    await writeBundledDefault(fixture);

    assert.deepEqual(await loadNotificationConfig(fixture.paths), {
      valid: true,
      config: { enable: true },
    });
  });
});

test("uses the bundled default when the optional user base is absent", async () => {
  await withFixture(async (fixture) => {
    await writeBundledDefault(fixture);
    await rm(fixture.paths.userBasePath, { recursive: true, force: true });

    assert.deepEqual(await loadNotificationConfig(fixture.paths), {
      valid: true,
      config: { enable: true },
    });
  });
});

test("merges an empty user layer and applies an explicit user opt-out", async (t) => {
  await t.test("empty layer inherits the bundled default", async () => {
    await withFixture(async (fixture) => {
      await writeBundledDefault(fixture);
      await writeJson(fixture.paths.userConfigPath, {});

      assert.deepEqual(await loadNotificationConfig(fixture.paths), {
        valid: true,
        config: { enable: true },
      });
    });
  });

  await t.test("explicit false suppresses notifications", async () => {
    await withFixture(async (fixture) => {
      await writeBundledDefault(fixture);
      await writeJson(fixture.paths.userConfigPath, { enable: false });

      assert.deepEqual(await loadNotificationConfig(fixture.paths), {
        valid: true,
        config: { enable: false },
      });
    });
  });
});

test("fails closed when the bundled layer is missing, incomplete, or malformed", async (t) => {
  await t.test("missing bundled file", async () => {
    await withFixture(async ({ paths }) => {
      assert.deepEqual(await loadNotificationConfig(paths), { valid: false });
    });
  });

  await t.test("incomplete bundled file", async () => {
    await withFixture(async (fixture) => {
      await writeJson(fixture.paths.packageConfigPath, {});
      assert.deepEqual(await loadNotificationConfig(fixture.paths), { valid: false });
    });
  });

  await t.test("malformed bundled JSON", async () => {
    await withFixture(async (fixture) => {
      await writeFile(fixture.paths.packageConfigPath, "{", "utf8");
      assert.deepEqual(await loadNotificationConfig(fixture.paths), { valid: false });
    });
  });
});

test("fails closed for malformed, unknown, oversized, and nonregular user configuration", async (t) => {
  await t.test("unknown key", async () => {
    await withFixture(async (fixture) => {
      await writeBundledDefault(fixture);
      await writeJson(fixture.paths.userConfigPath, { other: true });
      assert.deepEqual(await loadNotificationConfig(fixture.paths), { valid: false });
    });
  });

  await t.test("non-boolean value", async () => {
    await withFixture(async (fixture) => {
      await writeBundledDefault(fixture);
      await writeJson(fixture.paths.userConfigPath, { enable: "false" });
      assert.deepEqual(await loadNotificationConfig(fixture.paths), { valid: false });
    });
  });

  await t.test("oversized file", async () => {
    await withFixture(async (fixture) => {
      await writeBundledDefault(fixture);
      await writeFile(
        fixture.paths.userConfigPath,
        `{"enable":true}${" ".repeat(MAX_NOTIFICATION_CONFIG_BYTES)}`,
        "utf8",
      );
      assert.deepEqual(await loadNotificationConfig(fixture.paths), { valid: false });
    });
  });

  await t.test("directory instead of a regular file", async () => {
    await withFixture(async (fixture) => {
      await writeBundledDefault(fixture);
      await mkdir(fixture.paths.userConfigPath);
      assert.deepEqual(await loadNotificationConfig(fixture.paths), { valid: false });
    });
  });
});

test(
  "rejects configuration symlink targets that escape their approved base",
  { skip: process.platform === "win32" },
  async () => {
    await withFixture(async (fixture) => {
      const outsidePath = join(fixture.root, "outside.json");
      await writeJson(outsidePath, { enable: false });
      await symlink(outsidePath, fixture.paths.packageConfigPath);

      assert.deepEqual(await loadNotificationConfig(fixture.paths), { valid: false });
    });
  },
);

test(
  "fails closed for dangling user configuration file and base symlinks",
  { skip: process.platform === "win32" },
  async (t) => {
    await t.test("in-base user-file target", async () => {
      await withFixture(async (fixture) => {
        await writeBundledDefault(fixture);
        await symlink(
          join(fixture.paths.userBasePath, "missing.json"),
          fixture.paths.userConfigPath,
        );

        assert.deepEqual(await loadNotificationConfig(fixture.paths), {
          valid: false,
        });
      });
    });

    await t.test("escaping user-file target", async () => {
      await withFixture(async (fixture) => {
        await writeBundledDefault(fixture);
        await symlink(
          join(fixture.root, "missing-outside", "notifications.json"),
          fixture.paths.userConfigPath,
        );

        assert.deepEqual(await loadNotificationConfig(fixture.paths), {
          valid: false,
        });
      });
    });

    await t.test("user-base target", async () => {
      await withFixture(async (fixture) => {
        await writeBundledDefault(fixture);
        await rm(fixture.paths.userBasePath, { recursive: true, force: true });
        await symlink(
          join(fixture.root, "missing-agent", "ima"),
          fixture.paths.userBasePath,
        );

        assert.deepEqual(await loadNotificationConfig(fixture.paths), {
          valid: false,
        });
      });
    });
  },
);

test(
  "accepts a regular-file symlink target that remains inside its approved base",
  { skip: process.platform === "win32" },
  async () => {
    await withFixture(async (fixture) => {
      const bundledTarget = join(fixture.paths.packageBasePath, "default.json");
      const userTarget = join(fixture.paths.userBasePath, "override.json");
      await writeJson(bundledTarget, { enable: true });
      await writeJson(userTarget, { enable: false });
      await symlink(bundledTarget, fixture.paths.packageConfigPath);
      await symlink(userTarget, fixture.paths.userConfigPath);

      assert.deepEqual(await loadNotificationConfig(fixture.paths), {
        valid: true,
        config: { enable: false },
      });
    });
  },
);
