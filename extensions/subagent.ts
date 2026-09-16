/**
 * Subagent Tool — delegate tasks to specialized agents with isolated context.
 *
 * ## Entry point
 *
 * This file exports `default function (pi: ExtensionAPI)` which calls
 * `pi.registerTool({ name: "subagent", label: "Subagent", ... })`. Loaded
 * via `pi -e extensions/subagent.ts`. The tool is NOT loaded by `pi-vida`
 * yet (Wave 4 work in the 0.1.0 sweep); it ships as a standalone extension
 * that can be enabled by adding it to the per-vida `-e` list in `bin/pi-vida`.
 *
 * ## Modes
 *
 * - `single`  : { agent, task } — one agent, one task
 * - `parallel`: { tasks[] }  — array of tasks, max 8, max 4 concurrent
 * - `chain`   : { chain[] }  — sequential, `{previous}` placeholder for the
 *                              prior step's final output, fail-fast on first
 *                              non-zero exit
 *
 * Children spawn `pi` in JSON mode and ALWAYS inherit
 * `-e <harness>/extensions/damage-control-continue.ts --no-skills` (INV-skills).
 * The argv builder in `subagentHelpers.ts` enforces this — no caller can spawn
 * a child without it.
 *
 * ## Discovery
 *
 * Reuses the harness's `agentScan.collectAgents()` order:
 * `profiles/<vida>/agents/` → `profiles/agents/` → cwd `.pi/agents/`
 * (first-wins). The upstream user-vs-project trust prompt is dropped: this
 * harness has no such split — the harness itself is the project.
 *
 * ## Code layout
 *
 * - `subagent.ts`        — this file. Glue: schema + mode dispatch + result shaping.
 * - `subagentHelpers.ts` — types, constants, pure helpers, child-process plumbing.
 * - `subagent.test.ts`   — `bun test` suite: pure helpers, JSON-line parser, and
 *                          spawn/kill via a PATH wrapper named `pi`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collectAgents, harnessRoot } from "./agentScan.ts";
import {
	MAX_PARALLEL_TASKS,
	MAX_CONCURRENCY,
	type SingleResult,
	type SubagentDetails,
	aggregateUsage,
	formatUsageStats,
	getFinalOutput,
	isFailedResult,
	mapWithConcurrencyLimit,
	resultOutput,
	runSingleAgent,
	truncateAggregate,
	truncateParallelOutput,
} from "./subagentHelpers.ts";

const parameters = {
	type: "object",
	properties: {
		agent: { type: "string", description: "Name of the agent to invoke (single mode)" },
		task: { type: "string", description: "Task to delegate (single mode)" },
		tasks: {
			type: "array",
			description: "Parallel tasks: [{ agent, task, cwd? }]",
			items: {
				type: "object",
				properties: { agent: { type: "string" }, task: { type: "string" }, cwd: { type: "string" } },
				required: ["agent", "task"],
			},
		},
		chain: {
			type: "array",
			description: "Sequential chain: [{ agent, task, cwd? }]. {previous} → prior step output. Fail-fast.",
			items: {
				type: "object",
				properties: { agent: { type: "string" }, task: { type: "string" }, cwd: { type: "string" } },
				required: ["agent", "task"],
			},
		},
		cwd: { type: "string", description: "Working directory (single mode)" },
	},
} as const;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks[]), chain (chain[] with {previous} placeholder).",
			"Discovery: profiles/<vida>/agents/ → profiles/agents/ → cwd .pi/agents/ (first-wins).",
			"Children inherit -e damage-control-continue.ts so the safety gate is never bypassed.",
		].join(" "),
		parameters,

		async execute(_id, params, signal, _onUpdate, ctx) {
			const agents = collectAgents(ctx.cwd, import.meta.url);
			const childRoot = harnessRoot();
			const dispatchModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const dispatchThinkingLevel = ctx.thinkingLevel as string | undefined;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails = (
				mode: "single" | "parallel" | "chain",
				results: SingleResult[],
			): SubagentDetails => ({ mode, results });

			if (modeCount !== 1) {
				const available = agents.map((a) => a.name).join(", ") || "none";
				return {
					content: [
						{ type: "text", text: `Invalid parameters. Provide exactly one mode. Available agents: ${available}` },
					],
					details: makeDetails("single", []),
				};
			}

			// The argv builder in subagentHelpers.ts is the single source of truth
			// for the child spawn surface — see buildChildArgv tests.

			const run = (name: string, task: string, cwd: string | undefined, step?: number) =>
				runSingleAgent({
					agents,
					agentName: name,
					task,
					cwd,
					step,
					signal,
					defaultCwd: ctx.cwd,
					harnessRoot: childRoot,
					dispatchModel,
					dispatchThinkingLevel,
				});

			// chain
			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";
				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const task = step.task.replace(/\{previous\}/g, previousOutput);
					const r = await run(step.agent, task, step.cwd, i + 1);
					results.push(r);
					if (isFailedResult(r)) {
						return {
							content: [
								{
									type: "text",
									text: `Chain stopped at step ${i + 1} (${step.agent}): ${resultOutput(r)}`,
								},
							],
							details: makeDetails("chain", results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(r.messages);
				}
				const last = results[results.length - 1];
				return {
					content: [{ type: "text", text: getFinalOutput(last.messages) || "(no output)" }],
					details: makeDetails("chain", results),
				};
			}

			// parallel
			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel", []),
					};
				}
			const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, (t) =>
				run(t.agent, t.task, t.cwd),
			);
			const success = results.filter((r) => !isFailedResult(r)).length;
			const summaries = results.map((r) => {
				const status = isFailedResult(r)
					? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
					: "completed";
				return `### [${r.agent}] ${status}\n\n${truncateParallelOutput(resultOutput(r))}`;
			});
			const body = truncateAggregate(summaries);
			const totalUsage = formatUsageStats(aggregateUsage(results));
			const tail = totalUsage ? `\n\nTotal: ${totalUsage}` : "";
			return {
				content: [
					{
						type: "text",
						text: `Parallel: ${success}/${results.length} succeeded\n\n${body}${tail}`,
					},
				],
				details: makeDetails("parallel", results),
			};
		}

			// single
			if (params.agent && params.task) {
				const r = await run(params.agent, params.task, params.cwd);
				if (isFailedResult(r)) {
					return {
						content: [{ type: "text", text: `Agent ${r.stopReason || "failed"}: ${resultOutput(r)}` }],
						details: makeDetails("single", [r]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(r.messages) || "(no output)" }],
					details: makeDetails("single", [r]),
				};
			}

			return {
				content: [{ type: "text", text: "Invalid parameters." }],
				details: makeDetails("single", []),
			};
		},
	});
}
