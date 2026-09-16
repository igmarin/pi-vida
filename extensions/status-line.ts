/**
 * Status Line — turn counter in the footer (solo mode only)
 *
 * Shows turn progress with themed colors:
 *   session_start → " Ready"
 *   turn_start   → "● Turn N..."
 *   turn_end     → "✓ Turn N complete"
 *
 * Usage: loaded by bin/pi-vida for solo mode only. Not wired for chain/team.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyExtensionDefaults } from "./themeMap.ts";

export type TurnState = "ready" | "running" | "done";

export function formatTurnLine(
	state: TurnState,
	turn: number,
	theme: { fg: (colorName: string, text: string) => string },
): string {
	if (state === "ready") return theme.fg("dim", " Ready");
	if (state === "running") {
		return theme.fg("accent", "●") + theme.fg("dim", ` Turn ${turn}...`);
	}
	return theme.fg("success", "✓") + theme.fg("dim", ` Turn ${turn} complete`);
}

export default function (pi: ExtensionAPI) {
	let turnCount = 0;

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("status-line", formatTurnLine("ready", 0, ctx.ui.theme));
	});

	pi.on("turn_start", async (_event, ctx) => {
		turnCount++;
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("status-line", formatTurnLine("running", turnCount, ctx.ui.theme));
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("status-line", formatTurnLine("done", turnCount, ctx.ui.theme));
	});
}
