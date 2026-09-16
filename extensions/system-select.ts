/**
 * System Select — /system picks a persona from discovered agents.
 *
 * Search: profiles/<vida>/agents/ (YAML), shared profiles/agents/, cwd .pi/agents/,
 * then .claude/.gemini/.codex (cwd, then $HOME). First-wins on name. Body is prepended
 * to Pi's default instructions; tools restricted if the agent lists them.
 *
 * Usage: pi -e extensions/system-select.ts -e extensions/minimal.ts
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyExtensionDefaults } from "./themeMap.ts";
import { collectAgents, type AgentDef } from "./agentScan.ts";

function displayName(name: string): string {
	return name.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export default function (pi: ExtensionAPI) {
	let activeAgent: AgentDef | null = null;
	let allAgents: AgentDef[] = [];
	let defaultTools: string[] = [];

	function applyAgent(agent: AgentDef | null, ctx: ExtensionContext) {
		activeAgent = agent;
		pi.setActiveTools(agent && agent.tools.length > 0 ? agent.tools : defaultTools);
		if (!ctx.hasUI) return;
		if (!agent) {
			ctx.ui.setStatus("system-prompt", "System Prompt: Default");
			ctx.ui.notify("System Prompt reset to Default", "success");
			return;
		}
		ctx.ui.setStatus("system-prompt", `System Prompt: ${displayName(agent.name)}`);
		ctx.ui.notify(`System Prompt switched to: ${displayName(agent.name)}`, "success");
	}

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		activeAgent = null;
		allAgents = collectAgents(ctx.cwd, import.meta.url);
		defaultTools = pi.getActiveTools();
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("system-prompt", "System Prompt: Default");
		const counts = new Map<string, number>();
		for (const a of allAgents) counts.set(a.source, (counts.get(a.source) || 0) + 1);
		const loaded = [...counts.entries()].map(([src, n]) => `${n} from ${src}`).join(", ");
		const prompt = ctx.getSystemPrompt();
		const lines = [`System Prompt: Default (${prompt.split("\n").length} lines, ${prompt.length} chars)`];
		if (allAgents.length > 0) lines.unshift(`Loaded ${allAgents.length} agents (${loaded})`);
		ctx.ui.notify(lines.join("\n"), "info");
	});

	pi.registerCommand("system", {
		description: "Select a system prompt from discovered agents",
		handler: async (args, ctx) => {
			if (allAgents.length === 0) {
				if (ctx.hasUI) ctx.ui.notify("No agents found in profiles/<vida>/agents or .*/agents", "warning");
				return;
			}

			const raw = args?.trim();
			if (raw) {
				const key = raw.toLowerCase();
				if (key === "default" || key === "reset") {
					applyAgent(null, ctx);
					return;
				}
				const agent = allAgents.find((a) => a.name.toLowerCase() === raw.toLowerCase());
				if (!agent) {
					if (ctx.hasUI) ctx.ui.notify(`No agent named ${raw}`, "warning");
					return;
				}
				applyAgent(agent, ctx);
				return;
			}

			if (!ctx.hasUI) return;

			const options = ["Reset to Default", ...allAgents.map((a) => `${a.name} — ${a.description} [${a.source}]`)];
			const choice = await ctx.ui.select("Select System Prompt", options);
			if (choice === undefined) return;
			if (choice === options[0]) {
				applyAgent(null, ctx);
				return;
			}
			const idx = options.indexOf(choice) - 1;
			if (idx < 0 || idx >= allAgents.length) return;
			applyAgent(allAgents[idx], ctx);
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!activeAgent) return;
		return { systemPrompt: activeAgent.body + "\n\n" + event.systemPrompt };
	});
}
