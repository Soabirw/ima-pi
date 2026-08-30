export const speechRequest = (overrides = {}) => ({
  text: "Read this aloud.",
  apiKey: "test-api-key",
  model: "gpt-4o-mini-tts",
  voice: "alloy",
  playerCommand: "ffplay",
  ...overrides,
});

export const successfulSynthesis = () => Object.freeze({
  ok: true,
  audio: Uint8Array.of(1, 2, 3),
});

export const longSpeechText = () => "Sentence. ".repeat(1_000).trim();

export const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};
