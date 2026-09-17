/**
 * Tests for the damage-control (continue) gate.
 *
 * The pure helpers (isPathMatch, bashWriteTargets, expansionOperandRisk) are
 * tested directly; the tool_call handler is exercised by feeding synthetic
 * events through a captured pi.on, same as clarify-gate.test.ts. The gate
 * must fail closed: anything it cannot statically resolve is blocked.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import dcExt, {
	bashWriteTargets,
	expansionOperandRisk,
	isPathMatch,
} from "./damage-control-continue.ts";

type ToolCallEvent = { toolName: string; input: Record<string, unknown> };
type ToolCallResult = { block: boolean; reason?: string } | undefined;
type ToolCallHandler = (event: ToolCallEvent, ctx: unknown) => Promise<ToolCallResult>;
type SessionStartHandler = (event: unknown, ctx: unknown) => Promise<void>;

function makePi() {
	const captured: { sessionStart: SessionStartHandler | null; toolCall: ToolCallHandler | null } = {
		sessionStart: null,
		toolCall: null,
	};
	const entries: unknown[] = [];
	const pi = {
		on(event: string, handler: unknown) {
			if (event === "session_start") captured.sessionStart = handler as SessionStartHandler;
			if (event === "tool_call") captured.toolCall = handler as ToolCallHandler;
		},
		appendEntry(_name: string, entry: unknown) {
			entries.push(entry);
		},
	};
	return { pi, captured, entries };
}

function makeCtx(cwd = process.cwd(), hasUI = false) {
	const seen: string[] = [];
	const ctx = {
		cwd,
		hasUI,
		ui: {
			notify: (m: string, _level?: string) => {
				seen.push(m);
			},
			confirm: async () => false,
			setTheme: (_n: string) => ({ success: true }),
			setTitle: (_t: string) => {},
		},
	};
	return { ctx, seen };
}

/** Boot the extension, fire session_start so the rules file loads, return a
 *  tool_call invoker bound to that ctx. */
async function setup(cwd = process.cwd(), hasUI = false) {
	const { pi, captured, entries } = makePi();
	dcExt(pi as never);
	const { ctx, seen } = makeCtx(cwd, hasUI);
	await captured.sessionStart!({ type: "session_start" }, ctx);
	const call = (toolName: string, input: Record<string, unknown>): Promise<ToolCallResult> =>
		captured.toolCall!({ toolName, input }, ctx);
	return { call, seen, entries };
}

const bash = (command: string) => ({ toolName: "bash", input: { command } });

// loadRules() resolves .pi/damage-control-rules.yaml via process.cwd()
// (not ctx.cwd) — run every test in a fresh empty dir so a stray project
// rules file in the real checkout can never leak in. bun runs a file's
// tests serially, so the process-wide chdir cannot race within the suite.
let tmpCwd: string;
let prevCwd: string;

beforeEach(() => {
	tmpCwd = mkdtempSync(join(tmpdir(), "dc-test-"));
	prevCwd = process.cwd();
	process.chdir(tmpCwd);
});

afterEach(() => {
	process.chdir(prevCwd);
	rmSync(tmpCwd, { recursive: true, force: true });
});

describe("rule loading", () => {
	test("session_start with UI reports the loaded harness rules", async () => {
		const { seen } = await setup(process.cwd(), true);
		expect(seen.some((m) => /Damage-Control \(continue\): \d+ rules \(harness\)/.test(m))).toBe(true);
	});

	test("headless session_start stays silent but still loads rules", async () => {
		const { call, seen } = await setup(process.cwd(), false);
		expect(seen.length).toBe(0);
		const res = await call("bash", { command: "git push origin main" });
		expect(res?.block).toBe(true);
	});

	test("malformed project rules file falls back to harness defaults (fail closed)", async () => {
		mkdirSync(join(tmpCwd, ".pi"));
		writeFileSync(join(tmpCwd, ".pi", "damage-control-rules.yaml"), "- just\n- a\n- list\n");
		const { call, seen } = await setup(tmpCwd, true);
		expect(seen.some((m) => /invalid project damage-control-rules\.yaml/.test(m))).toBe(true);
		const res = await call("bash", { command: "git push" });
		expect(res?.block).toBe(true);
	});
});

describe("bash gating", () => {
	test("safe commands pass", async () => {
		const { call } = await setup();
		for (const command of ["ls -la", "git status", "echo hi", "ls 2>&1 | cat"]) {
			expect(await call("bash", { command })).toEqual({ block: false });
		}
	});

	test("default bashToolPatterns block git push/reset --hard/clean", async () => {
		const { call } = await setup();
		for (const [command, re] of [
			["git push origin main", /git push/],
			["git reset --hard HEAD~1", /git reset --hard/],
			["git clean -fd", /git clean/],
		] as const) {
			const res = await call("bash", { command });
			expect(res?.block).toBe(true);
			expect(res?.reason).toMatch(re);
		}
	});

	test("rm/mv with shell expansion operands is blocked", async () => {
		const { call } = await setup();
		for (const [command, re] of [
			["rm -rf src/*", /shell expansion/],
			["mv a b?", /shell expansion/],
			["rm -rf $DIR", /variable expansion/],
			["rm -rf `pwd`/junk", /variable expansion/],
		] as const) {
			const res = await call("bash", { command });
			expect(res?.block).toBe(true);
			expect(res?.reason).toMatch(re);
		}
	});

	test("rm -rf on a plain in-cwd path passes (gate is pattern-based)", async () => {
		const { call } = await setup();
		expect(await call("bash", { command: "rm -rf node_modules" })).toEqual({ block: false });
	});

	test("rm/mv of .git is blocked by noDeletePaths", async () => {
		const { call } = await setup();
		for (const command of ["rm -rf .git", "mv .git .git.bak"]) {
			const res = await call("bash", { command });
			expect(res?.block).toBe(true);
			expect(res?.reason).toMatch(/delete\/move protected path/);
		}
	});

	test("commands touching zero-access paths are blocked", async () => {
		const { call } = await setup();
		for (const command of ["cat .env", "cat .env.production", "cat ~/.pi/agent/auth.json"]) {
			const res = await call("bash", { command });
			expect(res?.block).toBe(true);
			expect(res?.reason).toMatch(/zero-access/);
		}
		expect(await call("bash", { command: "cat src/app.ts" })).toEqual({ block: false });
	});

	test("bash write targets outside cwd are blocked; inside passes", async () => {
		const { call } = await setup();
		const outside = await call("bash", { command: `echo hi > ${join(tmpdir(), "dc-evil.txt")}` });
		expect(outside?.block).toBe(true);
		expect(outside?.reason).toMatch(/outside cwd/);
		expect(await call("bash", { command: "echo hi > ./out.txt" })).toEqual({ block: false });
		expect(await call("bash", { command: "echo hi | tee ./log.txt" })).toEqual({ block: false });
	});

	test("unresolvable write target fails closed and logs an audit entry", async () => {
		const { call, entries } = await setup();
		const res = await call("bash", { command: "echo hi > $(mktemp)" });
		expect(res?.block).toBe(true);
		expect(res?.reason).toMatch(/not statically resolvable/);
		expect(entries).toContainEqual(expect.objectContaining({ action: "blocked" }));
	});

	test("bash event with no command fails closed (blocks, never silently allows)", async () => {
		const { call } = await setup();
		const res = await call("bash", {});
		expect(res?.block).toBe(true);
		expect(res?.reason).toMatch(/missing/);
		// whitespace-only previously passed silently — same fail-closed path
		const blank = await call("bash", { command: "   " });
		expect(blank?.block).toBe(true);
		expect(blank?.reason).toMatch(/missing/);
	});
});

describe("file tool gating", () => {
	test("write/edit outside cwd are blocked; inside pass", async () => {
		const { call } = await setup();
		const res = await call("write", { path: join(tmpdir(), "dc-evil.ts"), content: "x" });
		expect(res?.block).toBe(true);
		expect(res?.reason).toMatch(/outside cwd/);
		expect(await call("write", { path: "src/ok.ts", content: "x" })).toEqual({ block: false });
		expect(await call("edit", { path: "src/ok.ts" })).toEqual({ block: false });
	});

	test("zero-access paths block read/write/edit", async () => {
		const { call } = await setup();
		for (const [toolName, path] of [
			["read", ".env"],
			["edit", ".env.production"],
			["write", "docs/guide.env"], // *.env glob
			["read", "~/.pi/agent/auth.json"],
		] as const) {
			const res = await call(toolName, { path, content: "x" });
			expect(res?.block).toBe(true);
			expect(res?.reason).toMatch(/zero-access/);
		}
		expect(await call("read", { path: "README.md" })).toEqual({ block: false });
	});

	test("grep glob reaching a zero-access path is blocked", async () => {
		const { call } = await setup();
		const res = await call("grep", { path: ".", glob: "**/.env" });
		expect(res?.block).toBe(true);
		expect(res?.reason).toMatch(/zero-access/);
	});
});

describe("isPathMatch", () => {
	const cwd = "/repo";

	test("exact and basename matches", () => {
		expect(isPathMatch("/repo/.env", ".env", cwd)).toBe(true);
		expect(isPathMatch("/repo/sub/.env", ".env", cwd)).toBe(true);
	});

	test("prefix is not a match (.envrc is not .env)", () => {
		expect(isPathMatch("/repo/.envrc", ".env", cwd)).toBe(false);
		expect(isPathMatch("/repo/envfile", ".env", cwd)).toBe(false);
	});

	test("trailing-slash pattern matches the dir and its children, not siblings", () => {
		expect(isPathMatch("/repo/build", "build/", cwd)).toBe(true);
		expect(isPathMatch("/repo/build/x.o", "build/", cwd)).toBe(true);
		expect(isPathMatch("/repo/buildx", "build/", cwd)).toBe(false);
	});

	test("glob patterns match", () => {
		expect(isPathMatch("/repo/docs/guide.env", "*.env", cwd)).toBe(true);
		expect(isPathMatch("/repo/docs/guide.md", "*.env", cwd)).toBe(false);
	});

	test("tilde patterns resolve against the home directory", () => {
		const auth = join(homedir(), ".pi", "agent", "auth.json");
		expect(isPathMatch(auth, "~/.pi/agent/auth.json", cwd)).toBe(true);
		expect(isPathMatch("/repo/.pi/agent/auth.json", "~/.pi/agent/auth.json", cwd)).toBe(false);
	});
});

describe("bashWriteTargets", () => {
	test("redirects, tee, and of= produce targets", () => {
		expect(bashWriteTargets("echo hi > out.txt")).toEqual({ targets: ["out.txt"], unresolvable: false });
		expect(bashWriteTargets("echo hi >> out.txt")).toEqual({ targets: ["out.txt"], unresolvable: false });
		expect(bashWriteTargets("cmd | tee log.txt")).toEqual({ targets: ["log.txt"], unresolvable: false });
		expect(bashWriteTargets("dd if=x of=disk.img")).toEqual({ targets: ["disk.img"], unresolvable: false });
	});

	test("command substitution and backtick targets are unresolvable", () => {
		expect(bashWriteTargets("echo hi > $(mktemp)").unresolvable).toBe(true);
		expect(bashWriteTargets("echo hi > `f`").unresolvable).toBe(true);
		expect(bashWriteTargets("echo hi > $OUT/x").unresolvable).toBe(true);
	});

	test("empty and redirect-free input is safe", () => {
		expect(bashWriteTargets("")).toEqual({ targets: [], unresolvable: false });
		expect(bashWriteTargets("ls -la")).toEqual({ targets: [], unresolvable: false });
	});
});

describe("expansionOperandRisk", () => {
	test("globs and expansions in rm/mv operands are risky", () => {
		expect(expansionOperandRisk("rm -rf src/*")).toMatch(/shell expansion/);
		expect(expansionOperandRisk("mv a b?")).toMatch(/shell expansion/);
		expect(expansionOperandRisk("rm $DIR")).toMatch(/variable expansion/);
		expect(expansionOperandRisk("rm `f`")).toMatch(/variable expansion/);
	});

	test("quoted globs, plain operands, non-rm commands, and empty input are safe", () => {
		expect(expansionOperandRisk("rm 'quoted*'")).toBeNull();
		expect(expansionOperandRisk("rm plain-file")).toBeNull();
		expect(expansionOperandRisk("ls *")).toBeNull();
		expect(expansionOperandRisk("")).toBeNull();
	});
});
