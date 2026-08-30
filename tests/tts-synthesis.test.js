import assert from "node:assert/strict";
import test from "node:test";
import { synthesizeSpeech } from "../lib/ima-tts-speech.ts";
import { speechRequest } from "./tts-speech-fixtures.js";

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
