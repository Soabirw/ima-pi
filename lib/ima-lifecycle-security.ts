import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

export const LIFECYCLE_CONTENT_CATEGORIES = [
  "private_key",
  "credential_assignment",
  "bearer_credential",
  "basic_credential",
  "token_signature",
  "synthetic_bearer",
  "ambiguous_assignment",
  "unsupported_size",
  "finding_overflow",
  "unsafe_input",
] as const;

export type LifecycleContentCategory = (typeof LIFECYCLE_CONTENT_CATEGORIES)[number];
export type LifecycleContentTier = "allow" | "warn" | "block";

type LifecycleContentField =
  | "type"
  | "identity.project"
  | "identity.lifecycleKey"
  | "identity.lifecycleRootMemoryId"
  | "identity.taskwarriorProject"
  | "identity.taskwarriorTask"
  | "identity.taskwarriorUuid"
  | "identity.jiraKey"
  | "identity.planeWorkspace"
  | "identity.planeWorkItem"
  | "identity.sourceRefs"
  | "identity.priorArtifactIds"
  | "summary"
  | "artifact"
  | "provider"
  | "pinAttemptId";

export type LifecycleContentFinding = Readonly<{
  category: LifecycleContentCategory;
  field: LifecycleContentField;
  index: number | null;
  line: number;
  column: number;
}>;

export type LifecycleContentScreening = Readonly<{
  tier: LifecycleContentTier;
  findings: readonly LifecycleContentFinding[];
}>;

type Candidate = {
  tier: Exclude<LifecycleContentTier, "allow">;
  category: LifecycleContentCategory;
  start: number;
};

type TextField = {
  field: LifecycleContentField;
  index: number | null;
  value: string;
};

type PendingOperation = {
  owner: string;
  checkout: string;
  fingerprint: string;
  operation: unknown;
  expiresAt: number;
};

type LifecycleContentAdjudication =
  | { status: "claimed"; operation: unknown }
  | {
    status:
      | "capacity"
      | "conflict"
      | "expired"
      | "invalid"
      | "mismatch"
      | "missing";
  };

export type LifecycleContentAdjudicator = Readonly<{
  begin: (input: {
    owner: string;
    checkout: string;
    operation: unknown;
  }) => { status: "pending"; handle: string } | Exclude<LifecycleContentAdjudication, { status: "claimed" }>;
  claim: (input: {
    handle: string;
    owner: string;
    checkout: string;
  }) => LifecycleContentAdjudication;
}>;

export const MAX_LIFECYCLE_CONTENT_FINDINGS = 16;
export const MAX_LIFECYCLE_CONTENT_BYTES = 160_000;
const MAX_SCREENED_ARRAY_ITEMS = 64;
const MAX_PENDING_OPERATIONS = 16;
const PENDING_OPERATION_TTL_MS = 60_000;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const CREDENTIAL_LABEL = "(?:authorization|token|secret|password|api[_ -]?key|access[_ -]?token|client[_ -]?secret|private(?:[_ -]?key))";
const PRIVATE_KEY = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/gi;
const NAMED_ASSIGNMENT = new RegExp(
  `\\b(${CREDENTIAL_LABEL})\\b\\s*([:=])\\s*((?:bearer\\s+)?[^\\s,;)]+)`,
  "gi",
);
const AUTHORIZATION_SCHEME_HEADER = /\bauthorization\s*:\s*(basic|bearer)\s+([^\s,;)]+)/gi;
const BEARER_VALUE = /\bbearer\s+([^\s,;)]+)/gi;
const BASIC_VALUE = /\bbasic\s+([A-Za-z0-9+/]{6,510}={1,2})(?=$|[\s,;).`])/gi;
const TOKEN_SIGNATURE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;
const SYNTHETIC_VALUE = /^(?:test|synthetic|example|sample|placeholder|dummy|fake)[_-][a-z0-9._-]{1,128}$/i;
const EXPLICIT_PLACEHOLDER = /^(?:tokens?[.,;:)]?|credentials?[.,;:)]?|values?[.,;:)]?|headers?[.,;:)]?|authentication[.,;:)]?|authorization[.,;:)]?|secrets?[.,;:)]?|api[-_]?keys?[.,;:)]?|access[-_]?tokens?[.,;:)]?|placeholders?[.,;:)]?|<[^>\r\n]{1,128}>|\[[^\]\r\n]{1,128}\]|\{[^}\r\n]{1,128}\}|\$\{[^}\r\n]{1,128}\}|\[redacted\]|redacted|\.\.\.|process\.env\.[A-Z][A-Z0-9_]{1,127})$/i;
const CONCEPTUAL_BEARER_SCHEME = /^bearer(?:\s+authentication)?\s+scheme\b/i;
const CONCEPTUAL_BASIC_SCHEME = /^basic(?:\s+authentication)?\s+scheme\b/i;

const ownDataValue = (value: unknown, key: string): unknown => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor
      && descriptor.enumerable
      && !descriptor.get
      && !descriptor.set
      && Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
};

const ownDataArray = (value: unknown): unknown[] | null => {
  try {
    if (!Array.isArray(value) || value.length > MAX_SCREENED_ARRAY_ITEMS) return null;
    const values: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) return null;
      values.push(descriptor.value);
    }
    return values;
  } catch {
    return null;
  }
};

const unsafeLifecycleContentField = (value: unknown): LifecycleContentField | null => {
  const rootFields: readonly LifecycleContentField[] = [
    "type",
    "summary",
    "artifact",
    "provider",
    "pinAttemptId",
  ];
  const identityFields: readonly LifecycleContentField[] = [
    "identity.project",
    "identity.lifecycleKey",
    "identity.lifecycleRootMemoryId",
    "identity.taskwarriorProject",
    "identity.taskwarriorTask",
    "identity.taskwarriorUuid",
    "identity.jiraKey",
    "identity.planeWorkspace",
    "identity.planeWorkItem",
    "identity.sourceRefs",
    "identity.priorArtifactIds",
  ];
  const unsafeProperty = (target: unknown, key: string) => {
    try {
      if (!target || typeof target !== "object" || Array.isArray(target)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (descriptor) return Boolean(descriptor.get || descriptor.set || !Object.hasOwn(descriptor, "value"));
      return key in target;
    } catch {
      return true;
    }
  };
  const unsafeArray = (candidate: unknown) => {
    try {
      if (!Array.isArray(candidate) || candidate.length > MAX_SCREENED_ARRAY_ITEMS) return false;
      for (let index = 0; index < candidate.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
        if (!descriptor || descriptor.get || descriptor.set || !Object.hasOwn(descriptor, "value")) {
          return true;
        }
      }
      return false;
    } catch {
      return true;
    }
  };

  for (const field of rootFields) {
    if (unsafeProperty(value, field)) return field;
  }
  if (unsafeProperty(value, "identity")) return "identity.project";
  const identity = ownDataValue(value, "identity");
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return null;
  for (const field of identityFields) {
    const key = field.slice("identity.".length);
    if (unsafeProperty(identity, key)) return field;
  }
  if (unsafeArray(ownDataValue(identity, "sourceRefs"))) return "identity.sourceRefs";
  if (unsafeArray(ownDataValue(identity, "priorArtifactIds"))) return "identity.priorArtifactIds";
  return null;
};

const textFields = (value: unknown): TextField[] => {
  const fields: TextField[] = [];
  const add = (field: LifecycleContentField, candidate: unknown, index: number | null = null) => {
    if (typeof candidate === "string") fields.push({ field, index, value: candidate });
  };
  const addArray = (field: LifecycleContentField, candidate: unknown) => {
    const values = ownDataArray(candidate);
    values?.forEach((item, index) => add(field, item, index));
  };

  add("type", ownDataValue(value, "type"));

  const identity = ownDataValue(value, "identity");
  add("identity.project", ownDataValue(identity, "project"));
  add("identity.lifecycleKey", ownDataValue(identity, "lifecycleKey"));
  add("identity.lifecycleRootMemoryId", ownDataValue(identity, "lifecycleRootMemoryId"));
  add("identity.taskwarriorProject", ownDataValue(identity, "taskwarriorProject"));
  add("identity.taskwarriorTask", ownDataValue(identity, "taskwarriorTask"));
  add("identity.taskwarriorUuid", ownDataValue(identity, "taskwarriorUuid"));
  add("identity.jiraKey", ownDataValue(identity, "jiraKey"));
  add("identity.planeWorkspace", ownDataValue(identity, "planeWorkspace"));
  add("identity.planeWorkItem", ownDataValue(identity, "planeWorkItem"));
  addArray("identity.sourceRefs", ownDataValue(identity, "sourceRefs"));
  addArray("identity.priorArtifactIds", ownDataValue(identity, "priorArtifactIds"));
  add("summary", ownDataValue(value, "summary"));
  add("artifact", ownDataValue(value, "artifact"));
  add("provider", ownDataValue(value, "provider"));
  add("pinAttemptId", ownDataValue(value, "pinAttemptId"));
  return fields;
};

const normalizedCandidate = (value: string) => value.replace(/[.,;:)]$/, "");

const explicitPlaceholder = (value: string) => {
  const candidate = normalizedCandidate(value);
  if (EXPLICIT_PLACEHOLDER.test(candidate)) return true;
  const parts = candidate.split(":");
  return parts.length > 1 && parts.every((part) => EXPLICIT_PLACEHOLDER.test(part));
};

const syntheticValue = (value: string) => SYNTHETIC_VALUE.test(normalizedCandidate(value));

const bearerValuePlaceholder = (value: string) => explicitPlaceholder(value)
  && !/^(?:authentication|authorization|headers?|secrets?|api[-_]?keys?|access[-_]?tokens?)$/i.test(
    normalizedCandidate(value),
  );

const headerBearerPlaceholder = (value: string) => bearerValuePlaceholder(value);
const basicValuePlaceholder = (value: string) => bearerValuePlaceholder(value);

const conceptualBearerSchemeAt = (value: string, start: number) =>
  CONCEPTUAL_BEARER_SCHEME.test(value.slice(start));

const conceptualBasicSchemeAt = (value: string, start: number) =>
  CONCEPTUAL_BASIC_SCHEME.test(value.slice(start));

const commaDelimitedBearerRoleProseAt = (
  value: string,
  start: number,
  role: string,
) => {
  if (!/^[a-z]+$/.test(role)) return false;
  const scheme = `bearer ${role}`;
  if (!value.startsWith(scheme, start)) return false;
  return /^,\s+[a-z][a-z]*(?=$|[\s,.;:)`])/.test(value.slice(start + scheme.length));
};

const stronglyCredentialShaped = (value: string) =>
  new RegExp(TOKEN_SIGNATURE.source, "i").test(normalizedCandidate(value));

const covered = (ranges: readonly [number, number][], position: number) =>
  ranges.some(([start, end]) => position >= start && position < end);

const classificationForNamedAssignment = (
  label: string,
  separator: string,
  value: string,
): Candidate | null => {
  const bearer = /^bearer\s+(.+)$/i.exec(value)?.[1];
  if (bearer !== undefined) {
    if (label.toLowerCase() === "authorization") {
      return headerBearerPlaceholder(bearer)
        ? null
        : { tier: "block", category: "bearer_credential", start: 0 };
    }
    if (bearerValuePlaceholder(bearer)) return null;
    return syntheticValue(bearer)
      ? { tier: "warn", category: "synthetic_bearer", start: 0 }
      : { tier: "block", category: "bearer_credential", start: 0 };
  }
  if (explicitPlaceholder(value)) return null;
  if (separator === "=" || stronglyCredentialShaped(value)) {
    return { tier: "block", category: "credential_assignment", start: 0 };
  }
  return { tier: "warn", category: "ambiguous_assignment", start: 0 };
};

const locationFor = (value: string, position: number) => {
  const before = value.slice(0, position);
  const previousLineBreak = before.lastIndexOf("\n");
  return {
    line: before.split("\n").length,
    column: position - previousLineBreak,
  };
};

const findingsForText = (field: TextField): Candidate[] => {
  const candidates: Candidate[] = [];
  const assignmentRanges: [number, number][] = [];
  const add = (candidate: Candidate, start: number) => candidates.push({ ...candidate, start });

  for (const match of field.value.matchAll(new RegExp(PRIVATE_KEY.source, PRIVATE_KEY.flags))) {
    add({ tier: "block", category: "private_key", start: 0 }, match.index ?? 0);
  }
  for (const match of field.value.matchAll(
    new RegExp(AUTHORIZATION_SCHEME_HEADER.source, AUTHORIZATION_SCHEME_HEADER.flags),
  )) {
    const start = match.index ?? 0;
    assignmentRanges.push([start, start + match[0].length]);
    const scheme = match[1].toLowerCase();
    const schemeValue = match[2];
    const placeholder = scheme === "bearer"
      ? headerBearerPlaceholder(schemeValue)
      : basicValuePlaceholder(schemeValue);
    if (!placeholder) {
      add({
        tier: "block",
        category: scheme === "bearer" ? "bearer_credential" : "basic_credential",
        start: 0,
      }, start);
    }
  }
  for (const match of field.value.matchAll(new RegExp(NAMED_ASSIGNMENT.source, NAMED_ASSIGNMENT.flags))) {
    const start = match.index ?? 0;
    if (covered(assignmentRanges, start)) continue;
    assignmentRanges.push([start, start + match[0].length]);
    const candidate = classificationForNamedAssignment(match[1], match[2], match[3]);
    if (candidate) add(candidate, start);
  }
  for (const match of field.value.matchAll(new RegExp(BEARER_VALUE.source, BEARER_VALUE.flags))) {
    const start = match.index ?? 0;
    if (covered(assignmentRanges, start)) continue;
    const value = match[1];
    if (
      conceptualBearerSchemeAt(field.value, start)
      || commaDelimitedBearerRoleProseAt(field.value, start, value)
      || bearerValuePlaceholder(value)
    ) continue;
    add(
      syntheticValue(value)
        ? { tier: "warn", category: "synthetic_bearer", start: 0 }
        : { tier: "block", category: "bearer_credential", start: 0 },
      start,
    );
  }
  for (const match of field.value.matchAll(new RegExp(BASIC_VALUE.source, BASIC_VALUE.flags))) {
    const start = match.index ?? 0;
    const value = match[1];
    if (
      !covered(assignmentRanges, start)
      && !conceptualBasicSchemeAt(field.value, start)
      && !basicValuePlaceholder(value)
    ) {
      add({ tier: "block", category: "basic_credential", start: 0 }, start);
    }
  }
  for (const match of field.value.matchAll(new RegExp(TOKEN_SIGNATURE.source, TOKEN_SIGNATURE.flags))) {
    const start = match.index ?? 0;
    if (!covered(assignmentRanges, start)) {
      add({ tier: "block", category: "token_signature", start: 0 }, start);
    }
  }
  return candidates;
};

const findingsForTier = (
  tier: Exclude<LifecycleContentTier, "allow">,
  fields: readonly TextField[],
): LifecycleContentFinding[] => fields
  .flatMap((field) => findingsForText(field).map((candidate) => ({ field, candidate })))
  .filter(({ candidate }) => candidate.tier === tier)
  .sort((left, right) => {
    const leftField = fields.indexOf(left.field);
    const rightField = fields.indexOf(right.field);
    return leftField - rightField || left.candidate.start - right.candidate.start;
  })
  .map(({ field, candidate }) => ({
    category: candidate.category,
    field: field.field,
    index: field.index,
    ...locationFor(field.value, candidate.start),
  }));

const freezeFindings = (findings: readonly LifecycleContentFinding[]) =>
  Object.freeze(findings.map((finding) => Object.freeze(finding)));

const staticFinding = (
  category: Extract<LifecycleContentCategory, "unsupported_size" | "finding_overflow" | "unsafe_input">,
  field: LifecycleContentField,
  index: number | null,
): LifecycleContentFinding => ({ category, field, index, line: 1, column: 1 });

export const screenLifecycleContent = (value: unknown): LifecycleContentScreening => {
  const unsafeField = unsafeLifecycleContentField(value);
  if (unsafeField) {
    return Object.freeze({
      tier: "block",
      findings: freezeFindings([staticFinding("unsafe_input", unsafeField, null)]),
    });
  }
  const fields = textFields(value);
  const unsupported = fields.find(({ value: text }) =>
    Buffer.byteLength(text, "utf8") > MAX_LIFECYCLE_CONTENT_BYTES,
  );
  if (unsupported) {
    return Object.freeze({
      tier: "block",
      findings: freezeFindings([
        staticFinding("unsupported_size", unsupported.field, unsupported.index),
      ]),
    });
  }
  const blocks = findingsForTier("block", fields);
  if (blocks.length > 0) {
    return Object.freeze({
      tier: "block",
      findings: freezeFindings(blocks.slice(0, MAX_LIFECYCLE_CONTENT_FINDINGS)),
    });
  }
  const warnings = findingsForTier("warn", fields);
  if (warnings.length > MAX_LIFECYCLE_CONTENT_FINDINGS) {
    const firstUndisclosed = warnings[MAX_LIFECYCLE_CONTENT_FINDINGS];
    return Object.freeze({
      tier: "block",
      findings: freezeFindings([{
        category: "finding_overflow",
        field: firstUndisclosed.field,
        index: firstUndisclosed.index,
        line: firstUndisclosed.line,
        column: firstUndisclosed.column,
      }]),
    });
  }
  return warnings.length > 0
    ? Object.freeze({ tier: "warn", findings: freezeFindings(warnings) })
    : Object.freeze({ tier: "allow", findings: Object.freeze([]) });
};

export const containsRecognizedLifecycleContent = (value: unknown) =>
  screenLifecycleContent({ artifact: value }).tier !== "allow";

const safeIdentity = (value: unknown) => typeof value === "string"
  && value.length > 0
  && value.length <= 1_024
  && !CONTROL_CHARACTER.test(value);

const writeFingerprint = (hash: ReturnType<typeof createHash>, value: unknown, depth: number): boolean => {
  if (depth > 16) return false;
  if (value === null) {
    hash.update("null");
    return true;
  }
  if (typeof value === "string") {
    hash.update("string:");
    hash.update(String(Buffer.byteLength(value, "utf8")));
    hash.update(":");
    hash.update(value, "utf8");
    return true;
  }
  if (typeof value === "boolean") {
    hash.update(value ? "true" : "false");
    return true;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return false;
    hash.update(`number:${value}`);
    return true;
  }
  if (value === undefined) {
    hash.update("undefined");
    return true;
  }
  if (Array.isArray(value)) {
    const values = ownDataArray(value);
    if (!values) return false;
    hash.update(`array:${values.length}[`);
    for (const item of values) {
      if (!writeFingerprint(hash, item, depth + 1)) return false;
      hash.update(",");
    }
    hash.update("]");
    return true;
  }
  if (!value || typeof value !== "object") return false;

  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const sorted = (keys as string[]).sort();
    hash.update(`object:${sorted.length}{`);
    for (const key of sorted) {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        return false;
      }
      hash.update(`key:${key.length}:`);
      hash.update(key, "utf8");
      hash.update("=");
      if (!writeFingerprint(hash, descriptor.value, depth + 1)) return false;
      hash.update(",");
    }
    hash.update("}");
    return true;
  } catch {
    return false;
  }
};

export const lifecycleContentBinding = (value: unknown): string | null => {
  try {
    const hash = createHash("sha256");
    return writeFingerprint(hash, value, 0) ? hash.digest("hex") : null;
  } catch {
    return null;
  }
};

const clonedOperation = (value: unknown): unknown | null => {
  try {
    return structuredClone(value);
  } catch {
    return null;
  }
};

const currentTime = (now: () => number) => {
  try {
    const value = now();
    return Number.isFinite(value) ? Math.trunc(value) : null;
  } catch {
    return null;
  }
};

export const createLifecycleContentAdjudicator = (input: {
  now?: () => number;
  createId?: () => string;
  maximumPending?: number;
  ttlMs?: number;
} = {}): LifecycleContentAdjudicator => {
  const now = input.now ?? (() => Date.now());
  const createId = input.createId ?? randomUUID;
  const maximumPending = Number.isSafeInteger(input.maximumPending)
    && (input.maximumPending as number) > 0
    ? input.maximumPending as number
    : MAX_PENDING_OPERATIONS;
  const ttlMs = Number.isSafeInteger(input.ttlMs)
    && (input.ttlMs as number) > 0
    ? input.ttlMs as number
    : PENDING_OPERATION_TTL_MS;
  const pending = new Map<string, PendingOperation>();

  const removeExpired = (time: number) => {
    for (const [handle, operation] of pending) {
      if (operation.expiresAt <= time) pending.delete(handle);
    }
  };

  const begin: LifecycleContentAdjudicator["begin"] = ({ owner, checkout, operation }) => {
    const time = currentTime(now);
    const storedOperation = clonedOperation(operation);
    const fingerprint = lifecycleContentBinding(storedOperation);
    if (time === null || !safeIdentity(owner) || !safeIdentity(checkout) || !storedOperation || !fingerprint) {
      return { status: "invalid" };
    }
    removeExpired(time);
    if ([...pending.values()].some((entry) => entry.owner === owner && entry.checkout === checkout)) {
      return { status: "conflict" };
    }
    if (pending.size >= maximumPending) return { status: "capacity" };

    let handle: string;
    try {
      handle = createId();
    } catch {
      return { status: "invalid" };
    }
    if (!safeIdentity(handle) || pending.has(handle)) return { status: "invalid" };
    pending.set(handle, {
      owner,
      checkout,
      fingerprint,
      operation: storedOperation,
      expiresAt: time + ttlMs,
    });
    return { status: "pending", handle };
  };

  const claim: LifecycleContentAdjudicator["claim"] = ({ handle, owner, checkout }) => {
    const pendingOperation = typeof handle === "string" ? pending.get(handle) : undefined;
    if (!pendingOperation) return { status: "missing" };
    pending.delete(handle);

    const time = currentTime(now);
    if (time === null || !safeIdentity(owner) || !safeIdentity(checkout)) return { status: "invalid" };
    if (pendingOperation.expiresAt <= time) return { status: "expired" };
    if (
      pendingOperation.owner !== owner
      || pendingOperation.checkout !== checkout
      || lifecycleContentBinding(pendingOperation.operation) !== pendingOperation.fingerprint
    ) return { status: "mismatch" };
    const operation = clonedOperation(pendingOperation.operation);
    return operation ? { status: "claimed", operation } : { status: "mismatch" };
  };

  return Object.freeze({ begin, claim });
};
