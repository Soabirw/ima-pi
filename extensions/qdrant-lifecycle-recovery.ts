import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  executeQdrantLifecycleReset,
  prepareQdrantLifecycleReset,
  reconcileQdrantLifecycleReset,
  type QdrantLifecycleResetConfirmation,
  type QdrantLifecycleResetDependencies,
} from "../lib/qdrant-lifecycle-recovery.ts";
import { normalizeLifecycleRecordKey } from "../lib/ima-lifecycle.ts";
import { utf8ByteLength } from "../lib/qdrant-corpus.ts";

const MAX_TOOL_OUTPUT_BYTES = 16 * 1024;
const HASH_PATTERN = "^[a-f0-9]{64}$";
const HASH = /^[a-f0-9]{64}$/;
const REPORT_PATH = /^\.ima-cycle\/qdrant-lifecycle-reset-[A-Za-z0-9-]{1,96}\.report\.json$/;
const parameters = Type.Object({
  operation: StringEnum([
    "prepare",
    "execute",
    "reconcile",
  ] as const, { description: "Recovery operation." }),
  lifecycleKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  reportPath: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
  confirmation: Type.Optional(Type.String({ pattern: HASH_PATTERN })),
}, { additionalProperties: false });

type QdrantLifecycleRecoveryToolRequest =
  | { operation: "prepare"; lifecycleKey: string }
  | { operation: "execute"; reportPath: string; confirmation: string }
  | { operation: "reconcile"; reportPath: string; confirmation: string };

const ownDataRecord = (value: unknown): Record<string, unknown> | null => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.some((key) => typeof key !== "string")
      || keys.some((key) => {
        const descriptor = descriptors[key as string];
        return !descriptor
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable
          || !Object.hasOwn(descriptor, "value");
      })
    ) return null;
    return Object.fromEntries(keys.map((key) => [key, descriptors[key as string].value]));
  } catch {
    return null;
  }
};

const hasExactFields = (value: Record<string, unknown>, fields: readonly string[]) => {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
};

const boundedText = (value: unknown, maximum: number): string | null =>
  typeof value === "string"
  && value.length > 0
  && value.length <= maximum
  && utf8ByteLength(value) <= maximum
    ? value
    : null;

const projectToolRequest = (value: unknown): QdrantLifecycleRecoveryToolRequest | null => {
  const request = ownDataRecord(value);
  if (!request || typeof request.operation !== "string") return null;

  if (request.operation === "prepare") {
    const candidate = boundedText(request.lifecycleKey, 512);
    const lifecycleKey = candidate && normalizeLifecycleRecordKey(candidate) === candidate
      ? candidate
      : null;
    return hasExactFields(request, ["operation", "lifecycleKey"]) && lifecycleKey
      ? { operation: "prepare", lifecycleKey }
      : null;
  }

  if (request.operation === "execute" || request.operation === "reconcile") {
    const candidate = boundedText(request.reportPath, 1_024);
    const reportPath = candidate && REPORT_PATH.test(candidate) ? candidate : null;
    const confirmation = typeof request.confirmation === "string" && HASH.test(request.confirmation)
      ? request.confirmation
      : null;
    return hasExactFields(request, ["operation", "reportPath", "confirmation"])
      && reportPath
      && confirmation
      ? { operation: request.operation, reportPath, confirmation }
      : null;
  }

  return null;
};

const toolResult = (value: unknown) => {
  const text = JSON.stringify(value);
  if (typeof text !== "string" || utf8ByteLength(text) > MAX_TOOL_OUTPUT_BYTES) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        status: "blocked",
        code: "lifecycle_reset_output_invalid",
      }) }],
      details: { status: "blocked", code: "lifecycle_reset_output_invalid" },
    };
  }
  return { content: [{ type: "text" as const, text }], details: value };
};

export function registerQdrantLifecycleRecoveryTools(
  pi: Pick<ExtensionAPI, "registerTool">,
  supplied: QdrantLifecycleResetDependencies = {},
) {
  pi.registerTool({
    name: "ima_qdrant_lifecycle_reset",
    label: "Reset one Qdrant lifecycle authority",
    description: "Prepare, execute, or read-only reconcile a report-bound reset for one exact Qdrant lifecycle key. Execute and reconcile retain exact report-hash validation and require trusted UI confirmation; no provider fallback, migration, or automatic retry is available.",
    parameters,
    async execute(_id, request, signal, _update, ctx) {
      const projected = projectToolRequest(request);
      if (!projected) {
        return toolResult({ status: "blocked", code: "lifecycle_reset_request_invalid" });
      }

      const confirmReset = async (confirmation: QdrantLifecycleResetConfirmation) => {
        if (ctx.hasUI !== true || typeof ctx.ui.confirm !== "function") return null;
        const scope = [
          `Lifecycle key: ${confirmation.lifecycleKey}`,
          `Verified report SHA-256: ${confirmation.reportHash}`,
          `Exact scope: ${confirmation.pointCount} report-listed Qdrant point(s) across ${confirmation.recordCount} lifecycle record(s), bound to inventory fingerprint ${confirmation.destructiveScope.inventoryFingerprint}.`,
        ].join("\n");
        try {
          if (confirmation.stage === "intent") {
            const action = confirmation.operation === "execute"
              ? "This starts recovery-state mutation and verified snapshot creation. Deletion requires a separate confirmation."
              : "This permits reconciliation to clear recovery state only after direct, exhaustive absence verification.";
            const approved = await ctx.ui.confirm("Confirm Qdrant lifecycle recovery intent", `${scope}\n${action}`);
            return approved === true ? confirmation : null;
          }
          if (confirmation.stage === "deletion" && confirmation.snapshotReceipt) {
            const approved = await ctx.ui.confirm(
              "Confirm Qdrant lifecycle deletion",
              `${scope}\nVerified snapshot receipt: ${confirmation.snapshotReceipt.name}\nDelete exactly this report-bound scope now?`,
            );
            return approved === true ? confirmation : null;
          }
        } catch {
          return null;
        }
        return null;
      };
      const dependencies: QdrantLifecycleResetDependencies = {
        ...supplied,
        confirmReset,
      };

      try {
        switch (projected.operation) {
          case "prepare":
            return toolResult(await prepareQdrantLifecycleReset({
              cwd: ctx.cwd,
              lifecycleKey: projected.lifecycleKey,
              dependencies,
              signal,
            }));
          case "execute":
            return toolResult(await executeQdrantLifecycleReset({
              cwd: ctx.cwd,
              reportPath: projected.reportPath,
              confirmation: projected.confirmation,
              dependencies,
              signal,
            }));
          case "reconcile":
            return toolResult(await reconcileQdrantLifecycleReset({
              cwd: ctx.cwd,
              reportPath: projected.reportPath,
              confirmation: projected.confirmation,
              dependencies,
              signal,
            }));
          default:
            return toolResult({ status: "blocked", code: "lifecycle_reset_request_invalid" });
        }
      } catch {
        return toolResult({ status: "blocked", code: "lifecycle_reset_unavailable" });
      }
    },
  });
}

export default function qdrantLifecycleRecovery(pi: ExtensionAPI) {
  registerQdrantLifecycleRecoveryTools(pi);
}
