import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runPlaneMigrationPreparation } from "./plane-migrate-preparation.ts";
import {
  runPlaneMigrationApply,
  runPlaneMigrationReconcile,
  runPlaneMigrationStatus,
} from "./plane-migrate-operations.ts";

export {
  runPlaneMigrationPreparation,
  runPlaneMigrationApply,
  runPlaneMigrationReconcile,
  runPlaneMigrationStatus,
};

const notify = (ctx, message) => {
  if (ctx.hasUI) {
    ctx.ui.notify(message);
    return;
  }
  if (ctx.mode === "print" || ctx.mode === "json") {
    process.stderr.write(`[ima:plane-migrate] ${message}\n`);
  }
};

export const parsePlaneMigrationCommand = (args) => {
  if (typeof args !== "string") return null;
  const parts = args.trim() === "" ? [] : args.trim().split(/\s+/);
  if (parts.length === 0) return { verb: "prepare" };
  const [verb, relativeRunPath, ...extra] = parts;
  if (
    extra.length > 0
    || typeof relativeRunPath !== "string"
    || (verb !== "status" && verb !== "apply" && verb !== "reconcile")
  ) {
    return null;
  }
  return { verb, relativeRunPath };
};

export default function planeMigrate(pi: ExtensionAPI) {
  pi.registerCommand("ima:plane-migrate", {
    description: "Interactively prepare, inspect, apply, and reconcile a guarded Taskwarrior-to-Plane migration.",
    handler: async (args, ctx) => {
      const command = parsePlaneMigrationCommand(args);
      if (!command) {
        notify(ctx, "Usage: /ima:plane-migrate [status|apply|reconcile <relative-run-path>]");
        return;
      }
      if (command.verb === "prepare") {
        await runPlaneMigrationPreparation({ ctx });
        return;
      }
      const operation = { ctx, relativeRunPath: command.relativeRunPath };
      if (command.verb === "status") {
        await runPlaneMigrationStatus(operation);
        return;
      }
      if (command.verb === "apply") {
        await runPlaneMigrationApply(operation);
        return;
      }
      await runPlaneMigrationReconcile(operation);
    },
  });
}
