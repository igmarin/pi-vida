/**
 * Team member bootstrap (issue #79, INV-herdr).
 *
 * Loaded ONLY for Herdr member panes: the bash launcher starts one pane per
 * team member with `PI_VIDA_WORKER=<member>` and a member base argv
 * (`-e damage-control-continue.ts -e capabilities.ts -e team-member.ts
 * --no-skills`) — no boot-config wizard, no clarify-gate (workers are not a
 * second clarify ritual), no agent-team dispatcher.
 *
 * The member resolves its own persona through the same collectAgents
 * discovery as dispatch (first-wins) and applies it:
 * - `before_agent_start` appends the agent body to the system prompt
 *   (same hook shape as capabilities.ts).
 * - `session_start` applies the persona tool list via `setActiveTools`
 *   when tools are configured, plus one info notify.
 * An unknown member name notifies an error and enforces nothing — the pane
 * still works as a plain solo pi. Without PI_VIDA_WORKER both hooks no-op,
 * so stacking the extension is harmless.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collectAgents } from "./agentScan.ts";

export default function (pi: ExtensionAPI) {
	const worker = () => process.env.PI_VIDA_WORKER?.trim() || "";

	pi.on("before_agent_start", async (event, ctx) => {
		const name = worker();
		if (!name) return;
		const agent = collectAgents(ctx.cwd, import.meta.url).find(
			(a) => a.name.toLowerCase() === name.toLowerCase(),
		);
		if (!agent || !agent.body.trim()) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${agent.body}` };
	});

	pi.on("session_start", async (_event, ctx) => {
		const name = worker();
		if (!name) return;
		const agent = collectAgents(ctx.cwd, import.meta.url).find(
			(a) => a.name.toLowerCase() === name.toLowerCase(),
		);
		if (!agent) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`team-member: no persona found for worker '${name}' — running without agent enforcement`,
					"error",
				);
			}
			return;
		}
		if (agent.tools.length > 0) pi.setActiveTools(agent.tools);
		if (ctx.hasUI) {
			ctx.ui.notify(
				`team-member: ${name} (${agent.tools.length ? agent.tools.join(", ") : "no tool override"})`,
				"info",
			);
		}
	});
}
