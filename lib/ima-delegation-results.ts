import { truncateHead } from "@earendil-works/pi-coding-agent";
import type { CompletionFailureCode, DelegationFailure } from "./ima-delegation.ts";

export type DelegationSessionPointer = { id: string; file: string; resumeReference: string | null };
export type DelegationResult = {
  id: string;
  status: string;
  attempts: number;
  error?: string;
  failure?: DelegationFailure;
  escalation?: string | null;
  completion?: CompletionFailureCode[];
  provider?: string;
  model?: string;
  thinking?: string;
  summary?: string;
  summaryTruncated?: boolean;
  summaryBytes?: number;
  session: DelegationSessionPointer | null;
  unverifiedReason?: string;
};
export type DelegationSummaryLimits = { maxLines?: number; maxBytes?: number };

export const DELEGATION_SUMMARY_MAX_LINES = 400;
export const DELEGATION_SUMMARY_MAX_BYTES = 10 * 1024;
export const DELEGATION_RESULT_MAX_LINES = 2_000;
export const DELEGATION_RESULT_MAX_BYTES = 50 * 1024;

const DELEGATION_TRUNCATION_NOTICE = "[Child report truncated; inspect the structured child-session pointer for the full report when available.]";
const DELEGATION_TRUNCATION_NOTICE_BYTES = Buffer.byteLength(DELEGATION_TRUNCATION_NOTICE, "utf8");

const cleanString = (value: unknown) => typeof value === "string" ? value.trim() : "";
const normalizedSummaryLimits = (limits: DelegationSummaryLimits = {}) => ({
  maxLines: Number.isInteger(limits.maxLines) ? Math.max(1, limits.maxLines!) : DELEGATION_SUMMARY_MAX_LINES,
  maxBytes: Number.isInteger(limits.maxBytes) ? Math.max(1, limits.maxBytes!) : DELEGATION_SUMMARY_MAX_BYTES,
});
const semanticLineView = (text: string) => text.replace(/\r\n|\r/g, "\n");

const appendTruncationNotice = (content: string) => content
  ? `${content}${/[\r\n]$/.test(content) ? "" : "\n"}${DELEGATION_TRUNCATION_NOTICE}`
  : DELEGATION_TRUNCATION_NOTICE;

const withoutTruncationNotice = (content: string) => {
  const suffix = `\n${DELEGATION_TRUNCATION_NOTICE}`;
  if (content.endsWith(suffix)) return content.slice(0, -suffix.length);
  return content === DELEGATION_TRUNCATION_NOTICE ? "" : content;
};

const boundSummary = (text: string, limits: DelegationSummaryLimits, forceNotice = false) => {
  const normalizedLimits = normalizedSummaryLimits(limits);
  // Pi's truncation utility recognizes LF, so normalize CRLF and standalone CR before line budgeting.
  const semanticText = semanticLineView(text);
  const semanticFacts = truncateHead(semanticText, normalizedLimits);
  const sourceBytes = Buffer.byteLength(text, "utf8");
  const fitsSourceBoundary = sourceBytes <= normalizedLimits.maxBytes
    && semanticFacts.totalLines <= normalizedLimits.maxLines;
  if (fitsSourceBoundary && !forceNotice) {
    return {
      summary: text,
      truncated: false,
      bytes: sourceBytes,
      lines: semanticFacts.totalLines,
    };
  }

  const bodyMaxBytes = Math.max(0, normalizedLimits.maxBytes - DELEGATION_TRUNCATION_NOTICE_BYTES - 1);
  const summary = appendTruncationNotice(
    normalizedLimits.maxLines > 1 && bodyMaxBytes > 0
      ? truncateHead(semanticText, {
        maxLines: normalizedLimits.maxLines - 1,
        maxBytes: bodyMaxBytes,
      }).content
      : "",
  );
  return {
    summary,
    truncated: true,
    bytes: sourceBytes,
    lines: semanticFacts.totalLines,
  };
};

export function boundDelegationSummary(text: string, limits: DelegationSummaryLimits = {}) {
  return boundSummary(text, limits);
}

const sessionPointer = (session: { id?: unknown; file?: unknown; resumeReference?: unknown } | null | undefined): DelegationSessionPointer | null => {
  const id = cleanString(session?.id);
  const file = cleanString(session?.file);
  if (!id || !file) return null;
  return { id, file, resumeReference: cleanString(session?.resumeReference) || null };
};

export function createDelegationResult(input: {
  id: string;
  status: string;
  attempts?: number;
  error?: string;
  failure?: DelegationFailure;
  escalation?: string | null;
  completion?: CompletionFailureCode[];
  provider?: string;
  model?: string;
  thinking?: string;
  report?: unknown;
  unverifiedReason?: string;
  session?: { id?: unknown; file?: unknown; resumeReference?: unknown } | null;
}): DelegationResult {
  const report = typeof input.report === "string" ? input.report : "";
  const bounded = report.trim() ? boundDelegationSummary(report) : null;
  const unverifiedReason = cleanString(input.unverifiedReason);
  const completePointer = bounded ? sessionPointer(input.session) : null;
  const session = completePointer
    ? {
      ...completePointer,
      resumeReference: input.status === "succeeded" && !unverifiedReason
        ? completePointer.resumeReference
        : null,
    }
    : null;

  return {
    id: input.id,
    status: input.status,
    attempts: input.attempts ?? 0,
    ...(input.error ? { error: input.error } : {}),
    ...(input.failure ? { failure: input.failure } : {}),
    ...(input.escalation !== undefined ? { escalation: input.escalation } : {}),
    ...(input.completion?.length ? { completion: input.completion } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.thinking ? { thinking: input.thinking } : {}),
    ...(bounded ? {
      summary: bounded.summary,
      summaryTruncated: bounded.truncated,
      summaryBytes: bounded.bytes,
    } : {}),
    ...(bounded && unverifiedReason ? { unverifiedReason } : {}),
    session,
  };
}

const rebalanceResultSummary = (result: DelegationResult, limits: DelegationSummaryLimits): DelegationResult => {
  if (!result.summary) return result;
  const source = result.summaryTruncated ? withoutTruncationNotice(result.summary) : result.summary;
  const bounded = boundSummary(source, limits, result.summaryTruncated === true);
  return {
    ...result,
    summary: bounded.summary,
    summaryTruncated: true,
    summaryBytes: result.summaryBytes ?? bounded.bytes,
  };
};

const withoutSummary = (result: DelegationResult): DelegationResult => {
  const { summary, summaryTruncated, summaryBytes, ...metadata } = result;
  return metadata;
};

const serializeDelegationPayload = (payload: { status: string; results: DelegationResult[]; report: unknown; error?: string }) => JSON.stringify(payload)
  .replaceAll("\u2028", "\\u2028")
  .replaceAll("\u2029", "\\u2029");
const payloadBytes = (payload: { status: string; results: DelegationResult[]; report: unknown; error?: string }) => Buffer.byteLength(serializeDelegationPayload(payload), "utf8");

const overflowPayload = () => ({
  status: "failed",
  error: "delegation_result_overflow",
  results: [] as DelegationResult[],
  report: {
    state: "failed",
    blocker: "delegation_result_overflow",
    safeNextAction: "inspect the delegation result metadata before rerunning",
  },
});

export function buildDelegationToolPayload(input: { status: string; results: DelegationResult[]; report: unknown }) {
  const payload = { status: input.status, results: input.results, report: input.report };
  if (payloadBytes(payload) <= DELEGATION_RESULT_MAX_BYTES) {
    return { payload, serialized: serializeDelegationPayload(payload), overflow: false };
  }

  const metadataPayload = {
    status: input.status,
    results: input.results.map(withoutSummary),
    report: input.report,
  };
  if (payloadBytes(metadataPayload) > DELEGATION_RESULT_MAX_BYTES) {
    const overflow = overflowPayload();
    return { payload: overflow, serialized: serializeDelegationPayload(overflow), overflow: true };
  }

  const summaryCount = input.results.filter((result) => Boolean(result.summary)).length;
  if (!summaryCount) {
    const overflow = overflowPayload();
    return { payload: overflow, serialized: serializeDelegationPayload(overflow), overflow: true };
  }

  const maxLines = Math.min(DELEGATION_SUMMARY_MAX_LINES, Math.floor(DELEGATION_RESULT_MAX_LINES / summaryCount));
  const maxBytes = Math.min(
    DELEGATION_SUMMARY_MAX_BYTES,
    Math.max(...input.results.map((result) => Buffer.byteLength(result.summary ?? "", "utf8"))),
  );
  let lower = DELEGATION_TRUNCATION_NOTICE_BYTES;
  let upper = maxBytes;
  let best: { status: string; results: DelegationResult[]; report: unknown } | null = null;

  while (lower <= upper) {
    const budget = Math.floor((lower + upper) / 2);
    const candidate = {
      status: input.status,
      results: input.results.map((result) => rebalanceResultSummary(result, { maxLines, maxBytes: budget })),
      report: input.report,
    };
    if (payloadBytes(candidate) <= DELEGATION_RESULT_MAX_BYTES) {
      best = candidate;
      lower = budget + 1;
    } else {
      upper = budget - 1;
    }
  }

  if (!best) {
    const overflow = overflowPayload();
    return { payload: overflow, serialized: serializeDelegationPayload(overflow), overflow: true };
  }
  return { payload: best, serialized: serializeDelegationPayload(best), overflow: false };
}

export function summarizeDelegationResults(results: DelegationResult[]) {
  return results
    .map((result) => ({ ...result, session: result.session ? { ...result.session } : null }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
