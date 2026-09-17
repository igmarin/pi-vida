/**
 * Extension contract sweep (issue #103) — static invariants over
 * extensions/*.ts, same style as fusion-harness's orchestration-contract.
 *
 *   1. Every extension exports `export default function (pi` — Pi's entry
 *      contract; a missing/renamed default export fails at load, not in CI.
 *   2. `ctx.ui` is only touched where a `ctx.hasUI` guard dominates — print/
 *      JSON mode has no TUI, so an unguarded call crashes headless launches.
 *      Limit: the check is textual — `hasUI` anywhere in the enclosing
 *      function counts as a guard (a non-dominating mention passes), and
 *      destructured `const { ui } = ctx` uses are invisible to the sweep.
 *   3. Launcher `-e` order invariants in libexec/pi-vida-launch:
 *      damage-control-continue first (INV-skills), boot-config before
 *      capabilities (the wizard must update PI_OVERLAY before it is read).
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const extDir = import.meta.dir;
const files = readdirSync(extDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
const sources = new Map(files.map((f) => [f, readFileSync(join(extDir, f), "utf8")]));

// Imported by extensions, never loaded via `pi -e` — no default export.
const HELPERS = new Set([
	"agentScan.ts",
	"argExpand.ts",
	"installed-skills.ts",
	"subagentHelpers.ts",
	"themeMap.ts",
]);
const extensions = files.filter((f) => !HELPERS.has(f));

/** Is the `{` at `open` a function body? Arrows end `=>`; functions/methods
 *  end `)` (optionally `: ReturnType`) whose matching `(` is not led by a
 *  control-flow keyword. */
function isFunctionBrace(src: string, open: number): boolean {
	const head = src.slice(0, open);
	if (/=>\s*$/.test(head)) return true;
	if (!/\)\s*(?::\s*[^;{}]*)?$/.test(head)) return false;
	const close = head.lastIndexOf(")");
	let depth = 0;
	for (let i = close; i >= 0; i--) {
		if (head[i] === ")") depth++;
		else if (head[i] === "(") {
			if (--depth === 0) {
				const kw = head.slice(0, i).match(/([A-Za-z_$][\w$]*)\s*$/)?.[1];
				return !(kw === "if" || kw === "while" || kw === "for" || kw === "switch" || kw === "catch");
			}
		}
	}
	return false;
}

/** True when a `hasUI` guard sits between the enclosing function's `{` and
 *  the `ctx.ui` use at `idx` (guards dominate textually in every extension:
 *  early returns and `if (ctx.hasUI)` prefixes). */
function hasUiGuard(src: string, idx: number): boolean {
	let pos = idx;
	for (;;) {
		let depth = 0;
		let open = -1;
		for (let i = pos - 1; i >= 0; i--) {
			if (src[i] === "}") depth++;
			else if (src[i] === "{") {
				if (depth === 0) {
					open = i;
					break;
				}
				depth--;
			}
		}
		if (open < 0) return false;
		if (isFunctionBrace(src, open)) return /\bhasUI\b/.test(src.slice(open, idx));
		pos = open;
	}
}

// Wizard helpers (askCapabilities/askModels) call ctx.ui without a local
// guard — the only call site is behind the before_agent_start handler's
// `if (!ctx.hasUI) return`. Listed as file → unguarded-use count so a new
// unguarded use still fails the sweep.
const KNOWN_UNGUARDED = new Map([["boot-config.ts", 4]]);

describe("extension contract", () => {
	test("every extension exports `export default function (pi`", () => {
		for (const f of extensions) {
			expect(sources.get(f), f).toMatch(/export default function \(pi[):]/);
		}
	});

	test("HELPERS lists real modules and stays honest (no default export)", () => {
		for (const f of HELPERS) {
			expect(files, f).toContain(f);
			expect(sources.get(f), f).not.toMatch(/export default function/);
		}
	});

	test("ctx.ui is only touched behind a ctx.hasUI guard", () => {
		const unguarded = new Map<string, number>();
		for (const [file, src] of sources) {
			for (const m of src.matchAll(/ctx\??\.ui\./g)) {
				if (!hasUiGuard(src, m.index!)) unguarded.set(file, (unguarded.get(file) ?? 0) + 1);
			}
		}
		expect(unguarded).toEqual(KNOWN_UNGUARDED);
	});
});

describe("launch order (libexec/pi-vida-launch)", () => {
	const launcher = readFileSync(join(extDir, "..", "libexec", "pi-vida-launch"), "utf8");

	test("solo argv: damage-control first, boot-config before capabilities", () => {
		const solo = launcher.match(/pi_args=\((-e [^)]*)\)/)?.[1] ?? "";
		const exts = [...solo.matchAll(/extensions\/([\w.-]+\.ts)/g)].map((m) => m[1]);
		expect(exts.slice(0, 4)).toEqual([
			"damage-control-continue.ts",
			"boot-config.ts",
			"capabilities.ts",
			"clarify-gate.ts",
		]);
	});

	test("member base argv: damage-control first, no boot-config", () => {
		const member = launcher.match(/member_base_args\(\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
		const exts = [...member.matchAll(/extensions\/([\w.-]+\.ts)/g)].map((m) => m[1]);
		expect(exts[0]).toBe("damage-control-continue.ts");
		expect(exts).not.toContain("boot-config.ts");
		// Truncation tripwire: if the body regex above stops early, the list
		// loses members and this fails loudly instead of passing silently.
		expect(exts).toContain("team-member.ts");
	});
});
