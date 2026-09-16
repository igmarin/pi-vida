import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandArgs } from "./argExpand.ts";
import { canonicalLife, collectAgents, discover, harnessRoot } from "./agentScan.ts";

const tmp = join(tmpdir(), `mpa-scan-${process.pid}`);
const harness = join(tmp, "harness");
const cwd = join(tmp, "cwd");
const home = join(tmp, "home");

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	delete process.env.PI_VIDA_HOME;
	delete process.env.PI_LIFE_HOME;
	delete process.env.MY_PI_AGENT_HOME;
	delete process.env.PI_VIDA;
	delete process.env.PI_LIFE;
});

function seed() {
	mkdirSync(join(harness, "profiles/ruby/agents"), { recursive: true });
	mkdirSync(join(cwd, ".pi/agents"), { recursive: true });
	mkdirSync(join(cwd, ".claude/commands"), { recursive: true });
	mkdirSync(join(cwd, ".claude/agents"), { recursive: true });
	mkdirSync(join(home, ".claude/commands"), { recursive: true });
	writeFileSync(
		join(harness, "profiles/ruby/agents/planner.yaml"),
		"name: planner\ndescription: harness\nbody: |\n  HARNESS\n",
	);
	writeFileSync(
		join(cwd, ".pi/agents/planner.md"),
		"---\nname: planner\ndescription: project\n---\nPROJECT\n",
	);
	writeFileSync(
		join(cwd, ".pi/agents/builder.md"),
		"---\nname: builder\ndescription: pi-only\n---\nPI\n",
	);
	writeFileSync(
		join(cwd, ".claude/agents/builder.md"),
		"---\nname: builder\ndescription: claude\n---\nCLAUDE\n",
	);
	writeFileSync(join(cwd, ".claude/commands/foo.md"), "---\ndescription: do foo\n---\nDo foo $1\n");
	writeFileSync(join(home, ".claude/commands/foo.md"), "---\ndescription: home foo\n---\nHome\n");
	writeFileSync(join(home, ".claude/commands/bar.md"), "---\ndescription: home bar\n---\nBar\n");
	process.env.MY_PI_AGENT_HOME = harness;
	process.env.PI_LIFE = "rails";
}

test("expandArgs numbered tokens are not prefix-mangled", () => {
	expect(expandArgs("run $1 $10", "a b c d e f g h i j")).toBe("run a j");
	expect(expandArgs("all $ARGUMENTS then $1", "x y")).toBe("all x y then x");
	expect(expandArgs("missing $3", "only-one")).toBe("missing ");
});

test("canonicalLife aliases and rejects rails-python", () => {
	expect(canonicalLife("rails")).toBe("ruby");
	expect(canonicalLife("phoenix")).toBe("elixir");
	expect(canonicalLife("python")).toBe("python");
	expect(canonicalLife("rails-python")).toBeUndefined();
	expect(canonicalLife("ecto")).toBeUndefined();
});

test("harnessRoot resolves from env or import.meta.url", () => {
	// Test env precedence: PI_VIDA_HOME > PI_LIFE_HOME > MY_PI_AGENT_HOME
	const testRoot = join(tmpdir(), `harness-root-test-${process.pid}`);
	mkdirSync(testRoot, { recursive: true });
	
	try {
		process.env.PI_VIDA_HOME = testRoot;
		expect(harnessRoot()).toBe(testRoot);
		
		delete process.env.PI_VIDA_HOME;
		process.env.PI_LIFE_HOME = testRoot;
		expect(harnessRoot()).toBe(testRoot);
		
		delete process.env.PI_LIFE_HOME;
		process.env.MY_PI_AGENT_HOME = testRoot;
		expect(harnessRoot()).toBe(testRoot);
		
		// Test fallback to import.meta.url parent
		delete process.env.MY_PI_AGENT_HOME;
		const fallback = harnessRoot(import.meta.url);
		expect(fallback).toContain("pi-vida");
	} finally {
		rmSync(testRoot, { recursive: true, force: true });
		delete process.env.PI_VIDA_HOME;
		delete process.env.PI_LIFE_HOME;
		delete process.env.MY_PI_AGENT_HOME;
	}
});

test("first-wins: harness, then .pi, then .claude cwd, then home", () => {
	seed();
	const groups = discover(cwd, import.meta.url, home);
	const agents = collectAgents(cwd, import.meta.url, home);
	const planner = agents.find((a) => a.name === "planner");
	const builder = agents.find((a) => a.name === "builder");
	expect(planner?.source).toBe("profiles/ruby/agents");
	expect(planner?.body).toBe("HARNESS");
	expect(builder?.source).toBe(".pi/agents");
	expect(builder?.description).toBe("pi-only");
	const cmds = groups.flatMap((g) => g.commands);
	expect(cmds.map((c) => c.name)).toEqual(["foo", "bar"]);
	expect(cmds[0].description).toBe("do foo");
});

test("PI_VIDA wins over PI_LIFE", () => {
	seed();
	mkdirSync(join(harness, "profiles/python/agents"), { recursive: true });
	writeFileSync(
		join(harness, "profiles/python/agents/planner.yaml"),
		"name: planner\ndescription: python\nbody: PYTHON\n",
	);
	process.env.PI_VIDA = "python";
	const agents = collectAgents(cwd, import.meta.url, home);
	const planner = agents.find((a) => a.name === "planner");
	expect(planner?.source).toBe("profiles/python/agents");
	expect(planner?.body).toBe("PYTHON");
	expect(agents.some((a) => a.source === "profiles/ruby/agents")).toBe(false);
});

test("shared profiles/agents used when life dir is empty", () => {
	mkdirSync(join(harness, "profiles/agents"), { recursive: true });
	writeFileSync(
		join(harness, "profiles/agents/reviewer.yaml"),
		"name: reviewer\ndescription: shared\nbody: SHARED\n",
	);
	process.env.MY_PI_AGENT_HOME = harness;
	process.env.PI_LIFE = "python";
	const reviewer = collectAgents(cwd, import.meta.url, home).find((a) => a.name === "reviewer");
	expect(reviewer?.source).toBe("profiles/agents");
	expect(reviewer?.body).toBe("SHARED");
});

test("non-agent YAML in profiles/agents is skipped (agent-chain.yaml coexists)", () => {
	// Regression for #6: profiles/agents/agent-chain.yaml has a chains: schema,
	// not an agent schema. It must not surface as an agent named after the file.
	mkdirSync(join(harness, "profiles/agents"), { recursive: true });
	writeFileSync(
		join(harness, "profiles/agents/planner.yaml"),
		"name: planner\ndescription: shared\nbody: PLANNER\n",
	);
	writeFileSync(
		join(harness, "profiles/agents/agent-chain.yaml"),
		"chains:\n  plan-build-review:\n    steps:\n      - agent: planner\n",
	);
	process.env.MY_PI_AGENT_HOME = harness;
	process.env.PI_LIFE = "ruby";
	const agents = collectAgents(cwd, import.meta.url, home);
	expect(agents.some((a) => a.name === "agent-chain")).toBe(false);
	expect(agents.find((a) => a.name === "planner")).toBeDefined();
});

test("invalid PI_LIFE fails closed: no agents, no broad scan", () => {
	seed();
	process.env.PI_LIFE = "rails-python";
	expect(collectAgents(cwd, import.meta.url, home)).toEqual([]);
	expect(discover(cwd, import.meta.url, home)).toEqual([]);
});

test("malformed agent files are skipped gracefully", () => {
	seed();
	writeFileSync(join(harness, "profiles/ruby/agents/broken.yaml"), "::: not yaml [");
	const agents = collectAgents(cwd, import.meta.url, home);
	expect(agents.find((a) => a.name === "broken")).toBeUndefined();
	expect(agents.find((a) => a.name === "planner")).toBeDefined();
});

test("frontmatter quotes are stripped from descriptions", () => {
	seed();
	writeFileSync(join(cwd, ".pi/agents/quoted.md"), '---\nname: quoted\ndescription: "Runs builds"\n---\nQ\n');
	const q = collectAgents(cwd, import.meta.url, home).find((a) => a.name === "quoted");
	expect(q?.description).toBe("Runs builds");
});

test("agent md tools accept yaml list forms", () => {
	seed();
	writeFileSync(join(cwd, ".pi/agents/seq.md"), "---\nname: seq\ntools:\n  - bash\n  - read\n---\nSEQ\n");
	writeFileSync(join(cwd, ".pi/agents/inline.md"), "---\nname: inline\ntools: [bash, read]\n---\nINL\n");
	const agents = collectAgents(cwd, import.meta.url, home);
	expect(agents.find((a) => a.name === "seq")?.tools).toEqual(["bash", "read"]);
	expect(agents.find((a) => a.name === "inline")?.tools).toEqual(["bash", "read"]);
});

test("skill content excludes frontmatter", () => {
	seed();
	mkdirSync(join(cwd, ".pi/skills/demo"), { recursive: true });
	writeFileSync(join(cwd, ".pi/skills/demo/SKILL.md"), "---\nname: demo\ndescription: d\n---\nBODYTEXT\n");
	const demo = discover(cwd, import.meta.url, home).flatMap((g) => g.skills).find((s) => s.name === "demo");
	expect(demo?.content).not.toContain("description:");
	expect(demo?.content).toContain("BODYTEXT");
});
