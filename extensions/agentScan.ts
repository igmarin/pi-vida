/**
 * Discover commands, skills, and agents.
 * Order: profiles/<vida>/agents/ (YAML), shared profiles/agents/, cwd .pi/,
 * then .claude/.gemini/.codex (cwd, then $HOME). First-wins on name collision.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const LIVES = ["rust", "elixir", "ruby", "python"] as const;
const PROVIDERS = ["claude", "gemini", "codex"] as const;

export type Discovered = { name: string; description: string; content: string };
export type AgentDef = {
	name: string;
	description: string;
	tools: string[];
	body: string;
	source: string;
	/** Absolute file path this agent was parsed from. */
	path: string;
};
export type SourceGroup = {
	source: string;
	commands: Discovered[];
	skills: Discovered[];
	agents: AgentDef[];
	/** Agents dropped by first-wins because a winner in this group already
	 * claimed the name (issue #81: the inspector lists them as shadows). */
	shadowed: AgentDef[];
};

export function canonicalLife(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const k = raw.toLowerCase();
	if (k === "phoenix") return "elixir";
	if (k === "rails") return "ruby";
	if ((LIVES as readonly string[]).includes(k)) return k;
	return undefined;
}

/** Single harness-root resolver (issue #81 re-review): PI_VIDA_HOME, else
 * PI_LIFE_HOME, else MY_PI_AGENT_HOME, else the dir containing extFileUrl.
 * discover, agentSources, agent-chain's harnessChainPath, and agents-view
 * all consume this one implementation so the view cannot disagree with
 * discovery. */
export function harnessRoot(extFileUrl = import.meta.url): string {
	return process.env.PI_VIDA_HOME || process.env.PI_LIFE_HOME || process.env.MY_PI_AGENT_HOME || resolve(dirname(fileURLToPath(extFileUrl)), "..");
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function parseFrontmatter(raw: string): { fields: Record<string, unknown>; body: string } {
	const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
	if (!match) return { fields: {}, body: raw };
	try {
		const doc = parse(match[1]);
		if (doc && typeof doc === "object" && !Array.isArray(doc)) {
			return { fields: doc as Record<string, unknown>, body: match[2] };
		}
	} catch {}
	return { fields: {}, body: match[2] };
}

function toolsOf(v: unknown): string[] {
	if (Array.isArray(v)) return v.filter((t) => typeof t === "string").map((t) => t.trim()).filter(Boolean);
	if (typeof v === "string") return v.split(",").map((t) => t.trim()).filter(Boolean);
	return [];
}

function firstLine(s: string): string {
	return s.split("\n").find((l) => l.trim())?.trim() || "";
}

function scanCommands(dir: string): Discovered[] {
	if (!existsSync(dir)) return [];
	const items: Discovered[] = [];
	try {
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".md")) continue;
			const raw = readFileSync(join(dir, file), "utf-8");
			const { fields, body } = parseFrontmatter(raw);
			items.push({
				name: basename(file, ".md"),
				description: str(fields.description) || firstLine(body),
				content: body,
			});
		}
	} catch (e) {
		console.warn("agentScan: commands skipped in", dir + ":", errText(e));
	}
	return items;
}

function scanSkills(dir: string): Discovered[] {
	if (!existsSync(dir)) return [];
	const items: Discovered[] = [];
	try {
		for (const entry of readdirSync(dir)) {
			const skillFile = join(dir, entry, "SKILL.md");
			const flatFile = join(dir, entry);
			if (existsSync(skillFile) && statSync(skillFile).isFile()) {
				const raw = readFileSync(skillFile, "utf-8");
				const { fields, body } = parseFrontmatter(raw);
				items.push({
					name: entry,
					description: str(fields.description) || firstLine(body),
					content: body, // frontmatter never reaches the model session
				});
			} else if (entry.endsWith(".md") && statSync(flatFile).isFile()) {
				const raw = readFileSync(flatFile, "utf-8");
				const { fields, body } = parseFrontmatter(raw);
				items.push({
					name: basename(entry, ".md"),
					description: str(fields.description) || firstLine(body),
					content: body,
				});
			}
		}
	} catch (e) {
		console.warn("agentScan: skills skipped in", dir + ":", errText(e));
	}
	return items;
}

function agentFromMd(path: string, source: string): AgentDef | null {
	try {
		const raw = readFileSync(path, "utf-8");
		const { fields, body } = parseFrontmatter(raw);
		return {
			name: str(fields.name) || basename(path, ".md"),
			description: str(fields.description),
			tools: toolsOf(fields.tools),
			body: body.trim(),
			source,
			path,
		};
	} catch (e) {
		console.warn("agentScan: agent md skipped:", path, errText(e));
		return null;
	}
}

function agentFromYaml(path: string, source: string): AgentDef | null {
	try {
		const doc = parse(readFileSync(path, "utf-8"));
		if (doc == null || typeof doc !== "object" || Array.isArray(doc)) return null;
		const rec = doc as Record<string, unknown>;
		const fileName = basename(path).replace(/\.ya?ml$/, "");
		const name = typeof rec.name === "string" && rec.name ? rec.name : fileName;
		const description = typeof rec.description === "string" ? rec.description : "";
		const body = typeof rec.body === "string" ? rec.body : typeof rec.prompt === "string" ? rec.prompt : "";
		const hasContent = [rec.name, rec.description, rec.body, rec.prompt].some((v) => typeof v === "string" && v.trim());
		if (!hasContent) return null;
		return { name, description, tools: toolsOf(rec.tools), body: body.trim(), source, path };
	} catch (e) {
		console.warn("agentScan: agent yaml skipped:", path, errText(e));
		return null;
	}
}

function scanAgents(dir: string, source: string): AgentDef[] {
	if (!existsSync(dir)) return [];
	const items: AgentDef[] = [];
	try {
		for (const file of readdirSync(dir)) {
			const path = join(dir, file);
			if (!statSync(path).isFile()) continue;
			const agent = file.endsWith(".yaml") || file.endsWith(".yml")
				? agentFromYaml(path, source)
				: file.endsWith(".md")
					? agentFromMd(path, source)
					: null;
			if (agent) items.push(agent);
		}
	} catch (e) {
		console.warn("agentScan: agents skipped in", dir + ":", errText(e));
	}
	return items;
}

function take<T extends { name: string }>(
	items: T[],
	seen: Set<string>,
	key = (n: string) => n,
	dropped?: T[],
): T[] {
	const out: T[] = [];
	for (const item of items) {
		const k = key(item.name);
		if (seen.has(k)) {
			dropped?.push(item);
			continue;
		}
		seen.add(k);
		out.push(item);
	}
	return out;
}

/**
 * The agent source specs discover() walks, in first-wins order — the single
 * source of truth for the order display (issue #81). Prefixless entries are
 * candidates; discover() prefixes the ones that exist on disk with `*`.
 */
export function agentSources(
	root: string,
	life: string | undefined,
	cwd: string,
	home: string,
): { source: string; agents: string; commands?: string; skills?: string }[] {
	// Normalize the bases so AgentDef.path is absolute even when a caller
	// passes a relative cwd/root (or an env override holds a relative path).
	const rootDir = resolve(root);
	const cwdDir = resolve(cwd);
	const homeDir = resolve(home);
	const lives = life ? [life] : [...LIVES];
	const specs: { source: string; agents: string; commands?: string; skills?: string }[] =
		lives.map((l) => ({
			source: `profiles/${l}/agents`,
			agents: join(rootDir, "profiles", l, "agents"),
		}));
	specs.push({ source: "profiles/agents", agents: join(rootDir, "profiles", "agents") });
	specs.push({
		source: ".pi/agents",
		commands: join(cwdDir, ".pi", "commands"),
		skills: join(cwdDir, ".pi", "skills"),
		agents: join(cwdDir, ".pi", "agents"),
	});
	for (const p of PROVIDERS) {
		const dir = join(cwdDir, `.${p}`);
		specs.push({
			source: `.${p}`,
			commands: join(dir, "commands"),
			skills: join(dir, "skills"),
			agents: join(dir, "agents"),
		});
	}
	for (const p of PROVIDERS) {
		const dir = join(homeDir, `.${p}`);
		specs.push({
			source: `~/.${p}`,
			commands: join(dir, "commands"),
			skills: join(dir, "skills"),
			agents: join(dir, "agents"),
		});
	}
	return specs;
}

export function discover(
	cwd: string,
	extFileUrl: string,
	home = homedir(),
	vidaRaw: string | undefined = process.env.PI_VIDA || process.env.PI_LIFE,
): SourceGroup[] {
	const root = harnessRoot(extFileUrl);
	const life = vidaRaw ? canonicalLife(vidaRaw) : undefined;
	if (vidaRaw && !life) return []; // invalid PI_VIDA / PI_LIFE fails closed, not broad
	const specs = agentSources(root, life, cwd, home);

	const seenCmd = new Set<string>();
	const seenSkill = new Set<string>();
	const seenAgent = new Set<string>();
	const groups: SourceGroup[] = [];
	for (const spec of specs) {
		const commands = spec.commands ? take(scanCommands(spec.commands), seenCmd) : [];
		const skills = spec.skills ? take(scanSkills(spec.skills), seenSkill) : [];
		const dropped: AgentDef[] = [];
		const agents = take(scanAgents(spec.agents, spec.source), seenAgent, (n) => n.toLowerCase(), dropped);
		if (commands.length || skills.length || agents.length || dropped.length) {
			groups.push({ source: spec.source, commands, skills, agents, shadowed: dropped });
		}
	}
	return groups;
}

export function collectAgents(cwd: string, extFileUrl: string, home = homedir()): AgentDef[] {
	return discover(cwd, extFileUrl, home).flatMap((g) => g.agents);
}
