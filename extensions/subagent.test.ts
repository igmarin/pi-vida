import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
	buildChildArgv,
	childTimeoutMs,
	DEFAULT_CHILD_TIMEOUT_MS,
	dispatchOpts,
	formatTokens,
	formatUsageStats,
	getFinalOutput,
	isFailedResult,
	killChildTree,
	mapWithConcurrencyLimit,
	MAX_PARALLEL_OUTPUT_BYTES,
	parseSubagentLine,
	PER_TASK_OUTPUT_CAP,
	resultOutput,
	runSingleAgent,
	truncateAggregate,
	truncateParallelOutput,
	type RunOpts,
	type SingleResult,
} from "./subagentHelpers.ts";

describe("killChildTree", () => {
	const fakeProc = (pid: number | undefined, calls: string[]) => ({
		pid,
		kill: (sig: NodeJS.Signals) => {
			calls.push(`child:${sig}`);
			return true;
		},
	});

	test("unix kills the process group", () => {
		const calls: string[] = [];
		const origKill = process.kill;
		const origPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		process.kill = ((pid: number, sig: NodeJS.Signals) => {
			calls.push(`group:${pid}:${sig}`);
			return true;
		}) as typeof process.kill;
		try {
			killChildTree(fakeProc(42, calls), "SIGTERM");
			expect(calls).toEqual(["group:-42:SIGTERM"]);
		} finally {
			process.kill = origKill;
			Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
		}
	});

	test("group kill failure falls back to the child", () => {
		const calls: string[] = [];
		const origKill = process.kill;
		const origPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		process.kill = (() => {
			throw new Error("ESRCH");
		}) as typeof process.kill;
		try {
			killChildTree(fakeProc(42, calls), "SIGTERM");
			expect(calls).toEqual(["child:SIGTERM"]);
		} finally {
			process.kill = origKill;
			Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
		}
	});

	test("win32 kills the child directly", () => {
		const calls: string[] = [];
		const origPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		try {
			killChildTree(fakeProc(42, calls), "SIGKILL");
			expect(calls).toEqual(["child:SIGKILL"]);
		} finally {
			Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
		}
	});
});

function emptyResult(): SingleResult {
	return {
		agent: "x",
		agentSource: "test",
		task: "t",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
	};
}

describe("formatTokens", () => {
	test("0 returns '0'", () => {
		expect(formatTokens(0)).toBe("0");
	});
	test("999 returns '999'", () => {
		expect(formatTokens(999)).toBe("999");
	});
	test("1000 returns '1.0k'", () => {
		expect(formatTokens(1000)).toBe("1.0k");
	});
	test("9999 returns '10.0k' (just under the round-to-whole-k boundary)", () => {
		expect(formatTokens(9999)).toBe("10.0k");
	});
	test("10000 returns '10k'", () => {
		expect(formatTokens(10000)).toBe("10k");
	});
	test("1500000 returns '1.5M'", () => {
		expect(formatTokens(1500000)).toBe("1.5M");
	});
});

describe("formatUsageStats", () => {
	test("empty input returns ''", () => {
		expect(formatUsageStats({})).toBe("");
	});
	test("{turns: 1} returns '1 turn' (singular)", () => {
		expect(formatUsageStats({ turns: 1 })).toBe("1 turn");
	});
	test("{turns: 2} returns '2 turns' (plural)", () => {
		expect(formatUsageStats({ turns: 2 })).toBe("2 turns");
	});
	test("{turns: 2, input: 1500} contains '2 turns' and '↑1.5k'", () => {
		const u = formatUsageStats({ turns: 2, input: 1500 });
		expect(u).toContain("2 turns");
		expect(u).toContain("\u21911.5k");
	});
	test("all zeros returns '' (zeros are not emitted)", () => {
		expect(
			formatUsageStats({ input: 0, output: 0, turns: 0, cost: 0, contextTokens: 0 }),
		).toBe("");
	});
	test("{cost: 0.001234} formats as '$0.0012' (4-decimal precision)", () => {
		expect(formatUsageStats({ cost: 0.001234 })).toContain("$0.0012");
	});
	test("{contextTokens: 0} does not emit 'ctx:' (zero check)", () => {
		expect(formatUsageStats({ contextTokens: 0 })).not.toContain("ctx:");
	});
	test("appends the model name at the end", () => {
		const u = formatUsageStats({ turns: 1, input: 100 }, "gpt-5");
		expect(u.endsWith("gpt-5")).toBe(true);
	});
});

describe("isFailedResult", () => {
	test("{exitCode: 0, stopReason: 'end'} is not failed", () => {
		expect(isFailedResult({ exitCode: 0, stopReason: "end" })).toBe(false);
	});
	test("{exitCode: 1} is failed (non-zero exit)", () => {
		expect(isFailedResult({ exitCode: 1 })).toBe(true);
	});
	test("{exitCode: 0, stopReason: 'error'} is failed", () => {
		expect(isFailedResult({ exitCode: 0, stopReason: "error" })).toBe(true);
	});
	test("{exitCode: 0, stopReason: 'aborted'} is failed", () => {
		expect(isFailedResult({ exitCode: 0, stopReason: "aborted" })).toBe(true);
	});
	test("{exitCode: 0, stopReason: 'timeout'} is failed", () => {
		expect(isFailedResult({ exitCode: 0, stopReason: "timeout" })).toBe(true);
	});
	test("{exitCode: 0, stopReason: 'end'} is not failed (control)", () => {
		expect(isFailedResult({ exitCode: 0, stopReason: "end" })).toBe(false);
	});
});

describe("getFinalOutput", () => {
	test("empty messages returns ''", () => {
		expect(getFinalOutput([])).toBe("");
	});
	test("user-only messages return '' (no assistant message)", () => {
		expect(getFinalOutput([{ role: "user", content: [{ type: "text", text: "hi" }] }])).toBe("");
	});
	test("last assistant text wins", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "first" }] },
			{ role: "assistant", content: [{ type: "text", text: "last" }] },
		];
		expect(getFinalOutput(messages)).toBe("last");
	});
	test("assistant message with only a toolCall part returns '' (non-text parts skipped)", () => {
		const messages = [{ role: "assistant", content: [{ type: "toolCall" }] }];
		expect(getFinalOutput(messages)).toBe("");
	});
	test("mixed parts: text wins over toolCall", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall" }, { type: "text", text: "found" }] },
		];
		expect(getFinalOutput(messages)).toBe("found");
	});
});

describe("truncateParallelOutput", () => {
	test("short string is returned unchanged", () => {
		const s = "hello world";
		expect(truncateParallelOutput(s)).toBe(s);
	});
	test("string at exactly 50KB byte length is returned unchanged (<= boundary)", () => {
		const s = "a".repeat(PER_TASK_OUTPUT_CAP);
		expect(Buffer.byteLength(s, "utf8")).toBe(PER_TASK_OUTPUT_CAP);
		expect(truncateParallelOutput(s)).toBe(s);
	});
	test("string just over 50KB is truncated and annotated, total ≤ cap", () => {
		const s = "a".repeat(PER_TASK_OUTPUT_CAP + 100);
		const out = truncateParallelOutput(s);
		// rs-guard 1.8.3 review: the annotation must count toward the cap.
		// Final return must never exceed PER_TASK_OUTPUT_CAP bytes.
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(PER_TASK_OUTPUT_CAP);
		expect(out).toMatch(/\[Output truncated: \d+ bytes omitted\.\]$/);
		const dropped = Number(out.match(/truncated: (\d+) bytes/)![1]);
		expect(dropped).toBeGreaterThan(0);
	});
	test("multi-byte UTF-8: does not split a codepoint, output is re-encodable", () => {
		// 4-byte emoji repeated to exceed the cap
		const emoji = "\u{1F600}"; // grinning face
		const count = Math.ceil(PER_TASK_OUTPUT_CAP / 4) + 10;
		const s = emoji.repeat(count);
		const out = truncateParallelOutput(s);
		// Must re-encode as valid UTF-8 without throwing
		// The truncated prefix must end on a complete codepoint (i.e. encode cleanly)
		const head = out.split("\n\n[Output truncated")[0];
		const bytes = Buffer.byteLength(head, "utf8");
		expect(bytes).toBeLessThanOrEqual(PER_TASK_OUTPUT_CAP);
		// Re-encoding the head should round-trip exactly
		expect(Buffer.from(head, "utf8").toString("utf8")).toBe(head);
	});
});

describe("buildChildArgv", () => {
	const root = "/harness";

	test("first two args are ['-e', '<root>/extensions/damage-control-continue.ts']", () => {
		const argv = buildChildArgv(root, { task: "x" });
		expect(argv[0]).toBe("-e");
		expect(argv[1]).toBe(`${root}/extensions/damage-control-continue.ts`);
	});
	test("task becomes the trailing 'Task: <task>' arg", () => {
		const argv = buildChildArgv(root, { task: "hello" });
		expect(argv[argv.length - 1]).toBe("Task: hello");
	});
	test("dispatchModel adds '--model <value>'", () => {
		const argv = buildChildArgv(root, { task: "x", dispatchModel: "gpt-5" });
		const i = argv.indexOf("--model");
		expect(i).toBeGreaterThan(-1);
		expect(argv[i + 1]).toBe("gpt-5");
	});
	test("dispatchThinkingLevel adds '--thinking <value>'", () => {
		const argv = buildChildArgv(root, { task: "x", dispatchThinkingLevel: "high" });
		const i = argv.indexOf("--thinking");
		expect(i).toBeGreaterThan(-1);
		expect(argv[i + 1]).toBe("high");
	});
	test("agentTools adds '--tools <comma-joined>'", () => {
		const argv = buildChildArgv(root, { task: "x", agentTools: ["read", "bash"] });
		const i = argv.indexOf("--tools");
		expect(i).toBeGreaterThan(-1);
		expect(argv[i + 1]).toBe("read,bash");
	});
	test("empty agentSystemPrompt does not add --append-system-prompt", () => {
		const argv = buildChildArgv(root, { task: "x", agentSystemPrompt: "" });
		expect(argv.includes("--append-system-prompt")).toBe(false);
	});
	test("non-empty agentSystemPrompt adds '--append-system-prompt <prompt-file>' placeholder", () => {
		const argv = buildChildArgv(root, {
			task: "x",
			agentSystemPrompt: "you are a reviewer",
		});
		const i = argv.indexOf("--append-system-prompt");
		expect(i).toBeGreaterThan(-1);
		expect(argv[i + 1]).toBe("<prompt-file>");
	});
	test("INV-skills: -e damage-control-continue.ts is the very first flag pair", () => {
		const argv = buildChildArgv(root, {
			task: "x",
			dispatchModel: "gpt-5",
			agentTools: ["bash"],
			agentSystemPrompt: "p",
		});
		expect(argv[0]).toBe("-e");
		expect(argv[1]).toBe(`${root}/extensions/damage-control-continue.ts`);
	});
	test("--mode json, -p, --no-session are always present", () => {
		const argv = buildChildArgv(root, { task: "x" });
		expect(argv).toContain("--mode");
		expect(argv[argv.indexOf("--mode") + 1]).toBe("json");
		expect(argv).toContain("-p");
		expect(argv).toContain("--no-session");
	});
	test("INV-skills: --no-skills is the second flag (after the -e pair)", () => {
		// rs-guard 1.8.3 + AGENTS.md: the child argv MUST start with
		// ["-e", "<root>/extensions/damage-control-continue.ts", "--no-skills"]
		// so only allowlisted --skill paths are loaded.
		const argv = buildChildArgv(root, { task: "x" });
		expect(argv[0]).toBe("-e");
		expect(argv[1]).toBe(`${root}/extensions/damage-control-continue.ts`);
		expect(argv[2]).toBe("--no-skills");
	});
});

describe("mapWithConcurrencyLimit", () => {
	test("empty input returns empty output", async () => {
		const out = await mapWithConcurrencyLimit([], 4, async (x) => x);
		expect(out).toEqual([]);
	});
	test("single item returns single result", async () => {
		const out = await mapWithConcurrencyLimit(["a"], 4, async (x) => x);
		expect(out).toEqual(["a"]);
	});
	test("10 items, concurrency 4: all results, in input order", async () => {
		const items = Array.from({ length: 10 }, (_, i) => i);
		const out = await mapWithConcurrencyLimit(items, 4, async (x) => {
			await new Promise((r) => setTimeout(r, 1));
			return x * 2;
		});
		expect(out).toEqual(items.map((x) => x * 2));
	});
	test("3 items, concurrency 10: all results, in input order", async () => {
		const items = ["a", "b", "c"];
		const out = await mapWithConcurrencyLimit(items, 10, async (x) => x);
		expect(out).toEqual(["a", "b", "c"]);
	});
	test("concurrency cap is respected: peak in-flight never exceeds the limit", async () => {
		let inFlight = 0;
		let peak = 0;
		const items = Array.from({ length: 12 }, (_, i) => i);
		const out = await mapWithConcurrencyLimit(items, 3, async (x) => {
			inFlight++;
			if (inFlight > peak) peak = inFlight;
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return x;
		});
		expect(out).toHaveLength(12);
		expect(peak).toBeLessThanOrEqual(3);
		expect(peak).toBeGreaterThan(1); // sanity: concurrency actually happened
	});
});

describe("parseSubagentLine", () => {
	test("empty line returns false (no throw)", () => {
		const r = emptyResult();
		expect(parseSubagentLine("", r)).toBe(false);
		expect(r.messages).toHaveLength(0);
	});
	test("non-JSON line returns false (no throw)", () => {
		const r = emptyResult();
		expect(parseSubagentLine("not json", r)).toBe(false);
		expect(r.messages).toHaveLength(0);
	});
	test("event with non-message_end type returns false", () => {
		const r = emptyResult();
		expect(parseSubagentLine('{"type":"other"}', r)).toBe(false);
		expect(r.messages).toHaveLength(0);
	});
	test("assistant message_end pushes a message and increments turns", () => {
		const r = emptyResult();
		const line = JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
			},
		});
		expect(parseSubagentLine(line, r)).toBe(true);
		expect(r.messages).toHaveLength(1);
		expect(r.usage.turns).toBe(1);
	});
	test("cost as number: result.usage.cost increases by that amount", () => {
		const r = emptyResult();
		const line = JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "x" }],
				usage: { cost: 0.005 },
			},
		});
		parseSubagentLine(line, r);
		expect(r.usage.cost).toBeCloseTo(0.005, 6);
	});
	test("cost as object { total: N }: result.usage.cost increases by N", () => {
		const r = emptyResult();
		const line = JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "x" }],
				usage: { cost: { total: 0.007 } },
			},
		});
		parseSubagentLine(line, r);
		expect(r.usage.cost).toBeCloseTo(0.007, 6);
	});
	test("totalTokens: result.usage.contextTokens is set", () => {
		const r = emptyResult();
		const line = JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "x" }],
				usage: { totalTokens: 1234 },
			},
		});
		parseSubagentLine(line, r);
		expect(r.usage.contextTokens).toBe(1234);
	});
});

describe("resultOutput", () => {
	test("failed result: prefers errorMessage, then stderr, then final output", () => {
		const r = emptyResult();
		r.exitCode = 1;
		r.errorMessage = "boom";
		r.stderr = "should not see this";
		r.messages = [{ role: "assistant", content: [{ type: "text", text: "fallback" }] }];
		expect(resultOutput(r)).toBe("boom");
	});
	test("failed result with no errorMessage: uses stderr", () => {
		const r = emptyResult();
		r.exitCode = 1;
		r.stderr = "stderr text";
		expect(resultOutput(r)).toBe("stderr text");
	});
	test("failed result with no errorMessage/stderr: uses final output", () => {
		const r = emptyResult();
		r.exitCode = 1;
		r.messages = [{ role: "assistant", content: [{ type: "text", text: "from-messages" }] }];
		expect(resultOutput(r)).toBe("from-messages");
	});
	test("failed result with nothing: returns '(no output)'", () => {
		const r = emptyResult();
		r.exitCode = 1;
		expect(resultOutput(r)).toBe("(no output)");
	});
	test("successful result: returns final assistant text", () => {
		const r = emptyResult();
		r.exitCode = 0;
		r.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }] }];
		expect(resultOutput(r)).toBe("done");
	});
	test("successful result with no messages: returns '(no output)'", () => {
		const r = emptyResult();
		expect(resultOutput(r)).toBe("(no output)");
	});
});

describe("SingleResult classification: signal-killed vs spawn-error", () => {
	// These describe the contract that the close/error handlers in
	// runSingleAgent honor, without spawning a real process.
	test("isFailedResult flags code === null (signal-killed) as failed", () => {
		expect(isFailedResult({ exitCode: null as unknown as number, stopReason: "aborted" })).toBe(true);
	});
	test("isFailedResult flags stopReason === 'aborted' regardless of exit code", () => {
		expect(isFailedResult({ exitCode: 0, stopReason: "aborted" })).toBe(true);
	});
	test("isFailedResult does NOT flag a clean exit (code 0, no stopReason)", () => {
		expect(isFailedResult({ exitCode: 0 })).toBe(false);
	});
	test("resultOutput surfaces errorMessage on aborted results", () => {
		const r = emptyResult();
		r.exitCode = 1;
		r.stopReason = "aborted";
		r.errorMessage = "aborted by caller signal";
		expect(resultOutput(r)).toBe("aborted by caller signal");
	});
});

describe("truncateAggregate", () => {
	test("empty input returns empty string", () => {
		expect(truncateAggregate([])).toBe("");
	});
	test("single summary under cap is returned unchanged", () => {
		const s = "### [a] completed\n\nshort body";
		expect(truncateAggregate([s])).toBe(s);
	});
	test("3 summaries well under cap are all joined", () => {
		const s1 = "### [a] completed\n\nbody 1";
		const s2 = "### [b] completed\n\nbody 2";
		const s3 = "### [c] completed\n\nbody 3";
		const out = truncateAggregate([s1, s2, s3]);
		expect(out).toContain("body 1");
		expect(out).toContain("body 2");
		expect(out).toContain("body 3");
		expect(out).not.toContain("omitted");
	});
	test("summaries exceeding cap: some dropped, note added", () => {
		// Each summary is 1 KiB; cap defaults to 200 KiB; 250 summaries → ~250 KiB
		const summaries = Array.from({ length: 250 }, (_, i) => `### [t${i}] done\n\n${"x".repeat(1000)}`);
		const out = truncateAggregate(summaries);
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_PARALLEL_OUTPUT_BYTES + 100);
		expect(out).toMatch(/\d+ more task\(s\) omitted to fit \d+-byte output cap\./);
		// First summary always included
		expect(out).toContain("### [t0]");
		// Last summary likely dropped
		expect(out).not.toContain("### [t249]");
	});
	test("custom cap: small cap drops most summaries", () => {
		const summaries = Array.from({ length: 10 }, (_, i) => `summary ${i}: ${"x".repeat(200)}`);
		const out = truncateAggregate(summaries, 500);
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(500);
		expect(out).toMatch(/omitted/);
	});
});

describe("buildChildArgv — coverage of chain-mode args", () => {
	// Chain mode uses the same argv builder; the {previous} substitution
	// happens in the glue (subagent.ts) before calling buildChildArgv.
	// Here we verify that the {previous} token (if it ever leaked into a task)
	// is passed through verbatim — no special handling in the builder.
	const root = "/tmp/pi-vida-test";
	test("{previous} placeholder in task is passed verbatim to the child", () => {
		const argv = buildChildArgv(root, { task: "summarize: {previous}" });
		expect(argv[argv.length - 1]).toBe("Task: summarize: {previous}");
	});
});

describe("childTimeoutMs", () => {
	test("default is 15 minutes", () => {
		expect(childTimeoutMs({})).toBe(DEFAULT_CHILD_TIMEOUT_MS);
		expect(DEFAULT_CHILD_TIMEOUT_MS).toBe(15 * 60 * 1000);
	});
	test("PI_CHILD_TIMEOUT_MS overrides when a positive number", () => {
		expect(childTimeoutMs({ PI_CHILD_TIMEOUT_MS: "400" })).toBe(400);
	});
	test("invalid or non-positive values fall back to the default", () => {
		expect(childTimeoutMs({ PI_CHILD_TIMEOUT_MS: "0" })).toBe(DEFAULT_CHILD_TIMEOUT_MS);
		expect(childTimeoutMs({ PI_CHILD_TIMEOUT_MS: "-1" })).toBe(DEFAULT_CHILD_TIMEOUT_MS);
		expect(childTimeoutMs({ PI_CHILD_TIMEOUT_MS: "nope" })).toBe(DEFAULT_CHILD_TIMEOUT_MS);
	});
});

describe("dispatchOpts — per-role child dispatch", () => {
	const base: RunOpts = {
		agents: [],
		agentName: "planner",
		task: "t",
		defaultCwd: "/c",
		harnessRoot: "/h",
		dispatchModel: "primary/current",
		dispatchThinkingLevel: "medium",
	};

	// PI_OVERLAY is process-wide; save/restore around each case.
	let saved: string | undefined;
	function withEnv(value: string | undefined, fn: () => void): void {
		saved = process.env.PI_OVERLAY;
		if (value === undefined) delete process.env.PI_OVERLAY;
		else process.env.PI_OVERLAY = value;
		try {
			fn();
		} finally {
			if (saved === undefined) delete process.env.PI_OVERLAY;
			else process.env.PI_OVERLAY = saved;
		}
	}

	const overlay = JSON.stringify({
		capabilities: {},
		models: { planner: "xhigh/planner-model", reviewer: "low/reviewer-model" },
		thinking: { planner: "max" },
	});

	test("no PI_OVERLAY: falls back to the caller's dispatch opts", () => {
		withEnv(undefined, () => {
			expect(dispatchOpts(base)).toEqual({
				dispatchModel: "primary/current",
				dispatchThinkingLevel: "medium",
			});
		});
	});

	test("agent with a role entry: overlay model/thinking override the fallback", () => {
		withEnv(overlay, () => {
			expect(dispatchOpts(base)).toEqual({
				dispatchModel: "xhigh/planner-model",
				dispatchThinkingLevel: "max",
			});
		});
	});

	test("agent without a role entry falls back (per-step resolution is keyed on the child's name)", () => {
		withEnv(overlay, () => {
			const builder = dispatchOpts({ ...base, agentName: "builder" });
			expect(builder.dispatchModel).toBe("primary/current");
			expect(builder.dispatchThinkingLevel).toBe("medium");
		});
	});

	test("model and thinking resolve independently (entry with model only)", () => {
		withEnv(overlay, () => {
			const reviewer = dispatchOpts({ ...base, agentName: "reviewer" });
			expect(reviewer.dispatchModel).toBe("low/reviewer-model");
			expect(reviewer.dispatchThinkingLevel).toBe("medium");
		});
	});

	test("thinking-only entry overrides thinking while model falls back", () => {
		withEnv(
			JSON.stringify({
				capabilities: {},
				thinking: { planner: "off" },
			}),
			() => {
				const r = dispatchOpts(base);
				expect(r.dispatchModel).toBe("primary/current");
				expect(r.dispatchThinkingLevel).toBe("off");
			},
		);
	});

	test("malformed PI_OVERLAY falls back (defensive; capabilities.ts surfaces parse errors)", () => {
		withEnv("{not json", () => {
			expect(dispatchOpts(base)).toEqual({
				dispatchModel: "primary/current",
				dispatchThinkingLevel: "medium",
			});
		});
	});
});

// Spawn/kill tests use a PATH wrapper named `pi` (not a spawn mock) so
// process-group kill is real. Unix process-group case is skipped on win32;
// CI is Linux-only (ubuntu-latest).
const KILL_GRACE_MS = 5_000;

type FakePiMode = "ok" | "fail" | "sleep" | "ignore-term" | "fork";

function writeFakePi(
	dir: string,
	mode: FakePiMode,
): { pidFile: string; descFile: string } {
	const pidFile = join(dir, "pid");
	const descFile = join(dir, "desc");
	const script = `#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
const pidFile = ${JSON.stringify(pidFile)};
const descFile = ${JSON.stringify(descFile)};
try { writeFileSync(pidFile, String(process.pid)); } catch {}
if (mode === "ok") {
	console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello from child" }] } }));
	process.exit(0);
}
if (mode === "fail") {
	console.error("child failed");
	process.exit(1);
}
if (mode === "ignore-term") {
	process.on("SIGTERM", () => {});
	await Bun.sleep(1e12);
}
if (mode === "fork") {
	const child = spawn(process.execPath, ["-e", "process.on('SIGHUP', () => {}); setTimeout(() => {}, 1e12);"], { detached: false, stdio: "ignore" });
	if (child.pid) try { writeFileSync(descFile, String(child.pid)); } catch {}
	await Bun.sleep(1e12);
}
await Bun.sleep(1e12);
`;
	writeFileSync(join(dir, "pi"), script, { mode: 0o755 });
	return { pidFile, descFile };
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
	fn: (files: { dir: string; pidFile: string; descFile: string }) => Promise<T>,
): Promise<T> {
	const run = async () => {
		const dir = mkdtempSync(join(tmpdir(), "fake-pi-"));
		const files = writeFakePi(dir, mode);
		const prevPath = process.env.PATH;
		const prevTimeout = process.env.PI_CHILD_TIMEOUT_MS;
		process.env.PATH = `${dir}${delimiter}${prevPath ?? ""}`;
		try {
			return await fn({ dir, ...files });
		} finally {
			reap(pidFrom(files.pidFile));
			reap(pidFrom(files.descFile));
			if (prevPath === undefined) delete process.env.PATH;
			else process.env.PATH = prevPath;
			if (prevTimeout === undefined) delete process.env.PI_CHILD_TIMEOUT_MS;
			else process.env.PI_CHILD_TIMEOUT_MS = prevTimeout;
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

const dummyAgent = {
	name: "builder",
	description: "",
	tools: [] as string[],
	body: "",
	source: "test",
	path: "test/builder.yaml",
};

function spawnOpts(over: Partial<RunOpts> = {}): RunOpts {
	return {
		agents: [dummyAgent],
		agentName: "builder",
		task: "t",
		defaultCwd: process.cwd(),
		harnessRoot: "/tmp/harness",
		...over,
	};
}

describe("runSingleAgent spawn/kill", () => {
	test("timeout kills a sleeping fake pi and returns a failed timeout result", async () => {
		await withPathPi("sleep", async () => {
			process.env.PI_CHILD_TIMEOUT_MS = "400";
			const started = Date.now();
			const r = await runSingleAgent(spawnOpts());
			expect(Date.now() - started).toBeLessThan(8_000);
			expect(isFailedResult(r)).toBe(true);
			expect(r.stopReason).toBe("timeout");
		});
	}, 10_000);

	test("SIGTERM-ignore child is reaped by SIGKILL (fails if SIGKILL is gated on proc.killed)", async () => {
		await withPathPi("ignore-term", async ({ pidFile }) => {
			process.env.PI_CHILD_TIMEOUT_MS = "60000";
			const ctl = new AbortController();
			const pending = runSingleAgent(spawnOpts({ signal: ctl.signal }));
			const pid = await waitFile(pidFile);
			ctl.abort();
			const started = Date.now();
			const r = await pending;
			expect(Date.now() - started).toBeLessThan(KILL_GRACE_MS + 3_000);
			expect(isFailedResult(r)).toBe(true);
			expect(r.stopReason).toBe("aborted");
			expect(alive(pid)).toBe(false);
		});
	}, KILL_GRACE_MS + 5_000);

	test.skipIf(process.platform === "win32")(
		"process group: forked descendant is reaped (Unix-only; CI is Linux)",
		async () => {
			await withPathPi("fork", async ({ descFile }) => {
				process.env.PI_CHILD_TIMEOUT_MS = "60000";
				const ctl = new AbortController();
				const pending = runSingleAgent(spawnOpts({ signal: ctl.signal }));
				const desc = await waitFile(descFile);
				ctl.abort();
				const r = await pending;
				expect(isFailedResult(r)).toBe(true);
				await Bun.sleep(150);
				expect(alive(desc)).toBe(false);
			});
		},
		10_000,
	);

	test("AbortSignal takes the kill path", async () => {
		await withPathPi("sleep", async ({ pidFile }) => {
			process.env.PI_CHILD_TIMEOUT_MS = "60000";
			const ctl = new AbortController();
			const pending = runSingleAgent(spawnOpts({ signal: ctl.signal }));
			const pid = await waitFile(pidFile);
			ctl.abort();
			const r = await pending;
			expect(isFailedResult(r)).toBe(true);
			expect(r.stopReason).toBe("aborted");
			expect(alive(pid)).toBe(false);
		});
	}, 10_000);
});
