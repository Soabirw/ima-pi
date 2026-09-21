import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  denyLiveFetch,
  PROVIDER_FREE_FETCH_ERROR,
} from "./fixtures/deny-live-fetch.js";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");

const readPackage = async () => JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);

test("the default core suite denies fetch and structurally excludes live tests", async () => {
  const packageJson = await readPackage();
  const readme = await readFile(join(root, "README.md"), "utf8");

  assert.equal(
    packageJson.scripts.test,
    "node --import ./tests/fixtures/deny-live-fetch.js --test tests/*.test.js",
  );
  assert.doesNotMatch(packageJson.scripts.test, /tests\/live\//);
  await Promise.all([
    access(join(root, "tests", "live", "tts-speech-live.test.js")),
    access(join(root, "tests", "live", "vestige-migrate-live.test.js")),
  ]);
  await assert.rejects(access(join(root, "tests", "tts-speech-live.test.js")));
  await assert.rejects(access(join(root, "tests", "vestige-migrate-live.test.js")));
  assert.match(
    readme,
    /IMA_TTS_IT=1 OPENAI_API_KEY=<configured-secret> node --test tests\/live\/tts-speech-live\.test\.js/,
  );
  assert.match(
    readme,
    /IMA_MIGRATE_IT=1 node --test tests\/live\/vestige-migrate-live\.test\.js/,
  );

  assert.equal(globalThis.fetch, denyLiveFetch);
  assert.equal(Object.getOwnPropertyDescriptor(globalThis, "fetch")?.writable, true);
  await assert.rejects(denyLiveFetch(), (error) => {
    assert.equal(error.message, PROVIDER_FREE_FETCH_ERROR);
    return true;
  });

  const originalFetch = globalThis.fetch;
  const inMemoryFetch = async () => ({ source: "in-memory" });
  try {
    globalThis.fetch = inMemoryFetch;
    assert.deepEqual(await globalThis.fetch(), { source: "in-memory" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
