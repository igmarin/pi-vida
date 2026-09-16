import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Resolve dotskills' flat installation without broadening the profile allowlist. */
export function installedPackPaths(skillsHome: string, pack: string): string[] {
  const file = join(skillsHome, ".dotskills-manifest.json");
  if (!existsSync(file)) return [];
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  // Unknown schema fails closed: bump the parser when dotskills ships schema 2.
  if (manifest.schema_version !== 1 || !manifest.skills || typeof manifest.skills !== "object" || Array.isArray(manifest.skills)) {
    throw new Error(`invalid skill identity manifest: ${file}`);
  }
  const paths: string[] = [];
  for (const [identity, raw] of Object.entries(manifest.skills)) {
    if (!identity.startsWith(`${pack}:`)) continue;
    const entry = raw as { path?: unknown };
    // Flat install only: install_owned.py writes path = the skill dir name.
    if (!entry || typeof entry.path !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.path)) {
      throw new Error(`invalid installed skill path: ${identity}`);
    }
    const path = join(skillsHome, entry.path);
    if (!existsSync(join(path, "SKILL.md"))) throw new Error(`missing installed skill: ${identity} (${path})`);
    if (paths.includes(path)) throw new Error(`duplicate installed skill path: ${path}`);
    paths.push(path);
  }
  return paths.sort();
}

if (import.meta.main) {
  try {
    const paths = installedPackPaths(process.argv[2], process.argv[3]);
    if (paths.length) process.stdout.write(paths.join("\n") + "\n");
    else process.exit(1);
  } catch (error) {
    console.error(`pi-vida: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
}
