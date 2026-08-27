import {
  MAX_PAYLOAD_BYTES,
  MAX_SUMMARY_BYTES,
  normalizeInstitutionalRecord,
  utf8ByteLength,
  type InstitutionalRecord,
  type InstitutionalRecordInput,
} from "./qdrant-corpus.ts";
import { MAX_EXPORTED_RECORDS } from "./vestige-migrate-report.ts";

const REDACTED = "[redacted]";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIFECYCLE_FRONT_MATTER = /^---\r?\nlifecycle:\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const LIFECYCLE_MARKER = /<!-- ima-lifecycle verification: lifecycle_key=([^;\r\n]+); nonce=([0-9a-f-]{36}); phase=([^;\r\n]+); jira_key=[^;\r\n]*; taskwarrior_uuid=[^;\r\n]*; outcome=completed -->/gi;
const SECRET_ASSIGNMENT = "(?:authorization|token|secret|password|api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key)";
const SECRET_PATTERN = new RegExp(
  `(?:(\\b${SECRET_ASSIGNMENT}\\b\\s*[:=]\\s*(?:bearer\\s+)?)(\\S+)|(\\bbearer\\s+)(\\S+))`,
  "gi",
);

export { MAX_EXPORTED_RECORDS };
export {
  MAX_MIGRATION_REPORT_BYTES,
  buildCleanupReport,
  buildMigrationReport,
  cleanupOutcomeIsVerified,
  cleanupOutcomes,
  importOutcome,
  institutionalExpectationMatches,
  lifecycleRecallContains,
  parseMigrationReport,
  serializeCleanupReport,
  serializeMigrationReport,
} from "./vestige-migrate-report.ts";
export type {
  CleanupReport,
  CleanupRetentionReason,
  ImportOutcome,
  ImportReason,
  ImportStatus,
  MigrationReport,
  RecoveryReceipt,
} from "./vestige-migrate-report.ts";

export type ExportedVestigeMemory = {
  id: string;
  content: string;
  createdAt: string;
};

export type InstitutionalExpectation = {
  id: string;
  recordKey: string;
  project: string;
  site: string;
  repo: string;
  lifecycleKey: string;
  phase: string;
  summary: string;
  detail: string;
  sourceRefs: string[];
  contentHash: string;
  createdAt: string;
};

export type MigrationCandidate = {
  vestigeId: string;
  createdAt: string;
  record: InstitutionalRecordInput;
  expected: InstitutionalExpectation;
  wasRedacted: boolean;
};

export type QuarantineReason = "record_invalid" | "record_too_large" | "lifecycle_invalid" | "export_invalid";
export type QuarantinedMemory = { vestigeId: string | null; reason: QuarantineReason };
export type MigrationClassification = {
  lifecycle: MigrationCandidate[];
  retained: string[];
  quarantined: QuarantinedMemory[];
};

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

const unquote = (value: string) => {
  const singleQuoted = /^'((?:''|[^'])*)'$/.exec(value.trim());
  if (singleQuoted) return singleQuoted[1].replaceAll("''", "'");
  const doubleQuoted = /^"([^"\r\n]*)"$/.exec(value.trim());
  return doubleQuoted ? doubleQuoted[1] : value.trim();
};

const lifecycleField = (frontMatter: string, name: string) => {
  const match = new RegExp(`^  ${name}: (.+)$`, "m").exec(frontMatter);
  return match ? unquote(match[1]) : "";
};

const lifecycleSourceReferences = (frontMatter: string) => {
  const sourceRefs = /^  source_refs:\r?\n((?:    - .*(?:\r?\n|$))*)/m.exec(frontMatter)?.[1] ?? "";
  return sourceRefs
    .split(/\r?\n/)
    .map((line) => /^    - (.+)$/.exec(line)?.[1] ?? "")
    .map(unquote)
    .filter(Boolean);
};

const marker = (content: string) => {
  const matches = [...content.matchAll(new RegExp(LIFECYCLE_MARKER.source, "gi"))];
  const latest = matches.at(-1);
  return latest
    ? { lifecycleKey: latest[1].trim(), nonce: latest[2].toLowerCase(), phase: latest[3].trim() }
    : null;
};

const mask = (value: string) => value.length < REDACTED.length ? "*".repeat(value.length) : REDACTED;
const alreadyMasked = (value: string) => value === REDACTED || /^\*+$/.test(value);

export function redactSecrets(value: string) {
  let redacted = 0;
  const text = value.replace(
    SECRET_PATTERN,
    (match, assignmentPrefix: string | undefined, assignmentValue: string | undefined, bearerPrefix: string | undefined, bearerValue: string | undefined) => {
      const prefix = assignmentPrefix ?? bearerPrefix;
      const secret = assignmentValue ?? bearerValue;
      if (!prefix || !secret) return match;
      if (alreadyMasked(secret)) return `${prefix}${secret}`;
      redacted += 1;
      return `${prefix}${mask(secret)}`;
    },
  );
  return { text, redacted };
}

const leadParagraph = (body: string, heading: RegExpExecArray) => {
  const remaining = body.slice((heading.index ?? 0) + heading[0].length);
  const lines = remaining.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim());
  if (first === -1) return "";
  const paragraph: string[] = [];
  for (const line of lines.slice(first)) {
    if (!line.trim()) break;
    paragraph.push(line.trim());
  }
  return paragraph.join(" ");
};

const truncateUtf8 = (value: string, maximumBytes: number) => {
  let truncated = "";
  for (const character of value) {
    if (utf8ByteLength(truncated + character) > maximumBytes) break;
    truncated += character;
  }
  return truncated;
};

export function summarizeLifecycleDetail(detail: string) {
  const frontMatter = LIFECYCLE_FRONT_MATTER.exec(detail);
  const body = (frontMatter ? detail.slice(frontMatter[0].length) : detail).trim();
  const heading = /^#{1,6}\s+(.+?)\s*$/m.exec(body);
  if (!heading) return "";
  return truncateUtf8(
    [heading[1].trim(), leadParagraph(body, heading)].filter(Boolean).join(" — "),
    MAX_SUMMARY_BYTES,
  ).trim();
}

export function parseVestigeExport(value: string): { records: unknown[] } | null {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length <= MAX_EXPORTED_RECORDS
      ? { records: parsed }
      : null;
  } catch {
    return null;
  }
}

const exportedMemory = (value: unknown): ExportedVestigeMemory | null => {
  const record = object(value);
  const node = object(record?.node) ?? record;
  const id = text(node?.id ?? record?.id);
  const content = typeof node?.content === "string" ? node.content : "";
  const createdAt = text(node?.createdAt ?? node?.created_at ?? record?.createdAt ?? record?.created_at);
  return UUID_PATTERN.test(id) && content.trim() && createdAt ? { id, content, createdAt } : null;
};

const lifecycleMetadata = (content: string) => {
  const frontMatter = LIFECYCLE_FRONT_MATTER.exec(content);
  const verification = marker(content);
  if (!frontMatter || !verification) return null;
  const project = lifecycleField(frontMatter[1], "project");
  const lifecycleKey = lifecycleField(frontMatter[1], "lifecycle_key");
  const phase = lifecycleField(frontMatter[1], "phase");
  if (
    !project
    || !lifecycleKey
    || !phase
    || verification.lifecycleKey !== lifecycleKey
    || verification.phase !== phase
    || !UUID_PATTERN.test(verification.nonce)
  ) return null;
  return {
    project,
    lifecycleKey,
    phase,
    nonce: verification.nonce,
    sourceRefs: lifecycleSourceReferences(frontMatter[1]),
  };
};

const expectationFrom = (record: InstitutionalRecord): InstitutionalExpectation => {
  const payload = record.payload;
  return {
    id: record.id,
    recordKey: record.recordKey,
    project: payload.project,
    site: payload.site,
    repo: payload.repo,
    lifecycleKey: payload.lifecycle_key,
    phase: payload.phase,
    summary: payload.summary,
    detail: payload.detail,
    sourceRefs: [...payload.source_refs],
    contentHash: payload.content_hash,
    createdAt: payload.created_at,
  };
};

export function classifyVestigeExport(records: unknown[]): MigrationClassification {
  const classification: MigrationClassification = { lifecycle: [], retained: [], quarantined: [] };
  for (const rawRecord of records) {
    const source = exportedMemory(rawRecord);
    if (!source) {
      classification.quarantined.push({ vestigeId: null, reason: "export_invalid" });
      continue;
    }
    const metadata = lifecycleMetadata(source.content);
    if (!metadata) {
      if (utf8ByteLength(source.content) > MAX_PAYLOAD_BYTES) {
        classification.quarantined.push({ vestigeId: source.id, reason: "record_too_large" });
      } else {
        classification.retained.push(source.id);
      }
      continue;
    }

    const rawSummary = summarizeLifecycleDetail(source.content);
    const redactedDetail = redactSecrets(source.content);
    if (
      redactedDetail.text.length > MAX_PAYLOAD_BYTES
      || utf8ByteLength(redactedDetail.text) > MAX_PAYLOAD_BYTES
    ) {
      classification.quarantined.push({ vestigeId: source.id, reason: "record_too_large" });
      continue;
    }
    const redactedSummary = redactSecrets(summarizeLifecycleDetail(redactedDetail.text));
    if (!redactedSummary.text) {
      classification.quarantined.push({ vestigeId: source.id, reason: "lifecycle_invalid" });
      continue;
    }

    const record: InstitutionalRecordInput = {
      recordKey: `${metadata.lifecycleKey}:${metadata.phase}:${metadata.nonce}`,
      project: metadata.project,
      site: "",
      repo: "",
      lifecycleKey: metadata.lifecycleKey,
      phase: metadata.phase,
      summary: redactedSummary.text,
      detail: redactedDetail.text,
      sourceRefs: [...metadata.sourceRefs, `vestige:${source.id}`],
    };
    const normalized = normalizeInstitutionalRecord(record, source.createdAt);
    if (!normalized.success) {
      classification.quarantined.push({
        vestigeId: source.id,
        reason: normalized.error.code === "record_too_large" ? "record_too_large" : "record_invalid",
      });
      continue;
    }

    const expected = expectationFrom(normalized.data);
    classification.lifecycle.push({
      vestigeId: source.id,
      createdAt: expected.createdAt,
      record: {
        recordKey: expected.recordKey,
        project: expected.project,
        site: expected.site,
        repo: expected.repo,
        lifecycleKey: expected.lifecycleKey,
        phase: expected.phase,
        summary: expected.summary,
        detail: expected.detail,
        sourceRefs: [...expected.sourceRefs],
      },
      expected,
      wasRedacted: redactedDetail.text !== source.content || redactedSummary.text !== rawSummary,
    });
  }
  return classification;
}
