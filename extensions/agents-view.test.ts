/**
 * Tests for the resolved agents view (issue #81): winner + shadowed tracking,
 * PI_TEAM selection, missing chain file, invalid-vida fail-closed, and the
 * exact formatter output. Fixture conventions follow agentScan.test.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatAgentsView, resolvedAgentsView } from "./agents-view.ts";
import { EMPTY_OVERLAY, serializeOverlayEnv } from "./capabilities.ts";

const tmp = join(tmpdir(), `mpa-aview-${process.pid}`);
const harness = join(tmp, "harness");
const cwd = join(tmp, "cwd");
const home = join(tmp, "home");

const ENV_KEYS = [
	"PI_VIDA_HOME",
	"PI_LIFE_HOME",
	"MY_PI_AGENT_HOME",
	"PI_VIDA",
	"PI_LIFE",
	"PI_TEAM",
	"PI_OVERLAY",
] as const;

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	for (const k of ENV_KEYS) delete process.env[k];
});

function seed() {
	mkdirSync(join(harness, "profiles/agents"), { recursive: true });
	mkdirSync(join(harness, "profiles/ruby/agents"), { recursive: true });
	mkdirSync(join(cwd, ".pi/agents"), { recursive: true });
	// Deterministic order across sources: planner lives in shared
	// profiles/agents, builder in the vida dir (readdir order inside one
	// directory is unspecified).
	writeFileSync(
		join(harness, "profiles/ruby/agents/planner.yaml"),
		"name: planner\ndescription: plans\ntools: read, grep\nbody: |\n  PLAN\n",
	);
	writeFileSync(
		join(harness, "profiles/agents/builder.yaml"),
		"name: builder\ndescription: builds\ntools: read, write, edit, bash\nbody: |\n  BUILD\n",
	);
	writeFileSync(
		join(harness, "profiles/agents/agent-chain.yaml"),
		"teams:\n  default:\n    members: [planner, builder, reviewer, researcher]\n  fast:\n    members: [builder]\n",
	);
	// The project builder loses first-wins to the harness one (harness
	// profiles/<vida>/agents -> shared profiles/agents -> cwd .pi/agents).
	writeFileSync(
		join(cwd, ".pi/agents/builder.yaml"),
		"name: builder\ndescription: project builder\nbody: |\n  PROJECT\n",
	);
	process.env.MY_PI_AGENT_HOME = harness;
	process.env.PI_LIFE = "ruby";
}

test("winner + shadowed tracking with both discovery orders", () => {
	seed();
	const v = resolvedAgentsView(cwd, "ruby", import.meta.url, home);
	expect(v.agents.map((a) => a.name)).toEqual(["planner", "builder"]);
	expect(v.agents[0].path).toBe(join(harness, "profiles/ruby/agents/planner.yaml"));
	expect(v.agents[1].path).toBe(join(harness, "profiles/agents/builder.yaml"));
	expect(v.shadowed).toEqual([
		{ name: "builder", path: join(cwd, ".pi/agents/builder.yaml"), shadowedBy: "builder" },
	]);
	expect(v.team).toEqual({
		name: "default",
		members: ["planner", "builder", "reviewer", "researcher"],
		via: "default",
	});
	expect(v.chainFile?.source).toBe("profiles/agents");
	expect(v.chainOrder).toEqual([".pi/agents", "profiles/ruby/agents", "*profiles/agents"]);
	expect(v.agentOrder).toEqual([
		"*profiles/ruby/agents",
		"*profiles/agents",
		"*.pi/agents",
		".claude",
		".gemini",
		".codex",
		"~/.claude",
		"~/.gemini",
		"~/.codex",
	]);
});

test("PI_TEAM selects the active team", () => {
	seed();
	process.env.PI_TEAM = "fast";
	const v = resolvedAgentsView(cwd, "ruby", import.meta.url, home);
	expect(v.team).toEqual({ name: "fast", members: ["builder"], via: "PI_TEAM" });
	const out = formatAgentsView(v);
	expect(out).toContain("team: fast (PI_TEAM)");
	expect(out).toContain("members: builder");
});

test("unknown PI_TEAM degrades to team: none", () => {
	seed();
	process.env.PI_TEAM = "nope";
	const v = resolvedAgentsView(cwd, "ruby", import.meta.url, home);
	expect(v.team).toBeNull();
	expect(formatAgentsView(v)).toContain("team: none");
});

test("missing chain file: team none and chain-file none", () => {
	seed();
	rmSync(join(harness, "profiles/agents/agent-chain.yaml"));
	const v = resolvedAgentsView(cwd, "ruby", import.meta.url, home);
	expect(v.chainFile).toBeNull();
	expect(v.team).toBeNull();
	const out = formatAgentsView(v);
	expect(out).toContain("team: none");
	expect(out).toContain("chain-file: none");
	expect(out).not.toContain("members:");
});

test("malformed chain file degrades to team none without throwing", () => {
	seed();
	writeFileSync(join(harness, "profiles/agents/agent-chain.yaml"), "teams: [broken");
	const v = resolvedAgentsView(cwd, "ruby", import.meta.url, home);
	expect(v.chainFile?.path).toBe(join(harness, "profiles/agents/agent-chain.yaml"));
	expect(v.team).toBeNull();
	expect(v.agents.length).toBe(2);
});

test("invalid vida fails closed: empty discovery", () => {
	seed();
	const v = resolvedAgentsView(cwd, "nosuch", import.meta.url, home);
	expect(v.agents).toEqual([]);
	expect(v.shadowed).toEqual([]);
	expect(v.chainFile).toBeNull();
	expect(v.team).toBeNull();
	expect(v.chainOrder).toEqual([]);
	expect(v.agentOrder).toEqual([]);
});

test("case-differing shadow still prints under its winner", () => {
	seed();
	writeFileSync(
		join(cwd, ".pi/agents/Builder.yaml"),
		"name: Builder\ndescription: project\nbody: |\n  PROJECT\n",
	);
	const v = resolvedAgentsView(cwd, "ruby", import.meta.url, home);
	expect(v.shadowed.map((s) => s.name)).toContain("Builder");
	const out = formatAgentsView(v);
	expect(out).toContain(`  shadows: ${join(cwd, ".pi/agents/Builder.yaml")}`);
});

test("relative cwd yields absolute agent paths and starred order", () => {
	seed();
	const prevCwd = process.cwd();
	process.chdir(cwd);
	try {
		const v = resolvedAgentsView(".", "ruby", import.meta.url, home);
		expect(v.agents[0].path).toBe(join(harness, "profiles/ruby/agents/planner.yaml"));
		expect(v.agentOrder[0]).toBe("*profiles/ruby/agents");
	} finally {
		process.chdir(prevCwd);
	}
});

test("formatter snapshot with overlay model/thinking", () => {
	seed();
	const prevOverlay = process.env.PI_OVERLAY;
	process.env.PI_OVERLAY = serializeOverlayEnv({
		...EMPTY_OVERLAY,
		models: { builder: "openrouter/x" },
		thinking: { builder: "high" },
	});
	try {
		const v = resolvedAgentsView(cwd, "ruby", import.meta.url, home);
		expect(formatAgentsView(v)).toBe(
			[
				"vida: ruby",
				`harness: ${harness}`,
				`cwd: ${cwd}`,
				"team: default (default)",
				"members: planner, builder, reviewer, researcher",
				`chain-file: ${harness}/profiles/agents/agent-chain.yaml [profiles/agents]`,
				"chain-order: .pi/agents > profiles/ruby/agents > *profiles/agents",
				"agent-order: *profiles/ruby/agents > *profiles/agents > *.pi/agents > .claude > .gemini > .codex > ~/.claude > ~/.gemini > ~/.codex",
				"agent: planner",
				"  source: profiles/ruby/agents",
				`  path: ${harness}/profiles/ruby/agents/planner.yaml`,
				"  tools: read, grep",
				"  model: inherit",
				"  thinking: inherit",
				"agent: builder",
				"  source: profiles/agents",
				`  path: ${harness}/profiles/agents/builder.yaml`,
				"  tools: read, write, edit, bash",
				"  model: openrouter/x",
				"  thinking: high",
				`  shadows: ${cwd}/.pi/agents/builder.yaml`,
			].join("\n"),
		);
	} finally {
		if (prevOverlay === undefined) delete process.env.PI_OVERLAY;
		else process.env.PI_OVERLAY = prevOverlay;
	}
});
