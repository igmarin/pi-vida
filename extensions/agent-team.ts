/**
 * Agent Team — dispatcher-only primary (issue #8).
 *
 * ## Entry point
 *
 * This file exports `default function (pi: ExtensionAPI)` which restricts the
 * primary session to a single tool, `dispatch_agent`, and registers a
 * `/team-list` command. Loaded ONLY via `pi-vida <vida> team` — mutually
 * exclusive with chain (agent-chain.ts) and tilldone (status-line.ts), which
 * the launcher simply does not load in team mode (`setActiveTools` conflict).
 *
 * ## Behavior
 *
 * The primary cannot read, write, or shell out: it plans, splits the work, and
 * dispatches. `dispatch_agent(agent, task)` runs a team member. Outside Herdr
 * (`HERDR_ENV` unset) it runs a child `pi` via `subagentHelpers.runSingleAgent`
 * (INV-skills: children ALWAYS inherit `-e damage-control-continue.ts
 * --no-skills`). Inside Herdr (`HERDR_ENV=1`, INV-herdr #79) the launcher has
 * started one pane per member and exported `PI_HERDR_MEMBERS`; dispatch
 * prompts that member with `herdr agent prompt <member> <task> --wait` and
 * reads the answer back with `herdr agent read <member> --source
 * recent-unwrapped`. Members not started by the launcher are rejected before
 * any `herdr` call (prompt-only exception; no agent lifecycle here). Only
 * members of the active team may be dispatched — arbitrary agent names are
 * rejected.
 *
 * ## Team discovery
 *
 * Teams live under the `teams:` key of the same `agent-chain.yaml` file the
 * chains use, so `resolveChainFile` precedence applies unchanged:
 * cwd `.pi/agents/` → `profiles/<vida>/agents/` → shared `profiles/agents/`.
 * Active team: `PI_TEAM` env when set, else the `default` team, else the first
 * defined team. `/team-list` shows what is available.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	parseAgentTeams,
	pickTeam,
	resolveChainFile,
	type TeamDef,
} from "./agent-chain.ts";
import { collectAgents, harnessRoot } from "./agentScan.ts";
import { formatTeamList } from "./agents-view.ts";
import {
	aggregateUsage,
	childTimeoutMs,
	formatUsageStats,
	getFinalOutput,
	isFailedResult,
	killChildTree,
	KILL_GRACE_MS,
	resultOutput,
	runSingleAgent,
	drainInflight,
	truncateParallelOutput,
	type SingleResult,
} from "./subagentHelpers.ts";

/** One `herdr` child run (prompt-only; INV-herdr #79). Resolves
 *  { code, stdout, stderr }; never throws on a failed child. */
interface HerdrRun {
	code: number;
	/** stdout — pane text for `agent read` (prompt's stdout is chatter). */
	stdout: string;
	/** stderr (herdr diagnostics go to stderr). */
	stderr: string;
}

/** Result of a herdr-backed dispatch: error text or the pane output. */
export interface HerdrDispatchResult {
	ok: boolean;
	error?: string;
	output?: string;
}

/** In-flight herdr dispatches. session_shutdown drains these the same way
 *  subagentHelpers drains hidden children, so the primary cannot exit while
 *  an abort kill is still racing. */
const herdrInflight = new Set<Promise<unknown>>();

/** Per-member dispatch queues (#79): one member pane serves one turn at a
 *  time — herdr's `--wait` matches turn states, not turns, so overlapping
 *  prompts to the same member could let one completion satisfy the other's
 *  wait and cross the outputs. Different members run concurrently. */
const herdrQueues = new Map<string, Promise<unknown>>();

/** Wait until in-flight herdr dispatches settle. Capped at grace+1s so a
 *  wedged child cannot hang shutdown (the kill timer is the backstop). */
export async function drainHerdrInflight(): Promise<void> {
	if (herdrInflight.size === 0) return;
	let t: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.allSettled([...herdrInflight]),
			new Promise<void>((r) => {
				t = setTimeout(r, KILL_GRACE_MS + 1_000);
			}),
		]);
	} finally {
		if (t) clearTimeout(t);
	}
}

/** Dispatch one member via herdr, serialized per member and tracked for
 *  shutdown drain (#79). */
export function herdrDispatch(
	agentName: string,
	task: string,
	members: string[],
	signal?: AbortSignal,
	shutdown?: AbortSignal,
): Promise<HerdrDispatchResult> {
	const prev = herdrQueues.get(agentName) ?? Promise.resolve();
	const tracked = prev.then(
		() => herdrDispatchOnce(agentName, task, members, signal, shutdown),
		() => herdrDispatchOnce(agentName, task, members, signal, shutdown),
	);
	herdrQueues.set(
		agentName,
		tracked.catch(() => {}),
	);
	herdrInflight.add(tracked);
	void tracked.finally(() => herdrInflight.delete(tracked));
	return tracked;
}

/** INV-herdr (#79): prompt-only `herdr` from this extension, and only against
 *  members the launcher started (PI_HERDR_MEMBERS). Runs
 *  `herdr agent prompt <member> <task> --wait --timeout <ms>` wired to
 *  `signal`/`shutdown` (kill on abort/quit, same contract as the hidden-child
 *  path), then the success path reads the pane with
 *  `herdr agent read <member> --source recent-unwrapped --lines 200`,
 *  truncated via truncateParallelOutput. Never starts/stops agents or panes. */
async function herdrDispatchOnce(
	agentName: string,
	task: string,
	members: string[],
	signal?: AbortSignal,
	shutdown?: AbortSignal,
): Promise<HerdrDispatchResult> {
	if (!members.includes(agentName)) {
		return {
			ok: false,
			error: `'${agentName}' has no herdr pane. Members started in Herdr: ${members.join(", ") || "none"}.`,
		};
	}
	const prompt = await runHerdr(
		[
			"agent",
			"prompt",
			agentName,
			task,
			"--wait",
			"--timeout",
			String(childTimeoutMs()),
		],
		signal,
		shutdown,
	);
	if (prompt.code !== 0) {
		const tail = prompt.stderr.trim().split("\n").slice(-3).join("\n");
		return { ok: false, error: `herdr agent prompt ${agentName} failed: ${tail || "aborted"}` };
	}
	const read = await runHerdr(
		["agent", "read", agentName, "--source", "recent-unwrapped", "--lines", "200"],
		signal,
		shutdown,
	);
	if (read.code !== 0) {
		const tail = read.stderr.trim().split("\n").slice(-3).join("\n");
		return { ok: false, error: `herdr agent read ${agentName} failed: ${tail || "aborted"}` };
	}
	return { ok: true, output: truncateParallelOutput(read.stdout) };
}

/** One `herdr` child run (prompt-only; INV-herdr #79). Process-group kill on
 *  abort — same contract as the hidden-child spawn in subagentHelpers
 *  (SIGTERM, then SIGKILL after the grace; escalation on parent exit is the
 *  exit-handler's job there, ours is short-lived). Resolves { code, stdout,
 *  stderr }; never throws on a failed child. */
async function runHerdr(
	args: string[],
	signal?: AbortSignal,
	shutdown?: AbortSignal,
): Promise<HerdrRun> {
	const { promise, resolve } = Promise.withResolvers<HerdrRun>();
	const proc = spawn("herdr", args, {
		shell: false,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let closed = false;
	let killTimer: ReturnType<typeof setTimeout> | null = null;
	const killChild = () => {
		killChildTree(proc, "SIGTERM");
		if (killTimer) clearTimeout(killTimer);
		killTimer = setTimeout(() => {
			killTimer = null;
			if (!closed) killChildTree(proc, "SIGKILL");
		}, KILL_GRACE_MS);
	};
	const onAbort = () => killChild();
	const onData = (data: Buffer) => {
		stderr += data.toString();
	};
	const onStdout = (data: Buffer) => {
		stdout += data.toString();
	};
	const cleanup = () => {
		if (killTimer) clearTimeout(killTimer);
		signal?.removeEventListener("abort", onAbort);
		shutdown?.removeEventListener("abort", onAbort);
	};
	proc.stderr?.on("data", onData);
	proc.stdout?.on("data", onStdout);
	proc.on("close", (code) => {
		closed = true;
		cleanup();
		resolve({ code: code ?? 1, stdout, stderr });
	});
	proc.on("error", (err) => {
		closed = true;
		cleanup();
		resolve({ code: 1, stdout, stderr: `${stderr}${err.message}\n` });
	});
	const watch = (sig?: AbortSignal) => {
		if (!sig) return;
		if (sig.aborted) onAbort();
		else sig.addEventListener("abort", onAbort, { once: true });
	};
	watch(signal);
	watch(shutdown);
	return promise;
}

/** Resolve + parse the team map for a cwd, mirroring chain discovery. */
export function loadedTeams(cwd: string): {
	source: string;
	teams: Map<string, TeamDef>;
} {
	const file = resolveChainFile(cwd, import.meta.url, process.env.PI_VIDA || process.env.PI_LIFE);
	if (!file)
		throw new Error(
			"No agent-chain.yaml found in .pi/agents or profiles/agents",
		);
	return {
		source: file.source,
		teams: parseAgentTeams(readFileSync(file.path, "utf8")),
	};
}

export default function (pi: ExtensionAPI) {
	const shutdown = new AbortController();
	pi.on("session_shutdown", async () => {
		shutdown.abort();
		await Promise.all([drainInflight(), drainHerdrInflight()]);
	});
	// Dispatcher-only primary: no read, write, edit, or bash. Mutual exclusion
	// with chain/tilldone is structural — the launcher never loads those
	// extensions in team mode. setActiveTools is an action method: it must run
	// inside an event handler (session_start), not during extension loading.
	pi.on("session_start", async (_event, ctx) => {
		pi.setActiveTools(["dispatch_agent"]);
		// Issue #77: state the active team and member tool lists up front so
		// the dispatcher plans with knowledge of who can do what. Silent in
		// print/JSON mode, like the other UI-only surfaces.
		if (!ctx.hasUI) return;
		try {
			const { teams } = loadedTeams(ctx.cwd);
			const active = pickTeam(teams, process.env.PI_TEAM);
			const msg = `Team ${active.name} active — members with tools:\n${formatTeamList(
				teams,
				active,
				collectAgents(ctx.cwd, import.meta.url),
			)}`;
			ctx.ui.notify(msg, "info");
		} catch (e) {
			ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
		}
	});

	pi.registerCommand("team-list", {
		description: "List agent teams with member tool lists (teams: key of agent-chain.yaml)",
		handler: async (_args, ctx) => {
			try {
				const { source, teams } = loadedTeams(ctx.cwd);
				const active = pickTeam(teams, process.env.PI_TEAM);
				const msg = `Teams (${source}, active: ${active.name}):\n${formatTeamList(
					teams,
					active,
					collectAgents(ctx.cwd, import.meta.url),
				)}`;
				if (ctx.hasUI) ctx.ui.notify(msg, "info");
				else console.log(msg);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (ctx.hasUI) ctx.ui.notify(msg, "error");
				else console.error(msg);
			}
		},
	});

	pi.registerTool({
		name: "dispatch_agent",
		label: "Dispatch agent",
		description: [
			"Dispatch a task to a team member (child pi with isolated context).",
			"You are a dispatcher: plan, split the work, dispatch members, and synthesize.",
			"Only members of the active team are dispatchable; children inherit the safety gate.",
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				agent: {
					type: "string",
					description: "Team member name (see /team-list)",
				},
				task: { type: "string", description: "Task for the member" },
			},
			required: ["agent", "task"],
		},
		async execute(_id, params, signal, _onUpdate, ctx) {
			const agentName =
				typeof params.agent === "string" ? params.agent.trim() : "";
			const task = typeof params.task === "string" ? params.task.trim() : "";
			if (!agentName || !task) {
				return {
					content: [
						{ type: "text", text: "dispatch_agent requires agent and task." },
					],
					isError: true,
				};
			}
			let team: TeamDef;
			try {
				team = pickTeam(loadedTeams(ctx.cwd).teams, process.env.PI_TEAM);
			} catch (e) {
				return {
					content: [
						{ type: "text", text: e instanceof Error ? e.message : String(e) },
					],
					isError: true,
				};
			}
			if (!team.members.includes(agentName)) {
				return {
					content: [
						{
							type: "text",
							text: `'${agentName}' is not a member of team '${team.name}'. Members: ${team.members.join(", ")}.`,
						},
					],
					isError: true,
				};
			}

			// INV-herdr (#79): inside Herdr the launcher started one pane per
			// member and exported PI_HERDR_MEMBERS; dispatch prompts that pane
			// and reads the answer back. Outside Herdr the hidden-child path
			// below is byte-identical to the pre-#79 behavior.
			if (process.env.HERDR_ENV === "1") {
				const members = (process.env.PI_HERDR_MEMBERS ?? "")
					.split(",")
					.map((m) => m.trim())
					.filter(Boolean);
				const r = await herdrDispatch(agentName, task, members, signal, shutdown.signal);
				if (!r.ok) {
					return {
						content: [{ type: "text", text: r.error ?? "herdr dispatch failed." }],
						details: { team: team.name, agent: agentName },
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: r.output || "(no output)" }],
					details: { team: team.name, agent: agentName },
				};
			}

			const agents = collectAgents(ctx.cwd, import.meta.url);
			const childRoot = harnessRoot();
			const dispatchModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;
			const r: SingleResult = await runSingleAgent({
				agents,
				agentName,
				task,
				signal,
				shutdown: shutdown.signal,
				defaultCwd: ctx.cwd,
				harnessRoot: childRoot,
				dispatchModel,
				dispatchThinkingLevel: ctx.thinkingLevel as string | undefined,
			});
			if (isFailedResult(r)) {
				return {
					content: [
						{
							type: "text",
							text: `Agent ${agentName} ${r.stopReason || "failed"}: ${resultOutput(r)}`,
						},
					],
					details: { team: team.name, agent: agentName },
					isError: true,
				};
			}
			const usage = formatUsageStats(aggregateUsage([r]), r.model);
			return {
				content: [
					{
						type: "text",
						text: `${getFinalOutput(r.messages) || "(no output)"}${usage ? `\n\n${usage}` : ""}`,
					},
				],
				details: { team: team.name, agent: agentName },
			};
		},
	});
}
