import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  applyBookStackMigration,
  canaryBookStackMigration,
  cleanupBookStackMigration,
  dryRunBookStackMigration,
  preflightBookStackMigration,
  verifyBookStackMigration,
} from "../lib/bookstack-migrate.ts";
import { acquireBookStackMigrationLock } from "../lib/bookstack-migrate-artifacts.ts";
import { resolveBookStackClientInput } from "../lib/bookstack-migrate-config.ts";

const parameters = Type.Object({
  operation: Type.Union([
    Type.Literal("dry-run"),
    Type.Literal("preflight"),
    Type.Literal("canary"),
    Type.Literal("apply"),
    Type.Literal("verify"),
    Type.Literal("cleanup"),
  ]),
  specPath: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  reportPath: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  confirm: Type.Optional(Type.Union([
    Type.Literal("canary-report"),
    Type.Literal("apply-report"),
    Type.Literal("cleanup-report"),
  ])),
}, { additionalProperties: false });

const required = (value: string | undefined, code: string) => {
  if (!value) throw new Error(code);
  return value;
};

const withMigrationLock = async <Result>(cwd: string, operation: () => Promise<Result>) => {
  const release = await acquireBookStackMigrationLock(cwd);
  try {
    return await operation();
  } finally {
    await release();
  }
};

const resultText = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

export function registerBookStackMigrateTools(pi: Pick<ExtensionAPI, "registerTool">) {
  pi.registerTool({
    name: "ima_bookstack_migrate",
    label: "Migrate approved sources to BookStack",
    description: "Preflight, canary, apply, verify, or clean up an approved report-bound BookStack migration.",
    parameters,
    async execute(_id, request, signal, _update, ctx) {
      return withMigrationLock(ctx.cwd, async () => {
        if (request.operation === "dry-run") {
          const result = await dryRunBookStackMigration({
            projectRoot: ctx.cwd,
            specPath: required(request.specPath, "spec_path_required"),
            signal,
          });
          const status = result.report.summary.quarantined + result.report.summary.failed === 0
            ? "READY"
            : "NEEDS_REVIEW";
          return resultText({
            reportPath: result.artifact.path,
            runId: result.run.runId,
            status,
            summary: result.report.summary,
          });
        }

        const reportPath = required(request.reportPath, "report_path_required");
        if (request.operation === "verify") {
          const result = await verifyBookStackMigration({ projectRoot: ctx.cwd, reportPath });
          return resultText({ verified: result.verified, summary: result.report.summary });
        }

        if (request.operation === "preflight") {
          let bookStack;
          let configurationError;
          try {
            bookStack = resolveBookStackClientInput(process.env);
          } catch (error) {
            configurationError = error;
          }
          const result = await preflightBookStackMigration({
            projectRoot: ctx.cwd,
            dryRunReportPath: reportPath,
            bookStack,
            configurationError,
            signal,
          });
          return resultText({
            reportPath: result.artifact.path,
            outcome: result.report.outcome,
            checks: result.report.checks,
          });
        }
        const bookStack = resolveBookStackClientInput(process.env);
        if (request.operation === "canary") {
          if (request.confirm !== "canary-report") throw new Error("canary_confirmation_required");
          const result = await canaryBookStackMigration({
            projectRoot: ctx.cwd,
            dryRunReportPath: reportPath,
            bookStack,
            signal,
          });
          return resultText({
            reportPath: result.artifact.path,
            selected: result.selected.length,
            summary: result.report.summary,
          });
        }
        if (request.operation === "cleanup") {
          if (request.confirm !== "cleanup-report") throw new Error("cleanup_confirmation_required");
          const result = await cleanupBookStackMigration({ projectRoot: ctx.cwd, reportPath, bookStack });
          return resultText({ deletedPageIds: result.deleted });
        }
        if (request.confirm !== "apply-report") throw new Error("apply_confirmation_required");
        const result = await applyBookStackMigration({
          projectRoot: ctx.cwd,
          dryRunReportPath: reportPath,
          bookStack,
          signal,
        });
        return resultText({ reportPath: result.artifact.path, summary: result.report.summary });
      });
    },
  });
}

export default function bookStackMigrateExtension(pi: ExtensionAPI) {
  registerBookStackMigrateTools(pi);
}
