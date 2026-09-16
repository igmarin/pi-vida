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
		process.env.PATH = `${dir}${delimiter}${prevPath ?? ""}`;
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
		"name: builder\ndescription: test builder\nbody: |\n  test\n",
	);
	return cwd;
}

function loadTeam() {
	const tools: Record<string, { execute: Function }> = {};
	const events: Record<string, Function> = {};
	const pi = {
		on(ev: string, h: Function) {
			events[ev] = h;
		},
		registerCommand() {},
		registerTool(def: { name: string; execute: Function }) {
			tools[def.name] = def;
		},
		setActiveTools() {},
	};
	teamExt(pi as never);
	return { tools, events };
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
