import assert from "node:assert/strict";
import test from "node:test";
import { cleanForSpeech } from "../lib/ima-tts-clean.ts";
import { createSpeechEngine } from "../lib/ima-tts-speech.ts";
import { MAX_SPEECH_INPUT_CHARACTERS } from "../lib/ima-tts-segment.ts";
import {
  deferred,
  longSpeechText,
  speechRequest,
  successfulSynthesis,
} from "./tts-speech-fixtures.js";

test("contains asynchronous progress-hook rejection without delaying speech", async () => {
  const calls = { synthesize: 0, write: 0, playback: 0, remove: 0 };
  const engine = createSpeechEngine({
    exec: async () => {
      calls.playback += 1;
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

  const result = await engine.speak(speechRequest(), {
    onSegmentStart: async () => {
      throw new Error("async progress hook rejection");
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(result, { ok: true, spoke: true });
  assert.deepEqual(calls, { synthesize: 1, write: 1, playback: 1, remove: 1 });
});

test("does not start a segment after its progress hook cancels speech", async () => {
  const calls = { synthesize: 0, write: 0, playback: 0, remove: 0 };
  const engine = createSpeechEngine({
    exec: async () => {
      calls.playback += 1;
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

  const result = await engine.speak(speechRequest(), {
    onSegmentStart: () => engine.cancel(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "tts_cancelled");
  assert.deepEqual(calls, { synthesize: 0, write: 0, playback: 0, remove: 0 });
});

test("speaks long cleaned text in ordered sequential segments", async () => {
  const calls = {
    events: [],
    progress: [],
    synthesis: [],
    writes: [],
    playback: [],
    removals: [],
  };
  let identifier = 0;
  const engine = createSpeechEngine({
    exec: async (_command, args) => {
      const path = args.at(-1);
      calls.playback.push(path);
      calls.events.push(`play:${path}`);
      return { code: 0, killed: false };
    },
    synthesize: async ({ text }) => {
      calls.synthesis.push(text);
      calls.events.push(`synthesize:${calls.synthesis.length}`);
      return successfulSynthesis();
    },
    writeAudio: async (path) => {
      calls.writes.push(path);
      calls.events.push(`write:${path}`);
    },
    removeAudio: async (path) => {
      calls.removals.push(path);
      calls.events.push(`remove:${path}`);
    },
    getTemporaryDirectory: () => "/tmp/ima-tts-test",
    createIdentifier: () => `chunk-${identifier += 1}`,
  });
  const text = longSpeechText();

  const result = await engine.speak(speechRequest({ text }), {
    onSegmentStart: ({ index, total }) => {
      calls.progress.push({ index, total });
      if (index === 1) throw new Error("progress hook failed");
    },
  });
  const paths = calls.writes;

  assert.deepEqual(result, { ok: true, spoke: true });
  assert.ok(calls.synthesis.length > 1);
  assert.deepEqual(
    calls.progress,
    paths.map((_path, index) => ({ index: index + 1, total: paths.length })),
  );
  assert.equal(calls.synthesis.join(""), cleanForSpeech(text));
  assert.ok(calls.synthesis.every((chunk) => (
    chunk.length > 0 && chunk.length <= MAX_SPEECH_INPUT_CHARACTERS
  )));
  assert.equal(new Set(paths).size, paths.length);
  assert.deepEqual(calls.playback, paths);
  assert.deepEqual(calls.removals, paths);
  assert.deepEqual(
    calls.events,
    paths.flatMap((path, index) => [
      `synthesize:${index + 1}`,
      `write:${path}`,
      `play:${path}`,
      `remove:${path}`,
    ]),
  );
});

test("avoids separator-only synthesis at a paragraph straddle", async () => {
  const inputs = [];
  const text = [
    "x".repeat(MAX_SPEECH_INPUT_CHARACTERS - 1),
    "\n\n",
    "y".repeat(MAX_SPEECH_INPUT_CHARACTERS),
  ].join("");
  const engine = createSpeechEngine({
    exec: async () => ({ code: 0, killed: false }),
    synthesize: async ({ text: segment }) => {
      inputs.push(segment);
      return segment.trim()
        ? successfulSynthesis()
        : {
          ok: false,
          error: {
            code: "tts_synthesis_failed",
            message: "blank segment",
          },
        };
    },
    writeAudio: async () => {},
    removeAudio: async () => {},
  });

  const result = await engine.speak(speechRequest({ text }));

  assert.deepEqual(result, { ok: true, spoke: true });
  assert.equal(inputs.join(""), cleanForSpeech(text));
  assert.ok(inputs.every((segment) => (
    segment.trim() && segment.length <= MAX_SPEECH_INPUT_CHARACTERS
  )));
});

test("cancels a segmented sequence before later chunks start", async (t) => {
  await t.test("during a pending chunk", async () => {
    const pendingSynthesis = deferred();
    const secondSynthesisStarted = deferred();
    const synthesisInputs = [];
    let writes = 0;
    let playback = 0;
    const engine = createSpeechEngine({
      exec: async () => {
        playback += 1;
        return { code: 0, killed: false };
      },
      synthesize: async ({ text }) => {
        synthesisInputs.push(text);
        if (synthesisInputs.length === 2) {
          secondSynthesisStarted.resolve();
          return pendingSynthesis.promise;
        }
        return successfulSynthesis();
      },
      writeAudio: async () => {
        writes += 1;
      },
      removeAudio: async () => {},
    });

    const speaking = engine.speak(speechRequest({ text: longSpeechText() }));
    await secondSynthesisStarted.promise;
    engine.cancel();
    pendingSynthesis.resolve(successfulSynthesis());

    const result = await speaking;

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "tts_cancelled");
    assert.equal(synthesisInputs.length, 2);
    assert.equal(writes, 1);
    assert.equal(playback, 1);
  });

  await t.test("between completed chunks", async () => {
    const firstCleanup = deferred();
    const cleanupStarted = deferred();
    const synthesisInputs = [];
    const progress = [];
    let cleanupCalls = 0;
    const engine = createSpeechEngine({
      exec: async () => ({ code: 0, killed: false }),
      synthesize: async ({ text }) => {
        synthesisInputs.push(text);
        return successfulSynthesis();
      },
      writeAudio: async () => {},
      removeAudio: async () => {
        cleanupCalls += 1;
        if (cleanupCalls === 1) {
          cleanupStarted.resolve();
          await firstCleanup.promise;
        }
      },
    });

    const speaking = engine.speak(
      speechRequest({ text: longSpeechText() }),
      {
        onSegmentStart: ({ index, total }) => progress.push({ index, total }),
      },
    );
    await cleanupStarted.promise;
    engine.cancel();
    firstCleanup.resolve();

    const result = await speaking;

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "tts_cancelled");
    assert.equal(synthesisInputs.length, 1);
    assert.equal(cleanupCalls, 2);
    assert.deepEqual(progress.map(({ index }) => index), [1]);
    assert.ok(progress[0].total > 1);
  });
});

test("stops a segmented sequence at the first middle failure", async (t) => {
  const scenarios = [
    { failurePoint: "synthesis", expectedCode: "tts_synthesis_failed" },
    { failurePoint: "write", expectedCode: "tts_audio_write_failed" },
    { failurePoint: "playback", expectedCode: "tts_playback_failed" },
  ];

  for (const { failurePoint, expectedCode } of scenarios) {
    await t.test(`${failurePoint} failure prevents later chunks`, async () => {
      let synthesisCalls = 0;
      let writeCalls = 0;
      let playbackCalls = 0;
      const engine = createSpeechEngine({
        exec: async () => {
          playbackCalls += 1;
          return failurePoint === "playback" && playbackCalls === 2
            ? { code: 1, killed: false }
            : { code: 0, killed: false };
        },
        synthesize: async () => {
          synthesisCalls += 1;
          return failurePoint === "synthesis" && synthesisCalls === 2
            ? {
              ok: false,
              error: {
                code: "tts_synthesis_failed",
                message: "provider failure",
              },
            }
            : successfulSynthesis();
        },
        writeAudio: async () => {
          writeCalls += 1;
          if (failurePoint === "write" && writeCalls === 2) {
            throw new Error("write failure");
          }
        },
        removeAudio: async () => {
          throw new Error("cleanup failure");
        },
      });

      const result = await engine.speak(speechRequest({ text: longSpeechText() }));

      assert.equal(result.ok, false);
      assert.equal(result.error.code, expectedCode);
      assert.equal(synthesisCalls, 2);
    });
  }
});
