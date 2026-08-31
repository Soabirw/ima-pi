const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const textFromContent = (content: unknown): string | null => {
  if (!Array.isArray(content)) return null;

  const text = content
    .filter(
      (part): part is Record<string, unknown> =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();

  return text || null;
};

export const selectCurrentSettledAssistantText = (
  entries: readonly unknown[],
): string | null => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "message") continue;

    const message = entry.message;
    if (!isRecord(message) || message.role !== "assistant") continue;

    if (message.stopReason !== "stop") return null;
    return textFromContent(message.content);
  }

  return null;
};

export const selectLatestCompletedAssistantText = (
  entries: readonly unknown[],
): string | null => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "message") continue;

    const message = entry.message;
    if (
      !isRecord(message)
      || message.role !== "assistant"
      || message.stopReason !== "stop"
    ) {
      continue;
    }

    return textFromContent(message.content);
  }

  return null;
};
