import { utf8ByteLength } from "./qdrant-corpus.ts";

const REDACTED = "[redacted]";
const SECRET_ASSIGNMENT = "(?:authorization|token|secret|password|api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key)";
const SECRET_PATTERN = new RegExp(
  `(?:(\\b${SECRET_ASSIGNMENT}\\b\\s*[:=]\\s*(?:bearer\\s+)?)(\\S+)|(\\bbearer\\s+)(\\S+))`,
  "gi",
);
const LIFECYCLE_FRONT_MATTER = /^---\r?\nlifecycle:\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

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

const frontMatterBody = (detail: string) => {
  const frontMatter = LIFECYCLE_FRONT_MATTER.exec(detail);
  return (frontMatter ? detail.slice(frontMatter[0].length) : detail).trim();
};

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

const firstParagraph = (body: string) => {
  const lines = body.split(/\r?\n/);
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

export function summarizeInstitutionalDetail(detail: string) {
  const body = frontMatterBody(detail);
  const heading = /^#{1,6}\s+(.+?)\s*$/m.exec(body);
  const summary = heading
    ? [heading[1].trim(), leadParagraph(body, heading)].filter(Boolean).join(" — ")
    : firstParagraph(body);
  return truncateUtf8(summary, 2_000).trim();
}

export const summarizeLifecycleDetail = summarizeInstitutionalDetail;
