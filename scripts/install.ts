import { cp, mkdir, mkdtemp, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "skills");

const fail = (message: string): never => {
  console.error("Error: " + message);
  process.exit(1);
};

const parseArgs = (args: string[]) => {
  let dest = join(homedir(), ".agents", "skills");
  let validate = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--validate") validate = true;
    else if (args[index] === "--dest" && args[index + 1]) dest = resolve(args[++index]);
    else fail("Usage: node scripts/install.ts [--dest <directory>] [--validate]");
  }
  return { dest, validate };
};

const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

const canonicalPath = async (path: string) => {
  const unresolved: string[] = [];
  let current = resolve(path);
  while (true) {
    try {
      return join(await realpath(current), ...unresolved.reverse());
    } catch (error: any) {
      if (error?.code !== "ENOENT") fail("Destination could not be resolved.");
      const parent = dirname(current);
      if (parent === current) fail("Destination could not be resolved.");
      unresolved.push(basename(current));
      current = parent;
    }
  }
};

const validateDestination = async (dest: string) => {
  if (resolve(dest) === resolve("/")) fail("Destination must not be the filesystem root.");
  const [canonicalSource, canonicalDest] = await Promise.all([realpath(source), canonicalPath(dest)]);
  if (inside(canonicalSource, canonicalDest) || inside(canonicalDest, canonicalSource)) {
    fail("Source and destination must not overlap.");
  }
};

const skillNames = async () => {
  const entries = await readdir(source, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (!names.length) fail("No package skills found.");
  await Promise.all(names.map(async (name) => {
    try { await stat(join(source, name, "SKILL.md")); }
    catch { fail("Missing SKILL.md for " + name + "."); }
  }));
  return names;
};

const replaceSkill = async (name: string, dest: string) => {
  const target = join(dest, name);
  await mkdir(dirname(target), { recursive: true });
  const temporary = await mkdtemp(join(dirname(target), "." + basename(target) + "-"));
  const staged = join(temporary, name);
  try {
    await cp(join(source, name), staged, { recursive: true });
    const previous = target + ".previous-" + process.pid;
    await rm(previous, { recursive: true, force: true });
    try { await rename(target, previous); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    try {
      await rename(staged, target);
      await rm(previous, { recursive: true, force: true });
    } catch (error) {
      try { await rename(previous, target); } catch {}
      throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};

const { dest, validate } = parseArgs(process.argv.slice(2));
await validateDestination(dest);
const names = await skillNames();
if (validate) console.log("Validated " + names.length + " skills from " + source + ".");
else {
  for (const name of names) await replaceSkill(name, dest);
  console.log("Installed " + names.length + " skills to " + dest + ".");
}
