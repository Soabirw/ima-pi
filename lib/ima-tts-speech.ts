import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { cleanForSpeech } from "./ima-tts-clean.ts";
import {
  MAX_SPEECH_INPUT_CHARACTERS,
  segmentSpeechText,
} from "./ima-tts-segment.ts";
import { isValidPlayerCommand } from "./ima-tts.ts";

const OPENAI_SPEECH_ENDPOINT = "https://api.openai.com/v1/audio/speech";
const MP3_RESPONSE_FORMAT = "mp3";
const TEMP_FILE_MODE = 0o600;
const TEMP_FILE_FLAG = "wx";

export type TtsSpeechErrorCode =
  | "tts_input_invalid"
  | "tts_synthesis_failed"
  | "tts_audio_write_failed"
  | "tts_playback_failed"
  | "tts_cancelled";

export type TtsSpeechError = Readonly<{
  code: TtsSpeechErrorCode;
  message: string;
}>;

export type SynthesisResult =
  | Readonly<{ ok: true; audio: Uint8Array }>
  | Readonly<{ ok: false; error: TtsSpeechError }>;

export type SpeakResult =
  | Readonly<{ ok: true; spoke: true }>
  | Readonly<{ ok: true; spoke: false }>
  | Readonly<{ ok: false; error: TtsSpeechError }>;

type SpeechFetchResponse = Readonly<{
  ok: boolean;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

export type SpeechFetch = (
  input: string,
  init: Readonly<{
    method: "POST";
    headers: Readonly<Record<string, string>>;
    body: string;
    signal: AbortSignal;
  }>,
) => Promise<SpeechFetchResponse>;

export type SpeechSynthesisRequest = Readonly<{
  apiKey: string;
  model: string;
  voice: string;
  text: string;
  signal: AbortSignal;
  fetchImpl?: SpeechFetch;
}>;

type SynthesisBoundary = (
  request: Omit<SpeechSynthesisRequest, "fetchImpl">,
) => Promise<SynthesisResult>;

type SpeechExecResult = Readonly<{
  code: number;
  killed: boolean;
}>;

type SpeechExec = (
  command: string,
  args: string[],
  options: Readonly<{ signal: AbortSignal }>,
) => Promise<SpeechExecResult>;

type AudioWriter = (
  path: string,
  audio: Uint8Array,
  options: Readonly<{ mode: number; flag: string }>,
) => Promise<void>;

type AudioRemover = (path: string) => Promise<void>;

export type SpeechEngineDependencies = Readonly<{
  exec: SpeechExec;
  synthesize?: SynthesisBoundary;
  writeAudio?: AudioWriter;
  removeAudio?: AudioRemover;
  getTemporaryDirectory?: () => string;
  createIdentifier?: () => string;
}>;

export type SpeakRequest = Readonly<{
  text: string;
  apiKey: string;
  model: string;
  voice: string;
  playerCommand: string;
}>;

export type SpeechEngine = Readonly<{
  speak: (request: SpeakRequest) => Promise<SpeakResult>;
  cancel: () => void;
}>;

type ActiveOperation = {
  generation: number;
  controller: AbortController;
  tempPath: string | null;
};

const successfulSpeech: SpeakResult = Object.freeze({ ok: true, spoke: true });
const skippedSpeech: SpeakResult = Object.freeze({ ok: true, spoke: false });

const failure = (
  code: TtsSpeechErrorCode,
  message: string,
): Readonly<{ ok: false; error: TtsSpeechError }> => Object.freeze({
  ok: false,
  error: Object.freeze({ code, message }),
});

const synthesisFailure = (): Readonly<{ ok: false; error: TtsSpeechError }> =>
  failure(
    "tts_synthesis_failed",
    "OpenAI speech synthesis could not be completed.",
  );

const cancelledSpeech = (): Readonly<{ ok: false; error: TtsSpeechError }> =>
  failure("tts_cancelled", "Speech synthesis or playback was cancelled.");

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
};

const temporaryAudioPath = (
  directory: unknown,
  identifier: unknown,
): string | null => {
  const temporaryDirectory = nonEmptyString(directory);
  const fileIdentifier = nonEmptyString(identifier);
  if (!temporaryDirectory || !fileIdentifier) return null;

  const resolvedDirectory = resolve(temporaryDirectory);
  const resolvedPath = resolve(
    resolvedDirectory,
    `ima-tts-${fileIdentifier}.${MP3_RESPONSE_FORMAT}`,
  );

  return dirname(resolvedPath) === resolvedDirectory ? resolvedPath : null;
};

const ownsOperation = (
  activeOperation: ActiveOperation | null,
  operation: ActiveOperation,
): boolean => activeOperation?.generation === operation.generation;

const playerArguments = (
  playerCommand: string,
  path: string,
): readonly string[] => Object.freeze(
  basename(playerCommand) === "ffplay"
    ? ["-autoexit", path]
    : [path],
);

const playerSucceeded = (result: unknown): boolean =>
  typeof result === "object"
  && result !== null
  && "code" in result
  && "killed" in result
  && result.code === 0
  && result.killed === false;

export const synthesizeSpeech = async ({
  apiKey,
  model,
  voice,
  text,
  signal,
  fetchImpl = globalThis.fetch,
}: SpeechSynthesisRequest): Promise<SynthesisResult> => {
  const normalizedApiKey = nonEmptyString(apiKey);
  const normalizedModel = nonEmptyString(model);
  const normalizedVoice = nonEmptyString(voice);
  const nonBlankText = nonEmptyString(text);
  if (
    !normalizedApiKey
    || !normalizedModel
    || !normalizedVoice
    || !nonBlankText
    || signal.aborted
    || typeof fetchImpl !== "function"
  ) {
    return synthesisFailure();
  }

  try {
    const response = await fetchImpl(OPENAI_SPEECH_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${normalizedApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: normalizedModel,
        voice: normalizedVoice,
        input: text,
        response_format: MP3_RESPONSE_FORMAT,
      }),
      signal,
    });
    if (
      signal.aborted
      || !response?.ok
      || typeof response.arrayBuffer !== "function"
    ) {
      return synthesisFailure();
    }

    const audio = new Uint8Array(await response.arrayBuffer());
    return !signal.aborted && audio.byteLength > 0
      ? Object.freeze({ ok: true, audio })
      : synthesisFailure();
  } catch {
    return synthesisFailure();
  }
};

export const createSpeechEngine = (
  dependencies: SpeechEngineDependencies,
): SpeechEngine => {
  const synthesize = dependencies.synthesize ?? synthesizeSpeech;
  const writeAudio = dependencies.writeAudio
    ?? ((path, audio, options) => writeFile(path, audio, options));
  const removeAudio = dependencies.removeAudio
    ?? ((path) => rm(path, { force: true }));
  const getTemporaryDirectory = dependencies.getTemporaryDirectory ?? tmpdir;
  const createIdentifier = dependencies.createIdentifier ?? randomUUID;
  let nextGeneration = 0;
  let activeOperation: ActiveOperation | null = null;

  const operationWasCancelled = (operation: ActiveOperation): boolean =>
    !ownsOperation(activeOperation, operation)
    || operation.controller.signal.aborted;

  const removeTemporaryAudio = async (path: string | null): Promise<void> => {
    if (!path) return;

    try {
      await removeAudio(path);
    } catch {
      // Cleanup is best effort and must not mask a synthesis or playback result.
    }
  };

  const cancel = (): void => {
    const operation = activeOperation;
    if (!operation) return;

    activeOperation = null;
    operation.controller.abort();
    void removeTemporaryAudio(operation.tempPath);
  };

  const speakSegment = async (
    operation: ActiveOperation,
    request: SpeakRequest,
    playerCommand: string,
    text: string,
  ): Promise<SpeakResult> => {
    let path: string | null = null;

    try {
      if (operationWasCancelled(operation)) return cancelledSpeech();

      let synthesis: SynthesisResult;
      try {
        synthesis = await synthesize({
          apiKey: request.apiKey,
          model: request.model,
          voice: request.voice,
          text,
          signal: operation.controller.signal,
        });
      } catch {
        return operationWasCancelled(operation)
          ? cancelledSpeech()
          : synthesisFailure();
      }

      if (operationWasCancelled(operation)) return cancelledSpeech();
      if (
        !synthesis.ok
        || !(synthesis.audio instanceof Uint8Array)
        || !synthesis.audio.byteLength
      ) {
        return synthesisFailure();
      }

      try {
        path = temporaryAudioPath(getTemporaryDirectory(), createIdentifier());
      } catch {
        path = null;
      }
      if (!path) {
        return failure(
          "tts_audio_write_failed",
          "Temporary TTS audio could not be prepared.",
        );
      }
      operation.tempPath = path;

      if (operationWasCancelled(operation)) return cancelledSpeech();
      try {
        await writeAudio(path, synthesis.audio, {
          mode: TEMP_FILE_MODE,
          flag: TEMP_FILE_FLAG,
        });
      } catch {
        return operationWasCancelled(operation)
          ? cancelledSpeech()
          : failure(
            "tts_audio_write_failed",
            "Temporary TTS audio could not be written.",
          );
      }

      if (operationWasCancelled(operation)) return cancelledSpeech();

      const playbackArguments = [...playerArguments(playerCommand, path)];
      let playback: unknown;
      try {
        playback = await dependencies.exec(playerCommand, playbackArguments, {
          signal: operation.controller.signal,
        });
      } catch {
        return operationWasCancelled(operation)
          ? cancelledSpeech()
          : failure(
            "tts_playback_failed",
            "TTS audio playback could not be completed.",
          );
      }

      if (operationWasCancelled(operation)) return cancelledSpeech();
      return playerSucceeded(playback)
        ? successfulSpeech
        : failure(
          "tts_playback_failed",
          "TTS audio playback could not be completed.",
        );
    } finally {
      await removeTemporaryAudio(path);
      if (path && operation.tempPath === path) operation.tempPath = null;
    }
  };

  const speak = async (request: SpeakRequest): Promise<SpeakResult> => {
    cancel();

    if (typeof request?.text !== "string") {
      return failure("tts_input_invalid", "Speech text must be a string.");
    }

    const text = cleanForSpeech(request.text);
    const segments = segmentSpeechText(text, MAX_SPEECH_INPUT_CHARACTERS);
    if (!segments.length) return skippedSpeech;

    const playerCommand = nonEmptyString(request.playerCommand);
    if (!playerCommand || !isValidPlayerCommand(playerCommand)) {
      return failure(
        "tts_playback_failed",
        "The configured audio player command is invalid.",
      );
    }

    const operation: ActiveOperation = {
      generation: nextGeneration + 1,
      controller: new AbortController(),
      tempPath: null,
    };
    nextGeneration = operation.generation;
    activeOperation = operation;

    try {
      for (const segment of segments) {
        if (operationWasCancelled(operation)) return cancelledSpeech();

        const result = await speakSegment(
          operation,
          request,
          playerCommand,
          segment,
        );
        if (!result.ok) return result;
        if (operationWasCancelled(operation)) return cancelledSpeech();
      }

      return successfulSpeech;
    } finally {
      await removeTemporaryAudio(operation.tempPath);
      if (ownsOperation(activeOperation, operation)) activeOperation = null;
    }
  };

  return Object.freeze({ speak, cancel });
};
