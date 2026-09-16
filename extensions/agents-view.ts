/**
 * Resolved agents view (issue #81): winner + shadowed personas, active team,
 * chain file, and both discovery orders for a cwd + vida. The in-session
 * `/agents` command (#77) reuses `resolvedAgentsView`; the launcher CLI
 * (`bin/pi-vida agents`) reuses the same launch-arg resolver, so "same
 * resolver as launch" holds by construction (it also prints the resolved
 * `--skill` paths from that shared path).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AgentDef, agentSources, canonicalLife, discover, harnessRoot } from "./agentScan.ts";
import { chainCandidates, ChainError, parseAgentTeams, pickTeam } from "./agent-chain.ts";
import { overlayFromEnv } from "./capabilities.ts";

export interface ResolvedAgentsView {
	cwd: string;
	harnessRoot: string;
	vida: string | undefined;
	/** Active team, or null when no chain file exists. via: what selected it. */
	team: { name: string; members: string[]; via: "default" | "PI_TEAM" } | null;
	chainFile: { source: string; path: string } | null;
	/** Both discovery orders; `*` prefixes candidates that exist on disk. */
	chainOrder: string[];
	agentOrder: string[];
	agents: AgentDef[];
	shadowed: { name: string; path: string; shadowedBy: string }[];
}

/**
 * Resolve everything the inspector shows for cwd + vida. envs read here:
 * PI_VIDA_HOME / PI_LIFE_HOME / MY_PI_AGENT_HOME (harness root), PI_TEAM
 * (active team). An invalid vida fails closed: empty discovery, no team,
 * no orders — never a broad scan.
 */
export function resolvedAgentsView(
	cwd: string,
	vida: string | undefined,
	extFileUrl = import.meta.url,
	home = homedir(),
): ResolvedAgentsView {
	const root = harnessRoot(extFileUrl);
	const view: ResolvedAgentsView = {
		cwd,
		harnessRoot: root,
		vida: canonicalLife(vida),
		team: null,
		chainFile: null,
		chainOrder: [],
		agentOrder: [],
		agents: [],
		shadowed: [],
	};
	if (vida && !view.vida) return view;

	const groups = discover(cwd, extFileUrl, home, view.vida);
	for (const g of groups) view.agents.push(...g.agents);
	// A shadowed entry always lost first-wins to a winner in an earlier
	// group; shadowedBy is that winner's exact name (files may differ in case).
	for (const g of groups) {
		for (const s of g.shadowed) {
			const winner = view.agents.find((a) => a.name.toLowerCase() === s.name.toLowerCase());
			if (winner) view.shadowed.push({ name: s.name, path: s.path, shadowedBy: winner.name });
		}
	}

	const candidates = chainCandidates(cwd, extFileUrl, view.vida);
	const chainFile = candidates.find((c) => existsSync(c.path));
	if (chainFile) {
		view.chainFile = { source: chainFile.source, path: chainFile.path };
		try {
			const teams = parseAgentTeams(readFileSync(chainFile.path, "utf-8"));
			const wanted = process.env.PI_TEAM?.trim() || undefined;
			const team = pickTeam(teams, wanted);
			// pickTeam throws on an unknown wanted, so a returned team under a
			// wanted set can only be that team.
			const via = wanted ? "PI_TEAM" : "default";
			view.team = { name: team.name, members: [...team.members], via };
		} catch (e) {
			// ChainError covers the documented degrade paths: malformed chain
			// YAML (parse) and an unknown PI_TEAM (pickTeam). Anything else is
			// a real bug — rethrow, never mask it as team: none.
			if (!(e instanceof ChainError)) throw e;
			view.team = null;
		}
	}
	view.agentOrder = agentSources(root, view.vida, cwd, home).map((s) =>
		existsSync(s.agents) ? `*${s.source}` : s.source,
	);
	view.chainOrder = candidates.map((c) => (existsSync(c.path) ? `*${c.source}` : c.source));
	return view;
}

/**
 * The exact grep-friendly `key: value` output. Deterministic given the view
 * plus the current PI_OVERLAY (role model/thinking keyed on agent name, else
 * "inherit") — no fs access.
 */
export function formatAgentsView(v: ResolvedAgentsView): string {
	const lines: string[] = [];
	lines.push(`vida: ${v.vida ?? ""}`);
	lines.push(`harness: ${v.harnessRoot}`);
	lines.push(`cwd: ${v.cwd}`);
	if (v.team) {
		lines.push(`team: ${v.team.name} (${v.team.via})`);
		lines.push(`members: ${v.team.members.join(", ")}`);
	} else {
		lines.push("team: none");
	}
	lines.push(v.chainFile ? `chain-file: ${v.chainFile.path} [${v.chainFile.source}]` : "chain-file: none");
	lines.push(`chain-order: ${v.chainOrder.join(" > ")}`);
	lines.push(`agent-order: ${v.agentOrder.join(" > ")}`);
	const overlay = overlayFromEnv();
	for (const a of v.agents) {
		lines.push(`agent: ${a.name}`);
		lines.push(`  source: ${a.source}`);
		lines.push(`  path: ${a.path}`);
		lines.push(`  tools: ${a.tools.join(", ")}`);
		lines.push(`  model: ${overlay?.models?.[a.name] ?? "inherit"}`);
		lines.push(`  thinking: ${overlay?.thinking?.[a.name] ?? "inherit"}`);
		for (const s of v.shadowed.filter((s) => s.shadowedBy === a.name)) {
			lines.push(`  shadows: ${s.path}`);
		}
	}
	return lines.join("\n");
}

/** CLI: `bun extensions/agents-view.ts <cwd> [vida]`. No default export — the in-session /agents command is #77. */
if (import.meta.main) {
	const [cwd, vida] = process.argv.slice(2);
	if (!cwd) {
		console.error("usage: bun extensions/agents-view.ts <cwd> [vida]");
		process.exit(2);
	}
	const v = resolvedAgentsView(cwd, vida || process.env.PI_VIDA || process.env.PI_LIFE);
	if (vida && !v.vida) {
		console.error(`agents-view: unknown vida ${vida}`);
		process.exit(2);
	}
	console.log(formatAgentsView(v));
}
