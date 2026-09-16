#!/usr/bin/env bun
/**
 * skills-bootstrap — provision PI_SKILLS_HOME from packs.yaml.
 *
 * For each `packs:` entry: clone (or pull) the source into the repo cache,
 * symlink every skills/<name>/ containing a SKILL.md into the skills home,
 * and record "<pack>:<name>" in .dotskills-manifest.json so pi-vida's pack
 * resolution finds the installed skills.
 *
 * For each `skills:` entry: sync the repo the same way and link only
 * skills/<name>/ — used for mantra/tracker skills that live inside a pack
 * repo or a third-party repo.
 *
 * Sources are `owner/repo` (cloned from github.com) or an absolute path to a
 * local git checkout (used by the smoke fixture). Existing non-symlink dirs
 * in the skills home are never overwritten; they still count as installed.
 * A stale symlink whose target vanished is relinked. Idempotent: re-running
 * pulls repos and repairs links/manifest. The manifest is MERGED — entries
 * written by other installers (dotskills) are preserved; a manifest that
 * fails the schema check aborts the run rather than being overwritten.
 *
 * Usage: bun scripts/skills-bootstrap.ts
 * Env:   PI_SKILLS_HOME (default ~/.agents/skills)
 *        PI_VIDA_REPOS  (default ~/.local/share/pi-vida/repos; PI_LIFE_REPOS fallback)
 *        PACKS_YAML     (default <repo>/packs.yaml)
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

export interface PacksConfig {
	packs: Record<string, string>;
	skills: Record<string, string>;
}

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/;

/** Parse packs.yaml. Unknown keys, non-string values, and bad names fail closed. */
export function parsePacksConfig(text: string): PacksConfig {
	const doc = parse(text);
	if (doc == null || typeof doc !== "object" || Array.isArray(doc)) {
		throw new Error("invalid packs.yaml: expected a mapping");
	}
	for (const key of Object.keys(doc)) {
		if (key !== "packs" && key !== "skills") {
			throw new Error(`invalid packs.yaml: unknown key ${key}`);
		}
	}
	const section = (key: "packs" | "skills"): Record<string, string> => {
		const v = (doc as Record<string, unknown>)[key];
		if (v == null) return {};
		if (typeof v !== "object" || Array.isArray(v)) {
			throw new Error(`invalid packs.yaml: ${key} must be a mapping`);
		}
		const out: Record<string, string> = {};
		for (const [name, source] of Object.entries(v)) {
			if (!SKILL_NAME.test(name)) {
				throw new Error(`invalid packs.yaml: bad ${key} name ${name}`);
			}
			if (typeof source !== "string" || !(GITHUB_REPO.test(source) || source.startsWith("/"))) {
				throw new Error(`invalid packs.yaml: ${key}.${name} must be owner/repo or an absolute path`);
			}
			out[name] = source;
		}
		return out;
	};
	return { packs: section("packs"), skills: section("skills") };
}

/** Skill dir names under <repoDir>/skills that contain a SKILL.md. */
export function collectSkillDirs(repoDir: string): string[] {
	const skillsDir = join(repoDir, "skills");
	if (!existsSync(skillsDir)) return [];
	return readdirSync(skillsDir, { withFileTypes: true })
		.filter((e) => e.isDirectory() && existsSync(join(skillsDir, e.name, "SKILL.md")))
		.map((e) => e.name)
		.sort();
}

/** Keep only manifest entries whose skill is actually installed. */
export function manifestEntries(
	planned: Record<string, { path: string }>,
	skillsHome: string,
): Record<string, { path: string }> {
	const out: Record<string, { path: string }> = {};
	for (const [identity, entry] of Object.entries(planned)) {
		if (existsSync(join(skillsHome, entry.path, "SKILL.md"))) out[identity] = entry;
	}
	return out;
}

interface Plan {
	repos: Record<string, string[]>; // source -> skill names to link (packs: all; skills: one)
	manifest: Record<string, { path: string }>;
}

/**
 * Build the link+manifest plan from config. Pure: no fs, no network.
 * allowlist (optional): when given, only those names install — packs whose
 * name is listed contribute their repo skills, `skills:` entries whose name
 * is listed contribute their single link. An allowlisted name that matches
 * nothing in packs.yaml fails closed (the profile is stale).
 */
export function planInstall(
	config: PacksConfig,
	packSkills: (pack: string, source: string) => string[],
	allowlist?: string[],
): Plan {
	const allowed = allowlist == null ? null : new Set(allowlist);
	if (allowed) {
		for (const name of allowed) {
			if (!Object.hasOwn(config.packs, name) && !Object.hasOwn(config.skills, name)) {
				throw new Error(`allowlist name not in packs.yaml: ${name}`);
			}
		}
	}
	const packs = Object.entries(config.packs).filter(([name]) => allowed?.has(name) ?? true);
	const skills = Object.entries(config.skills).filter(([name]) => allowed?.has(name) ?? true);
	const repos: Record<string, string[]> = {};
	const manifest: Record<string, { path: string }> = {};
	const addRepo = (source: string, names: string[]) => {
		const cur = repos[source] ?? (repos[source] = []);
		for (const n of names) if (!cur.includes(n)) cur.push(n);
	};
	for (const [pack, source] of packs) {
		const names = packSkills(pack, source);
		addRepo(source, names);
		for (const name of names) manifest[`${pack}:${name}`] = { path: name };
	}
	for (const [name, source] of skills) {
		addRepo(source, [name]);
	}
	return { repos, manifest };
}

/** Cache dir for a source: owner__repo for github, path tail for local. */
export function repoCacheDir(source: string, reposRoot: string): string {
	const safe = source.startsWith("/")
		? source.replaceAll("/", "_").replace(/^_/, "")
		: source.replace("/", "__");
	return join(reposRoot, safe);
}

async function sh(args: string[], cwd?: string): Promise<void> {
	const proc = Bun.spawn(args, { cwd, stdout: "inherit", stderr: "inherit" });
	if ((await proc.exited) !== 0) {
		throw new Error(`${args.join(" ")} failed`);
	}
}

/** Sync a source into the cache and return its dir. Local paths are used in place. */
async function syncRepo(source: string, reposRoot: string): Promise<string> {
	if (source.startsWith("/")) {
		if (!existsSync(source)) throw new Error(`local source missing: ${source}`);
		return source;
	}
	const dir = repoCacheDir(source, reposRoot);
	if (existsSync(join(dir, ".git"))) {
		await sh(["git", "-C", dir, "pull", "--ff-only", "-q"]);
		return dir;
	}
	mkdirSync(reposRoot, { recursive: true });
	await sh(["git", "clone", "-q", "--depth", "1", `https://github.com/${source}.git`, dir]);
	return dir;
}

function linkSkill(repoDir: string, name: string, skillsHome: string): "linked" | "exists" | "missing" {
	const src = join(repoDir, "skills", name);
	if (!existsSync(join(src, "SKILL.md"))) return "missing";
	const dest = join(skillsHome, name);
	const stat = lstatSync(dest, { throwIfNoEntry: false });
	if (stat?.isSymbolicLink()) {
		// Repair stale links: a symlink whose target vanished is replaced.
		if (existsSync(dest)) return "exists";
		unlinkSync(dest);
	} else if (stat) {
		return "exists"; // real dir/file: never overwrite
	}
	symlinkSync(src, dest);
	return "linked";
}

/** Read an existing manifest for merging. Foreign schema fails closed. */
function readExistingManifest(skillsHome: string): Record<string, { path: string }> {
	const file = join(skillsHome, ".dotskills-manifest.json");
	if (!existsSync(file)) return {};
	const doc = JSON.parse(readFileSync(file, "utf8"));
	if (doc.schema_version !== 1 || !doc.skills || typeof doc.skills !== "object" || Array.isArray(doc.skills)) {
		throw new Error(`invalid skill identity manifest: ${file}`);
	}
	return doc.skills;
}

/**
 * Sources to sync for this run. allowlist == null -> every referenced
 * source; otherwise the sources of every allowlisted name (a pack and a
 * skill may share one source — either name pulls it in).
 */
export function sourcesToSync(
	config: PacksConfig,
	allowlist?: string[],
): string[] {
	const needed: string[] = [];
	const push = (source: string) => {
		if (!needed.includes(source)) needed.push(source);
	};
	for (const [name, src] of Object.entries(config.packs)) {
		if (!allowlist || allowlist.includes(name)) push(src);
	}
	for (const [name, src] of Object.entries(config.skills)) {
		if (!allowlist || allowlist.includes(name)) push(src);
	}
	return needed;
}

async function main(): Promise<void> {
	const root = join(import.meta.dir, "..");
	const skillsHome = process.env.PI_SKILLS_HOME ?? join(homedir(), ".agents", "skills");
	const reposRoot = process.env.PI_VIDA_REPOS ?? process.env.PI_LIFE_REPOS ?? join(homedir(), ".local", "share", "pi-vida", "repos");
	const packsYaml = process.env.PACKS_YAML ?? join(root, "packs.yaml");
	const config = parsePacksConfig(readFileSync(packsYaml, "utf8"));

	// --allowlist <names...>: install only those profile names (mantra, packs,
	// tracker). Everything else in packs.yaml stays untouched. No flag = full
	// packs.yaml provisioning (`just skills`).
	const allowIdx = process.argv.indexOf("--allowlist");
	const allowlist =
		allowIdx === -1
			? undefined
			: process.argv.slice(allowIdx + 1).filter((a) => a !== "--");
	if (allowlist && allowlist.length === 0) {
		console.error("skills-bootstrap: --allowlist requires at least one name");
		process.exit(2);
	}

	// Sync every referenced repo first so pack skill lists come from disk.
	const repoDirs: Record<string, string> = {};
	for (const source of sourcesToSync(config, allowlist)) {
		repoDirs[source] = await syncRepo(source, reposRoot);
	}

	const plan = planInstall(
		config,
		(pack, source) => {
			const names = collectSkillDirs(repoDirs[source]);
			if (names.length === 0) console.error(`warning: pack ${pack}: no skills found in ${source}`);
			return names;
		},
		allowlist,
	);

	mkdirSync(skillsHome, { recursive: true });
	let linked = 0;
	let present = 0;
	for (const [source, names] of Object.entries(plan.repos)) {
		for (const name of names) {
			const r = linkSkill(repoDirs[source], name, skillsHome);
			if (r === "linked") linked++;
			else if (r === "exists") present++;
			else console.error(`warning: ${source} has no skills/${name}/SKILL.md`);
		}
	}

	// Merge over any existing manifest (dotskills or a previous run), then
	// keep only entries whose skill is actually installed — a recorded but
	// missing SKILL.md fails launches closed.
	const merged = { ...readExistingManifest(skillsHome), ...plan.manifest };
	const manifest = { schema_version: 1, skills: manifestEntries(merged, skillsHome) };
	writeFileSync(join(skillsHome, ".dotskills-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(`skills: ${linked} linked, ${present} already present, ${Object.keys(manifest.skills).length} manifest entries -> ${skillsHome}`);
}

if (import.meta.main) {
	main().catch((e) => {
		console.error(`skills-bootstrap: ${e instanceof Error ? e.message : e}`);
		process.exit(1);
	});
}
