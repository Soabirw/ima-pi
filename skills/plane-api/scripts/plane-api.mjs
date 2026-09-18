#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPlaneClient,
  readPlaneConfig,
  toPublicPlaneError,
} from "./plane-client.mjs";

export const usage = `Usage:
  plane-api.mjs plane:get plane:<workspace>:PROJ-123
  plane-api.mjs plane:states plane:<workspace>:PROJ-123
  plane-api.mjs plane:comments plane:<workspace>:PROJ-123
  plane-api.mjs plane:comment plane:<workspace>:PROJ-123 "Plain-text comment"
  plane-api.mjs plane:set-state plane:<workspace>:PROJ-123 STATE_UUID
  plane-api.mjs plane:create plane:<workspace>:PROJECT "Title" [description] [priority]
  plane-api.mjs plane:assign-unassigned plane:<workspace>:PROJECT MEMBER_UUID confirm
`;

const oneArgument = (args) => args.length === 1 ? args : null;
const commentArguments = (args) => args.length >= 2 ? [args[0], args.slice(1).join(" ")] : null;
const twoArguments = (args) => args.length === 2 ? args : null;
const assignUnassignedArguments = (args) =>
  args.length === 3 && args[2] === "confirm" ? [args[0], args[1]] : null;
const createArguments = (args) => args.length >= 2 && args.length <= 4 ? args : null;

const commands = Object.freeze({
  "plane:get": {
    parseArgs: oneArgument,
    run: (client, [reference]) => client.getWorkItem(reference),
  },
  "plane:states": {
    parseArgs: oneArgument,
    run: (client, [reference]) => client.listStates(reference),
  },
  "plane:comments": {
    parseArgs: oneArgument,
    run: (client, [reference]) => client.listComments(reference),
  },
  "plane:comment": {
    parseArgs: commentArguments,
    run: (client, [reference, text]) => client.createComment(reference, text),
  },
  "plane:create": {
    parseArgs: createArguments,
    run: (client, [reference, name, description, priority]) => client.createWorkItem(reference, {
      name,
      ...(description === undefined ? {} : { description }),
      ...(priority === undefined ? {} : { priority }),
    }),
  },
  "plane:set-state": {
    parseArgs: twoArguments,
    run: (client, [reference, stateId]) => client.setState(reference, stateId),
  },
  "plane:assign-unassigned": {
    parseArgs: assignUnassignedArguments,
    run: (client, [projectReference, memberId]) =>
      client.assignUnassigned(projectReference, memberId),
  },
});

const usageError = () => ({
  success: false,
  error: {
    code: "USAGE_ERROR",
    message: usage.trim(),
  },
});

const writeJson = (writer, value) => writer.write(`${JSON.stringify(value)}\n`);

const clientDependenciesFrom = ({
  fetchImpl,
  timeoutMs,
  createAbortController,
  setTimeoutImpl,
  clearTimeoutImpl,
}) => Object.fromEntries(
  Object.entries({
    fetchImpl,
    timeoutMs,
    createAbortController,
    setTimeoutImpl,
    clearTimeoutImpl,
  }).filter(([, value]) => value !== undefined),
);

export const runPlaneApi = async ({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  createClient = createPlaneClient,
  fetchImpl,
  timeoutMs,
  createAbortController,
  setTimeoutImpl,
  clearTimeoutImpl,
} = {}) => {
  const [commandName, ...args] = argv;
  const command = Object.hasOwn(commands, commandName) ? commands[commandName] : null;
  const commandArgs = command?.parseArgs(args);

  if (!command || !commandArgs) {
    writeJson(stderr, usageError());
    return 2;
  }

  try {
    const config = readPlaneConfig(env);
    const client = createClient({
      ...config,
      ...clientDependenciesFrom({
        fetchImpl,
        timeoutMs,
        createAbortController,
        setTimeoutImpl,
        clearTimeoutImpl,
      }),
    });
    const data = await command.run(client, commandArgs);

    writeJson(stdout, { success: true, data });
    return 0;
  } catch (error) {
    writeJson(stderr, { success: false, error: toPublicPlaneError(error) });
    return 1;
  }
};

export const isDirectExecution = (moduleUrl = import.meta.url, executablePath = process.argv[1]) =>
  typeof executablePath === "string" && pathToFileURL(resolve(executablePath)).href === moduleUrl;

if (isDirectExecution()) {
  process.exitCode = await runPlaneApi();
}
