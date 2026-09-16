/**
 * Tests for the team-member extension (issue #79).
 *
 * INV-herdr: members are launched by the bash launcher with PI_VIDA_WORKER
 * set to their name. The extension resolves that member persona through the
 * same collectAgents discovery as dispatch (first-wins) and applies
 * systemPrompt (before_agent_start) + setActiveTools (session_start). No
 * PI_VIDA_WORKER -> no-op in every hook.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import memberExt from "./team-member.ts";

/** cwd with one discovered agent (profiles/agents wins, no chain file needed). */
function agentCwd(): string {
	const cwd = mkdtempSync(join(tmpdir(), "member-cwd-"));
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "agents", "builder.yaml"),
		"name: builder\ndescription: test builder\ntools: read, edit\nbody: |\n  You are the test builder.\n",
	);
	return cwd;
}

function loadMember() {
	const tools: string[][] = [];
	const events: Record<string, Function> = {};
	const seen: { msg: string; level?: string }[] = [];
	const pi = {
		on(ev: string, h: Function) {
			events[ev] = h;
		},
		setActiveTools(names: string[]) {
			tools.push(names);
		},
		registerCommand() {},
		registerTool() {},
	};
	memberExt(pi as never);
	return { events, tools, setActiveToolsCalls: tools };
}

/** Point MY_PI_AGENT_HOME and HOME at the fixture so the repo's
 * profiles/agents personas (the real builder.yaml) and the machine's
 * ~/.claude/.gemini/.codex personas do not leak into discovery. */
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

function prevRestore(key: string): () => void {
	const prev = process.env[key];
	return () => {
		if (prev === undefined) delete process.env[key];
		else process.env[key] = prev;
	};
}

describe("team-member extension (#79)", () => {
	test("no PI_VIDA_WORKER: hooks are no-ops", async () => {
		const restore = prevRestore("PI_VIDA_WORKER");
		delete process.env.PI_VIDA_WORKER;
		const cwd = agentCwd();
		try {
			const { events, setActiveToolsCalls } = loadMember();
			const sys = await events.before_agent_start(
				{
					type: "before_agent_start",
					prompt: "hi",
					systemPrompt: "BASE",
					systemPromptOptions: {},
				},
				{ cwd, hasUI: true },
			);
			expect(sys).toBeUndefined();
			await events.session_start({ type: "session_start", reason: "startup" }, {
				cwd,
				hasUI: true,
				ui: { notify: () => {} },
			});
			expect(setActiveToolsCalls).toEqual([]);
		} finally {
			restore();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("known member: systemPrompt gains the agent body, tools applied once", async () => {
		const restore = prevRestore("PI_VIDA_WORKER");
		process.env.PI_VIDA_WORKER = "builder";
		const cwd = agentCwd();
		const restoreHarness = isolateHarness(cwd);
		try {
			const { events, setActiveToolsCalls } = loadMember();
			const sys = await events.before_agent_start(
				{
					type: "before_agent_start",
					prompt: "hi",
					systemPrompt: "BASE",
					systemPromptOptions: {},
				},
				{ cwd, hasUI: true },
			);
			expect(sys).toEqual({ systemPrompt: "BASE\n\nYou are the test builder." });
			const seen: { msg: string; level?: string }[] = [];
			await events.session_start({ type: "session_start", reason: "startup" }, {
				cwd,
				hasUI: true,
				ui: { notify: (msg: string, level?: string) => seen.push({ msg, level }) },
			});
			expect(setActiveToolsCalls).toEqual([["read", "edit"]]);
			expect(seen.length).toBe(1);
			expect(seen[0].level).toBe("info");
			expect(seen[0].msg).toContain("builder");
		} finally {
			restoreHarness();
			restore();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("unknown member: session_start notifies error and fails startup", async () => {
		const restore = prevRestore("PI_VIDA_WORKER");
		process.env.PI_VIDA_WORKER = "nobody";
		const cwd = agentCwd();
		const restoreHarness = isolateHarness(cwd);
		try {
			const { events, setActiveToolsCalls } = loadMember();
			const seen: { msg: string; level?: string }[] = [];
			// Persona resolution is part of the member startup contract: a
			// missing persona must fail the member session, not degrade to an
			// unrestricted solo agent the primary still counts as a member.
			await expect(
				events.session_start({ type: "session_start", reason: "startup" }, {
					cwd,
					hasUI: true,
					ui: { notify: (msg: string, level?: string) => seen.push({ msg, level }) },
				}),
			).rejects.toThrow(/nobody/);
			expect(seen.length).toBe(1);
			expect(seen[0].level).toBe("error");
			expect(setActiveToolsCalls).toEqual([]);
		} finally {
			restoreHarness();
			restore();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("member with no tools: systemPrompt applied, setActiveTools not called", async () => {
		const restore = prevRestore("PI_VIDA_WORKER");
		process.env.PI_VIDA_WORKER = "builder";
		const cwd = mkdtempSync(join(tmpdir(), "member-cwd-"));
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "builder.yaml"),
			"name: builder\ndescription: test builder\nbody: |\n  Only body.\n",
		);
		const restoreHarness = isolateHarness(cwd);
		try {
			const { events, setActiveToolsCalls } = loadMember();
			const sys = await events.before_agent_start(
				{
					type: "before_agent_start",
					prompt: "hi",
					systemPrompt: "BASE",
					systemPromptOptions: {},
				},
				{ cwd, hasUI: true },
			);
			expect(sys).toEqual({ systemPrompt: "BASE\n\nOnly body." });
			await events.session_start({ type: "session_start", reason: "startup" }, {
				cwd,
				hasUI: true,
				ui: { notify: () => {} },
			});
			expect(setActiveToolsCalls).toEqual([]);
		} finally {
			restoreHarness();
			restore();
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
