/**
 * Capabilities — pure helpers for the project overlay.
 *
 * The overlay is `<cwd>/.pi/capabilities.yaml`. Missing file ≡ all off.
 * The parser is strict: a non-mapping top-level value, an unknown key, or a
 * non-boolean capability throws (the caller in `bin/pi-vida` exits 2 on throw).
 *
 * Pure: no I/O, no `process.cwd()`. The caller passes the file contents.
 *
 * The default export below is the prompt-gate entry point wired in bin/pi-vida.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CAPABILITY_KEYS = [
	"graphify",
	"codegraph",
	"serena",
	"rs-guard",
	"obscura",
	"playwright",
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/** Roles the boot-config TUI can configure models/thinking for (issue #15). */
export const ROLE_KEYS = [
	"solo",
	"planner",
	"builder",
	"reviewer",
	"researcher",
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

export interface Overlay {
	capabilities: Record<CapabilityKey, boolean>;
	extraSkills: string[];
	trackerSkill: string | null;
	/** role → "provider/model" (issue #15). Absent when unset. */
	models?: Record<string, string>;
	/** role → thinking level (issue #15). Absent when unset. */
	thinking?: Record<string, string>;
}

export const EMPTY_OVERLAY: Overlay = {
	capabilities: Object.freeze(
		Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, false])) as Record<
			CapabilityKey,
			boolean
		>,
	),
	extraSkills: Object.freeze([]) as string[],
	trackerSkill: null,
	models: undefined,
	thinking: undefined,
};

export class OverlayParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OverlayParseError";
	}
}

function isPlainMapping(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function asBool(value: unknown, key: string): boolean {
	if (typeof value === "boolean") return value;
	throw new OverlayParseError(
		`overlay: ${key} must be a boolean (got ${typeof value})`,
	);
}

function asStringList(value: unknown, key: string): string[] {
	if (value == null) return [];
	if (!Array.isArray(value)) {
		throw new OverlayParseError(
			`overlay: ${key} must be a list of non-empty strings (got ${typeof value})`,
		);
	}
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || !item) {
			throw new OverlayParseError(
				`overlay: ${key} must be a list of non-empty strings`,
			);
		}
		out.push(item);
	}
	return out;
}

function asNullableString(value: unknown, key: string): string | null {
	if (value == null) return null;
	if (typeof value !== "string" || !value) {
		throw new OverlayParseError(`overlay: ${key} must be a non-empty string`);
	}
	return value;
}

/**
 * Validate a role → string map against the closed ROLE_KEYS set. Shared by
 * the overlay parser, the env deserializer, boot-config profile extraction,
 * and the launcher's profile rows — one contract, one error vocabulary.
 * Fail closed on empty roles, non-string values, and unknown roles (a
 * misspelled role would otherwise be silently ignored at launch).
 */
export function asRoleMap(
	value: unknown,
	key: string,
	prefix = "overlay",
): Record<string, string> | undefined {
	if (value == null) return undefined;
	if (!isPlainMapping(value)) {
		throw new OverlayParseError(
			`${prefix}: ${key} must be a mapping of role → string`,
		);
	}
	const out: Record<string, string> = {};
	for (const [role, v] of Object.entries(value)) {
		if (!(ROLE_KEYS as readonly string[]).includes(role)) {
			throw new OverlayParseError(
				`${prefix}: ${key}.${role} is not a known role (${ROLE_KEYS.join(", ")})`,
			);
		}
		if (typeof v !== "string" || !v) {
			throw new OverlayParseError(
				`${prefix}: ${key}.${role} must be a non-empty string`,
			);
		}
		out[role] = v;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** As `asRoleMap`, but the values must be valid pi thinking levels. */
export function asThinkingMap(
	value: unknown,
	key: string,
	prefix = "overlay",
): Record<string, string> | undefined {
	const map = asRoleMap(value, key, prefix);
	if (map == null) return undefined;
	for (const [role, level] of Object.entries(map)) {
		if (!isThinkingLevelName(level)) {
			throw new OverlayParseError(
				`${prefix}: ${key}.${role} must be a thinking level (${THINKING_LEVELS.join(", ")})`,
			);
		}
	}
	return map;
}

export function isThinkingLevelName(value: string): value is ThinkingLevelName {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Parse a YAML-parsed overlay object. The `yaml` package is the only consumer
 * and it gives us `unknown` per parse(). The caller passes the parsed value.
 */
export function parseOverlayDoc(doc: unknown): Overlay {
	if (doc == null) return cloneEmpty();
	if (!isPlainMapping(doc)) {
		throw new OverlayParseError("overlay: expected a mapping at the top level");
	}

	const known = new Set<string>([
		...CAPABILITY_KEYS,
		"extra_skills",
		"tracker",
		"models",
		"thinking",
	]);
	const unknown: string[] = [];
	for (const k of Object.keys(doc)) {
		if (k === "tracker") continue;
		if (!known.has(k)) unknown.push(k);
	}
	if (unknown.length > 0) {
		throw new OverlayParseError(
			`overlay: unknown key(s): ${unknown.join(", ")}`,
		);
	}

	const caps = {} as Record<CapabilityKey, boolean>;
	for (const k of CAPABILITY_KEYS) {
		caps[k] = k in doc ? asBool(doc[k], k) : false;
	}

	const trackerRaw = doc.tracker;
	let trackerSkill: string | null = null;
	if (isPlainMapping(trackerRaw)) {
		const trackerUnknown: string[] = [];
		for (const k of Object.keys(trackerRaw)) {
			if (k !== "skill") trackerUnknown.push(k);
		}
		if (trackerUnknown.length > 0) {
			throw new OverlayParseError(
				`overlay: tracker has unknown key(s): ${trackerUnknown.join(", ")}`,
			);
		}
		if (!("skill" in trackerRaw)) {
			throw new OverlayParseError(
				"overlay: tracker requires a 'skill' key when present",
			);
		}
		trackerSkill = asNullableString(trackerRaw.skill, "tracker.skill");
	} else if (trackerRaw != null) {
		throw new OverlayParseError(
			"overlay: tracker must be a mapping with a 'skill' key",
		);
	}

	const extraSkills = asStringList(doc.extra_skills, "extra_skills");
	const models = asRoleMap(doc.models, "models");
	const thinking = asThinkingMap(doc.thinking, "thinking");

	return {
		capabilities: Object.freeze(caps),
		extraSkills: Object.freeze(extraSkills),
		trackerSkill,
		models,
		thinking,
	};
}

function cloneEmpty(): Overlay {
	return {
		capabilities: Object.freeze(
			Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, false])) as Record<
				CapabilityKey,
				boolean
			>,
		),
		extraSkills: Object.freeze([]) as string[],
		trackerSkill: null,
		models: undefined,
		thinking: undefined,
	};
}

/**
 * Build the prompt section that lists the active capabilities. Returns "" when
 * nothing is on, so the caller can skip the rewrite entirely.
 */
export function buildCapabilitiesSection(overlay: Overlay): string {
	const on: CapabilityKey[] = CAPABILITY_KEYS.filter(
		(k) => overlay.capabilities[k],
	);
	if (
		on.length === 0 &&
		overlay.extraSkills.length === 0 &&
		overlay.trackerSkill == null
	) {
		return "";
	}
	const lines: string[] = [
		"<capabilities>",
		"Capabilities enabled for this project (per .pi/capabilities.yaml):",
	];
	for (const k of on) lines.push(`- ${k}: on`);
	if (overlay.extraSkills.length > 0) {
		lines.push(`- extra skills: ${overlay.extraSkills.join(", ")}`);
	}
	if (overlay.trackerSkill != null) {
		lines.push(`- tracker skill: ${overlay.trackerSkill}`);
	}
	lines.push(
		"Capabilities not listed are off; do not propose or invoke them.",
		"</capabilities>",
	);
	return lines.join("\n");
}

/**
 * Serialize an overlay to the env-var payload that `extensions/capabilities.ts`
 * reads. Stable JSON so the extension does not need a YAML parser.
 */
export function serializeOverlayEnv(overlay: Overlay): string {
	return JSON.stringify({
		capabilities: overlay.capabilities,
		extraSkills: overlay.extraSkills,
		trackerSkill: overlay.trackerSkill,
		models: overlay.models,
		thinking: overlay.thinking,
	});
}

/**
 * Merge profile-level `models:`/`thinking:` role maps under the overlay's:
 * overlay entries win per role, profile entries fill the gaps. The launcher
 * calls this so PI_OVERLAY carries the resolved role maps and children
 * dispatch from it (live merge). Keys absent from both sides stay `undefined`
 * so the fast-path payload stays stable.
 */
export function mergeRoleMaps(
	overlay: Overlay,
	baseModels: Record<string, string> = {},
	baseThinking: Record<string, string> = {},
): Overlay {
	const models = { ...baseModels, ...(overlay.models ?? {}) };
	const thinking = { ...baseThinking, ...(overlay.thinking ?? {}) };
	return {
		...overlay,
		models: Object.keys(models).length ? models : undefined,
		thinking: Object.keys(thinking).length ? thinking : undefined,
	};
}

/**
 * Inverse of `serializeOverlayEnv`. The extension calls this at session start.
 * Throws OverlayParseError on a malformed payload (should never happen because
 * the launcher wrote it; defensive only).
 */
export function deserializeOverlayEnv(payload: string): Overlay {
	if (payload == null || payload === "") return cloneEmpty();
	const doc = JSON.parse(payload) as unknown;
	if (!isPlainMapping(doc)) {
		throw new OverlayParseError("PI_OVERLAY: expected a JSON object");
	}
	const caps = doc.capabilities;
	if (!isPlainMapping(caps)) {
		throw new OverlayParseError("PI_OVERLAY: capabilities must be an object");
	}
	const out = {} as Record<CapabilityKey, boolean>;
	for (const k of CAPABILITY_KEYS) {
		const v = caps[k];
		if (v === undefined) {
			out[k] = false;
		} else if (typeof v === "boolean") {
			out[k] = v;
		} else {
			throw new OverlayParseError(
				`PI_OVERLAY: capabilities.${k} must be a boolean`,
			);
		}
	}
	const rawExtra = doc.extraSkills;
	const extraSkills = Array.isArray(rawExtra)
		? rawExtra.map((s) => {
				if (typeof s !== "string")
					throw new OverlayParseError(
						"PI_OVERLAY: extraSkills must be strings",
					);
				return s;
			})
		: [];
	const rawTracker = doc.trackerSkill;
	let trackerSkill: string | null;
	if (rawTracker == null) {
		trackerSkill = null;
	} else if (typeof rawTracker === "string" && rawTracker) {
		trackerSkill = rawTracker;
	} else {
		throw new OverlayParseError(
			"PI_OVERLAY: trackerSkill must be a non-empty string or null",
		);
	}
	const models = asRoleMap(doc.models, "models", "PI_OVERLAY");
	const thinking = asThinkingMap(doc.thinking, "thinking", "PI_OVERLAY");
	return {
		capabilities: Object.freeze(out),
		extraSkills: Object.freeze(extraSkills),
		trackerSkill,
		models,
		thinking,
	};
}

/** Read PI_OVERLAY at runtime (child dispatch + capability gate).
 * Returns `undefined` on a malformed payload: the launcher wrote it and
 * capabilities.ts surfaces parse errors at prompt time, so dispatch just
 * falls back to the primary's model/thinking instead of failing the child. */
export function overlayFromEnv(): Overlay | undefined {
	try {
		return deserializeOverlayEnv(process.env.PI_OVERLAY ?? "");
	} catch {
		return undefined;
	}
}

/**
 * Capability prompt-gate — reads PI_OVERLAY (JSON, written by bin/pi-vida) and
 * appends a `<capabilities>` section to the system prompt at before_agent_start
 * when anything is on. With everything off, the system prompt is left alone —
 * the model never sees a capability that is not enabled for the project.
 *
 * bin/pi-vida parses `<cwd>/.pi/capabilities.yaml` and exports the result.
 * If the file is missing, it exports EMPTY_OVERLAY (all off), so the gate is a
 * no-op. If the file is malformed, bin/pi-vida exits 2 before pi is launched
 * (fail closed, per issue #11 acceptance criteria).
 *
 * Usage: pi -e extensions/capabilities.ts
 */

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const payload = process.env.PI_OVERLAY ?? "";
		let overlay: Overlay;
		try {
			overlay = deserializeOverlayEnv(payload);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`capabilities: ${message}`);
		}
		const section = buildCapabilitiesSection(overlay);
		if (!section) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${section}` };
	});
}
