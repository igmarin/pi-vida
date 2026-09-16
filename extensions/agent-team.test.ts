/**
 * Tests for agent-team dispatch and session_shutdown kill.
 *
 * Team membership is pure. Spawn/kill uses a PATH wrapper named `pi` (not a
 * spawn mock) so process-group kill is real. Tests do not call a real model
 * and do not require Herdr. Unix process-group coverage lives in
 * subagent.test.ts (CI is Linux-only).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import teamExt from "./agent-team.ts";

type FakePiMode = "ok" | "fail" | "sleep";

function writeFakePi(dir: string, mode: FakePiMode): { pidFile: string } {
	const pidFile = join(dir, "pid");
	const script = `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
const pidFile = ${JSON.stringify(pidFile)};
try { writeFileSync(pidFile, String(process.pid)); } catch {}
if (mode === "ok") {
	console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello from child" }] } }));
	process.exit(0);
}
if (mode === "fail") {
	console.error("child failed");
	process.exit(1);
}
process.on("SIGTERM", () => {});
await Bun.sleep(1e12);
`;
	writeFileSync(join(dir, "pi"), script, { mode: 0o755 });
	return { pidFile };
}

function pidFrom(file: string): number | undefined {
	if (!existsSync(file)) return undefined;
	const n = Number(readFileSync(file, "utf8").trim());
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function reap(pid: number | undefined): void {
	if (!pid) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		/* ignore */
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		/* ignore */
	}
}

async function waitFile(file: string, ms = 3_000): Promise<number> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		const pid = pidFrom(file);
		if (pid) return pid;
		await Bun.sleep(20);
	}
	throw new Error(`timed out waiting for ${file}`);
}

const gPath = globalThis as typeof globalThis & { __piFakePathChain?: Promise<unknown> };

async function withPathPi<T>(
	mode: FakePiMode,
	fn: (files: { dir: string; pidFile: string }) => Promise<T>,
): Promise<T> {
	const run = async () => {
		const dir = mkdtempSync(join(tmpdir(), "fake-pi-team-"));
		const files = writeFakePi(dir, mode);
		const prevPath = process.env.PATH;
		const prevTimeout = process.env.PI_CHILD_TIMEOUT_MS;
		const prevTeam = process.env.PI_TEAM;
		const prevLife = process.env.PI_LIFE;
		const prevVida = process.env.PI_VIDA;
		const prevHome = process.env.MY_PI_AGENT_HOME;
		const prevVidaHome = process.env.PI_VIDA_HOME;
		const prevHerdrEnv = process.env.HERDR_ENV;
		process.env.PATH = `${dir}${delimiter}${prevPath ?? ""}`;
		// These tests pin the hidden-child dispatch contract (#79): they must run
		// the no-herdr path even when bun test itself is launched inside Herdr.
		delete process.env.HERDR_ENV;
		delete process.env.PI_LIFE;
		delete process.env.PI_VIDA;
		delete process.env.MY_PI_AGENT_HOME;
		delete process.env.PI_VIDA_HOME;
		try {
			return await fn({ dir, ...files });
		} finally {
			reap(pidFrom(files.pidFile));
			if (prevPath === undefined) delete process.env.PATH;
			else process.env.PATH = prevPath;
			if (prevHerdrEnv === undefined) delete process.env.HERDR_ENV;
			else process.env.HERDR_ENV = prevHerdrEnv;
			if (prevTimeout === undefined) delete process.env.PI_CHILD_TIMEOUT_MS;
			else process.env.PI_CHILD_TIMEOUT_MS = prevTimeout;
			if (prevTeam === undefined) delete process.env.PI_TEAM;
			else process.env.PI_TEAM = prevTeam;
			if (prevLife === undefined) delete process.env.PI_LIFE;
			else process.env.PI_LIFE = prevLife;
			if (prevVida === undefined) delete process.env.PI_VIDA;
			else process.env.PI_VIDA = prevVida;
			if (prevHome === undefined) delete process.env.MY_PI_AGENT_HOME;
			else process.env.MY_PI_AGENT_HOME = prevHome;
			if (prevVidaHome === undefined) delete process.env.PI_VIDA_HOME;
			else process.env.PI_VIDA_HOME = prevVidaHome;
			rmSync(dir, { recursive: true, force: true });
		}
	};
	const prev = gPath.__piFakePathChain ?? Promise.resolve();
	const curr = prev.then(run, run);
	gPath.__piFakePathChain = curr.then(
		() => {},
		() => {},
	);
	return curr;
}

const TEAM_YAML = `
chains:
  plan-build-review:
    steps:
      - agent: planner
teams:
  default:
    members: [planner, builder, reviewer, researcher]
  fast:
    members: [builder]
`;

function teamCwd(yaml = TEAM_YAML): string {
	const cwd = mkdtempSync(join(tmpdir(), "team-cwd-"));
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "agents", "agent-chain.yaml"), yaml);
	writeFileSync(
		join(cwd, ".pi", "agents", "builder.yaml"),
		"name: builder\ndescription: test builder\ntools: read\nbody: |\n  test\n",
	);
	return cwd;
}

/** Point MY_PI_AGENT_HOME and HOME at the fixture so neither the repo's
 * profiles/agents nor the machine's ~/.claude/.gemini/.codex personas leak
 * into discovery (bun's os.homedir() reads $HOME). */
function isolateHarness(cwd: string): () => void {
	const prevRoot = process.env.MY_PI_AGENT_HOME;
	const prevHome = process.env.HOME;
	process.env.MY_PI_AGENT_HOME = cwd;
	process.env.HOME = cwd;
	return () => {
		if (prevRoot === undefined) delete process.env.MY_PI_AGENT_HOME;
		else process.env.MY_PI_AGENT_HOME = prevRoot;
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
	};
}

function loadTeam() {
	const tools: Record<string, { execute: Function }> = {};
	const events: Record<string, Function> = {};
	const commands: Record<string, { description: string; handler: Function }> = {};
	const pi = {
		on(ev: string, h: Function) {
			events[ev] = h;
		},
		registerCommand(name: string, def: { description: string; handler: Function }) {
			commands[name] = def;
		},
		registerTool(def: { name: string; execute: Function }) {
			tools[def.name] = def;
		},
		setActiveTools() {},
	};
	teamExt(pi as never);
	return { tools, events, commands };
}

function ctxOf(cwd: string) {
	return { cwd, hasUI: false, model: undefined, thinkingLevel: undefined };
}

describe("agent-team dispatch", () => {
	test("unknown member is rejected", async () => {
		const cwd = teamCwd();
		try {
			const { tools } = loadTeam();
			const out = await tools.dispatch_agent.execute(
				"id",
				{ agent: "nobody", task: "do a thing" },
				new AbortController().signal,
				undefined,
				ctxOf(cwd),
			);
			expect(out.isError).toBe(true);
			expect(out.content[0].text).toMatch(/not a member/);
			expect(out.content[0].text).toMatch(/nobody/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("active team comes from PI_TEAM", async () => {
		const cwd = teamCwd();
		const prev = process.env.PI_TEAM;
		process.env.PI_TEAM = "fast";
		try {
			const { tools } = loadTeam();
			const rejected = await tools.dispatch_agent.execute(
				"id",
				{ agent: "planner", task: "plan it" },
				new AbortController().signal,
				undefined,
				ctxOf(cwd),
			);
			expect(rejected.isError).toBe(true);
			expect(rejected.content[0].text).toMatch(/team 'fast'/);
			expect(rejected.content[0].text).toMatch(/planner/);
		} finally {
			if (prev === undefined) delete process.env.PI_TEAM;
			else process.env.PI_TEAM = prev;
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("successful dispatch returns child text", async () => {
		const cwd = teamCwd();
		try {
			await withPathPi("ok", async () => {
				const { tools } = loadTeam();
				const out = await tools.dispatch_agent.execute(
					"id",
					{ agent: "builder", task: "build it" },
					new AbortController().signal,
					undefined,
					ctxOf(cwd),
				);
				expect(out.isError).toBeFalsy();
				expect(out.content[0].text).toContain("hello from child");
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("failed child is a tool error", async () => {
		const cwd = teamCwd();
		try {
			await withPathPi("fail", async () => {
				const { tools } = loadTeam();
				const out = await tools.dispatch_agent.execute(
					"id",
					{ agent: "builder", task: "build it" },
					new AbortController().signal,
					undefined,
					ctxOf(cwd),
				);
				expect(out.isError).toBe(true);
				expect(out.content[0].text).toMatch(/builder/);
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("session_shutdown takes the kill path", async () => {
		const cwd = teamCwd();
		try {
			await withPathPi("sleep", async ({ pidFile }) => {
				process.env.PI_CHILD_TIMEOUT_MS = "60000";
				const { tools, events } = loadTeam();
				expect(typeof events.session_shutdown).toBe("function");
				const pending = tools.dispatch_agent.execute(
					"id",
					{ agent: "builder", task: "hang" },
					new AbortController().signal,
					undefined,
					ctxOf(cwd),
				);
				const pid = await waitFile(pidFile);
				await events.session_shutdown();
				// Must be dead when shutdown returns — fails if the handler only
				// abort()s and leaves SIGKILL on a timer the parent might not wait for.
				expect(alive(pid)).toBe(false);
				const out = await pending;
				expect(out.isError).toBe(true);
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}, 12_000);
});

describe("agent-team herdr dispatch (#79)", () => {
	/** Fake `herdr` on PATH (JSON-free stdout; argv log for assertions).
	 *  Modes: ok | fail | sleep — same shape as writeFakePi. */
	function writeFakeHerdr(dir: string, mode: FakePiMode): { logFile: string; herdrPidFile: string } {
		const logFile = join(dir, "herdr-log.jsonl");
		const herdrPidFile = join(dir, "herdr-pid");
		const script = `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
const logFile = ${JSON.stringify(logFile)};
const pidFile = ${JSON.stringify(herdrPidFile)};
const args = process.argv.slice(2);
appendFileSync(logFile, JSON.stringify(args) + "\\n");
if (args[0] === "agent" && args[1] === "prompt") {
	if (mode === "fail") {
		console.error("herdr: prompt rejected (agent_blocked)");
		process.exit(1);
	}
	if (mode === "sleep") {
		writeFileSync(pidFile, String(process.pid));
		process.on("SIGTERM", () => {});
		await Bun.sleep(1e12);
	}
	process.exit(0);
}
if (args[0] === "agent" && args[1] === "read") {
	console.log("PANE-OUTPUT: builder finished the task");
	process.exit(0);
}
process.exit(0);
`;
		writeFileSync(join(dir, "herdr"), script, { mode: 0o755 });
		return { logFile, herdrPidFile };
	}

	async function withPathHerdr<T>(
		mode: FakePiMode,
		fn: (files: {
			dir: string;
			/** The fake herdr's pid file (herdr prompt sleep mode). */
			pidFile: string;
			logFile: string;
			herdrPidFile: string;
			piPidFile: string;
		}) => Promise<T>,
	): Promise<T> {
		const run = async () => {
			const dir = mkdtempSync(join(tmpdir(), "fake-herdr-team-"));
			const herdrFiles = writeFakeHerdr(dir, mode);
			const piFiles = writeFakePi(dir, "ok");
			const prevPath = process.env.PATH;
			const prevHerdrEnv = process.env.HERDR_ENV;
			const prevMembers = process.env.PI_HERDR_MEMBERS;
			const prevTimeout = process.env.PI_CHILD_TIMEOUT_MS;
			const prevLife = process.env.PI_LIFE;
			const prevVida = process.env.PI_VIDA;
			const prevHome = process.env.MY_PI_AGENT_HOME;
			const prevVidaHome = process.env.PI_VIDA_HOME;
			process.env.PATH = `${dir}${delimiter}${prevPath ?? ""}`;
			process.env.HERDR_ENV = "1";
			process.env.PI_HERDR_MEMBERS = "builder";
			delete process.env.PI_LIFE;
			delete process.env.PI_VIDA;
			delete process.env.MY_PI_AGENT_HOME;
			delete process.env.PI_VIDA_HOME;
			try {
				return await fn({ dir, pidFile: herdrFiles.herdrPidFile, logFile: herdrFiles.logFile, herdrPidFile: herdrFiles.herdrPidFile, piPidFile: piFiles.pidFile });
			} finally {
				reap(pidFrom(herdrFiles.herdrPidFile));
				reap(pidFrom(piFiles.pidFile));
				if (prevPath === undefined) delete process.env.PATH;
				else process.env.PATH = prevPath;
				if (prevHerdrEnv === undefined) delete process.env.HERDR_ENV;
				else process.env.HERDR_ENV = prevHerdrEnv;
				if (prevMembers === undefined) delete process.env.PI_HERDR_MEMBERS;
				else process.env.PI_HERDR_MEMBERS = prevMembers;
				if (prevTimeout === undefined) delete process.env.PI_CHILD_TIMEOUT_MS;
				else process.env.PI_CHILD_TIMEOUT_MS = prevTimeout;
				if (prevLife === undefined) delete process.env.PI_LIFE;
				else process.env.PI_LIFE = prevLife;
				if (prevVida === undefined) delete process.env.PI_VIDA;
				else process.env.PI_VIDA = prevVida;
				if (prevHome === undefined) delete process.env.MY_PI_AGENT_HOME;
				else process.env.MY_PI_AGENT_HOME = prevHome;
				if (prevVidaHome === undefined) delete process.env.PI_VIDA_HOME;
				else process.env.PI_VIDA_HOME = prevVidaHome;
				rmSync(dir, { recursive: true, force: true });
			}
		};
		const prev = gPath.__piFakePathChain ?? Promise.resolve();
		const curr = prev.then(run, run);
		gPath.__piFakePathChain = curr.then(
			() => {},
			() => {},
		);
		return curr;
	}

	function logCalls(logFile: string): string[][] {
		if (!existsSync(logFile)) return [];
		return readFileSync(logFile, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as string[]);
	}

	test("allowed member prompts via herdr and reads the pane", async () => {
		const cwd = teamCwd();
		try {
			await withPathHerdr("ok", async ({ logFile }) => {
				const { tools } = loadTeam();
				const out = await tools.dispatch_agent.execute(
					"id",
					{ agent: "builder", task: "build it" },
					new AbortController().signal,
					undefined,
					ctxOf(cwd),
				);
				expect(out.isError).toBeFalsy();
				expect(out.content[0].text).toContain("PANE-OUTPUT: builder finished the task");
				const calls = logCalls(logFile);
				const prompt = calls.find((c) => c[0] === "agent" && c[1] === "prompt");
				expect(prompt).toBeDefined();
				expect(prompt![2]).toBe("builder");
				expect(prompt![3]).toBe("build it");
				expect(prompt).toContain("--wait");
				const read = calls.find((c) => c[0] === "agent" && c[1] === "read");
				expect(read![2]).toBe("builder");
				expect(read).toContain("--source");
				expect(read).toContain("recent-unwrapped");
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("member outside PI_HERDR_MEMBERS is a clear error, herdr untouched", async () => {
		const cwd = teamCwd();
		try {
			await withPathHerdr("ok", async ({ logFile }) => {
				const { tools } = loadTeam();
				const out = await tools.dispatch_agent.execute(
					"id",
					{ agent: "researcher", task: "research it" },
					new AbortController().signal,
					undefined,
					ctxOf(cwd),
				);
				expect(out.isError).toBe(true);
				expect(out.content[0].text).toMatch(/researcher/);
				expect(out.content[0].text).toMatch(/builder/);
				expect(logCalls(logFile)).toEqual([]);
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("herdr prompt failure is a tool error with stderr", async () => {
		const cwd = teamCwd();
		try {
			await withPathHerdr("fail", async () => {
				const { tools } = loadTeam();
				const out = await tools.dispatch_agent.execute(
					"id",
					{ agent: "builder", task: "build it" },
					new AbortController().signal,
					undefined,
					ctxOf(cwd),
				);
				expect(out.isError).toBe(true);
				expect(out.content[0].text).toContain("agent_blocked");
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("HERDR_ENV unset keeps the hidden-child path, herdr never invoked", async () => {
		const cwd = teamCwd();
		try {
			await withPathHerdr("ok", async ({ logFile }) => {
				delete process.env.HERDR_ENV;
				const { tools } = loadTeam();
				const out = await tools.dispatch_agent.execute(
					"id",
					{ agent: "builder", task: "build it" },
					new AbortController().signal,
					undefined,
					ctxOf(cwd),
				);
				expect(out.isError).toBeFalsy();
				expect(out.content[0].text).toContain("hello from child");
				expect(existsSync(logFile)).toBe(false);
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("session_shutdown aborts an in-flight herdr prompt", async () => {
		const cwd = teamCwd();
		try {
			await withPathHerdr("sleep", async ({ pidFile }) => {
				const { tools, events } = loadTeam();
				const pending = tools.dispatch_agent.execute(
					"id",
					{ agent: "builder", task: "hang" },
					new AbortController().signal,
					undefined,
					ctxOf(cwd),
				);
				const pid = await waitFile(pidFile);
				await events.session_shutdown();
				expect(alive(pid)).toBe(false);
				const out = await pending;
				expect(out.isError).toBe(true);
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}, 12_000);

	test("same-member dispatches serialize; different members run concurrently", async () => {
		const cwd = teamCwd();
		try {
			// Fake herdr where every prompt sleeps until marked: the run's output
			// records the interleaving (finish order proves serialization).
			const dir = mkdtempSync(join(tmpdir(), "fake-herdr-queue-"));
			const logFile = join(dir, "log");
			const script = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n");
if (args[0] === "agent" && args[1] === "prompt") {
	await Bun.sleep(args.includes("first") ? 300 : 30);
	process.exit(0);
}
if (args[0] === "agent" && args[1] === "read") {
	console.log("PANE-OUTPUT: builder finished the task");
	process.exit(0);
}
process.exit(0);
`;
			writeFileSync(join(dir, "herdr"), script, { mode: 0o755 });
			const prevPath = process.env.PATH;
			const prevHerdrEnv = process.env.HERDR_ENV;
			const prevMembers = process.env.PI_HERDR_MEMBERS;
			const prevTimeout = process.env.PI_CHILD_TIMEOUT_MS;
			const prevLife = process.env.PI_LIFE;
			const prevVida = process.env.PI_VIDA;
			const prevHome = process.env.MY_PI_AGENT_HOME;
			const prevVidaHome = process.env.PI_VIDA_HOME;
			process.env.PATH = `${dir}${delimiter}${prevPath ?? ""}`;
			process.env.HERDR_ENV = "1";
			process.env.PI_HERDR_MEMBERS = "builder";
			delete process.env.PI_LIFE;
			delete process.env.PI_VIDA;
			delete process.env.MY_PI_AGENT_HOME;
			delete process.env.PI_VIDA_HOME;
			try {
				const { tools } = loadTeam();
				// Fire two prompts at the same member concurrently. The second
				// must not START until the first prompt settles.
				const p1 = tools.dispatch_agent.execute("id", { agent: "builder", task: "first" }, new AbortController().signal, undefined, ctxOf(cwd));
				const p2 = tools.dispatch_agent.execute("id", { agent: "builder", task: "second" }, new AbortController().signal, undefined, ctxOf(cwd));
				const [r1, r2] = await Promise.all([p1, p2]);
				expect(r1.isError).toBeFalsy();
				expect(r2.isError).toBeFalsy();
				// Prompt starts are serialized: first prompt's argv logged before
				// second prompt's argv (single writer, prompt lines only).
				const promptOrder = logCalls(logFile)
					.map((c) => (c[0] === "agent" && c[1] === "prompt" ? c[3] : null))
					.filter(Boolean);
				expect(promptOrder).toEqual(["first", "second"]);
			} finally {
				if (prevPath === undefined) delete process.env.PATH;
				else process.env.PATH = prevPath;
				if (prevHerdrEnv === undefined) delete process.env.HERDR_ENV;
				else process.env.HERDR_ENV = prevHerdrEnv;
				if (prevMembers === undefined) delete process.env.PI_HERDR_MEMBERS;
				else process.env.PI_HERDR_MEMBERS = prevMembers;
				if (prevTimeout === undefined) delete process.env.PI_CHILD_TIMEOUT_MS;
				else process.env.PI_CHILD_TIMEOUT_MS = prevTimeout;
				if (prevLife === undefined) delete process.env.PI_LIFE;
				else process.env.PI_LIFE = prevLife;
				if (prevVida === undefined) delete process.env.PI_VIDA;
				else process.env.PI_VIDA = prevVida;
				if (prevHome === undefined) delete process.env.MY_PI_AGENT_HOME;
				else process.env.MY_PI_AGENT_HOME = prevHome;
				if (prevVidaHome === undefined) delete process.env.PI_VIDA_HOME;
				else process.env.PI_VIDA_HOME = prevVidaHome;
				rmSync(dir, { recursive: true, force: true });
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}, 15_000);
});

describe("agent-team team-list and session_start notify (#77)", () => {
	test("/team-list includes member tools and stars the active team", async () => {
		const cwd = teamCwd();
		const restore = isolateHarness(cwd);
		try {
			const { commands } = loadTeam();
			const seen: { msg: string; level?: string }[] = [];
			await commands["team-list"].handler("", {
				cwd,
				hasUI: true,
				ui: { notify: (msg: string, level?: string) => seen.push({ msg, level }) },
			});
			expect(seen.length).toBe(1);
			expect(seen[0].level).toBe("info");
			expect(seen[0].msg).toContain("* default — planner (no agent file), builder (read), reviewer (no agent file), researcher (no agent file)");
			expect(seen[0].msg).toContain("  fast — builder (read)");
		} finally {
			restore();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("/team-list PI_TEAM override stars the selected team", async () => {
		const cwd = teamCwd();
		const restore = isolateHarness(cwd);
		const prev = process.env.PI_TEAM;
		process.env.PI_TEAM = "fast";
		try {
			const { commands } = loadTeam();
			const seen: string[] = [];
			await commands["team-list"].handler("", {
				cwd,
				hasUI: true,
				ui: { notify: (msg: string) => seen.push(msg) },
			});
			expect(seen[0]).toContain("* fast — builder (read)");
		} finally {
			if (prev === undefined) delete process.env.PI_TEAM;
			else process.env.PI_TEAM = prev;
			restore();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("session_start notifies active team and members when UI present", async () => {
		const cwd = teamCwd();
		const restore = isolateHarness(cwd);
		try {
			const { events } = loadTeam();
			const seen: string[] = [];
			await events.session_start(undefined, {
				cwd,
				hasUI: true,
				ui: { notify: (msg: string) => seen.push(msg) },
			});
			expect(seen.length).toBe(1);
			expect(seen[0]).toContain("Team default active — members with tools:");
			expect(seen[0]).toContain("* default — planner (no agent file), builder (read)");
		} finally {
			restore();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("session_start without UI is silent (print/JSON mode)", async () => {
		const cwd = teamCwd();
		try {
			const { events } = loadTeam();
			const seen: string[] = [];
			await events.session_start(undefined, { cwd, hasUI: false });
			expect(seen.length).toBe(0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
