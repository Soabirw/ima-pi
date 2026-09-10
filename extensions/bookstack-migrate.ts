import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyBookStackMigration, cleanupBookStackMigration, dryRunBookStackMigration, verifyBookStackMigration } from "../lib/bookstack-migrate.ts";
import { acquireBookStackMigrationLock } from "../lib/bookstack-migrate-artifacts.ts";

const parameters = Type.Object({
  operation: Type.Union([Type.Literal("dry-run"), Type.Literal("apply"), Type.Literal("verify"), Type.Literal("cleanup")]),
  specPath: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  reportPath: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  confirm: Type.Optional(Type.Union([Type.Literal("apply-report"), Type.Literal("cleanup-report")])),
}, { additionalProperties: false });

const required = (value: string | undefined, code: string) => {
  if (!value) throw new Error(code);
  return value;
};

const withMigrationLock = async <Result>(cwd: string, operation: () => Promise<Result>) => {
  const release = await acquireBookStackMigrationLock(cwd);
  try { return await operation(); } finally { await release(); }
};

export function registerBookStackMigrateTools(pi: Pick<ExtensionAPI, "registerTool">) {
  pi.registerTool({
    name: "ima_bookstack_migrate",
    label: "Migrate approved sources to BookStack",
    description: "Run a dry-run, report-bound BookStack import, or verification. Apply requires an explicit report confirmation.",
    parameters,
    async execute(_id, request, _signal, _update, ctx) {
      return withMigrationLock(ctx.cwd, async () => {
        if (request.operation === "dry-run") {
          const result = await dryRunBookStackMigration({ projectRoot: ctx.cwd, specPath: required(request.specPath, "spec_path_required") });
          const status = result.report.summary.quarantined + result.report.summary.failed === 0
            ? "READY"
            : "NEEDS_REVIEW";
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                reportPath: result.artifact.path,
                runId: result.run.runId,
                status,
                summary: result.report.summary,
              }),
            }],
          };
        }
        if (request.operation === "verify") {
          const result = await verifyBookStackMigration({ projectRoot: ctx.cwd, reportPath: required(request.reportPath, "report_path_required") });
          return { content: [{ type: "text" as const, text: JSON.stringify({ verified: result.verified, summary: result.report.summary }) }] };
        }
        if (request.operation === "cleanup") {
          if (request.confirm !== "cleanup-report") throw new Error("cleanup_confirmation_required");
          const result = await cleanupBookStackMigration({
            projectRoot: ctx.cwd,
            reportPath: required(request.reportPath, "report_path_required"),
            bookStack: {
              origin: required(process.env.BOOKSTACK_ORIGIN, "bookstack_origin_required"),
              tokenId: required(process.env.BOOKSTACK_TOKEN_ID, "bookstack_token_id_required"),
              tokenSecret: required(process.env.BOOKSTACK_TOKEN_SECRET, "bookstack_token_secret_required"),
            },
          });
          return { content: [{ type: "text" as const, text: JSON.stringify({ deletedPageIds: result.deleted }) }] };
        }
        if (request.confirm !== "apply-report") throw new Error("apply_confirmation_required");
        const result = await applyBookStackMigration({
          projectRoot: ctx.cwd,
          dryRunReportPath: required(request.reportPath, "report_path_required"),
          bookStack: {
            origin: required(process.env.BOOKSTACK_ORIGIN, "bookstack_origin_required"),
            tokenId: required(process.env.BOOKSTACK_TOKEN_ID, "bookstack_token_id_required"),
            tokenSecret: required(process.env.BOOKSTACK_TOKEN_SECRET, "bookstack_token_secret_required"),
          },
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ reportPath: result.artifact.path, summary: result.report.summary }) }] };
      });
    },
  });
}

export default function bookStackMigrateExtension(pi: ExtensionAPI) {
  registerBookStackMigrateTools(pi);
}
