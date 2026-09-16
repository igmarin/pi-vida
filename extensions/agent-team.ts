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
 * dispatches. `dispatch_agent(agent, task)` runs a team member as a child `pi`
 * via `subagentHelpers.runSingleAgent` (INV-skills: children ALWAYS inherit
 * `-e damage-control-continue.ts --no-skills`). Only members of the active
 * team may be dispatched — arbitrary agent names are rejected.
 *
 * ## Team discovery
 *
 * Teams live under the `teams:` key of the same `agent-chain.yaml` file the
 * chains use, so `resolveChainFile` precedence applies unchanged:
 * cwd `.pi/agents/` → `profiles/<vida>/agents/` → shared `profiles/agents/`.
 * Active team: `PI_TEAM` env when set, else the `default` team, else the first
 * defined team. `/team-list` shows what is available.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	parseAgentTeams,
	pickTeam,
	resolveChainFile,
	type TeamDef,
} from "./agent-chain.ts";
import { collectAgents, harnessRoot } from "./agentScan.ts";
import {
	aggregateUsage,
	formatUsageStats,
	getFinalOutput,
	isFailedResult,
	resultOutput,
	runSingleAgent,
	drainInflight,
	type SingleResult,
} from "./subagentHelpers.ts";

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
		await drainInflight();
	});
	// Dispatcher-only primary: no read, write, edit, or bash. Mutual exclusion
	// with chain/tilldone is structural — the launcher never loads those
	// extensions in team mode. setActiveTools is an action method: it must run
	// inside an event handler (session_start), not during extension loading.
	pi.on("session_start", async () => {
		pi.setActiveTools(["dispatch_agent"]);
	});

	pi.registerCommand("team-list", {
		description: "List available agent teams (teams: key of agent-chain.yaml)",
		handler: async (_args, ctx) => {
			try {
				const { source, teams } = loadedTeams(ctx.cwd);
				const wanted = process.env.PI_TEAM;
				const active = pickTeam(teams, wanted);
				const lines = [...teams.values()].map(
					(t) =>
						`${t.name === active.name ? "* " : "  "}${t.name} — ${t.description}`,
				);
				const msg = `Teams (${source}, active: ${active.name}):\n${lines.join("\n")}`;
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
