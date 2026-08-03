import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpAdapter } from "pi-mcp-adapter";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export default createMcpAdapter({
  configPath: join(packageRoot, "config", "mcp.json"),
});
