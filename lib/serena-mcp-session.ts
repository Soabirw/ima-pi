import type { McpToolCaller } from "./mcp-client.ts";
import { utf8ByteLength } from "./qdrant-corpus.ts";

const MAX_MCP_TEXT_BYTES = 300_000;
const MAX_SESSION_BYTES = 1_024;
const MAX_TOOL_COUNT = 256;
const MAX_RECORD_KEYS = 64;
const SESSION_ARGUMENT_NAMES = ["session_id", "sessionId"] as const;

type SerenaToolName =
  | "activate_project"
  | "initial_instructions"
  | "list_memories"
  | "read_memory"
  | "write_memory";

type SerenaToolContract = {
  required: Readonly<Record<string, "string" | "integer">>;
  optional: Readonly<Record<string, "string" | "integer">>;
};

type SerenaToolCapability = {
  name: SerenaToolName;
  sessionArgument: (typeof SESSION_ARGUMENT_NAMES)[number] | null;
};

type InternalCapabilities = {
  tools: Partial<Record<SerenaToolName, SerenaToolCapability>>;
  sessionRequired: boolean;
  public: SerenaMcpCapabilities;
};

type SessionToken =
  | { state: "absent" }
  | { state: "valid"; value: string }
  | { state: "invalid" };

type InstructionResponse =
  | { valid: true; token: SessionToken }
  | { valid: false };

type Preparation =
  | { success: true; instructionsLoaded: boolean }
  | { success: false; code: SerenaMcpSessionFailureCode };

export type SerenaMcpCapabilities = {
  sessionRequired: boolean;
  instructionsFirst: boolean;
  contextSupported: boolean;
  lifecycleSupported: boolean;
};

export type SerenaMcpSessionFailureCode =
  | "aborted"
  | "serena_protocol_unsupported"
  | "serena_session_unavailable";

export type SerenaMcpSession = {
  capabilities: SerenaMcpCapabilities;
  prepare: (timeoutMs: number, signal?: AbortSignal) => Promise<Preparation>;
  activateProject: (
    project: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  initialInstructions: (
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  listMemories: (
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  readMemory: (
    memoryName: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  writeMemory: (
    input: { memoryName: string; content: string },
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<unknown>;
};

export type SerenaMcpSessionCreation =
  | {
    success: true;
    capabilities: SerenaMcpCapabilities;
    session: SerenaMcpSession;
  }
  | {
    success: false;
    code: Extract<SerenaMcpSessionFailureCode, "serena_protocol_unsupported" | "serena_session_unavailable">;
  };

const TOOL_CONTRACTS: Readonly<Record<SerenaToolName, SerenaToolContract>> = {
  activate_project: {
    required: { project: "string" },
    optional: {},
  },
  initial_instructions: {
    required: {},
    optional: {},
  },
  list_memories: {
    required: {},
    optional: { topic: "string" },
  },
  read_memory: {
    required: { memory_name: "string" },
    optional: {},
  },
  write_memory: {
    required: {
      memory_name: "string",
      content: "string",
    },
    optional: { max_chars: "integer" },
  },
};

const ownDataRecord = (
  value: unknown,
  maximumKeys = MAX_RECORD_KEYS,
): Record<string, unknown> | null => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length > maximumKeys || keys.some((key) => typeof key !== "string")) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => {
      const descriptor = descriptors[key as string];
      return !descriptor
        || descriptor.get
        || descriptor.set
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, "value");
    })) return null;
    return Object.fromEntries(keys.map((key) => [key, descriptors[key as string].value]));
  } catch {
    return null;
  }
};

const ownDataArray = (value: unknown, maximum: number): unknown[] | null => {
  try {
    if (!Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = descriptors.length?.value;
    if (
      !Number.isSafeInteger(length)
      || length < 0
      || length > maximum
      || keys.length !== length + 1
      || keys.some((key) => typeof key !== "string")
      || keys.some((key) => key !== "length" && !/^\d+$/.test(key as string))
      || !descriptors.length
      || descriptors.length.get
      || descriptors.length.set
      || !Object.hasOwn(descriptors.length, "value")
    ) return null;

    const values: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor
        || descriptor.get
        || descriptor.set
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, "value")
      ) return null;
      values.push(descriptor.value);
    }
    return values;
  } catch {
    return null;
  }
};

const objectProperty = (value: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(value, key) ? value[key] : undefined;

const boundedText = (value: unknown, maximumBytes: number): string | null =>
  typeof value === "string" && utf8ByteLength(value) <= maximumBytes ? value : null;

const safeSessionValue = (value: unknown): string | null => {
  const token = boundedText(value, MAX_SESSION_BYTES);
  return token && /^[\x21-\x7e]+$/.test(token) ? token : null;
};

const HARMLESS_SCHEMA_ANNOTATION_KEYS = new Set([
  "$comment",
  "default",
  "deprecated",
  "description",
  "examples",
  "readOnly",
  "title",
  "writeOnly",
]);

const hasOnlySupportedSchemaKeywords = (
  schema: Record<string, unknown>,
  evaluated: readonly string[],
) => Object.keys(schema).every((key) =>
  evaluated.includes(key) || HARMLESS_SCHEMA_ANNOTATION_KEYS.has(key),
);

const expectedFields = (contract: SerenaToolContract) => [
  ...Object.keys(contract.required),
  ...Object.keys(contract.optional),
];

const expectedType = (contract: SerenaToolContract, field: string) =>
  Object.hasOwn(contract.required, field)
    ? contract.required[field]
    : contract.optional[field];

const exactRequiredFields = (
  required: readonly unknown[],
  fields: readonly string[],
) => required.length === fields.length
  && fields.every((field) => required.includes(field));

const parseToolCapability = (
  name: SerenaToolName,
  inputSchema: unknown,
): SerenaToolCapability | null => {
  const contract = TOOL_CONTRACTS[name];
  const schema = ownDataRecord(inputSchema);
  if (
    !schema
    || schema.type !== "object"
    || !hasOnlySupportedSchemaKeywords(schema, ["type", "properties", "required"])
  ) return null;

  const properties = ownDataRecord(objectProperty(schema, "properties"));
  const required = objectProperty(schema, "required") === undefined
    ? []
    : ownDataArray(objectProperty(schema, "required"), 32);
  if (!properties || !required || !required.every((field) => typeof field === "string")) return null;

  const baseFields = expectedFields(contract);
  const sessionArguments = SESSION_ARGUMENT_NAMES.filter((field) => Object.hasOwn(properties, field));
  if (sessionArguments.length > 1) return null;
  const sessionArgument = sessionArguments[0] ?? null;
  const schemaFields = [...baseFields, ...(sessionArgument ? [sessionArgument] : [])];
  if (
    Object.keys(properties).length !== schemaFields.length
    || !schemaFields.every((field) => Object.hasOwn(properties, field))
    || !exactRequiredFields(required, [
      ...Object.keys(contract.required),
      ...(sessionArgument ? [sessionArgument] : []),
    ])
  ) return null;

  return schemaFields.every((field) => {
    const property = ownDataRecord(properties[field]);
    const type = field === sessionArgument ? "string" : expectedType(contract, field);
    return Boolean(
      property
      && hasOnlySupportedSchemaKeywords(property, ["type"])
      && property.type === type,
    );
  }) ? { name, sessionArgument } : null;
};

const parsedCapabilities = (value: unknown): InternalCapabilities | null => {
  const result = ownDataRecord(value);
  if (!result || Object.keys(result).length !== 1 || !Object.hasOwn(result, "tools")) return null;
  const tools = ownDataArray(result.tools, MAX_TOOL_COUNT);
  if (!tools) return null;

  const found: Partial<Record<SerenaToolName, SerenaToolCapability>> = {};
  for (const value of tools) {
    const tool = ownDataRecord(value);
    const name = tool ? boundedText(tool.name, 256) : null;
    if (!tool || !name || !Object.hasOwn(TOOL_CONTRACTS, name)) continue;
    const toolName = name as SerenaToolName;
    if (found[toolName]) return null;
    const capability = parseToolCapability(toolName, tool.inputSchema);
    if (!capability) return null;
    found[toolName] = capability;
  }

  const nonInstructionTools = [
    found.activate_project,
    found.list_memories,
    found.read_memory,
    found.write_memory,
  ].filter((tool): tool is SerenaToolCapability => tool !== undefined);
  const sessionArguments = nonInstructionTools
    .map((tool) => tool.sessionArgument)
    .filter((argument): argument is (typeof SESSION_ARGUMENT_NAMES)[number] => argument !== null);
  const sessionRequired = sessionArguments.length > 0;
  if (sessionRequired && new Set(sessionArguments).size !== 1) return null;

  const instructions = found.initial_instructions;
  const sessionArgument = sessionRequired ? sessionArguments[0] : null;
  if (
    instructions
    && (
      sessionRequired && instructions.sessionArgument !== null && instructions.sessionArgument !== sessionArgument
      || !sessionRequired && instructions.sessionArgument !== null
    )
  ) return null;

  const contextSupported = Boolean(
    found.activate_project
    && found.initial_instructions
    && found.list_memories
    && found.read_memory,
  );
  const lifecycleSupported = Boolean(
    found.activate_project
    && found.list_memories
    && found.read_memory
    && found.write_memory
    && (!sessionRequired || found.initial_instructions),
  );

  return {
    tools: found,
    sessionRequired,
    public: {
      sessionRequired,
      instructionsFirst: sessionRequired,
      contextSupported,
      lifecycleSupported,
    },
  };
};

const sessionTokenFromRecord = (value: unknown): SessionToken => {
  const record = ownDataRecord(value);
  if (!record) return { state: "invalid" };
  const names = SESSION_ARGUMENT_NAMES.filter((name) => Object.hasOwn(record, name));
  if (names.length === 0) return { state: "absent" };
  if (names.length !== 1) return { state: "invalid" };
  const token = safeSessionValue(record[names[0]]);
  return token ? { state: "valid", value: token } : { state: "invalid" };
};

const jsonWhitespace = (character: string | undefined) =>
  character === " " || character === "\t" || character === "\n" || character === "\r";

const jsonDigit = (character: string | undefined) =>
  character !== undefined && character >= "0" && character <= "9";

const jsonHexadecimal = (character: string | undefined) =>
  character !== undefined && /[0-9a-fA-F]/.test(character);

const jsonTextHasUniqueObjectFields = (value: string): boolean => {
  let index = 0;
  const maximumNesting = 64;

  const skipWhitespace = () => {
    while (jsonWhitespace(value[index])) index += 1;
  };

  const parseString = (): string | null => {
    if (value[index] !== "\"") return null;
    const start = index;
    index += 1;
    while (index < value.length) {
      const character = value[index];
      if (character === "\"") {
        index += 1;
        try {
          return JSON.parse(value.slice(start, index));
        } catch {
          return null;
        }
      }
      if (character === "\\") {
        index += 1;
        const escape = value[index];
        if (escape === "u") {
          if (
            !jsonHexadecimal(value[index + 1])
            || !jsonHexadecimal(value[index + 2])
            || !jsonHexadecimal(value[index + 3])
            || !jsonHexadecimal(value[index + 4])
          ) return null;
          index += 5;
          continue;
        }
        if (escape !== "\"" && escape !== "\\" && escape !== "/" && !"bfnrt".includes(escape ?? "")) {
          return null;
        }
        index += 1;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) return null;
      index += 1;
    }
    return null;
  };

  const parseNumber = () => {
    if (value[index] === "-") index += 1;
    if (value[index] === "0") {
      index += 1;
    } else if (value[index] !== undefined && value[index] >= "1" && value[index] <= "9") {
      index += 1;
      while (jsonDigit(value[index])) index += 1;
    } else {
      return false;
    }
    if (value[index] === ".") {
      index += 1;
      if (!jsonDigit(value[index])) return false;
      while (jsonDigit(value[index])) index += 1;
    }
    if (value[index] === "e" || value[index] === "E") {
      index += 1;
      if (value[index] === "+" || value[index] === "-") index += 1;
      if (!jsonDigit(value[index])) return false;
      while (jsonDigit(value[index])) index += 1;
    }
    return true;
  };

  const parseLiteral = (literal: string) => {
    if (value.slice(index, index + literal.length) !== literal) return false;
    index += literal.length;
    return true;
  };

  const parseValue = (depth: number): boolean => {
    if (depth > maximumNesting) return false;
    skipWhitespace();
    if (value[index] === "{") return parseObject(depth + 1);
    if (value[index] === "[") return parseArray(depth + 1);
    if (value[index] === "\"") return parseString() !== null;
    if (value[index] === "t") return parseLiteral("true");
    if (value[index] === "f") return parseLiteral("false");
    if (value[index] === "n") return parseLiteral("null");
    return parseNumber();
  };

  const parseObject = (depth: number): boolean => {
    if (depth > maximumNesting) return false;
    index += 1;
    skipWhitespace();
    if (value[index] === "}") {
      index += 1;
      return true;
    }
    const fields = new Set<string>();
    while (index < value.length) {
      const field = parseString();
      if (field === null || fields.has(field)) return false;
      fields.add(field);
      skipWhitespace();
      if (value[index] !== ":") return false;
      index += 1;
      if (!parseValue(depth)) return false;
      skipWhitespace();
      if (value[index] === "}") {
        index += 1;
        return true;
      }
      if (value[index] !== ",") return false;
      index += 1;
      skipWhitespace();
    }
    return false;
  };

  const parseArray = (depth: number): boolean => {
    if (depth > maximumNesting) return false;
    index += 1;
    skipWhitespace();
    if (value[index] === "]") {
      index += 1;
      return true;
    }
    while (index < value.length) {
      if (!parseValue(depth)) return false;
      skipWhitespace();
      if (value[index] === "]") {
        index += 1;
        return true;
      }
      if (value[index] !== ",") return false;
      index += 1;
      skipWhitespace();
    }
    return false;
  };

  try {
    if (!parseValue(0)) return false;
    skipWhitespace();
    return index === value.length;
  } catch {
    return false;
  }
};

const jsonShapedText = (value: string) => /^[\t\n\r ]*(?:\{|\[)/.test(value);

const tokenFromText = (value: string): SessionToken => {
  if (jsonShapedText(value)) {
    if (!jsonTextHasUniqueObjectFields(value)) return { state: "invalid" };
    try {
      return sessionTokenFromRecord(JSON.parse(value));
    } catch {
      return { state: "invalid" };
    }
  }
  const direct = safeSessionValue(value);
  return direct ? { state: "valid", value: direct } : { state: "absent" };
};

const SESSION_INSTRUCTION_MARKER = /(?:^|\r?\n)<session>\r?\nYour Serena session id is `([^`\r\n]+)`\. Pass it as the `session_id` parameter to tools which require it\.\r?\n<\/session>(?=\r?\n|$)/g;

const tokenFromInstructionText = (value: string): SessionToken => {
  const matches = [...value.matchAll(SESSION_INSTRUCTION_MARKER)];
  if (matches.length > 1) return { state: "invalid" };
  if (matches.length === 1) {
    const token = safeSessionValue(matches[0][1]);
    return token ? { state: "valid", value: token } : { state: "invalid" };
  }
  return tokenFromText(value);
};

const agreedSessionToken = (candidates: readonly SessionToken[]): SessionToken => {
  if (candidates.some((candidate) => candidate.state === "invalid")) return { state: "invalid" };
  const values = candidates
    .filter((candidate): candidate is Extract<SessionToken, { state: "valid" }> => candidate.state === "valid")
    .map((candidate) => candidate.value);
  return values.length === 0
    ? { state: "absent" }
    : new Set(values).size === 1
      ? { state: "valid", value: values[0] }
      : { state: "invalid" };
};

const textInstructionContent = (value: unknown): string | null => {
  const content = ownDataArray(value, 1);
  if (!content || content.length !== 1) return null;
  const block = ownDataRecord(content[0]);
  if (
    !block
    || Object.keys(block).length !== 2
    || block.type !== "text"
    || typeof block.text !== "string"
    || utf8ByteLength(block.text) > MAX_MCP_TEXT_BYTES
  ) return null;
  return block.text;
};

const structuredInstructionToken = (value: unknown): SessionToken => {
  const record = ownDataRecord(value);
  if (
    !record
    || Object.keys(record).some((key) =>
      key !== "result" && !SESSION_ARGUMENT_NAMES.includes(key as (typeof SESSION_ARGUMENT_NAMES)[number]),
    )
  ) return { state: "invalid" };

  const candidates = [sessionTokenFromRecord(record)];
  if (Object.hasOwn(record, "result")) {
    const result = boundedText(record.result, MAX_MCP_TEXT_BYTES);
    if (result === null) return { state: "invalid" };
    candidates.push(tokenFromInstructionText(result));
  }
  return agreedSessionToken(candidates);
};

const instructionResponseSessionToken = (value: unknown): InstructionResponse => {
  const response = ownDataRecord(value);
  if (
    !response
    || Object.keys(response).some((key) =>
      key !== "content" && key !== "isError" && key !== "structuredContent",
    )
    || response.isError === true
    || (Object.hasOwn(response, "isError") && response.isError !== false)
  ) return { valid: false };

  const structuredToken = Object.hasOwn(response, "structuredContent")
    ? structuredInstructionToken(response.structuredContent)
    : null;
  const candidates: SessionToken[] = structuredToken ? [structuredToken] : [];
  if (Object.hasOwn(response, "content")) {
    const content = textInstructionContent(response.content);
    if (
      content === null
      && (
        ownDataArray(response.content, 0) === null
        || structuredToken?.state !== "valid"
      )
    ) return { valid: false };
    if (content !== null) candidates.push(tokenFromInstructionText(content));
  }
  return candidates.length > 0
    ? { valid: true, token: agreedSessionToken(candidates) }
    : { valid: false };
};

const aborted = (signal?: AbortSignal) => signal?.aborted === true;

const failure = (code: SerenaMcpSessionFailureCode): Preparation => ({ success: false, code });

const createSession = (
  call: McpToolCaller,
  capabilities: InternalCapabilities,
  initialization: unknown,
): SerenaMcpSessionCreation => {
  const initializationToken: SessionToken = initialization === undefined
    ? { state: "absent" }
    : sessionTokenFromRecord(initialization);
  if (initializationToken.state === "invalid") {
    return { success: false, code: "serena_session_unavailable" };
  }
  if (capabilities.sessionRequired && !capabilities.tools.initial_instructions) {
    return { success: false, code: "serena_protocol_unsupported" };
  }

  let sessionValue = initializationToken.state === "valid" ? initializationToken.value : null;
  let preparation: Preparation | null = null;
  let preparing: Promise<Preparation> | null = null;

  const invoke = async (
    tool: SerenaToolCapability,
    arguments_: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (aborted(signal)) throw new Error("serena_session_aborted");
    if (tool.sessionArgument && !sessionValue) throw new Error("serena_session_unavailable");
    const argumentsWithSession = tool.sessionArgument
      ? { ...arguments_, [tool.sessionArgument]: sessionValue }
      : arguments_;
    return call(tool.name, argumentsWithSession, timeoutMs);
  };

  const ensurePrepared = async (
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Preparation> => {
    if (!capabilities.sessionRequired) return { success: true, instructionsLoaded: false };
    if (preparation) return preparation;
    if (preparing) return preparing;

    preparing = (async () => {
      if (aborted(signal)) return failure("aborted");
      const instructions = capabilities.tools.initial_instructions;
      if (!instructions) return failure("serena_protocol_unsupported");
      if (instructions.sessionArgument && !sessionValue) return failure("serena_session_unavailable");

      let response: unknown;
      try {
        response = await invoke(instructions, {}, timeoutMs, signal);
      } catch {
        return failure(aborted(signal) ? "aborted" : "serena_session_unavailable");
      }
      const instructionResponse = instructionResponseSessionToken(response);
      if (aborted(signal) || !instructionResponse.valid) {
        return failure(aborted(signal) ? "aborted" : "serena_session_unavailable");
      }

      const agreed = agreedSessionToken([initializationToken, instructionResponse.token]);
      if (agreed.state !== "valid") return failure("serena_session_unavailable");
      sessionValue = agreed.value;
      return { success: true, instructionsLoaded: true };
    })();

    preparation = await preparing;
    preparing = null;
    return preparation;
  };

  const requirePrepared = () => {
    if (capabilities.sessionRequired && preparation?.success !== true) {
      throw new Error("serena_session_unavailable");
    }
  };

  const requiredTool = (name: SerenaToolName): SerenaToolCapability => {
    const tool = capabilities.tools[name];
    if (!tool) throw new Error("serena_protocol_unsupported");
    return tool;
  };

  const session: SerenaMcpSession = {
    capabilities: { ...capabilities.public },
    prepare: ensurePrepared,
    activateProject: async (project, timeoutMs, signal) => {
      requirePrepared();
      return invoke(requiredTool("activate_project"), { project }, timeoutMs, signal);
    },
    initialInstructions: async (timeoutMs, signal) =>
      invoke(requiredTool("initial_instructions"), {}, timeoutMs, signal),
    listMemories: async (timeoutMs, signal) => {
      requirePrepared();
      return invoke(requiredTool("list_memories"), {}, timeoutMs, signal);
    },
    readMemory: async (memoryName, timeoutMs, signal) => {
      requirePrepared();
      return invoke(requiredTool("read_memory"), { memory_name: memoryName }, timeoutMs, signal);
    },
    writeMemory: async ({ memoryName, content }, timeoutMs, signal) => {
      requirePrepared();
      return invoke(requiredTool("write_memory"), {
        memory_name: memoryName,
        content,
      }, timeoutMs, signal);
    },
  };

  return {
    success: true,
    capabilities: { ...capabilities.public },
    session,
  };
};

const legacyCapabilities = (): InternalCapabilities => ({
  tools: {
    activate_project: { name: "activate_project", sessionArgument: null },
    initial_instructions: { name: "initial_instructions", sessionArgument: null },
    list_memories: { name: "list_memories", sessionArgument: null },
    read_memory: { name: "read_memory", sessionArgument: null },
    write_memory: { name: "write_memory", sessionArgument: null },
  },
  sessionRequired: false,
  public: {
    sessionRequired: false,
    instructionsFirst: false,
    contextSupported: true,
    lifecycleSupported: true,
  },
});

export const parseSerenaMcpCapabilities = (value: unknown): SerenaMcpCapabilities | null => {
  const capabilities = parsedCapabilities(value);
  return capabilities ? { ...capabilities.public } : null;
};

export const supportsSerenaMcpLifecycleSchemas = (value: unknown): boolean =>
  parseSerenaMcpCapabilities(value)?.lifecycleSupported === true;

export const createSerenaMcpSession = (input: {
  call: McpToolCaller;
  advertisedTools: unknown;
  initialization?: unknown;
}): SerenaMcpSessionCreation => {
  const capabilities = parsedCapabilities(input.advertisedTools);
  return capabilities
    ? createSession(input.call, capabilities, input.initialization)
    : { success: false, code: "serena_protocol_unsupported" };
};

/** Compatibility path for callers that predate same-connection discovery. */
export const createLegacySerenaMcpSession = (
  call: McpToolCaller,
): SerenaMcpSessionCreation => createSession(call, legacyCapabilities(), undefined);
