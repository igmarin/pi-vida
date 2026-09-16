/**
 * Tests for boot-config (issue #15).
 *
 * Pure helpers cover profile default extraction, model reference resolution,
 * thinking-level validation, and overlay doc construction. The
 * before_agent_start wizard flow is exercised with a mocked ctx.ui so the
 * confirm-writes / reject-does-not-write / existing-overlay-skips behavior
 * is testable headlessly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import bootConfig, {
	buildOverlayDoc,
	extractProfileModelDefaults,
	findModelByReference,
} from "./boot-config.ts";
import {
	CAPABILITY_KEYS,
	deserializeOverlayEnv,
	isThinkingLevelName,
	parseOverlayDoc,
	serializeOverlayEnv,
} from "./capabilities.ts";

describe("extractProfileModelDefaults", () => {
	test("returns empty for absent keys", () => {
		expect(extractProfileModelDefaults({ vida: "ruby" })).toEqual({});
		expect(extractProfileModelDefaults(null)).toEqual({});
	});

	test("extracts models and thinking maps", () => {
		const doc = parse(`
vida: ruby
models:
  solo: openrouter/z-ai/glm-5.3-flash
  reviewer: openrouter/other
thinking:
  solo: medium
`);
		expect(extractProfileModelDefaults(doc)).toEqual({
			models: {
				solo: "openrouter/z-ai/glm-5.3-flash",
				reviewer: "openrouter/other",
			},
			thinking: { solo: "medium" },
		});
	});

	test("throws on malformed values", () => {
		expect(() => extractProfileModelDefaults({ models: "solo" })).toThrow(
			/models must be a mapping/,
		);
		expect(() => extractProfileModelDefaults({ models: { solo: 42 } })).toThrow(
			/models\.solo must be a non-empty string/,
		);
		expect(() =>
			extractProfileModelDefaults({ thinking: { solo: null } }),
		).toThrow(/thinking\.solo must be a non-empty string/);
		expect(() => extractProfileModelDefaults({ models: ["solo"] })).toThrow(
			/models must be a mapping/,
		);
	});

	test("rejects unknown roles and invalid thinking levels (shared contract)", () => {
		expect(() =>
			extractProfileModelDefaults({ models: { sol: "openrouter/x" } }),
		).toThrow(/models\.sol is not a known role/);
		expect(() =>
			extractProfileModelDefaults({ thinking: { solo: "highh" } }),
		).toThrow(/thinking\.solo must be a thinking level/);
	});

	test("ignores non-object doc shapes", () => {
		expect(extractProfileModelDefaults("nope")).toEqual({});
		expect(extractProfileModelDefaults([1])).toEqual({});
	});
});

describe("findModelByReference", () => {
	const models = [
		{ id: "glm-5.3-flash", provider: "openrouter" },
		{ id: "glm-5.3-flash", provider: "zai" },
		{ id: "claude-sonnet-4-5", provider: "anthropic" },
	];

	test("canonical provider/id match wins", () => {
		expect(findModelByReference("openrouter/glm-5.3-flash", models)).toEqual({
			id: "glm-5.3-flash",
			provider: "openrouter",
		});
		expect(findModelByReference("anthropic/claude-sonnet-4-5", models)).toEqual(
			{
				id: "claude-sonnet-4-5",
				provider: "anthropic",
			},
		);
	});

	test("bare id resolves only when unambiguous", () => {
		expect(findModelByReference("claude-sonnet-4-5", models)).toEqual({
			id: "claude-sonnet-4-5",
			provider: "anthropic",
		});
		expect(findModelByReference("glm-5.3-flash", models)).toBeUndefined();
	});

	test("no match and empty reference return undefined", () => {
		expect(findModelByReference("openrouter/nope", models)).toBeUndefined();
		expect(findModelByReference("", models)).toBeUndefined();
		expect(findModelByReference("  ", models)).toBeUndefined();
	});
});

describe("isThinkingLevelName", () => {
	test("accepts the seven pi levels and rejects anything else", () => {
		for (const level of [
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]) {
			expect(isThinkingLevelName(level)).toBe(true);
		}
		expect(isThinkingLevelName("medium-ish")).toBe(false);
		expect(isThinkingLevelName("")).toBe(false);
		expect(isThinkingLevelName("HIGH")).toBe(false);
	});
});

describe("buildOverlayDoc", () => {
	test("includes capabilities and omits empty models/thinking", () => {
		const doc = buildOverlayDoc({ graphify: true, "rs-guard": false });
		expect(doc).toEqual({ graphify: true, "rs-guard": false });
	});

	test("includes models/thinking when non-empty", () => {
		const doc = buildOverlayDoc(
			{ graphify: false },
			{ solo: "openrouter/z-ai/glm-5.3-flash" },
			{ solo: "medium" },
		);
		expect(doc).toEqual({
			graphify: false,
			models: { solo: "openrouter/z-ai/glm-5.3-flash" },
			thinking: { solo: "medium" },
		});
	});

	test("written doc re-parses to the same overlay via parseOverlayDoc", () => {
		const doc = buildOverlayDoc(
			{ graphify: true, codegraph: false },
			{ solo: "openrouter/z-ai/glm-5.3-flash" },
			{ solo: "high" },
		);
		const overlay = parseOverlayDoc(parse(JSON.stringify(doc)));
		expect(overlay.capabilities.graphify).toBe(true);
		expect(overlay.models).toEqual({ solo: "openrouter/z-ai/glm-5.3-flash" });
		expect(overlay.thinking).toEqual({ solo: "high" });
		const envPayload = serializeOverlayEnv(overlay);
		expect(envPayload).toContain(
			'"models":{"solo":"openrouter/z-ai/glm-5.3-flash"}',
		);
	});
});

/**
 * Wizard-flow tests: the default export registers a before_agent_start
 * handler; invoking it with a mocked ExtensionContext exercises the full
 * confirm / reject / skip paths without a real TUI.
 */

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function loadHandler(): Handler {
	let handler: Handler | undefined;
	const pi = {
		on: (event: string, fn: Handler) => {
			if (event === "before_agent_start") handler = fn;
		},
		setModel: async () => true,
		setThinkingLevel: () => {},
	};
	bootConfig(pi as never);
	if (!handler) throw new Error("before_agent_start handler not registered");
	return handler;
}

interface UiScript {
	select?: (title: string) => Promise<string | undefined>;
	confirm?: (title: string) => Promise<boolean>;
	input?: (title: string) => Promise<string | undefined>;
	notify?: (message: string, type?: string) => void;
}

function makeCtx(ui: UiScript, cwd: string) {
	return {
		hasUI: true,
		ui: {
			select: ui.select ?? (async () => "off"),
			confirm: ui.confirm ?? (async () => true),
			input: ui.input ?? (async () => ""),
			notify: ui.notify ?? (() => {}),
		},
		cwd,
		modelRegistry: { getAvailable: () => [] },
	};
}

describe("boot-config wizard flow", () => {
	const envKeys = ["PI_OVERLAY", "PI_OVERLAY_EXISTS", "PI_VIDA_HOME", "PI_LIFE_HOME", "MY_PI_AGENT_HOME", "PI_VIDA", "PI_LIFE"] as const;
	let savedEnv: Record<string, string | undefined>;
	let cwd = "";

	beforeEach(() => {
		savedEnv = {};
		for (const k of envKeys) {
			savedEnv[k] = process.env[k];
			delete process.env[k];
		}
		cwd = mkdtempSync(join(tmpdir(), "boot-config-test-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		for (const k of envKeys) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
	});

	test("confirmation writes the overlay and exports the env payload", async () => {
		const handler = loadHandler();
		const selects: string[] = [];
		await handler(
			{},
			makeCtx(
				{
					select: async (title) => {
						selects.push(title);
						return "off";
					},
					// [configure-models -> no, save -> yes]
					confirm: async () => true,
				},
				cwd,
			) as never,
		);
		expect(selects).toHaveLength(CAPABILITY_KEYS.length);
		const overlayPath = join(cwd, ".pi", "capabilities.yaml");
		expect(existsSync(overlayPath)).toBe(true);
		const overlay = parseOverlayDoc(parse(readFileSync(overlayPath, "utf8")));
		for (const k of CAPABILITY_KEYS) expect(overlay.capabilities[k]).toBe(false);
		expect(overlay.models).toBeUndefined();
		expect(overlay.thinking).toBeUndefined();
		expect(process.env.PI_OVERLAY_EXISTS).toBe("1");
		expect(process.env.PI_OVERLAY).toContain('"graphify":false');
	});

	test("save keeps launcher-merged role maps under the wizard's selections", async () => {
		// The launcher merges profile role maps into PI_OVERLAY before the
		// wizard runs; the save must not drop them.
		process.env.PI_OVERLAY = serializeOverlayEnv({
			capabilities: Object.freeze({}) as never,
			extraSkills: [],
			trackerSkill: null,
			models: { planner: "profile-model" },
			thinking: { builder: "high" },
		});
		const handler = loadHandler();
		await handler(
			{},
			makeCtx({ confirm: async () => true }, cwd) as never,
		);
		const merged = deserializeOverlayEnv(process.env.PI_OVERLAY ?? "");
		expect(merged.models?.planner).toBe("profile-model");
		expect(merged.thinking?.builder).toBe("high");
	});

	test("wizard values win over launcher-merged role maps", async () => {
		process.env.PI_OVERLAY = serializeOverlayEnv({
			capabilities: Object.freeze({}) as never,
			extraSkills: [],
			trackerSkill: null,
			models: { planner: "prior-model" },
		});
		const handler = loadHandler();
		await handler(
			{},
			makeCtx(
				{
					confirm: async () => true,
					input: async (title) =>
						title.includes("planner") ? "wiz-model" : "",
					select: async (title) =>
						title.includes("Thinking") ? "(none)" : "off",
				},
				cwd,
			) as never,
		);
		const merged = deserializeOverlayEnv(process.env.PI_OVERLAY ?? "");
		expect(merged.models?.planner).toBe("wiz-model");
	});

	test("rejection does not write the overlay", async () => {
		const handler = loadHandler();
		const notifies: string[] = [];
		await handler(
			{},
			makeCtx(
				{
					// [configure-models -> no, save -> no]
					confirm: async () => false,
					notify: (message) => notifies.push(message),
				},
				cwd,
			) as never,
		);
		expect(existsSync(join(cwd, ".pi", "capabilities.yaml"))).toBe(false);
		expect(process.env.PI_OVERLAY_EXISTS).toBeUndefined();
		expect(process.env.PI_OVERLAY).toBeUndefined();
		expect(notifies.join("\n")).toContain("not saved");
	});

	test("an existing overlay skips the wizard entirely", async () => {
		process.env.PI_OVERLAY_EXISTS = "1";
		const handler = loadHandler();
		let prompted = false;
		await handler(
			{},
			makeCtx(
				{
					select: async () => {
						prompted = true;
						return "off";
					},
					confirm: async () => true,
				},
				cwd,
			) as never,
		);
		expect(prompted).toBe(false);
		expect(existsSync(join(cwd, ".pi", "capabilities.yaml"))).toBe(false);
	});

	test("no UI available skips the wizard entirely", async () => {
		const handler = loadHandler();
		let prompted = false;
		const ctx = makeCtx(
			{
				select: async () => {
					prompted = true;
					return "off";
				},
			},
			cwd,
		) as { hasUI: boolean; ui: unknown; cwd: string; modelRegistry: unknown };
		ctx.hasUI = false;
		await handler({}, ctx as never);
		expect(prompted).toBe(false);
		expect(existsSync(join(cwd, ".pi", "capabilities.yaml"))).toBe(false);
	});
});
