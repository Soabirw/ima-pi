import { writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const commandSummary = (pi: ExtensionAPI) =>
  pi.getCommands().map(({ name, source, sourceInfo }) => ({
    name,
    source,
    scope: sourceInfo.scope,
    origin: sourceInfo.origin,
  }));

export default function discoveryProbe(pi: ExtensionAPI) {
  pi.registerCommand("ima:probe", {
    description: "Report IMA Pi command and resource discovery",
    handler: async (args, ctx) => {
      const result = { args, commands: commandSummary(pi) };
      const outputPath = process.env.IMA_PI_PROBE_RESULT;

      if (outputPath) {
        await writeFile(outputPath, JSON.stringify(result, null, 2));
      }

      if (ctx.hasUI) {
        ctx.ui.notify("IMA Pi package resources are loaded.", "info");
      }
    },
  });
}
