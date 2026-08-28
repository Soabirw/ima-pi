import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const VESTIGE_TIMEOUT_MS = 300_000;

type VestigeCommand = "backup" | "export";

type VestigeCommandInput = {
  command: VestigeCommand;
  outputPath: string;
  dataDir?: string;
};

export type VestigeCliInput = {
  outputPath: string;
  dataDir?: string;
  signal?: AbortSignal;
  vestigeBin?: string;
};

export const vestigeArgs = ({ command, outputPath, dataDir }: VestigeCommandInput) => [
  command,
  outputPath,
  ...(command === "export" ? ["--format", "json"] : []),
  ...(dataDir ? ["--data-dir", dataDir] : []),
];

const runVestige = async (command: VestigeCommand, input: VestigeCliInput): Promise<void> => {
  const { outputPath, dataDir, signal, vestigeBin = "vestige" } = input;
  signal?.throwIfAborted();
  await execFile(vestigeBin, vestigeArgs({ command, outputPath, dataDir }), {
    shell: false,
    signal,
    timeout: VESTIGE_TIMEOUT_MS,
  });
  signal?.throwIfAborted();
};

export const runVestigeBackup = (input: VestigeCliInput) => runVestige("backup", input);
export const runVestigeExport = (input: VestigeCliInput) => runVestige("export", input);
