import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import test from "node:test";
import { cleanForSpeech } from "../lib/ima-tts-clean.ts";
import {
  createSpeechEngine,
  synthesizeSpeech,
} from "../lib/ima-tts-speech.ts";
import { MAX_SPEECH_INPUT_CHARACTERS } from "../lib/ima-tts-segment.ts";
import {
  playerCandidatePaths,
  TTS_CONFIG_DEFAULTS,
} from "../lib/ima-tts.ts";

const speechRequest = (overrides = {}) => ({
  text: "Read this aloud.",
  apiKey: "test-api-key",
  model: "gpt-4o-mini-tts",
  voice: "alloy",
  playerCommand: "ffplay",
  ...overrides,
});

const successfulSynthesis = () => Object.freeze({
  ok: true,
  audio: Uint8Array.of(1, 2, 3),
});

const longSpeechText = () => "Sentence. ".repeat(1_000).trim();

const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const playerIsAvailable = async (playerCommand) => {
  const candidates = playerCandidatePaths(playerCommand, process.env.PATH);

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }

  return false;
};

const runLivePlayer = (command, args, { signal }) => new Promise((resolve) => {
  let settled = false;
  let killed = false;
  let child;

  const finish = (code) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", stopPlayer);
    resolve({ code: code ?? 1, killed });
  };

  const stopPlayer = () => {
    if (killed) return;
    killed = true;
    try {
      child.kill("SIGTERM");
    } catch {
      finish(1);
    }
  };

  try {
    child = spawn(command, args, { shell: false, stdio: "ignore" });
  } catch {
    finish(1);
    return;
  }

  if (signal.aborted) stopPlayer();
  else signal.addEventListener("abort", stopPlayer, { once: true });
  child.once("error", () => finish(1));
  child.once("close", finish);
});

test("cleans Markdown into deterministic spoken-friendly prose", () => {
  const source = [
    "# Finding",
    "Keep **useful** [words](https://example.com/docs).",
    "> - `Read this`",
  ].join("\n");

  const cleaned = cleanForSpeech(source);

  assert.equal(cleaned, "Finding\nKeep useful words.\nRead this");
  assert.equal(source, [
    "# Finding",
    "Keep **useful** [words](https://example.com/docs).",
    "> - `Read this`",
  ].join("\n"));
  assert.equal(cleanForSpeech(source), cleaned);
});

test("removes comments, HTML, fenced code, bare URLs, and absolute paths", () => {
  const source = [
    "<!-- ima-cycle outcome: phase=plan; outcome=COMPLETED -->",
    "<p>Before</p>",
    "```ts",
    "const ignored = true;",
    "```",
    "After https://example.com/now /home/eric/IMA/dev/ima-pi/lib/ima-tts.ts",
  ].join("\n");

  assert.equal(cleanForSpeech(source), "Before\nAfter");
});

test("removes short POSIX paths without stripping slash prose", () => {
  const source = "Keep /etc/passwd and (/tmp/audio.mp3) with /profile but preserve and/or";
  const cleaned = cleanForSpeech(source);

  assert.equal(cleaned, "Keep and () with but preserve and/or");
  assert.equal(cleanForSpeech(source), cleaned);
  assert.equal(
    source,
    "Keep /etc/passwd and (/tmp/audio.mp3) with /profile but preserve and/or",
  );
});

test("collapses whitespace while retaining useful prose", () => {
  assert.equal(
    cleanForSpeech("  First   line  \r\n\r\n\r\n  Second line  "),
    "First line\n\nSecond line",
  );
});

test("posts an MP3 OpenAI synthesis request with the supplied abort signal", async () => {
  const controller = new AbortController();
  const audio = Uint8Array.of(5, 8, 13);
  let request;

  const result = await synthesizeSpeech({
    ...speechRequest({ text: "Speak this." }),
    signal: controller.signal,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        arrayBuffer: async () => audio.buffer,
      };
    },
  });

  assert.deepEqual(result, { ok: true, audio });
  assert.equal(request.url, "https://api.openai.com/v1/audio/speech");
  assert.deepEqual(request.options.headers, {
    Authorization: "Bearer test-api-key",
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(request.options.body), {
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: "Speak this.",
    response_format: "mp3",
  });
  assert.equal(request.options.signal, controller.signal);
});

test("preserves nonblank segment boundaries in provider input", async () => {
  const text = " \nSegment boundary text.\n ";
  let providerInput;
  let fetchCalls = 0;

  const result = await synthesizeSpeech({
    ...speechRequest({ text }),
    signal: new AbortController().signal,
    fetchImpl: async (_url, options) => {
      fetchCalls += 1;
      providerInput = JSON.parse(options.body).input;
      return {
        ok: true,
        arrayBuffer: async () => Uint8Array.of(1).buffer,
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(fetchCalls, 1);
  assert.equal(providerInput, text);

  let blankFetchCalls = 0;
  const blankResult = await synthesizeSpeech({
    ...speechRequest({ text: " \n\t " }),
    signal: new AbortController().signal,
    fetchImpl: async () => {
      blankFetchCalls += 1;
      return {
        ok: true,
        arrayBuffer: async () => Uint8Array.of(1).buffer,
      };
    },
  });

  assert.equal(blankResult.ok, false);
  assert.equal(blankResult.error.code, "tts_synthesis_failed");
  assert.equal(blankFetchCalls, 0);
});

test("contains synthesis transport, API, abort, and malformed-audio failures", async () => {
  const failedFetches = [
    async () => {
      throw new Error("test-api-key must not escape");
    },
    async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) }),
    async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }),
  ];

  for (const fetchImpl of failedFetches) {
    const result = await synthesizeSpeech({
      ...speechRequest(),
      signal: new AbortController().signal,
      fetchImpl,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "tts_synthesis_failed");
    assert.doesNotMatch(result.error.message, /test-api-key|response body/i);
  }

  const controller = new AbortController();
  controller.abort();
  let fetchCalls = 0;
  const aborted = await synthesizeSpeech({
    ...speechRequest(),
    signal: controller.signal,
    fetchImpl: async () => {
      fetchCalls += 1;
      return { ok: true, arrayBuffer: async () => Uint8Array.of(1).buffer };
    },
  });

  assert.equal(aborted.ok, false);
  assert.equal(fetchCalls, 0);
});

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

test("speaks long cleaned text in ordered sequential segments", async () => {
  const calls = {
    events: [],
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

  const result = await engine.speak(speechRequest({ text }));
  const paths = calls.writes;

  assert.deepEqual(result, { ok: true, spoke: true });
  assert.ok(calls.synthesis.length > 1);
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

    const speaking = engine.speak(speechRequest({ text: longSpeechText() }));
    await cleanupStarted.promise;
    engine.cancel();
    firstCleanup.resolve();

    const result = await speaking;

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "tts_cancelled");
    assert.equal(synthesisInputs.length, 1);
    assert.equal(cleanupCalls, 2);
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

test(
  "runs one opt-in default FFplay multi-segment acceptance check",
  { skip: process.env.IMA_TTS_IT !== "1" },
  async (t) => {
    if (process.platform !== "linux") {
      t.skip("Linux playback is outside this platform.");
      return;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      t.skip("OPENAI_API_KEY is required when IMA_TTS_IT=1.");
      return;
    }

    const playerCommand = TTS_CONFIG_DEFAULTS.playerCommand;
    if (!(await playerIsAvailable(playerCommand))) {
      t.skip(`A usable Linux player is required: ${playerCommand}.`);
      return;
    }

    let synthesisCalls = 0;
    const engine = createSpeechEngine({
      exec: runLivePlayer,
      synthesize: async (request) => {
        synthesisCalls += 1;
        return synthesizeSpeech(request);
      },
    });
    const text = (
      "This is a sequential default FFplay acceptance segment. "
    ).repeat(60);

    const result = await engine.speak({
      text,
      apiKey,
      model: TTS_CONFIG_DEFAULTS.model,
      voice: TTS_CONFIG_DEFAULTS.voice,
      playerCommand,
    });

    assert.ok(cleanForSpeech(text).length > MAX_SPEECH_INPUT_CHARACTERS);
    assert.deepEqual(result, { ok: true, spoke: true });
    assert.ok(synthesisCalls > 1);
    t.diagnostic("Confirm that default FFplay exits after each segment and segment two begins.");
  },
);

test(
  "runs one opt-in live OpenAI MP3 playback acceptance check",
  { skip: process.env.IMA_TTS_IT !== "1" },
  async (t) => {
    if (process.platform !== "linux") {
      t.skip("Linux playback is outside this platform.");
      return;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      t.skip("OPENAI_API_KEY is required when IMA_TTS_IT=1.");
      return;
    }

    const playerCommand = process.env.IMA_TTS_PLAYER_COMMAND
      ?? TTS_CONFIG_DEFAULTS.playerCommand;
    if (!(await playerIsAvailable(playerCommand))) {
      t.skip(`A usable Linux player is required: ${playerCommand}.`);
      return;
    }

    const engine = createSpeechEngine({ exec: runLivePlayer });
    const result = await engine.speak({
      text: "This is a short text to speech acceptance check.",
      apiKey,
      model: TTS_CONFIG_DEFAULTS.model,
      voice: TTS_CONFIG_DEFAULTS.voice,
      playerCommand,
    });

    assert.deepEqual(result, { ok: true, spoke: true });
    t.diagnostic("Confirm that the short MP3 playback began within a few seconds.");
  },
);
