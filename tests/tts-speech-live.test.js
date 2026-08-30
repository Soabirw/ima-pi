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
