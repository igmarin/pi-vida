/**
 * Per-extension theme + terminal title. First -e wins when stacked.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const THEME_MAP: Record<string, string> = {
	minimal: "synthwave",
	"purpose-gate": "tokyo-night",
	"cross-agent": "ocean-breeze",
	"system-select": "catppuccin-mocha",
	"damage-control-continue": "gruvbox",
};

function extensionName(fileUrl: string): string {
	const filePath = fileUrl.startsWith("file://") ? fileURLToPath(fileUrl) : fileUrl;
	return basename(filePath).replace(/\.[^.]+$/, "");
}

function primaryExtensionName(): string | null {
	const argv = process.argv;
	for (let i = 0; i < argv.length - 1; i++) {
		if (argv[i] === "-e" || argv[i] === "--extension") {
			return basename(argv[i + 1]).replace(/\.[^.]+$/, "");
		}
	}
	return null;
}

export function applyExtensionDefaults(fileUrl: string, ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;

	const name = extensionName(fileUrl);
	const primary = primaryExtensionName();
	if (!primary || primary === name) {
		const themeName = THEME_MAP[name] ?? "synthwave";
		const result = ctx.ui.setTheme(themeName);
		if (!result.success && themeName !== "synthwave") ctx.ui.setTheme("synthwave");
	}

	if (primary) {
		// ponytail: Pi exposes no title hook, so a fixed 150ms timer races Pi's
		// startup title write — on a slow startup (>150ms) the default title wins
		// and this one is lost. Remove when Pi ships a title hook or
		// post-startup event to hang setTitle on.
		setTimeout(() => ctx.ui.setTitle(`π - ${primary}`), 150);
	}
}
