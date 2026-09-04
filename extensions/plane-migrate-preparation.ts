import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import * as artifactApi from "../lib/plane-taskwarrior-migration-artifacts.ts";
import {
  TASKWARRIOR_EXTERNAL_SOURCE,
  buildDryRunReport,
  buildMigrationPlan,
} from "../lib/plane-taskwarrior-migration.ts";
import {
  HISTORY_POLICIES,
  analyzeTaskwarriorInventory,
  buildPreparationReadinessReport,
  buildPreparationSource,
  decisionsToPlanInputs,
  destinationCompatibility,
  indexExistingIdentities,
  projectsNeedingDecisions,
} from "../lib/plane-taskwarrior-planning.ts";
import { stripPlaneEnvironment } from "../scripts/plane-taskwarrior-migrate.mjs";
import {
  PlaneApiError,
  createPlaneClient,
  readPlaneConfig,
  toPublicPlaneError,
} from "../skills/plane-api/scripts/plane-client.mjs";

const executeFile = promisify(execFileCallback);
const TASK_EXPORT_MAX_BUFFER = 32 * 1024 * 1024;
const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const COMPLETE_HISTORY_LABEL = "Pending and completed (default)";
const PENDING_ONLY_LABEL = "Pending only";

class PreparationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const preparationFailure = (code) => {
  throw new PreparationError(code);
};

const notify = (ctx, message, level = "warning") => {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
    return;
  }
  if (ctx.mode === "print" || ctx.mode === "json") {
    process.stderr.write(`[ima:plane-migrate] ${message}\n`);
  }
};

const timestampFrom = (clock) => {
  const date = clock();
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) preparationFailure("CLOCK_INVALID");
  return date.toISOString().replace(/[:.]/g, "-");
};

const workspaceFrom = (env) => {
  const workspace = env.PLANE_WORKSPACE;
  if (typeof workspace !== "string" || !WORKSPACE_PATTERN.test(workspace)) {
    preparationFailure("WORKSPACE_INVALID");
  }
  return workspace;
};

const taskExport = async ({ cwd, env, execFile }) => {
  try {
    const { stdout } = await execFile("task", ["export"], {
      cwd,
      env: stripPlaneEnvironment(env),
      maxBuffer: TASK_EXPORT_MAX_BUFFER,
      shell: false,
    });
    const tasks = JSON.parse(typeof stdout === "string" ? stdout : stdout.toString("utf8"));
    if (!Array.isArray(tasks)) preparationFailure("TASK_EXPORT_INVALID");
    return tasks;
  } catch (error) {
    if (error instanceof PreparationError) throw error;
    preparationFailure("TASK_EXPORT_UNAVAILABLE");
  }
};

const activeProjects = (projects) => projects
  .filter((project) => project.archivedAt === null)
  .sort((left, right) => left.identifier.localeCompare(right.identifier));

const isProjectAccessDenied = (error) => error instanceof PlaneApiError
  && error.code === "HTTP_ERROR"
  && error.status === 403;

const discoverDestination = async ({ client, workspace, project }) => {
  try {
    const states = await client.listProjectStates({ workspace, projectId: project.id });
    const items = await client.listProjectItemsByExternalSource({
      workspace,
      projectId: project.id,
      externalSource: TASKWARRIOR_EXTERNAL_SOURCE,
    });

    return {
      project,
      compatibility: destinationCompatibility({ project, states }),
      identityLookup: { status: "ready", itemCount: items.length },
      states,
      items,
    };
  } catch (error) {
    if (isProjectAccessDenied(error)) return null;
    throw error;
  }
};

const discoverDestinations = async ({ client, workspace }) => {
  const projects = activeProjects(await client.listWorkspaceProjects({ workspace }));
  const destinations = await Promise.all(projects.map((project) =>
    discoverDestination({ client, workspace, project }),
  ));

  return destinations.filter((destination) => destination !== null);
};

const sourceProjectLabel = (project) => project ?? "(none)";

const destinationOptionsFor = (discovered) => discovered
  .filter(({ compatibility }) => compatibility.compatible)
  .map((entry) => ({
    label: `${entry.project.identifier} — ${entry.project.name} (${entry.project.id})`,
    entry,
  }));

const historyPolicyFor = (choice) => choice === PENDING_ONLY_LABEL
  ? HISTORY_POLICIES.pendingOnly
  : HISTORY_POLICIES.pendingAndCompleted;

const choicesFor = async ({ ctx, decisionProjects, discovered }) => {
  const decisions = [];
  const compatibleDestinations = destinationOptionsFor(discovered);

  for (const project of decisionProjects) {
    const sourceLabel = sourceProjectLabel(project.taskwarriorProject);
    const action = await ctx.ui.select(
      `Migration for ${sourceLabel}`,
      ["Migrate", "Skip"],
    );
    if (!action) return { status: "cancelled" };
    if (action !== "Migrate" && action !== "Skip") {
      return { status: "blocked", code: "ACTION_SELECTION_INVALID" };
    }

    if (action === "Skip") {
      decisions.push({
        taskwarriorProject: project.taskwarriorProject,
        action: "skip",
        taskUuids: project.unmigratedTaskUuids,
      });
      continue;
    }

    if (compatibleDestinations.length === 0) {
      return { status: "blocked", code: "NO_COMPATIBLE_DESTINATION" };
    }

    const destinationChoice = await ctx.ui.select(
      `Destination for ${sourceLabel}`,
      compatibleDestinations.map(({ label }) => label),
    );
    if (!destinationChoice) return { status: "cancelled" };
    const selectedDestination = compatibleDestinations.find(({ label }) => label === destinationChoice);
    if (!selectedDestination) return { status: "blocked", code: "DESTINATION_SELECTION_INVALID" };

    const historyChoice = await ctx.ui.select(
      `History for ${sourceLabel}`,
      [COMPLETE_HISTORY_LABEL, PENDING_ONLY_LABEL],
    );
    if (!historyChoice) return { status: "cancelled" };
    if (historyChoice !== COMPLETE_HISTORY_LABEL && historyChoice !== PENDING_ONLY_LABEL) {
      return { status: "blocked", code: "HISTORY_SELECTION_INVALID" };
    }

    decisions.push({
      taskwarriorProject: project.taskwarriorProject,
      action: "migrate",
      taskUuids: project.unmigratedTaskUuids,
      historyPolicy: historyPolicyFor(historyChoice),
      destination: {
        workspace: selectedDestination.entry.project.workspace ?? undefined,
        projectId: selectedDestination.entry.project.id,
        projectKey: selectedDestination.entry.project.identifier,
        projectName: selectedDestination.entry.project.name,
        backlogStateId: selectedDestination.entry.compatibility.backlogStateId,
        doneStateId: selectedDestination.entry.compatibility.doneStateId,
      },
    });
  }

  return { status: "ready", decisions };
};

const withWorkspace = (decisions, workspace) => decisions.map((decision) =>
  decision.action === "migrate"
    ? { ...decision, destination: { ...decision.destination, workspace } }
    : decision);

const decisionReview = ({ decisions, decisionProjects }) => {
  const projectsBySource = new Map(decisionProjects.map((project) => [
    sourceProjectLabel(project.taskwarriorProject),
    project,
  ]));

  return decisions.map((decision) => {
    const sourceLabel = sourceProjectLabel(decision.taskwarriorProject);
    const project = projectsBySource.get(sourceLabel);
    const pendingCount = project?.unmigratedPending ?? 0;
    const completedCount = decision.historyPolicy === HISTORY_POLICIES.pendingOnly
      ? 0
      : project?.unmigratedCompleted ?? 0;
    const counts = `${pendingCount} pending, ${completedCount} completed`;
    if (decision.action === "skip") return `${sourceLabel}: skip (${counts})`;
    const history = decision.historyPolicy === HISTORY_POLICIES.pendingOnly
      ? "pending only"
      : "pending and completed";
    return `${sourceLabel}: migrate ${counts} to ${decision.destination.projectKey} (${history})`;
  }).join("\n");
};

const codeFrom = (error) => error !== null
  && typeof error === "object"
  && "code" in error
  && typeof error.code === "string"
  ? error.code
  : null;

const messageFor = (error) => {
  if (error instanceof PreparationError) {
    return {
      WORKSPACE_INVALID: "PLANE_WORKSPACE must identify one accessible workspace.",
      TASK_EXPORT_INVALID: "Taskwarrior export returned invalid data.",
      TASK_EXPORT_UNAVAILABLE: "Taskwarrior export was unavailable.",
      NO_COMPATIBLE_DESTINATION: "No discovered destination has both backlog and completed workflow states.",
      DESTINATION_SELECTION_INVALID: "The selected Plane destination was unavailable.",
      ACTION_SELECTION_INVALID: "The selected migration action was unavailable.",
      HISTORY_SELECTION_INVALID: "The selected history policy was unavailable.",
      CLOCK_INVALID: "Migration preparation could not create a safe run timestamp.",
      decision_tasks_empty: "The selected history policy leaves no tasks to prepare.",
      tasks_empty: "Select at least one project to migrate before preparing a run.",
    }[error.code] ?? "Migration preparation could not be completed safely.";
  }

  if (error instanceof PlaneApiError) return toPublicPlaneError(error).message;
  if (codeFrom(error)) return "Plane migration could not be completed safely.";
  if (error instanceof Error && error.message.startsWith("plane_taskwarrior_planning_")) {
    return "Migration selections could not be converted into a safe plan.";
  }
  return "Plane migration could not be completed safely.";
};

const dependenciesFor = () => ({
  env: process.env,
  execFile: executeFile,
  readConfig: readPlaneConfig,
  createClient: createPlaneClient,
  artifactApi,
  clock: () => new Date(),
});

export const runPlaneMigrationPreparation = async ({ ctx, dependencies = dependenciesFor() }) => {
  if (ctx.mode !== "tui") {
    notify(ctx, "Plane migration preparation requires interactive TUI mode.");
    return { status: "blocked", code: "INTERACTIVE_ONLY" };
  }

  try {
    const workspace = workspaceFrom(dependencies.env);
    const config = dependencies.readConfig(dependencies.env);
    const tasks = await taskExport({
      cwd: ctx.cwd,
      env: dependencies.env,
      execFile: dependencies.execFile,
    });
    const inventory = analyzeTaskwarriorInventory(tasks);
    const client = dependencies.createClient(config);
    const discovered = await discoverDestinations({ client, workspace });
    const identities = indexExistingIdentities(discovered.map(({ project, items }) => ({ project, items })));
    if (identities.ambiguous.length > 0) {
      notify(ctx, "Plane identity inventory is ambiguous; resolve duplicate Taskwarrior identities before preparing.");
      return { status: "blocked", code: "IDENTITY_AMBIGUOUS" };
    }

    const decisionProjects = projectsNeedingDecisions({
      inventory,
      existingByTaskUuid: identities.existingByTaskUuid,
      historyPolicyDefault: HISTORY_POLICIES.pendingAndCompleted,
    });
    if (decisionProjects.length === 0) {
      notify(ctx, "No eligible Taskwarrior tasks need migration.", "info");
      return { status: "completed", code: "NO_NEW_TASKS" };
    }

    const selected = await choicesFor({ ctx, decisionProjects, discovered });
    if (selected.status === "cancelled") {
      notify(ctx, "Plane migration preparation cancelled.", "info");
      return selected;
    }
    if (selected.status === "blocked") {
      notify(ctx, messageFor(new PreparationError(selected.code)));
      return selected;
    }

    const decisions = withWorkspace(selected.decisions, workspace);
    if (!decisions.some((decision) => decision.action === "migrate")) {
      notify(ctx, "No projects were selected for migration preparation.", "info");
      return { status: "completed", code: "NO_PROJECTS_SELECTED" };
    }

    const confirmed = await ctx.ui.confirm(
      "Review migration preparation",
      decisionReview({ decisions, decisionProjects }),
    );
    if (!confirmed) {
      notify(ctx, "Plane migration preparation cancelled.", "info");
      return { status: "cancelled" };
    }

    const planInputs = decisionsToPlanInputs({ decisions, tasks });
    const plan = buildMigrationPlan({
      worksheet: planInputs.projectMappings,
      destinations: planInputs.destinations,
      tasks: planInputs.tasks,
    });
    const source = buildPreparationSource({ workspace, decisions, discovered, tasks });
    const readiness = buildPreparationReadinessReport({
      planSha256: plan.planSha256,
      decisions: source.decisions,
      discovered: source.discovered,
    });
    const dryRunReport = buildDryRunReport(plan);
    const run = await dependencies.artifactApi.createMigrationRun({
      cwd: ctx.cwd,
      timestamp: timestampFrom(dependencies.clock),
    });

    await dependencies.artifactApi.writeRunArtifact({
      run,
      name: dependencies.artifactApi.MIGRATION_ARTIFACTS.source,
      value: source,
    });
    await dependencies.artifactApi.writeRunArtifact({
      run,
      name: dependencies.artifactApi.MIGRATION_ARTIFACTS.plan,
      value: plan,
    });
    await dependencies.artifactApi.writeRunArtifact({
      run,
      name: dependencies.artifactApi.MIGRATION_ARTIFACTS.dryRunReport,
      value: dryRunReport,
    });
    await dependencies.artifactApi.writeRunArtifact({
      run,
      name: dependencies.artifactApi.MIGRATION_ARTIFACTS.preflightReport,
      value: readiness,
    });

    const preparedMessage = [
      `Prepared ${run.relativeRunPath}.`,
      `Plan ${plan.planSha256}.`,
      `${inventory.deletedCount} deleted task(s) excluded.`,
      `Readiness ${readiness.outcome}.`,
    ].join(" ");
    notify(ctx, preparedMessage, readiness.outcome === "READY" ? "info" : "warning");
    return {
      status: "prepared",
      relativeRunPath: run.relativeRunPath,
      planSha256: plan.planSha256,
      summary: plan.summary,
      deletedCount: inventory.deletedCount,
      readiness: readiness.outcome,
    };
  } catch (error) {
    notify(ctx, messageFor(error));
    return { status: "blocked", code: "PREPARATION_FAILED" };
  }
};

export default function planeMigratePreparationExtension() {
  // Pi loads every package extension file; command registration remains in plane-migrate.ts.
}
