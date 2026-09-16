/**
 * Subagent helpers — types, pure functions, and the child `pi` process plumbing
 * for the subagent tool. Kept separate from `subagent.ts` so the tool's
 * behavior can be exercised by `bun test` without booting the `pi` host.
 *
 * Children ALWAYS inherit `-e <harness>/extensions/damage-control-continue.ts`
 * (INV-skills). The argv builder enforces this — no caller can spawn a child
 * without it.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { overlayFromEnv } from "./capabilities.ts";
import type { AgentDef } from "./agentScan.ts";

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const PER_TASK_OUTPUT_CAP = 50 * 1024;
export const KILL_GRACE_MS = 5_000;
export const DEFAULT_CHILD_TIMEOUT_MS = 15 * 60 * 1000;

/** Wall-clock timeout for a child `pi`. Override with `PI_CHILD_TIMEOUT_MS`. */
export function childTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PI_CHILD_TIMEOUT_MS;
	if (raw == null || raw === "") return DEFAULT_CHILD_TIMEOUT_MS;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHILD_TIMEOUT_MS;
	return n;
}
// Aggregate cap on the synthesized parallel-mode tool output. At MAX_PARALLEL_TASKS
// tasks each truncated to PER_TASK_OUTPUT_CAP, the joined summary would be ~400 KiB
// — too large to paste as a context message. 200 KiB keeps the full picture when
// most tasks are small, and still fits when most are at the per-task cap.
export const MAX_PARALLEL_OUTPUT_BYTES = 200 * 1024;

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export const EMPTY_USAGE: UsageStats = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
};

// Shape we read from the child's JSON-mode stdout. Kept loose; we only touch a
// few fields.
export interface SubagentMessage {
	role: string;
	content: Array<{ type: string; text?: string; name?: string; arguments?: Record<string, unknown> }>;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number } | number;
		totalTokens?: number;
	};
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface SingleResult {
	agent: string;
	agentSource: string;
	task: string;
	exitCode: number;
	messages: SubagentMessage[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	results: SingleResult[];
}

export function formatTokens(n: number): string {
	if (n < 1000) return n.toString();
	// 1000–9999 → one decimal ("1.0k"–"9.9k"). 10000+ rounds to whole ("10k", "999k")
	// so the output stays in the 4-5 char range and aligns visually in tooltips.
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export interface UsageStatsInput {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
	contextTokens?: number;
	turns?: number;
}

export function formatUsageStats(u: UsageStatsInput, model?: string): string {
	const parts: string[] = [];
	const t = u.turns ?? 0,
		i = u.input ?? 0,
		o = u.output ?? 0,
		r = u.cacheRead ?? 0,
		w = u.cacheWrite ?? 0;
	if (t) parts.push(`${t} turn${t > 1 ? "s" : ""}`);
	if (i) parts.push(`\u2191${formatTokens(i)}`);
	if (o) parts.push(`\u2193${formatTokens(o)}`);
	if (r) parts.push(`R${formatTokens(r)}`);
	if (w) parts.push(`W${formatTokens(w)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (u.contextTokens && u.contextTokens > 0) parts.push(`ctx:${formatTokens(u.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function getFinalOutput(messages: SubagentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role !== "assistant") continue;
		for (const part of messages[i].content) {
			if (part.type === "text" && typeof part.text === "string") return part.text;
		}
	}
	return "";
}

export function isFailedResult(r: Pick<SingleResult, "exitCode" | "stopReason">): boolean {
	return (
		r.exitCode !== 0 ||
		r.stopReason === "error" ||
		r.stopReason === "aborted" ||
		r.stopReason === "timeout"
	);
}

export function resultOutput(r: SingleResult): string {
	if (isFailedResult(r)) return r.errorMessage || r.stderr || getFinalOutput(r.messages) || "(no output)";
	return getFinalOutput(r.messages) || "(no output)";
}

/**
 * Truncate a string to ≤ PER_TASK_OUTPUT_CAP bytes, then append a one-line
 * "[Output truncated: N bytes omitted.]" annotation. The annotation itself
 * counts toward the cap, so the final return is always ≤ PER_TASK_OUTPUT_CAP
 * bytes total — callers can paste it directly into a context block.
 */
export function truncateParallelOutput(output: string): string {
	const ANNOTATION_OVERHEAD = 80; // safe headroom for "[Output truncated: N bytes omitted.]"
	const cap = Math.max(0, PER_TASK_OUTPUT_CAP - ANNOTATION_OVERHEAD);
	if (Buffer.byteLength(output, "utf8") <= PER_TASK_OUTPUT_CAP) return output;
	let truncated = output.slice(0, cap);
	while (Buffer.byteLength(truncated, "utf8") > cap) truncated = truncated.slice(0, -1);
	const dropped = Buffer.byteLength(output, "utf8") - Buffer.byteLength(truncated, "utf8");
	return `${truncated}\n\n[Output truncated: ${dropped} bytes omitted.]`;
}

/**
 * Enforce an aggregate byte cap on a multi-task summary. Each task summary
 * is already truncated to PER_TASK_OUTPUT_CAP by truncateParallelOutput; this
 * applies a second cap to the joined string. Tasks beyond the cap are dropped
 * with a one-line "## N more tasks omitted" note.
 */
export function truncateAggregate(summaries: string[], cap = MAX_PARALLEL_OUTPUT_BYTES): string {
	if (summaries.length === 0) return "";
	const sep = "\n\n---\n\n";
	const droppedNote = (kept: number, total: number) =>
		kept === total ? "" : `... ${total - kept} more task(s) omitted to fit ${cap}-byte output cap.\n\n`;
	const included: string[] = [];
	let used = 0;
	for (let i = 0; i < summaries.length; i++) {
		const s = summaries[i];
		const sepBytes = included.length === 0 ? 0 : Buffer.byteLength(sep, "utf8");
		const sBytes = Buffer.byteLength(s, "utf8");
		if (used + sepBytes + sBytes > cap && included.length > 0) break;
		included.push(s);
		used += sepBytes + sBytes;
	}
	return droppedNote(included.length, summaries.length) + included.join(sep);
}

export interface BuildChildArgvOptions {
	task: string;
	agentSystemPrompt?: string;
	agentTools?: string[];
	dispatchModel?: string;
	dispatchThinkingLevel?: string;
}

/**
 * Build the child `pi` argv. INV-skills requires the first two tokens to be
 * `-e <harness>/extensions/damage-control-continue.ts --no-skills` so the
 * safety gate is always present and only allowlisted `--skill` paths are
 * loaded. When the agent has a body we insert a `<prompt-file>` slot that the
 * caller replaces with a real path before spawn.
 */
export function buildChildArgv(harnessRoot: string, opts: BuildChildArgvOptions): string[] {
	const argv: string[] = [
		"-e",
		path.join(harnessRoot, "extensions", "damage-control-continue.ts"),
		"--no-skills",
		"--mode",
		"json",
		"-p",
		"--no-session",
	];
	if (opts.dispatchModel) argv.push("--model", opts.dispatchModel);
	if (opts.dispatchThinkingLevel) argv.push("--thinking", opts.dispatchThinkingLevel);
	if (opts.agentTools && opts.agentTools.length > 0) argv.push("--tools", opts.agentTools.join(","));
	if (opts.agentSystemPrompt && opts.agentSystemPrompt.trim()) {
		argv.push("--append-system-prompt", "<prompt-file>");
	}
	argv.push(`Task: ${opts.task}`);
	return argv;
}

export function resolveHarnessRoot(): string {
	if (process.env.PI_VIDA_HOME) return process.env.PI_VIDA_HOME;
	if (process.env.PI_LIFE_HOME) return process.env.PI_LIFE_HOME;
	if (process.env.MY_PI_AGENT_HOME) return process.env.MY_PI_AGENT_HOME;
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

async function writePromptFile(
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const filePath = path.join(dir, `prompt-${agentName.replace(/[^\w.-]+/g, "_")}.md`);
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir, filePath };
}

function cleanupTmp(tmp: { dir: string; filePath: string } | null): void {
	if (!tmp) return;
	try {
		fs.unlinkSync(tmp.filePath);
	} catch {
		/* ignore */
	}
	try {
		fs.rmdirSync(tmp.dir);
	} catch {
		/* ignore */
	}
}

export function aggregateUsage(results: SingleResult[]) {
	const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const r of results) {
		t.input += r.usage.input;
		t.output += r.usage.output;
		t.cacheRead += r.usage.cacheRead;
		t.cacheWrite += r.usage.cacheWrite;
		t.cost += r.usage.cost;
		t.turns += r.usage.turns;
	}
	return t;
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	limit: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const cap = Math.max(1, Math.min(limit, items.length));
	const out: TOut[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: cap }, async () => {
			while (true) {
				const i = next++;
				if (i >= items.length) return;
				out[i] = await fn(items[i], i);
			}
		}),
	);
	return out;
}

/**
 * Parse a single line from the child's JSON-mode stdout into a `SingleResult`.
 * Returns `true` when the line was consumed (a `message_end` event), `false`
 * otherwise (empty line, non-JSON, or non-message_end event). Extracted from
 * `runSingleAgent` so the parser can be tested without spawning a process.
 */
export function parseSubagentLine(line: string, result: SingleResult): boolean {
	if (!line.trim()) return false;
	let event: any;
	try {
		event = JSON.parse(line);
	} catch {
		return false;
	}
	if (event.type !== "message_end" || !event.message) return false;
	const msg = event.message as SubagentMessage;
	result.messages.push(msg);
	if (msg.role !== "assistant") return true;
	result.usage.turns++;
	const u = msg.usage;
	if (u) {
		result.usage.input += u.input ?? 0;
		result.usage.output += u.output ?? 0;
		result.usage.cacheRead += u.cacheRead ?? 0;
		result.usage.cacheWrite += u.cacheWrite ?? 0;
		const cost = u.cost;
		if (typeof cost === "number") result.usage.cost += cost;
		else if (cost && typeof cost === "object" && typeof cost.total === "number") {
			result.usage.cost += cost.total;
		}
		result.usage.contextTokens = u.totalTokens ?? result.usage.contextTokens;
	}
	if (!result.model && msg.model) result.model = msg.model;
	if (msg.stopReason) result.stopReason = msg.stopReason;
	if (msg.errorMessage) result.errorMessage = msg.errorMessage;
	return true;
}

export interface RunOpts {
	agents: AgentDef[];
	agentName: string;
	task: string;
	cwd?: string;
	step?: number;
	signal?: AbortSignal;
	/** Session-long abort (session_shutdown). Watched separately so we do not
	 *  accumulate AbortSignal.any listeners on it per dispatch. */
	shutdown?: AbortSignal;
	defaultCwd: string;
	harnessRoot: string;
	dispatchModel?: string;
	dispatchThinkingLevel?: string;
}

/**
 * Per-role child dispatch (follow-up to #15): chain steps, team dispatch, and
 * the subagent tool spawn children through `runSingleAgent`; the child's
 * model/thinking resolve from PI_OVERLAY keyed on the child's agent name
 * (planner, builder, reviewer, researcher — the same roles the overlay's
 * models:/thinking: maps configure), falling back to the caller-provided
 * primary values (ctx.model / ctx.thinkingLevel) when the agent has no role
 * entry. Role names double as agent names by design: the default agents ARE
 * the roles, and a custom agent named `planner` intentionally receives the
 * planner entry (first-wins discovery). A malformed PI_OVERLAY also falls
 * back — the launcher wrote it, and capabilities.ts surfaces parse errors at
 * prompt time.
 */
export function dispatchOpts(opts: RunOpts): {
	dispatchModel?: string;
	dispatchThinkingLevel?: string;
} {
	const overlay = overlayFromEnv();
	return {
		dispatchModel: overlay?.models?.[opts.agentName] ?? opts.dispatchModel,
		dispatchThinkingLevel: overlay?.thinking?.[opts.agentName] ?? opts.dispatchThinkingLevel,
	};
}

const inflight = new Set<Promise<unknown>>();

/** Wait until in-flight `runSingleAgent` calls settle. Snapshot only — abort
 *  already flipped, so no new dispatch should start. Capped at grace+1s so a
 *  stuck child cannot wedge shutdown (exit-handler SIGKILL is the backstop). */
export async function drainInflight(): Promise<void> {
	if (inflight.size === 0) return;
	let t: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.allSettled([...inflight]),
			new Promise<void>((r) => {
				t = setTimeout(r, KILL_GRACE_MS + 1_000);
			}),
		]);
	} finally {
		if (t) clearTimeout(t);
	}
}

export async function runSingleAgent(opts: RunOpts): Promise<SingleResult> {
	const tracked = runSingleAgentOnce(opts);
	inflight.add(tracked);
	try {
		return await tracked;
	} finally {
		inflight.delete(tracked);
	}
}

async function runSingleAgentOnce(opts: RunOpts): Promise<SingleResult> {
	const agent = opts.agents.find((a) => a.name === opts.agentName);
	if (!agent) {
		const available = opts.agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: opts.agentName,
			agentSource: "unknown",
			task: opts.task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${opts.agentName}". Available agents: ${available}.`,
			usage: { ...EMPTY_USAGE },
			step: opts.step,
		};
	}

	const { dispatchModel, dispatchThinkingLevel } = dispatchOpts(opts);
	const argv = buildChildArgv(opts.harnessRoot, {
		task: opts.task,
		agentSystemPrompt: agent.body,
		agentTools: agent.tools,
		dispatchModel,
		dispatchThinkingLevel,
	});
	const result: SingleResult = {
		agent: opts.agentName,
		agentSource: agent.source,
		task: opts.task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { ...EMPTY_USAGE },
		step: opts.step,
	};

	let tmp: { dir: string; filePath: string } | null = null;
	try {
		if (agent.body.trim()) {
			tmp = await writePromptFile(agent.name, agent.body);
			const i = argv.indexOf("<prompt-file>");
			if (i >= 0) argv[i] = tmp.filePath;
		} else {
			const i = argv.indexOf("<prompt-file>");
			if (i >= 0) argv.splice(i - 1, 2);
		}

		if (opts.signal?.aborted || opts.shutdown?.aborted) {
			result.exitCode = 1;
			result.stopReason = "aborted";
			result.errorMessage = "aborted by caller signal";
			return result;
		}

		const timeoutMs = childTimeoutMs();
		result.exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", argv, {
				cwd: opts.cwd ?? opts.defaultCwd,
				shell: false,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			});
			let buffer = "";
			let closed = false;
			let timedOut = false;
			let aborted = false;
			let killTimer: ReturnType<typeof setTimeout> | null = null;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const signalTree = (sig: NodeJS.Signals) => {
				try {
					if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, sig);
					else proc.kill(sig);
				} catch {
					try {
						proc.kill(sig);
					} catch {
						/* ignore */
					}
				}
			};
			// ChildProcess.killed only means a signal was sent, so escalation
			// tracks the close/error event, not proc.killed. process.exit()
			// skips the grace timer, so also SIGKILL on parent exit.
			const killChild = () => {
				signalTree("SIGTERM");
				if (killTimer) clearTimeout(killTimer);
				killTimer = setTimeout(() => {
					killTimer = null;
					if (!closed) signalTree("SIGKILL");
				}, KILL_GRACE_MS);
			};
			const onProcessExit = () => {
				if (!closed) signalTree("SIGKILL");
			};
			process.on("exit", onProcessExit);
			const onAbort = () => {
				aborted = true;
				killChild();
			};
			const cleanup = () => {
				if (timer) clearTimeout(timer);
				if (killTimer) {
					clearTimeout(killTimer);
					killTimer = null;
				}
				process.removeListener("exit", onProcessExit);
				opts.signal?.removeEventListener("abort", onAbort);
				opts.shutdown?.removeEventListener("abort", onAbort);
			};
			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) parseSubagentLine(line, result);
			});
			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});
			proc.on("close", (code) => {
				closed = true;
				if (buffer.trim()) parseSubagentLine(buffer, result);
				cleanup();
				if (aborted) {
					result.stopReason = "aborted";
					result.errorMessage = opts.signal?.aborted
						? "aborted by caller signal"
						: "killed by signal";
					resolve(1);
					return;
				}
				if (timedOut) {
					result.stopReason = "timeout";
					result.errorMessage = `timed out after ${timeoutMs}ms`;
					resolve(1);
					return;
				}
				if (code === null) {
					result.stopReason = "aborted";
					result.errorMessage = "killed by signal";
					resolve(1);
					return;
				}
				resolve(code);
			});
			proc.on("error", (err) => {
				closed = true;
				cleanup();
				result.errorMessage = err.message;
				result.stderr = (result.stderr + err.message + "\n").trim();
				resolve(1);
			});
			const watch = (sig?: AbortSignal) => {
				if (!sig) return;
				if (sig.aborted) onAbort();
				else sig.addEventListener("abort", onAbort, { once: true });
			};
			watch(opts.signal);
			watch(opts.shutdown);
			timer = setTimeout(() => {
				timedOut = true;
				killChild();
			}, timeoutMs);
		});
		return result;
	} finally {
		cleanupTmp(tmp);
	}
}
