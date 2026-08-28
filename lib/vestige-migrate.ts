import {
  MAX_LIFECYCLE_KEY_LENGTH,
  MAX_PHASE_LENGTH,
  MAX_PROJECT_LENGTH,
} from "./qdrant-corpus.ts";
import { hasUnpairedSurrogate } from "./qdrant-corpus-chunks.ts";
import {
  normalizeMetadataText,
  normalizeSourceReferences,
} from "./qdrant-corpus-contract.ts";
import {
  candidateFor,
  type InstitutionalMetadata,
  type MigrationSourceCandidate,
} from "./vestige-migrate-source.ts";
import { MAX_EXPORTED_RECORDS } from "./vestige-migrate-report.ts";

const MAX_PREFERENCE_PREFIX_BYTES = 256;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIFECYCLE_FRONT_MATTER = /^---\r?\nlifecycle:\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const LIFECYCLE_MARKER = /<!-- ima-lifecycle verification: lifecycle_key=([^;\r\n]+); nonce=([0-9a-f-]{36}); phase=([^;\r\n]+); jira_key=[^;\r\n]*; taskwarrior_uuid=[^;\r\n]*; outcome=completed -->/gi;
const MACHINE_LIFECYCLE_PROVENANCE = /^ima-mcp\s+vestige\s+save\s+([a-z][a-z0-9_-]{0,127})$/i;
const MARKDOWN_HEADING = /^#{1,6}[ \t]+\S/m;
const STANDALONE_PREFERENCE = /^(?:(?:user|eric|i)\s+(?:prefer|prefers|want|wants|like|likes|dislike|dislikes|avoid|avoids|need|needs|use|uses))\b/i;
const LIFECYCLE_PHASES = new Set([
  "plan",
  "implementation",
  "test",
  "review",
  "resolution",
  "rereview",
  "closeout",
  "decision",
  "investigation",
  "document",
]);

export { MAX_EXPORTED_RECORDS };
export {
  MAX_MIGRATION_REPORT_BYTES,
  MAX_SOURCE_BUNDLE_RECORDS,
  buildMigrationReport,
  cleanupDestinationIsVerified,
  cleanupSources,
  deriveSourceStatus,
  destinationRecordOutcome,
  institutionalExpectationMatches,
  parseMigrationReport,
  serializeMigrationReport,
  vestigePurgeAcknowledged,
} from "./vestige-migrate-report.ts";
export type {
  DestinationRecordOutcome,
  ImportReason,
  ImportStatus,
  MigrationReport,
  MigrationSourceOutcome,
  RecoveryReceipt,
} from "./vestige-migrate-report.ts";
export {
  buildCleanupReport,
  serializeCleanupReport,
} from "./vestige-cleanup-report.ts";
export type {
  CleanupReport,
  CleanupRetentionReason,
} from "./vestige-cleanup-report.ts";
export {
  redactSecrets,
  summarizeInstitutionalDetail,
  summarizeLifecycleDetail,
} from "./vestige-migrate-content.ts";
export {
  sourceBundleIndexDetail,
  splitVestigeSource,
} from "./vestige-migrate-source.ts";
export type {
  DestinationRecordRole,
  InstitutionalExpectation,
  MigrationRecordCandidate,
  MigrationSourceCandidate,
} from "./vestige-migrate-source.ts";

export type ExportedVestigeMemory = {
  id: string;
  content: string;
  createdAt: string;
  nodeType?: string;
  source?: string;
  tags: string[];
};

export type QuarantineReason =
  | "export_invalid"
  | "record_invalid"
  | "record_too_large"
  | "summary_invalid";
export type QuarantinedMemory = { vestigeId: string | null; reason: QuarantineReason };
export type RetainedPreference = { vestigeId: string; reason: "explicit_preference" };
export type MigrationClassification = {
  institutional: MigrationSourceCandidate[];
  retained: RetainedPreference[];
  quarantined: QuarantinedMemory[];
};

type CanonicalLifecycleMetadata = {
  project: string;
  lifecycleKey: string;
  phase: string;
  nonce: string;
  sourceRefs: string[];
};

type LifecycleMetadata =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "valid"; metadata: CanonicalLifecycleMetadata };

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

const lifecycleSourceReferences = (frontMatter: string): string[] | null => {
  const lines = frontMatter.split(/\r?\n/);
  const sourceRefsIndex = lines.findIndex((line) => /^  source_refs:/.test(line));
  if (sourceRefsIndex === -1) return [];

  const declaration = /^  source_refs:(.*)$/.exec(lines[sourceRefsIndex]);
  if (!declaration) return null;
  const inline = declaration[1].trim();
  if (inline === "[]") return [];
  if (inline) return null;

  const sourceRefs: string[] = [];
  for (const line of lines.slice(sourceRefsIndex + 1)) {
    if (/^  [^\s][^:]*:/.test(line)) break;
    if (!line.trim()) continue;
    const entry = /^    - (.+)$/.exec(line);
    if (!entry) return null;
    sourceRefs.push(unquote(entry[1]));
  }
  return normalizeSourceReferences(sourceRefs);
};

const marker = (content: string) => {
  const matches = [...content.matchAll(new RegExp(LIFECYCLE_MARKER.source, "gi"))];
  const latest = matches.at(-1);
  return latest
    ? { lifecycleKey: latest[1].trim(), nonce: latest[2].toLowerCase(), phase: latest[3].trim() }
    : null;
};

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

const exportedNode = (value: unknown) => {
  const record = object(value);
  return { record, node: object(record?.node) ?? record };
};

const exportedMemoryId = (value: unknown) => {
  const { record, node } = exportedNode(value);
  const id = text(node?.id ?? record?.id).toLowerCase();
  return UUID_PATTERN.test(id) ? id : null;
};

const boundedMetadata = (value: unknown, maximum: number) => {
  const normalized = normalizeMetadataText(value, maximum, true);
  return normalized || undefined;
};

const metadataTags = (value: unknown) => {
  if (!Array.isArray(value) || value.length > 64) return [];
  return [...new Set(value
    .map((tag) => boundedMetadata(tag, 128))
    .filter((tag): tag is string => Boolean(tag)))];
};

const exportedMemory = (value: unknown): ExportedVestigeMemory | null => {
  const { record, node } = exportedNode(value);
  const id = exportedMemoryId(value);
  const content = typeof node?.content === "string" ? node.content : "";
  const createdAt = text(node?.createdAt ?? node?.created_at ?? record?.createdAt ?? record?.created_at);
  if (!id || !content.trim() || !createdAt) return null;
  return {
    id,
    content,
    createdAt,
    nodeType: boundedMetadata(node?.nodeType ?? node?.node_type ?? record?.nodeType ?? record?.node_type, MAX_PHASE_LENGTH),
    source: boundedMetadata(node?.source ?? record?.source, 1_024),
    tags: metadataTags(node?.tags ?? record?.tags),
  };
};

const lifecycleMetadata = (content: string): LifecycleMetadata => {
  const frontMatter = LIFECYCLE_FRONT_MATTER.exec(content);
  const verification = marker(content);
  if (!frontMatter && !verification) return { status: "absent" };
  if (!frontMatter || !verification) return { status: "invalid" };

  const project = normalizeMetadataText(lifecycleField(frontMatter[1], "project"), MAX_PROJECT_LENGTH);
  const lifecycleKey = normalizeMetadataText(lifecycleField(frontMatter[1], "lifecycle_key"), MAX_LIFECYCLE_KEY_LENGTH);
  const phase = normalizeMetadataText(lifecycleField(frontMatter[1], "phase"), MAX_PHASE_LENGTH);
  const sourceRefs = lifecycleSourceReferences(frontMatter[1]);
  if (
    !project
    || !lifecycleKey
    || !phase
    || !sourceRefs
    || verification.lifecycleKey !== lifecycleKey
    || verification.phase !== phase
    || !UUID_PATTERN.test(verification.nonce)
  ) return { status: "invalid" };

  return {
    status: "valid",
    metadata: {
      project,
      lifecycleKey,
      phase,
      nonce: verification.nonce,
      sourceRefs,
    },
  };
};

const machineLifecyclePhase = (source?: string) => {
  const match = source ? MACHINE_LIFECYCLE_PROVENANCE.exec(source) : null;
  const phase = match?.[1].toLowerCase() ?? "";
  return LIFECYCLE_PHASES.has(phase) ? phase : null;
};

const normalizedNodeType = (nodeType?: string) => {
  const normalized = nodeType
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") ?? "";
  return normalized && normalized.length <= MAX_PHASE_LENGTH ? normalized : null;
};

const hasMarkdownArtifactStructure = (content: string) => MARKDOWN_HEADING.test(content);

const metadataHasPreferenceToken = (value?: string) => value
  ? value.toLowerCase().split(/[^a-z]+/).some((token) => token === "preference" || token === "preferences")
  : false;

const isExplicitStandalonePreference = (source: ExportedVestigeMemory) => {
  if (metadataHasPreferenceToken(source.source) || source.tags.some(metadataHasPreferenceToken)) return true;
  let prefix = "";
  for (const character of source.content.trimStart()) {
    if (Buffer.byteLength(prefix + character, "utf8") > MAX_PREFERENCE_PREFIX_BYTES) break;
    prefix += character;
  }
  return STANDALONE_PREFERENCE.test(prefix);
};

const metadataFor = (
  source: ExportedVestigeMemory,
  canonical: CanonicalLifecycleMetadata | null,
): InstitutionalMetadata => {
  if (canonical) {
    return {
      project: canonical.project,
      lifecycleKey: canonical.lifecycleKey,
      phase: canonical.phase,
      recordKey: `${canonical.lifecycleKey}:${canonical.phase}:${canonical.nonce}`,
      sourceRefs: [...canonical.sourceRefs],
    };
  }
  const recordKey = `vestige:${source.id}`;
  return {
    project: "legacy-vestige",
    lifecycleKey: recordKey,
    phase: machineLifecyclePhase(source.source) ?? normalizedNodeType(source.nodeType) ?? "legacy",
    recordKey,
    sourceRefs: [],
  };
};

const hasInstitutionalSignal = (
  source: ExportedVestigeMemory,
  canonical: CanonicalLifecycleMetadata | null,
) => Boolean(canonical || machineLifecyclePhase(source.source) || hasMarkdownArtifactStructure(source.content));

const crossSourceDestinationCollisions = (sources: MigrationSourceCandidate[]) => {
  const sourceByRecordKey = new Map<string, string>();
  const collidingSources = new Set<string>();
  for (const source of sources) {
    for (const candidate of source.records) {
      const prior = sourceByRecordKey.get(candidate.expected.recordKey);
      if (prior && prior !== source.vestigeId) {
        collidingSources.add(prior);
        collidingSources.add(source.vestigeId);
      } else {
        sourceByRecordKey.set(candidate.expected.recordKey, source.vestigeId);
      }
    }
  }
  return collidingSources;
};

export function classifyVestigeExport(records: unknown[]): MigrationClassification {
  const idCounts = new Map<string, number>();
  for (const record of records) {
    const id = exportedMemoryId(record);
    if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }

  const classification: MigrationClassification = { institutional: [], retained: [], quarantined: [] };
  const duplicateIds = new Set<string>();
  for (const rawRecord of records) {
    const id = exportedMemoryId(rawRecord);
    if (id && (idCounts.get(id) ?? 0) > 1) {
      if (!duplicateIds.has(id)) {
        classification.quarantined.push({ vestigeId: id, reason: "record_invalid" });
        duplicateIds.add(id);
      }
      continue;
    }

    const source = exportedMemory(rawRecord);
    if (!source) {
      classification.quarantined.push({ vestigeId: id, reason: "export_invalid" });
      continue;
    }
    if (source.content.includes("\0") || hasUnpairedSurrogate(source.content)) {
      classification.quarantined.push({ vestigeId: source.id, reason: "record_invalid" });
      continue;
    }

    const lifecycle = lifecycleMetadata(source.content);
    if (lifecycle.status === "invalid") {
      classification.quarantined.push({ vestigeId: source.id, reason: "record_invalid" });
      continue;
    }
    const canonical = lifecycle.status === "valid" ? lifecycle.metadata : null;
    if (!hasInstitutionalSignal(source, canonical) && isExplicitStandalonePreference(source)) {
      classification.retained.push({ vestigeId: source.id, reason: "explicit_preference" });
      continue;
    }

    const candidate = candidateFor({ source, metadata: metadataFor(source, canonical) });
    if ("quarantine" in candidate) {
      classification.quarantined.push({ vestigeId: source.id, reason: candidate.quarantine });
      continue;
    }
    classification.institutional.push(candidate.source);
  }

  const collisions = crossSourceDestinationCollisions(classification.institutional);
  if (!collisions.size) return classification;
  const institutional = classification.institutional.filter((source) => !collisions.has(source.vestigeId));
  const quarantined = [
    ...classification.quarantined,
    ...classification.institutional
      .filter((source) => collisions.has(source.vestigeId))
      .map((source) => ({ vestigeId: source.vestigeId, reason: "record_invalid" as const })),
  ];
  return { institutional, retained: classification.retained, quarantined };
}
