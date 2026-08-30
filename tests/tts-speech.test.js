import assert from "node:assert/strict";
import test from "node:test";
import { createSpeechEngine } from "../lib/ima-tts-speech.ts";
import {
  deferred,
  speechRequest,
  successfulSynthesis,
} from "./tts-speech-fixtures.js";

test("skips cleanup-only input without synthesis, filesystem, or player effects", async () => {
  const calls = { synthesize: 0, write: 0, execute: 0, remove: 0 };
  const engine = createSpeechEngine({
    exec: async () => {
      calls.execute += 1;
      return { code: 0, killed: false };
    },
    synthesize: async () => {
      calls.synthesize += 1;
      return successfulSynthesis();
    },
    writeAudio: async () => {
      calls.write += 1;
    },
    removeAudio: async () => {
      calls.remove += 1;
    },
  });

  for (const text of [
    "<!-- hidden -->\n```js\nconst ignored = true;\n```",
    "/etc/passwd",
  ]) {
    const result = await engine.speak(speechRequest({ text }));

    assert.deepEqual(result, { ok: true, spoke: false });
  }

  assert.deepEqual(calls, { synthesize: 0, write: 0, execute: 0, remove: 0 });
});

test("rejects a relative player command before metered synthesis", async () => {
  let synthesisCalls = 0;
  const engine = createSpeechEngine({
    exec: async () => ({ code: 0, killed: false }),
    synthesize: async () => {
      synthesisCalls += 1;
      return successfulSynthesis();
    },
  });

  const result = await engine.speak(speechRequest({
    playerCommand: "relative/player",
  }));

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "tts_playback_failed");
  assert.equal(synthesisCalls, 0);
});

test("writes private temporary MP3 audio, plays it without a shell, and removes it", async () => {
  const calls = { synthesize: [], write: [], execute: [], remove: [] };
  const engine = createSpeechEngine({
    exec: async (command, args, options) => {
      calls.execute.push({ command, args, options });
      return { code: 0, killed: false };
    },
    synthesize: async (request) => {
      calls.synthesize.push(request);
      return successfulSynthesis();
    },
    writeAudio: async (path, audio, options) => {
      calls.write.push({ path, audio, options });
    },
    removeAudio: async (path) => {
      calls.remove.push(path);
    },
    getTemporaryDirectory: () => "/tmp/ima-tts-test",
    createIdentifier: () => "fixed-id",
  });

  const result = await engine.speak(speechRequest());
  const path = "/tmp/ima-tts-test/ima-tts-fixed-id.mp3";

  assert.deepEqual(result, { ok: true, spoke: true });
  assert.equal(calls.synthesize.length, 1);
  assert.equal(calls.write.length, 1);
  assert.equal(calls.write[0].path, path);
  assert.deepEqual(calls.write[0].audio, Uint8Array.of(1, 2, 3));
  assert.deepEqual(calls.write[0].options, { mode: 0o600, flag: "wx" });
  assert.deepEqual(calls.execute.map(({ command, args }) => ({ command, args })), [
    { command: "ffplay", args: ["-autoexit", path] },
  ]);
  assert.equal(calls.execute[0].options.signal, calls.synthesize[0].signal);
  assert.deepEqual(calls.remove, [path]);
});

test("adds autoexit only to FFplay playback commands", async (t) => {
  const commands = [
    {
      label: "bare FFplay",
      playerCommand: "ffplay",
      prefix: ["-autoexit"],
    },
    {
      label: "absolute FFplay",
      playerCommand: "/usr/bin/ffplay",
      prefix: ["-autoexit"],
    },
    {
      label: "bare custom player",
      playerCommand: "mpv",
      prefix: [],
    },
    {
      label: "absolute custom player",
      playerCommand: "/usr/bin/mpv",
      prefix: [],
    },
  ];

  for (const [index, { label, playerCommand, prefix }] of commands.entries()) {
    await t.test(label, async () => {
      let execution;
      let synthesisSignal;
      const engine = createSpeechEngine({
        exec: async (command, args, options) => {
          execution = { command, args, options };
          return { code: 0, killed: false };
        },
        synthesize: async ({ signal }) => {
          synthesisSignal = signal;
          return successfulSynthesis();
        },
        writeAudio: async () => {},
        removeAudio: async () => {},
        getTemporaryDirectory: () => "/tmp/ima-tts-test",
        createIdentifier: () => `player-${index}`,
      });
      const path = `/tmp/ima-tts-test/ima-tts-player-${index}.mp3`;

      const result = await engine.speak(speechRequest({ playerCommand }));

      assert.deepEqual(result, { ok: true, spoke: true });
      assert.equal(execution.command, playerCommand);
      assert.deepEqual(execution.args, [...prefix, path]);
      assert.equal(execution.options.signal, synthesisSignal);
    });
  }
});

test("contains synthesis, write, and player failures while cleaning owned audio", async (t) => {
  await t.test("synthesis failure has no later effects", async () => {
    const calls = { write: 0, execute: 0, remove: 0 };
    const engine = createSpeechEngine({
      exec: async () => {
        calls.execute += 1;
        return { code: 0, killed: false };
      },
      synthesize: async () => ({
        ok: false,
        error: { code: "tts_synthesis_failed", message: "untrusted provider body" },
      }),
      writeAudio: async () => {
        calls.write += 1;
      },
      removeAudio: async () => {
        calls.remove += 1;
      },
    });

    const result = await engine.speak(speechRequest());

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "tts_synthesis_failed");
    assert.deepEqual(calls, { write: 0, execute: 0, remove: 0 });
  });

  await t.test("write failure prevents playback and removes the temporary path", async () => {
    const removals = [];
    let executions = 0;
    const engine = createSpeechEngine({
      exec: async () => {
        executions += 1;
        return { code: 0, killed: false };
      },
      synthesize: async () => successfulSynthesis(),
      writeAudio: async () => {
        throw new Error("write failed");
      },
      removeAudio: async (path) => {
        removals.push(path);
      },
      getTemporaryDirectory: () => "/tmp/ima-tts-test",
      createIdentifier: () => "write-failure",
    });

    const result = await engine.speak(speechRequest());

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "tts_audio_write_failed");
    assert.equal(executions, 0);
    assert.deepEqual(removals, ["/tmp/ima-tts-test/ima-tts-write-failure.mp3"]);
  });

  await t.test("player failure remains non-fatal and removes the temporary path", async () => {
    const removals = [];
    const engine = createSpeechEngine({
      exec: async () => ({ code: 1, killed: false }),
      synthesize: async () => successfulSynthesis(),
      writeAudio: async () => {},
      removeAudio: async (path) => {
        removals.push(path);
      },
      getTemporaryDirectory: () => "/tmp/ima-tts-test",
      createIdentifier: () => "player-failure",
    });

    const result = await engine.speak(speechRequest());

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "tts_playback_failed");
    assert.deepEqual(removals, ["/tmp/ima-tts-test/ima-tts-player-failure.mp3"]);
  });
});

test("supersedes stale synthesis without letting it clear the current operation", async () => {
  const firstSynthesis = deferred();
  const secondSynthesis = deferred();
  const signals = [];
  const executions = [];
  let synthesisCalls = 0;
  const engine = createSpeechEngine({
    exec: async (command, args) => {
      executions.push({ command, args });
      return { code: 0, killed: false };
    },
    synthesize: (request) => {
      signals.push(request.signal);
      synthesisCalls += 1;
      return synthesisCalls === 1 ? firstSynthesis.promise : secondSynthesis.promise;
    },
    writeAudio: async () => {},
    removeAudio: async () => {},
    getTemporaryDirectory: () => "/tmp/ima-tts-test",
    createIdentifier: () => "current",
  });

  const first = engine.speak(speechRequest({ text: "First request" }));
  const second = engine.speak(speechRequest({ text: "Second request" }));

  assert.equal(signals.length, 2);
  assert.equal(signals[0].aborted, true);

  firstSynthesis.resolve(successfulSynthesis());
  const firstResult = await first;
  assert.equal(firstResult.ok, false);
  assert.equal(firstResult.error.code, "tts_cancelled");

  secondSynthesis.resolve(successfulSynthesis());
  assert.deepEqual(await second, { ok: true, spoke: true });
  assert.deepEqual(executions, [{
    command: "ffplay",
    args: ["-autoexit", "/tmp/ima-tts-test/ima-tts-current.mp3"],
  }]);
});

test("cancels in-flight synthesis immediately and remains idempotent", async () => {
  const pendingSynthesis = deferred();
  let synthesisSignal;
  const calls = { write: 0, execute: 0, remove: 0 };
  const engine = createSpeechEngine({
    exec: async () => {
      calls.execute += 1;
      return { code: 0, killed: false };
    },
    synthesize: (request) => {
      synthesisSignal = request.signal;
      return pendingSynthesis.promise;
    },
    writeAudio: async () => {
      calls.write += 1;
    },
    removeAudio: async () => {
      calls.remove += 1;
    },
  });

  const speaking = engine.speak(speechRequest());
  engine.cancel();
  assert.doesNotThrow(() => engine.cancel());
  assert.equal(synthesisSignal.aborted, true);

  pendingSynthesis.resolve(successfulSynthesis());
  const result = await speaking;

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "tts_cancelled");
  assert.deepEqual(calls, { write: 0, execute: 0, remove: 0 });
});

test("cancels in-flight playback and starts temporary-file cleanup", async () => {
  const pendingPlayback = deferred();
  const playbackStarted = deferred();
  const removals = [];
  let playbackSignal;
  const engine = createSpeechEngine({
    exec: (command, args, options) => {
      playbackSignal = options.signal;
      playbackStarted.resolve({ command, args });
      return pendingPlayback.promise;
    },
    synthesize: async () => successfulSynthesis(),
    writeAudio: async () => {},
    removeAudio: async (path) => {
      removals.push(path);
    },
    getTemporaryDirectory: () => "/tmp/ima-tts-test",
    createIdentifier: () => "cancelled",
  });

  const speaking = engine.speak(speechRequest());
  await playbackStarted.promise;
  engine.cancel();
  engine.cancel();

  assert.equal(playbackSignal.aborted, true);
  assert.deepEqual(removals, ["/tmp/ima-tts-test/ima-tts-cancelled.mp3"]);

  pendingPlayback.resolve({ code: 0, killed: false });
  const result = await speaking;

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "tts_cancelled");
  assert.deepEqual(removals, [
    "/tmp/ima-tts-test/ima-tts-cancelled.mp3",
    "/tmp/ima-tts-test/ima-tts-cancelled.mp3",
  ]);
});
