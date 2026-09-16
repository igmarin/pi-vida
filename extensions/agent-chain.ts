/**
 * Agent Chain — run named, ordered agent pipelines (plan → build → review).
 *
 * ## Entry point
 *
 * This file exports `default function (pi: ExtensionAPI)` which registers the
 * `/chain` and `/chain-list` commands and the `run_chain` tool. Loaded via
 * `pi-vida <vida> chain` (mutually exclusive with team and status-line by
 * launcher construction).
 *
 * ## Chain discovery
 *
 * Chains are YAML. One file per scope, `agent-chain.yaml`, containing named
 * chains under a `chains:` key — and, since issue #8, named teams under a
 * `teams:` key (consumed by `agent-team.ts`, the dispatcher-only primary).
 * Precedence (first file that exists wins, so a
 * project can override the harness default without polluting the repo):
 *
 *   1. cwd `.pi/agents/agent-chain.yaml`      (project override)
 *   2. `profiles/<vida>/agents/agent-chain.yaml`
 *   3. `profiles/agents/agent-chain.yaml`     (shared harness default)
 *
 * ## Schema
 *
 * ```yaml
 * chains:
 *   plan-build-review:
 *     description: Plan, build, then review.
 *     steps:
 *       - agent: planner
 *         task: "Plan: {task}"              # {task} = the original request,
 *       - agent: builder                    # {previous} = prior step output
 *         task: "Implement. {previous}"
 *       - agent: reviewer
 *         task: "Review. {previous}"
 * ```
 *
 * Every step needs an `agent`. `task` is a template; `{task}` and
 * `{previous}` are substituted before the step runs. A step without `task`
 * receives the original request verbatim.
 *
 * A step may set `rs_guard: true` (issue #7, chain-level by design). When the
 * project overlay enables the `rs-guard` capability (PI_OVERLAY, written by
 * bin/pi-vida) the chain shells out to `rs-guard --diff-file` on `git diff
 * HEAD` before the step's agent runs; the agent receives the findings and must
 * verify them, not re-implement the review. Overlay off or empty diff → the
 * agent runs skills-only. Overlay on + missing binary, or a non-zero rs-guard
 * exit (2 = REQUEST_CHANGES, anything else = error), fails the chain closed.
 *
 * ## Execution
 *
 * Each step spawns a child `pi` via `subagentHelpers.runSingleAgent` (INV-skills
 * enforced by `buildChildArgv`). Steps run sequentially, fail-fast on the first
 * non-zero exit. Agents come from the same discovery as the subagent tool.
 */

import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parse as yamlParse } from "yaml";
import { type AgentDef, collectAgents, harnessRoot } from "./agentScan.ts";
import { deserializeOverlayEnv } from "./capabilities.ts";
import {
	getFinalOutput,
	isFailedResult,
	resolveHarnessRoot,
	resultOutput,
	runSingleAgent,
	drainInflight,
	type SingleResult,
} from "./subagentHelpers.ts";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in agent-chain.test.ts)
// ---------------------------------------------------------------------------

export interface ChainStepDef {
	agent: string;
	task?: string;
	rs_guard?: boolean;
}

export interface ChainDef {
	name: string;
	description: string;
	steps: ChainStepDef[];
}

export interface ChainFile {
	chains: Record<string, { description?: string; steps: unknown }>;
}

export class ChainError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ChainError";
	}
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return v != null && typeof v === "object" && !Array.isArray(v);
}

function strList(v: unknown): string {
	return typeof v === "string" ? v : "";
}

/** Parse the YAML text of an `agent-chain.yaml` into a map of chain defs. */
export function parseChainFile(text: string): Map<string, ChainDef> {
	let doc: unknown;
	try {
		doc = yamlParse(text);
	} catch (e) {
		throw new ChainError(
			`agent-chain: invalid YAML: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (!isRecord(doc))
		throw new ChainError("agent-chain: expected a mapping with a chains key");
	const raw = doc.chains;
	if (!isRecord(raw))
		throw new ChainError("agent-chain: expected a mapping under 'chains'");
	const out = new Map<string, ChainDef>();
	for (const [name, body] of Object.entries(raw)) {
		if (!name) continue;
		if (!isRecord(body) || !Array.isArray(body.steps)) {
			throw new ChainError(`agent-chain: chain '${name}' needs a steps list`);
		}
		const steps: ChainStepDef[] = [];
		for (const [i, step] of body.steps.entries()) {
			if (!isRecord(step))
				throw new ChainError(
					`agent-chain: chain '${name}' step ${i + 1} must be a mapping`,
				);
			const agent = strList(step.agent);
			if (!agent)
				throw new ChainError(
					`agent-chain: chain '${name}' step ${i + 1} needs an 'agent' name`,
				);
			const task = typeof step.task === "string" ? step.task : undefined;
			let rsGuard: boolean | undefined;
			if (step.rs_guard !== undefined) {
				if (typeof step.rs_guard !== "boolean")
					throw new ChainError(
						`agent-chain: chain '${name}' step ${i + 1} rs_guard must be a boolean`,
					);
				rsGuard = step.rs_guard;
			}
			steps.push({ agent, task, rs_guard: rsGuard });
		}
		if (steps.length === 0)
			throw new ChainError(`agent-chain: chain '${name}' has no steps`);
		out.set(name, {
			name,
			description:
				strList(body.description) ||
				`${name}: ${steps.map((s) => s.agent).join(" -> ")}`,
			steps,
		});
	}
	if (out.size === 0) throw new ChainError("agent-chain: no chains defined");
	return out;
}

// ---------------------------------------------------------------------------
// Teams (issue #8). Same file, `teams:` key; the resolver/precedence in
// resolveChainFile applies unchanged. agent-team.ts (dispatcher-only primary)
// consumes these; chains and teams are mutually exclusive by launcher mode.
// ---------------------------------------------------------------------------

export interface TeamDef {
	name: string;
	description: string;
	members: string[];
}

/**
 * Parse the `teams:` key of an `agent-chain.yaml` into team defs. A file with
 * no `teams:` key yields an empty map (chains-only files stay valid).
 */
export function parseAgentTeams(text: string): Map<string, TeamDef> {
	let doc: unknown;
	try {
		doc = yamlParse(text);
	} catch (e) {
		throw new ChainError(
			`agent-team: invalid YAML: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (!isRecord(doc) || doc.teams === undefined) return new Map();
	const raw = doc.teams;
	if (!isRecord(raw))
		throw new ChainError("agent-team: expected a mapping under 'teams'");
	const out = new Map<string, TeamDef>();
	for (const [name, body] of Object.entries(raw)) {
		if (!name) continue;
		if (!isRecord(body) || !Array.isArray(body.members)) {
			throw new ChainError(`agent-team: team '${name}' needs a members list`);
		}
		const members: string[] = [];
		for (const m of body.members) {
			if (typeof m !== "string" || !m.trim()) {
				throw new ChainError(
					`agent-team: team '${name}' members must be non-empty strings`,
				);
			}
			if (members.includes(m)) {
				throw new ChainError(
					`agent-team: team '${name}' has duplicate member '${m}'`,
				);
			}
			members.push(m);
		}
		if (members.length === 0)
			throw new ChainError(`agent-team: team '${name}' has no members`);
		out.set(name, {
			name,
			description:
				strList(body.description) || `${name}: ${members.join(", ")}`,
			members,
		});
	}
	return out;
}

/**
 * Pick the active team: the requested name, else `default`, else the first
 * defined team. Throws when nothing matches or nothing is defined.
 */
export function pickTeam(
	teams: Map<string, TeamDef>,
	wanted?: string,
): TeamDef {
	if (teams.size === 0)
		throw new ChainError("agent-team: no teams defined in agent-chain.yaml");
	const key = wanted?.trim();
	if (key) {
		const t = teams.get(key);
		if (!t)
			throw new ChainError(
				`agent-team: no team '${key}'. Available: ${[...teams.keys()].join(", ")}.`,
			);
		return t;
	}
	return teams.get("default") ?? teams.values().next().value!;
}

/** Canonicalize a life alias; `undefined` when unset or invalid. */
export function chainLife(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const k = raw.toLowerCase();
	if (k === "phoenix") return "elixir";
	if (k === "rails") return "ruby";
	if (k === "rust" || k === "elixir" || k === "ruby" || k === "python")
		return k;
	return undefined;
}

function harnessChainPath(
	extFileUrl: string,
	lifeRaw: string | null,
): { source: string; path: string }[] {
	const root = harnessRoot(extFileUrl);
	const life = chainLife(lifeRaw || undefined);
	const out: { source: string; path: string }[] = [];
	if (life)
		out.push({
			source: `profiles/${life}/agents`,
			path: join(root, "profiles", life, "agents", "agent-chain.yaml"),
		});
	out.push({
		source: "profiles/agents",
		path: join(root, "profiles", "agents", "agent-chain.yaml"),
	});
	return out;
}

/**
 * Chain-file candidates in precedence order — the single source of truth the
 * formatter path (agents-view) and resolveChainFile consume (issue #81).
 * Prefixless entries are candidates; the formatter prefixes ones on disk `*`.
 */
export function chainCandidates(
	cwd: string,
	extFileUrl: string,
	life: string | undefined,
): { source: string; path: string }[] {
	return [
		{
			source: ".pi/agents",
			path: join(cwd, ".pi", "agents", "agent-chain.yaml"),
		},
		...harnessChainPath(extFileUrl, life || null),
	];
}

/**
 * Resolve the chain file for the cwd. Project `.pi/agents` wins over the
 * harness so a repo can override the default; a repo without the file still
 * gets the harness default (no pollution requirement, issue #6).
 */
export function resolveChainFile(
	cwd: string,
	extFileUrl: string,
	life: string | undefined,
): { source: string; path: string } | null {
	for (const p of chainCandidates(cwd, extFileUrl, life)) {
		if (existsSync(p.path)) return p;
	}
	return null;
}

/** Sub `{task}` and `{previous}` in a step's task template. */
export function renderStepTask(
	template: string | undefined,
	task: string,
	previous: string,
): string {
	if (!template) return task;
	return template.replace(/\{task\}/g, task).replace(/\{previous\}/g, previous);
}

// ---------------------------------------------------------------------------
// rs-guard step guard (issue #7, chain-level)
// ---------------------------------------------------------------------------

/**
 * Whether the overlay payload (PI_OVERLAY JSON, written by bin/pi-vida)
 * enables the `rs-guard` capability. Missing/empty payload or a malformed
 * payload counts as off — the launcher never writes malformed JSON, and
 * capabilities.ts already surfaces parse errors at prompt time.
 */
export function overlayRsGuardEnabled(payload: string | undefined): boolean {
	if (!payload) return false;
	try {
		return deserializeOverlayEnv(payload).capabilities["rs-guard"];
	} catch {
		return false;
	}
}

export type GuardPlan =
	| { action: "skip" }
	| { action: "run" }
	| { action: "error"; reason: string };

/**
 * Decide what a `rs_guard: true` step does before its agent runs. Overlay off
 * → skip (skills-only review, per issue #7). Overlay on + missing binary →
 * error (never a silent skip). Overlay on + empty diff → skip (nothing to
 * review). Otherwise run the binary.
 */
export function planGuardStep(p: {
	overlayOn: boolean;
	hasBinary: boolean;
	hasDiff: boolean;
}): GuardPlan {
	if (!p.overlayOn) return { action: "skip" };
	if (!p.hasBinary) {
		return {
			action: "error",
			reason:
				"overlay enables rs-guard but the binary is not on PATH; install rs-guard or set rs-guard: false in .pi/capabilities.yaml",
		};
	}
	if (!p.hasDiff) return { action: "skip" };
	return { action: "run" };
}

/** `git diff HEAD` output (staged + unstaged). Throws when git fails so the
 * guard fails closed instead of silently skipping on a broken repo. */
async function gitDiffHead(cwd: string, signal?: AbortSignal): Promise<string> {
	const proc = Bun.spawn(["git", "diff", "HEAD"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		signal,
	});
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	if (code !== 0) {
		throw new Error(
			`'git diff HEAD' failed (exit ${code})${err.trim() ? `: ${err.trim()}` : ""}`,
		);
	}
	return out;
}

/**
 * Env for the rs-guard child: the parent env plus KEY=VALUE pairs from
 * ~/.config/rs-guard/env (same source the pre-commit hook sources), so the
 * chain works when the provider key lives only in that file.
 */
function rsGuardEnv(): Record<string, string> {
	const env: Record<string, string> = { ...process.env };
	try {
		const file = join(homedir(), ".config", "rs-guard", "env");
		if (existsSync(file)) {
			for (const line of readFileSync(file, "utf8").split("\n")) {
				const m = line.match(
					/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/,
				);
				if (!m) continue;
				let v = m[2].trim();
				if (
					(v.startsWith('"') && v.endsWith('"')) ||
					(v.startsWith("'") && v.endsWith("'"))
				) {
					v = v.slice(1, -1);
				}
				env[m[1]] = v;
			}
		}
	} catch {
		// unreadable env file: the parent env is all the child gets
	}
	return env;
}

/**
 * Run the rs-guard half of a `rs_guard: true` step. Returns a findings note to
 * append to the step's task (null when skipped), or throws ChainError on a
 * missing binary (overlay on), a failed `git diff HEAD` (fail closed), or a
 * non-zero rs-guard exit. Forwards `signal` to both subprocesses so an
 * aborted chain tears them down.
 */
async function runGuardStep(
	chainName: string,
	stepNo: number,
	cwd: string,
	signal?: AbortSignal,
	shutdown?: AbortSignal,
): Promise<string | null> {
	const ac = new AbortController();
	const stop = () => ac.abort();
	if (signal?.aborted || shutdown?.aborted) ac.abort();
	signal?.addEventListener("abort", stop, { once: true });
	shutdown?.addEventListener("abort", stop, { once: true });
	try {
		return await runGuardStepBody(chainName, stepNo, cwd, ac.signal);
	} finally {
		signal?.removeEventListener("abort", stop);
		shutdown?.removeEventListener("abort", stop);
	}
}

async function runGuardStepBody(
	chainName: string,
	stepNo: number,
	cwd: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const hasBinary = Bun.which("rs-guard") != null;
	let diff: string;
	try {
		diff = await gitDiffHead(cwd, signal);
	} catch (e) {
		throw new ChainError(
			`chain ${chainName} step ${stepNo}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	const plan = planGuardStep({
		overlayOn: overlayRsGuardEnabled(process.env.PI_OVERLAY),
		hasBinary,
		hasDiff: diff.trim() !== "",
	});
	if (plan.action === "error")
		throw new ChainError(`chain ${chainName} step ${stepNo}: ${plan.reason}`);
	if (plan.action === "skip") return null;

	const dir = mkdtempSync(join(tmpdir(), "rs-guard-chain-"));
	try {
		const diffFile = join(dir, "diff.patch");
		writeFileSync(diffFile, diff);
		const proc = Bun.spawn(["rs-guard", "--diff-file", diffFile], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: rsGuardEnv(),
			signal,
		});
		const [out, err] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const code = await proc.exited;
		const output = [out.trim(), err.trim()].filter(Boolean).join("\n");
		if (code !== 0) {
			throw new ChainError(
				`chain ${chainName} step ${stepNo}: rs-guard failed (exit ${code})${output ? `:\n${output}` : ""}`,
			);
		}
		return `rs-guard review passed (exit 0). Automated findings to verify and summarize — do not re-run the binary:\n${output || "(no findings)"}`;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export async function runChainSteps(
	chain: ChainDef,
	task: string,
	opts: {
		agents: AgentDef[];
		harnessRoot: string;
		cwd: string;
		signal?: AbortSignal;
		shutdown?: AbortSignal;
		dispatchModel?: string;
		dispatchThinkingLevel?: string;
	},
): Promise<{ results: SingleResult[]; output: string }> {
	const results: SingleResult[] = [];
	let previous = "";
	for (let i = 0; i < chain.steps.length; i++) {
		if (opts.signal?.aborted || opts.shutdown?.aborted) {
			throw new ChainError(
				`chain ${chain.name} stopped at step ${i + 1}: aborted`,
			);
		}
		const step = chain.steps[i];
		let stepTask = renderStepTask(step.task, task, previous);
		if (step.rs_guard) {
			const note = await runGuardStep(
				chain.name,
				i + 1,
				opts.cwd,
				opts.signal,
				opts.shutdown,
			);
			if (note) stepTask += `\n\n${note}`;
		}
		const r = await runSingleAgent({
			agents: opts.agents,
			agentName: step.agent,
			task: stepTask,
			step: i + 1,
			signal: opts.signal,
			shutdown: opts.shutdown,
			defaultCwd: opts.cwd,
			harnessRoot: opts.harnessRoot,
			dispatchModel: opts.dispatchModel,
			dispatchThinkingLevel: opts.dispatchThinkingLevel,
		});
		results.push(r);
		if (isFailedResult(r)) {
			throw new ChainError(
				`chain ${chain.name} stopped at step ${i + 1} (${step.agent}): ${resultOutput(r)}`,
			);
		}
		previous = getFinalOutput(r.messages) || previous;
	}
	return { results, output: previous };
}

function loadedChains(cwd: string): {
	source: string;
	chains: Map<string, ChainDef>;
} {
	const file = resolveChainFile(cwd, import.meta.url, process.env.PI_VIDA || process.env.PI_LIFE);
	if (!file)
		throw new ChainError(
			"No agent-chain.yaml found in .pi/agents or profiles/agents",
		);
	return {
		source: file.source,
		chains: parseChainFile(readFileSync(file.path, "utf8")),
	};
}

function selectChain(
	chains: Map<string, ChainDef>,
	raw: string,
): { name: string; task: string } {
	const first = raw.split(/\s+/)[0];
	if (chains.has(first))
		return { name: first, task: raw.slice(first.length).trim() };
	const name = chains.has("plan-build-review")
		? "plan-build-review"
		: (chains.keys().next().value as string);
	return { name, task: raw.trim() };
}

export default function (pi: ExtensionAPI) {
	const shutdown = new AbortController();
	pi.on("session_shutdown", async () => {
		shutdown.abort();
		await drainInflight();
	});

	pi.registerCommand("chain-list", {
		description:
			"List available agent chains (YAML: .pi/agents, profiles/<vida>/agents, profiles/agents)",
		handler: async (_args, ctx) => {
			try {
				const { source, chains } = loadedChains(ctx.cwd);
				const lines = [...chains.values()].map(
					(c) => `${c.name} — ${c.description}`,
				);
				if (ctx.hasUI)
					ctx.ui.notify(`Chains (${source}):\n${lines.join("\n")}`, "info");
				else console.log(`[${source}] ${lines.join("\n")}`);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (ctx.hasUI) ctx.ui.notify(msg, "error");
				else console.error(msg);
			}
		},
	});

	pi.registerCommand("chain", {
		description:
			"Run a named chain. Usage: /chain [name] <task>. Default chain: plan-build-review",
		handler: async (args, ctx) => {
			if (!args || !args.trim()) {
				if (ctx.hasUI)
					ctx.ui.notify("Usage: /chain [chain-name] <task>", "warning");
				return;
			}
			let chain: ChainDef;
			let task: string;
			try {
				const { chains } = loadedChains(ctx.cwd);
				const picked = selectChain(chains, args);
				chain = chains.get(picked.name)!;
				task = picked.task;
				if (!task) throw new ChainError(`Usage: /chain ${picked.name} <task>`);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (ctx.hasUI) ctx.ui.notify(msg, "error");
				else console.error(msg);
				return;
			}
			if (ctx.hasUI)
				ctx.ui.notify(
					`Running chain ${chain.name} (${chain.steps.map((s) => s.agent).join(" -> ")})`,
					"info",
				);
			const agents = collectAgents(ctx.cwd, import.meta.url);
			const harnessRoot = resolveHarnessRoot();
			const dispatchModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;
			try {
				const { output } = await runChainSteps(chain, task, {
					agents,
					harnessRoot,
					cwd: ctx.cwd,
					shutdown: shutdown.signal,
					dispatchModel,
					dispatchThinkingLevel: ctx.thinkingLevel as string | undefined,
				});
				pi.sendUserMessage(output || "(chain finished with no output)");
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (ctx.hasUI) ctx.ui.notify(msg, "error");
				else console.error(msg);
			}
		},
	});

	pi.registerTool({
		name: "run_chain",
		label: "Run chain",
		description:
			"Run a named agent chain from agent-chain.yaml (e.g. plan-build-review). Fail-fast on step error.",
		parameters: {
			type: "object",
			properties: {
				chain: {
					type: "string",
					description:
						"Chain name from agent-chain.yaml (default plan-build-review)",
				},
				task: {
					type: "string",
					description: "The request to run through the chain",
				},
			},
			required: ["task"],
		},
		async execute(_id, params, signal, _onUpdate, ctx) {
			const task = typeof params.task === "string" ? params.task.trim() : "";
			if (!task)
				return {
					content: [
						{ type: "text", text: "run_chain requires a non-empty task." },
					],
					isError: true,
				};
			let chain: ChainDef;
			try {
				const { chains } = loadedChains(ctx.cwd);
				const wanted =
					typeof params.chain === "string" && params.chain
						? params.chain
						: "plan-build-review";
				chain = chains.get(wanted)!;
				if (!chain)
					throw new ChainError(
						`No chain '${wanted}'. Available: ${[...chains.keys()].join(", ")}.`,
					);
			} catch (e) {
				return {
					content: [
						{ type: "text", text: e instanceof Error ? e.message : String(e) },
					],
					isError: true,
				};
			}
			const agents = collectAgents(ctx.cwd, import.meta.url);
			const harnessRoot = resolveHarnessRoot();
			const dispatchModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;
			try {
				const { output } = await runChainSteps(chain, task, {
					agents,
					harnessRoot,
					cwd: ctx.cwd,
					signal,
					shutdown: shutdown.signal,
					dispatchModel,
					dispatchThinkingLevel: ctx.thinkingLevel as string | undefined,
				});
				return {
					content: [
						{ type: "text", text: output || "(chain finished with no output)" },
					],
					details: {
						chain: chain.name,
						steps: chain.steps.map((s) => s.agent),
					},
				};
			} catch (e) {
				return {
					content: [
						{ type: "text", text: e instanceof Error ? e.message : String(e) },
					],
					isError: true,
				};
			}
		},
	});
}
