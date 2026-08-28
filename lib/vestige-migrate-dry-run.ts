import {
  isCorpusErrorCode,
  normalizeCorpusFailureContext,
  utf8ByteLength,
  type CorpusFailure,
  type CorpusResult,
} from "./qdrant-corpus.ts";
import type {
  CorpusCollectionState,
  CorpusPrerequisites,
} from "./qdrant-http.ts";
import type { MigrationClassification } from "./vestige-migrate.ts";

export const MIGRATION_PREFLIGHT_CHECK_NAMES = [
  "endpoint_configuration",
  "qdrant_service_and_version",
  "ollama_embedding_model",
  "institutional_collection",
  "artifact_run_directory",
  "vestige_sqlite_backup",
  "vestige_json_export",
  "export_validation",
  "classification_and_redaction",
  "migration_mutations",
] as const;

const PREFLIGHT_STATUSES = ["PASS", "FAIL", "BLOCKED", "SKIP"] as const;
const MAX_CHECK_MESSAGE_BYTES = 512;
const MAX_MISSING_INDEXES = 7;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][A-Za-z0-9.-]{1,32})?$/;
const KNOWN_INDEXES = new Set([
  "lifecycle_key",
  "phase",
  "project",
  "site",
  "repo",
  "record_kind",
  "parent_record_key",
]);

export type MigrationPreflightCheckName = typeof MIGRATION_PREFLIGHT_CHECK_NAMES[number];
export type MigrationPreflightStatus = typeof PREFLIGHT_STATUSES[number];
export type MigrationPreflightCheck = {
  name: MigrationPreflightCheckName;
  status: MigrationPreflightStatus;
  code?: string;
  message: string;
};
export type MigrationPreflightResult = {
  outcome: "READY" | "NOT_READY";
  checks: MigrationPreflightCheck[];
};
export type DryRunSummary = {
  institutionalSources: number;
  destinationRecords: number;
  retainedPreferences: number;
  quarantined: number;
  redacted: number;
};
export type DryRunCorpus = {
  qdrantVersion?: string;
  collection?: CorpusCollectionState["collection"];
  missingIndexes?: string[];
};

const CHECK_LABELS: Record<MigrationPreflightCheckName, string> = {
  endpoint_configuration: "Endpoint configuration",
  qdrant_service_and_version: "Qdrant service and version",
  ollama_embedding_model: "Ollama embedding model",
  institutional_collection: "Institutional collection",
  artifact_run_directory: "Artifact run directory",
  vestige_sqlite_backup: "Vestige SQLite backup",
  vestige_json_export: "Vestige JSON export",
  export_validation: "Export validation",
  classification_and_redaction: "Classification and redaction",
  migration_mutations: "Migration mutations",
};

export const isMigrationPreflightCheckName = (
  value: unknown,
): value is MigrationPreflightCheckName =>
  typeof value === "string"
  && MIGRATION_PREFLIGHT_CHECK_NAMES.includes(value as MigrationPreflightCheckName);

export const isMigrationPreflightStatus = (
  value: unknown,
): value is MigrationPreflightStatus =>
  typeof value === "string" && PREFLIGHT_STATUSES.includes(value as MigrationPreflightStatus);

export const boundedCheckMessage = (value: unknown): string | null => {
  const message = typeof value === "string" ? value.trim() : "";
  return message
    && utf8ByteLength(message) <= MAX_CHECK_MESSAGE_BYTES
    && !CONTROL_CHARACTER.test(message)
    ? message
    : null;
};

const safeFailureDetails = (error: Pick<CorpusFailure["error"], "code" | "context">) => {
  const code = isCorpusErrorCode(error.code) ? error.code : undefined;
  const context = normalizeCorpusFailureContext(error.context);
  const details = [
    ...(code ? [code] : []),
    ...(context ? [
      `operation=${context.operation}`,
      `cause=${context.cause}`,
      ...(context.httpStatus === undefined ? [] : [`status=${context.httpStatus}`]),
    ] : []),
  ];
  return { code, details };
};

const preflightCheck = (
  name: MigrationPreflightCheckName,
  status: MigrationPreflightStatus,
  message: string,
  code?: string,
): MigrationPreflightCheck => ({
  name,
  status,
  ...(code ? { code } : {}),
  message,
});

export const passedCheck = (name: MigrationPreflightCheckName) =>
  preflightCheck(name, "PASS", `${CHECK_LABELS[name]} passed.`);

export const failedCheck = (
  name: MigrationPreflightCheckName,
  error?: Pick<CorpusFailure["error"], "code" | "context">,
) => {
  const details = error ? safeFailureDetails(error) : { code: undefined, details: [] };
  return preflightCheck(
    name,
    "FAIL",
    `${CHECK_LABELS[name]} failed${details.details.length ? `: ${details.details.join("; ")}` : ""}.`,
    details.code,
  );
};

export const blockedCheck = (
  name: MigrationPreflightCheckName,
  dependency: MigrationPreflightCheckName,
) => preflightCheck(name, "BLOCKED", `${CHECK_LABELS[name]} is blocked by ${dependency}.`);

export const skippedMutationCheck = () => preflightCheck(
  "migration_mutations",
  "SKIP",
  "Migration mutations are excluded in dry run: snapshot, collection/index changes, embedding, destination access, MCP, cleanup, and deletion.",
);

const isEndpointConfigurationFailure = (result: CorpusResult<unknown>) => !result.success
  && normalizeCorpusFailureContext(result.error.context)?.operation === "endpoint_configuration";

const checkFromCorpusResult = <Data>(
  name: MigrationPreflightCheckName,
  result: CorpusResult<Data>,
  endpointConfigurationFailed: boolean,
) => {
  if (result.success) return passedCheck(name);
  return endpointConfigurationFailed && isEndpointConfigurationFailure(result)
    ? blockedCheck(name, "endpoint_configuration")
    : failedCheck(name, result.error);
};

export const safeVersion = (value: unknown) =>
  typeof value === "string" && VERSION.test(value) ? value : undefined;

export const safeCollection = (
  value: unknown,
): CorpusCollectionState["collection"] | undefined =>
  value === "absent" || value === "needs_indexes" || value === "ready" ? value : undefined;

export const safeMissingIndexes = (value: unknown) => Array.isArray(value)
  && value.length <= MAX_MISSING_INDEXES
  && value.every((index) => typeof index === "string" && KNOWN_INDEXES.has(index))
  ? [...new Set(value)]
  : undefined;

export const corpusPreflight = (input: CorpusPrerequisites): {
  checks: MigrationPreflightCheck[];
  corpus: DryRunCorpus;
} => {
  const endpointConfigurationFailed = !input.endpointConfiguration.success;
  const collection = input.institutionalCollection.success
    ? input.institutionalCollection.data
    : undefined;
  const qdrantVersion = input.qdrantServiceAndVersion.success
    ? safeVersion(input.qdrantServiceAndVersion.data)
    : undefined;
  const collectionState = safeCollection(collection?.collection);
  const missingIndexes = safeMissingIndexes(collection?.missingIndexes);
  return {
    checks: [
      checkFromCorpusResult(
        "endpoint_configuration",
        input.endpointConfiguration,
        false,
      ),
      checkFromCorpusResult(
        "qdrant_service_and_version",
        input.qdrantServiceAndVersion,
        endpointConfigurationFailed,
      ),
      checkFromCorpusResult(
        "ollama_embedding_model",
        input.ollamaEmbeddingModel,
        endpointConfigurationFailed,
      ),
      checkFromCorpusResult(
        "institutional_collection",
        input.institutionalCollection,
        endpointConfigurationFailed,
      ),
    ],
    corpus: {
      ...(qdrantVersion ? { qdrantVersion } : {}),
      ...(collectionState ? { collection: collectionState } : {}),
      ...(missingIndexes ? { missingIndexes } : {}),
    },
  };
};

export const dryRunSummary = (classification: MigrationClassification): DryRunSummary => ({
  institutionalSources: classification.institutional.length,
  destinationRecords: classification.institutional.reduce(
    (count, source) => count + source.records.length,
    0,
  ),
  retainedPreferences: classification.retained.length,
  quarantined: classification.quarantined.length,
  redacted: classification.institutional.reduce(
    (count, source) => count + Number(source.wasRedacted),
    0,
  ),
});

export const requiredMigrationMutations = (
  collection?: CorpusCollectionState["collection"],
  institutionalSources = 1,
) => {
  if (institutionalSources < 1) return [];
  if (collection === "absent") {
    return [
      "create_institutional_collection",
      "create_missing_indexes",
      "embed_summaries",
      "store_and_verify_records",
    ];
  }
  if (collection === "needs_indexes") {
    return [
      "create_missing_indexes",
      "create_snapshot",
      "embed_summaries",
      "store_and_verify_records",
    ];
  }
  return collection === "ready"
    ? ["create_snapshot", "embed_summaries", "store_and_verify_records"]
    : [];
};

export const preflightOutcome = (
  checks: MigrationPreflightCheck[],
): MigrationPreflightResult["outcome"] => {
  const requiredChecks = checks.filter((check) => check.name !== "migration_mutations");
  return requiredChecks.length === MIGRATION_PREFLIGHT_CHECK_NAMES.length - 1
    && requiredChecks.every((check) => check.status === "PASS")
    ? "READY"
    : "NOT_READY";
};
