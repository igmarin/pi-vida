/**
 * Boot Config TUI — first-launch wizard (issue #15).
 *
 * Runs BEFORE capabilities.ts in the `-e` chain. When the project overlay
 * (<cwd>/.pi/capabilities.yaml) does not exist (PI_OVERLAY_EXISTS unset),
 * walks the user through the 6 capability toggles and optional per-role
 * model/thinking defaults, then writes the overlay on explicit confirmation.
 *
 * On confirm the extension:
 * - writes <cwd>/.pi/capabilities.yaml (yaml stringify, re-parsed by
 *   parseOverlayDoc on every later launch)
 * - updates process.env.PI_OVERLAY so capabilities.ts (loaded after this
 *   extension) reads the fresh overlay in the same session
 * - applies the solo model/thinking immediately via pi.setModel /
 *   pi.setThinkingLevel
 *
 * Any cancelled dialog (undefined) skips that step. Profile YAML parse
 * failure skips model config only. Without a file the session continues
 * all-off (empty overlay).
 *
 * Pure helpers are exported for boot-config.test.ts.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { parse, stringify } from "yaml";
import {
	asRoleMap,
	asThinkingMap,
	CAPABILITY_KEYS,
	type CapabilityKey,
	isThinkingLevelName,
	mergeRoleMaps,
	overlayFromEnv,
	type Overlay,
	ROLE_KEYS,
	serializeOverlayEnv,
	THINKING_LEVELS,
} from "./capabilities.ts";

export interface ProfileModelDefaults {
	models?: Record<string, string>;
	thinking?: Record<string, string>;
}

/**
 * Extract optional models/thinking defaults from a parsed profile YAML doc.
 * Delegates to the shared role-map/thinking validators so profiles, overlays,
 * and the env payload enforce one contract. Throws on malformed values —
 * the caller skips model config on throw.
 */
export function extractProfileModelDefaults(
	doc: unknown,
): ProfileModelDefaults {
	if (doc == null || typeof doc !== "object" || Array.isArray(doc)) return {};
	const raw = doc as Record<string, unknown>;
	const models = asRoleMap(raw.models, "models", "profile");
	const thinking = asThinkingMap(raw.thinking, "thinking", "profile");
	const out: ProfileModelDefaults = {};
	if (models) out.models = models;
	if (thinking) out.thinking = thinking;
	return out;
}

/**
 * Resolve a "provider/model" (or bare, unambiguous model id) reference
 * against the registry model list. Exact canonical match first; a bare id
 * must be unambiguous across providers.
 */
export function findModelByReference<
	T extends { id: string; provider: string },
>(reference: string, models: ReadonlyArray<T>): T | undefined {
	const ref = reference.trim();
	if (!ref) return undefined;
	const canonical = models.find((m) => `${m.provider}/${m.id}` === ref);
	if (canonical) return canonical;
	const bare = models.filter((m) => m.id === ref);
	return bare.length === 1 ? bare[0] : undefined;
}

/** Build the YAML doc object for .pi/capabilities.yaml. */
export function buildOverlayDoc(
	caps: Record<string, boolean>,
	models?: Record<string, string>,
	thinking?: Record<string, string>,
): Record<string, unknown> {
	const doc: Record<string, unknown> = { ...caps };
	if (models && Object.keys(models).length > 0) doc.models = models;
	if (thinking && Object.keys(thinking).length > 0) doc.thinking = thinking;
	return doc;
}

function readProfileDefaults(ctx: ExtensionContext): ProfileModelDefaults {
	const home = process.env.PI_VIDA_HOME || process.env.PI_LIFE_HOME || process.env.MY_PI_AGENT_HOME;
	const life = process.env.PI_VIDA || process.env.PI_LIFE;
	if (!home || !life) return {};
	const profilePath = path.join(home, "profiles", `${life}.yaml`);
	try {
		const doc = parse(readFileSync(profilePath, "utf8")) as unknown;
		return extractProfileModelDefaults(doc);
	} catch (err) {
		// Missing profile is a normal no-defaults state (e.g. direct `pi -e`
		// launches); only real parse/schema failures are worth surfacing.
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
		const message = err instanceof Error ? err.message : String(err);
		if (ctx.hasUI)
			ctx.ui.notify(
				`boot-config: skipping model config (${message})`,
				"warning",
			);
		return {};
	}
}

async function askCapabilities(
	ctx: ExtensionContext,
): Promise<Record<string, boolean>> {
	const caps: Record<string, boolean> = {};
	for (const key of CAPABILITY_KEYS) {
		const answer = await ctx.ui.select(`Enable ${key}?`, ["off", "on"]);
		if (answer === undefined) continue;
		caps[key] = answer === "on";
	}
	return caps;
}

async function askModels(
	ctx: ExtensionContext,
	defaults: ProfileModelDefaults,
): Promise<ProfileModelDefaults> {
	const configure = await ctx.ui.confirm(
		"Configure model per role?",
		"Sets model and thinking level for solo/planner/builder/reviewer/researcher. Cancel any prompt to keep pi defaults.",
	);
	if (!configure) return {};
	const models: Record<string, string> = { ...(defaults.models ?? {}) };
	const thinking: Record<string, string> = { ...(defaults.thinking ?? {}) };
	for (const role of ROLE_KEYS) {
		const answer = await ctx.ui.input(
			`Model for ${role}`,
			defaults.models?.[role] ?? "provider/model",
		);
		if (answer === undefined) continue;
		const trimmed = answer.trim();
		if (!trimmed) {
			delete models[role];
			delete thinking[role];
			continue;
		}
		models[role] = trimmed;
		const level = await ctx.ui.select(`Thinking level for ${role}`, [
			"(none)",
			...THINKING_LEVELS,
		]);
		if (level === undefined || level === "(none)") {
			delete thinking[role];
		} else {
			thinking[role] = level;
		}
	}
	return {
		models: Object.keys(models).length > 0 ? models : undefined,
		thinking: Object.keys(thinking).length > 0 ? thinking : undefined,
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (_event, ctx) => {
		if (process.env.PI_OVERLAY_EXISTS === "1") return;
		if (!ctx.hasUI) return;

		const caps = await askCapabilities(ctx);
		const modelDefaults = readProfileDefaults(ctx);
		const configured = await askModels(ctx, modelDefaults);

		const save = await ctx.ui.confirm(
			"Save configuration to .pi/capabilities.yaml?",
			"Saves capability toggles" +
				(configured.models ? ", models" : "") +
				(configured.thinking ? ", thinking" : "") +
				" for this project.",
		);
		if (!save) {
			if (ctx.hasUI)
				ctx.ui.notify(
					"boot-config: not saved; session continues with all-off capabilities.",
					"warning",
				);
			return;
		}

		const overlayDoc = buildOverlayDoc(
			caps,
			configured.models,
			configured.thinking,
		);
		const overlayPath = path.join(ctx.cwd, ".pi", "capabilities.yaml");
		try {
			mkdirSync(path.dirname(overlayPath), { recursive: true });
			writeFileSync(overlayPath, stringify(overlayDoc), "utf8");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(
				`boot-config: failed to write ${overlayPath}: ${message}`,
				"error",
			);
			return;
		}

		// Re-serialize through the canonical helper so capabilities.ts (loaded
		// after this extension) reads the same payload the launcher would have
		// written, and mark the overlay as existing for future handlers.
		const overlay: Overlay = {
			capabilities: Object.freeze({ ...caps }) as Record<
				CapabilityKey,
				boolean
			>,
			extraSkills: [],
			trackerSkill: null,
			models: configured.models,
			thinking: configured.thinking,
		};
		// The launcher's PI_OVERLAY already carries profile role maps merged
		// in — keep them as the base under whatever the wizard just saved so
		// first-launch sessions don't lose child-dispatch defaults. A malformed
		// env (standalone extension load) just means no base.
		const prior = overlayFromEnv();
		process.env.PI_OVERLAY = serializeOverlayEnv(
			mergeRoleMaps(overlay, prior?.models ?? {}, prior?.thinking ?? {}),
		);
		process.env.PI_OVERLAY_EXISTS = "1";

		// Apply solo model/thinking immediately. Model resolution needs the
		// registry; failures warn and never block the session.
		const soloModel = configured.models?.solo;
		if (soloModel) {
			const match = findModelByReference(
				soloModel,
				ctx.modelRegistry.getAvailable(),
			);
			if (match) {
				const ok = await pi.setModel(match);
				if (!ok && ctx.hasUI)
					ctx.ui.notify(
						`boot-config: no auth configured for ${soloModel}`,
						"warning",
					);
			} else if (ctx.hasUI) {
				ctx.ui.notify(
					`boot-config: model ${soloModel} not found; takes effect via --model on next launch`,
					"warning",
				);
			}
		}
		const soloThinking = configured.thinking?.solo;
		if (soloThinking && isThinkingLevelName(soloThinking)) {
			pi.setThinkingLevel(soloThinking);
		}
		if (ctx.hasUI) ctx.ui.notify(`boot-config: saved ${overlayPath}`, "info");
	});
}
