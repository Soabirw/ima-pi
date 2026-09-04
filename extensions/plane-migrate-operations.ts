import * as artifactApi from "../lib/plane-taskwarrior-migration-artifacts.ts";
import {
  applyPreparedMigrationRun,
  inspectPreparedMigrationRun,
  readPreparedMigrationRunStatus,
  reconcilePreparedMigrationRun,
} from "../lib/plane-taskwarrior-prepared-run-operations.ts";
import {
  PlaneApiError,
  createPlaneClient,
  readPlaneConfig,
  toPublicPlaneError,
} from "../skills/plane-api/scripts/plane-client.mjs";

const MIGRATION_STATUS_KEY = "ima-plane-migrate";
const MIGRATION_WIDGET_KEY = "ima-plane-migrate-progress";

const notify = (ctx, message, level = "warning") => {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
    return;
  }
  if (ctx.mode === "print" || ctx.mode === "json") {
    process.stderr.write(`[ima:plane-migrate] ${message}\n`);
  }
};

const uiEffect = (effect) => {
  try {
    effect();
  } catch {
    // Migration progress is best-effort and must not interrupt a guarded operation.
  }
};

const setMigrationActivity = (ctx, message) => {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  uiEffect(() => ctx.ui.setStatus(MIGRATION_STATUS_KEY, message));
  uiEffect(() => ctx.ui.setWidget(MIGRATION_WIDGET_KEY, [`Plane migration: ${message}`]));
};

const clearMigrationActivity = (ctx) => {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  uiEffect(() => ctx.ui.setStatus(MIGRATION_STATUS_KEY, undefined));
  uiEffect(() => ctx.ui.setWidget(MIGRATION_WIDGET_KEY, undefined));
};

const progressCount = (event) => Number.isInteger(event?.completed)
  && Number.isInteger(event?.total)
  && event.completed >= 0
  && event.total >= 0
  ? ` (${event.completed}/${event.total})`
  : "";

const readinessProgressCount = (event) => Number.isInteger(event?.readinessCompleted)
  && Number.isInteger(event?.readinessTotal)
  && event.readinessCompleted >= 0
  && event.readinessTotal >= 0
  ? ` (${event.readinessCompleted}/${event.readinessTotal})`
  : "";

const readinessProgressDetail = (event) => {
  if (typeof event?.projectKey !== "string") return "";
  const count = readinessProgressCount(event);
  if (event.readinessStep === "project-states") {
    return `: ${event.projectKey} project states${count}`;
  }
  if (event.readinessStep === "external-identities") {
    return `: ${event.projectKey} identity checks${count}`;
  }
  return "";
};

const migrationProgressMessage = (event) => {
  const count = progressCount(event);
  const outcome = event?.outcome ? `; ${event.outcome}` : "";
  return {
    "waiting-for-lock": "Waiting for the migration lock.",
    "revalidating-run": "Revalidating the reviewed migration under lock.",
    "checking-readiness": `Checking live destination readiness${count}${readinessProgressDetail(event)}.`,
    "readiness-persisted": event?.outcome === "READY"
      ? "Live readiness passed and was saved."
      : "Live readiness is blocked and was saved.",
    "checkpoint-loaded": "Loading the resumable migration checkpoint.",
    "reconciliation-invalidated": "Cleared prior reconciliation evidence.",
    "applying-items": `Applying work items${count}${outcome}.`,
    "applying-relations": `Applying work-item relations${count}${outcome}.`,
    "applying-backfills": `Backfilling work-item descriptions${count}${outcome}.`,
    "application-checkpoints-complete": "All migration checkpoints are saved.",
    "reconciliation-checkpoint-loaded": "Loading the reconciliation checkpoint.",
    "reconciling-items": `Reconciling migrated work items${count}.`,
    "reconciling-relations": `Reconciling work-item relation sources${count}.`,
    "building-reconciliation": "Building the reconciliation report.",
    "reconciliation-persisted": "The reconciliation report is saved.",
  }[event?.phase] ?? "Processing the migration.";
};

const migrationProgress = (ctx) => (event) => {
  setMigrationActivity(ctx, migrationProgressMessage(event));
};

const codeFrom = (error) => error !== null
  && typeof error === "object"
  && "code" in error
  && typeof error.code === "string"
  ? error.code
  : null;

const messageFor = (error) => {
  if (error instanceof PlaneApiError) return toPublicPlaneError(error).message;
  if (codeFrom(error)) return "Plane migration could not be completed safely.";
  return "Plane migration could not be completed safely.";
};

const dependenciesFor = () => ({
  env: process.env,
  readConfig: readPlaneConfig,
  createClient: createPlaneClient,
  artifactApi,
  inspectPreparedRun: inspectPreparedMigrationRun,
  readPreparedStatus: readPreparedMigrationRunStatus,
  applyPreparedRun: applyPreparedMigrationRun,
  reconcilePreparedRun: reconcilePreparedMigrationRun,
});

const nonInteractiveResult = (ctx, operation) => {
  notify(ctx, `Plane migration ${operation} requires interactive TUI mode.`);
  return { status: "blocked", code: "INTERACTIVE_ONLY" };
};

const preparedRunInput = ({ ctx, relativeRunPath, dependencies }) => ({
  cwd: ctx.cwd,
  relativeRunPath,
  env: dependencies.env,
  artifactApi: dependencies.artifactApi,
  createClient: dependencies.createClient,
  readConfig: dependencies.readConfig,
  onProgress: migrationProgress(ctx),
});

const applyReview = ({ run, plan, backfillPlan }) => [
  `Run: ${run.relativeRunPath}`,
  `Creates: ${plan.summary.creates}; description backfills: ${backfillPlan?.updates?.length ?? 0}; relations: ${plan.summary.eligibleRelations}.`,
  `Skipped deleted tasks: ${plan.summary.taskSkips}.`,
  `Plan SHA-256: ${plan.planSha256}`,
  "Plane writes begin only after a literal confirm and locked revalidation.",
].join("\n");

const statusMessage = ({ relativeRunPath, state, readiness }) => [
  `Migration ${relativeRunPath} is ${state}.`,
  readiness === null ? "No recorded readiness result." : `Readiness ${readiness}.`,
].join(" ");

export const runPlaneMigrationStatus = async ({ ctx, relativeRunPath, dependencies = dependenciesFor() }) => {
  if (ctx.mode !== "tui") return nonInteractiveResult(ctx, "status");

  try {
    setMigrationActivity(ctx, "Reading local migration artifacts.");
    notify(ctx, "Reading local Plane migration status.", "info");
    const result = await dependencies.readPreparedStatus({
      cwd: ctx.cwd,
      relativeRunPath,
      artifactApi: dependencies.artifactApi,
    });
    notify(ctx, statusMessage(result), result.state === "blocked" ? "warning" : "info");
    return result;
  } catch (error) {
    notify(ctx, messageFor(error));
    return { status: "blocked", code: "STATUS_FAILED" };
  } finally {
    clearMigrationActivity(ctx);
  }
};

export const runPlaneMigrationApply = async ({ ctx, relativeRunPath, dependencies = dependenciesFor() }) => {
  if (ctx.mode !== "tui") return nonInteractiveResult(ctx, "application");

  try {
    setMigrationActivity(ctx, "Inspecting the prepared migration.");
    notify(ctx, "Inspecting the prepared Plane migration.", "info");
    const inspected = await dependencies.inspectPreparedRun({
      cwd: ctx.cwd,
      relativeRunPath,
      artifactApi: dependencies.artifactApi,
    });
    setMigrationActivity(ctx, "Awaiting migration review confirmation.");
    const acceptedReview = await ctx.ui.confirm(
      "Review Plane migration application",
      applyReview(inspected),
    );
    if (!acceptedReview) {
      notify(ctx, "Plane migration application cancelled.", "info");
      return { status: "cancelled" };
    }

    setMigrationActivity(ctx, "Awaiting the literal application confirmation.");
    const confirmation = await ctx.ui.input("Type confirm to apply", "confirm");
    if (confirmation === undefined) {
      notify(ctx, "Plane migration application cancelled.", "info");
      return { status: "cancelled" };
    }
    if (confirmation !== "confirm") {
      notify(ctx, "Plane migration application requires the exact literal confirm.");
      return { status: "blocked", code: "CONFIRMATION_INVALID" };
    }

    setMigrationActivity(ctx, "Starting guarded migration application.");
    notify(ctx, "Plane migration application started; live progress is shown above the editor and in the status bar.", "info");
    const result = await dependencies.applyPreparedRun({
      ...preparedRunInput({ ctx, relativeRunPath, dependencies }),
      reviewedPlanSha256: inspected.plan.planSha256,
    });
    notify(
      ctx,
      result.state === "applied"
        ? `Migration ${result.relativeRunPath} applied. Reconcile before claiming verified completion.`
        : `Migration ${result.relativeRunPath} is partially applied and can be resumed safely.`,
      result.state === "applied" ? "info" : "warning",
    );
    return result;
  } catch (error) {
    notify(ctx, messageFor(error));
    return { status: "blocked", code: "APPLICATION_FAILED" };
  } finally {
    clearMigrationActivity(ctx);
  }
};

export const runPlaneMigrationReconcile = async ({ ctx, relativeRunPath, dependencies = dependenciesFor() }) => {
  if (ctx.mode !== "tui") return nonInteractiveResult(ctx, "reconciliation");

  try {
    setMigrationActivity(ctx, "Inspecting the prepared checkpoint.");
    notify(ctx, "Plane migration reconciliation started; live progress is shown above the editor and in the status bar.", "info");
    const result = await dependencies.reconcilePreparedRun(
      preparedRunInput({ ctx, relativeRunPath, dependencies }),
    );
    notify(
      ctx,
      result.state === "reconciled"
        ? `Migration ${result.relativeRunPath} is reconciled and verified.`
        : `Migration ${result.relativeRunPath} is not yet reconciled.`,
      result.state === "reconciled" ? "info" : "warning",
    );
    return result;
  } catch (error) {
    notify(ctx, messageFor(error));
    return { status: "blocked", code: "RECONCILIATION_FAILED" };
  } finally {
    clearMigrationActivity(ctx);
  }
};

export default function planeMigrateOperationsExtension() {
  // Pi loads every package extension file; command registration remains in plane-migrate.ts.
}
