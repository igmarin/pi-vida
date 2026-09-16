/**
 * Damage-Control (continue) — blocked tools return feedback; the turn lives.
 * Does not call ctx.abort().
 *
 * Best-effort text matching: rm/mv with glob/expansion operands and bash write
 * targets outside cwd are blocked (fail closed); other shell expansions may pass.
 *
 * Usage: pi -e extensions/damage-control-continue.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { parse as yamlParse } from "yaml";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { applyExtensionDefaults } from "./themeMap.ts";

interface Rule {
	pattern: string;
	reason: string;
	ask?: boolean;
	re: RegExp;
}

interface Rules {
	bashToolPatterns: Rule[];
	zeroAccessPaths: string[];
	readOnlyPaths: string[];
	noDeletePaths: string[];
}

const EMPTY: Rules = {
	bashToolPatterns: [],
	zeroAccessPaths: [],
	readOnlyPaths: [],
	noDeletePaths: [],
};

function continueFeedback(toolName: string, violationReason: string, invocation: string): string {
	return [
		`Damage-Control: ${toolName} blocked — ${violationReason}`,
		``,
		`Attempted: ${invocation}`,
		``,
		`Do not retry this exact call. If the intent was destructive, ask the user how to proceed.`,
		`If it was only to inspect a secret or protected path, assume the value exists and continue.`,
	].join("\n");
}

function expandTilde(p: string): string {
	return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

function resolvePath(p: string, cwd: string): string {
	return resolve(cwd, expandTilde(p));
}

function underCwd(target: string, cwd: string): boolean {
	const root = resolve(cwd);
	const abs = resolve(target);
	return abs === root || abs.startsWith(root + sep);
}

function commandReferencesPath(command: string, protectedPath: string): boolean {
	if (!protectedPath) return false;
	let idx = command.indexOf(protectedPath);
	while (idx >= 0) {
		const after = command[idx + protectedPath.length];
		if (!after || !/[A-Za-z0-9_-]/.test(after)) return true;
		idx = command.indexOf(protectedPath, idx + 1);
	}
	return false;
}

function stripToken(tok: string): string {
	return tok.replace(/^['"([{]+/, "").replace(/['")\]},;]+$/, "");
}

export function bashWriteTargets(command: string): { targets: string[]; unresolvable: boolean } {
	const targets: string[] = [];
	let unresolvable = false;
	const push = (raw: string) => {
		const t = raw.replace(/^['"]|['"]$/g, "").replace(/[)&<;|].*$/, "").trim();
		if (!t) return;
		if (/[$`]/.test(t)) {
			unresolvable = true;
			return;
		}
		targets.push(t);
	};
	const res = [
		/(?:^|[\s;(&|])(?:\d*&?>{1,2}|\d*<>|>\|)\s*(\S+)/g,
		/(?:^|[\s;|])tee\s+(?:-a\s+)?(\S+)/g,
		/\bof=(\S+)/g,
	];
	for (const re of res) {
		let m: RegExpExecArray | null;
		while ((m = re.exec(command))) push(m[1]);
	}
	return { targets, unresolvable };
}

export function expansionOperandRisk(command: string): string | null {
	if (!/\b(?:rm|mv)\b/.test(command)) return null;
	const unquoted = command.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, " ");
	if (/[[?*]/.test(unquoted)) return "shell expansion in rm/mv operands";
	if (/[$`]/.test(command)) return "variable expansion in rm/mv operands";
	return null;
}

export function isPathMatch(targetPath: string, pattern: string, cwd: string): boolean {
	const resolvedPattern = expandTilde(pattern);
	if (pattern.endsWith("/") || resolvedPattern.endsWith(sep)) {
		const dir = isAbsolute(resolvedPattern) ? resolvedPattern.replace(/[/\\]+$/, "") : resolve(cwd, resolvedPattern);
		return targetPath === dir || targetPath.startsWith(dir + sep);
	}
	const regexPattern = resolvedPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	const regex = new RegExp(`^${regexPattern}$|^${regexPattern}/|/${regexPattern}$|/${regexPattern}/`);
	const relativePath = relative(cwd, targetPath);
	return regex.test(targetPath) || regex.test(relativePath);
}

function harnessRoot(): string {
	if (process.env.PI_VIDA_HOME) return process.env.PI_VIDA_HOME;
	if (process.env.PI_LIFE_HOME) return process.env.PI_LIFE_HOME;
	if (process.env.MY_PI_AGENT_HOME) return process.env.MY_PI_AGENT_HOME;
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function parseRulesFile(rulesPath: string): Rules {
	const loaded = yamlParse(readFileSync(rulesPath, "utf8")) as Partial<Rules>;
	if (loaded == null || typeof loaded !== "object" || Array.isArray(loaded)) {
		throw new Error("expected a mapping");
	}
	const bashToolPatterns = (loaded.bashToolPatterns || []).map((rule) => ({
		...rule,
		re: new RegExp(rule.pattern),
	}));
	return {
		bashToolPatterns,
		zeroAccessPaths: loaded.zeroAccessPaths || [],
		readOnlyPaths: loaded.readOnlyPaths || [],
		noDeletePaths: loaded.noDeletePaths || [],
	};
}

function loadRules(): { rules: Rules; source: string; warning?: string } {
	const project = join(process.cwd(), ".pi", "damage-control-rules.yaml");
	const harness = join(harnessRoot(), "damage-control-rules.yaml");
	if (existsSync(project)) {
		try {
			return { source: "project", rules: parseRulesFile(project) };
		} catch (err) {
			const warning =
				"invalid project damage-control-rules.yaml; using harness defaults: " +
				(err instanceof Error ? err.message : String(err));
			console.error("pi-vida:", warning);
			return { source: "harness", rules: parseRulesFile(harness), warning };
		}
	}
	return { source: "harness", rules: parseRulesFile(harness) };
}

export default function (pi: ExtensionAPI) {
	let rules: Rules = EMPTY;

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		try {
			const loaded = loadRules();
			rules = loaded.rules;
			const total =
				rules.bashToolPatterns.length +
				rules.zeroAccessPaths.length +
				rules.readOnlyPaths.length +
				rules.noDeletePaths.length;
			if (ctx.hasUI) {
				if (loaded.warning) ctx.ui.notify(`Damage-Control: ${loaded.warning}`, "warning");
				ctx.ui.notify(`Damage-Control (continue): ${total} rules (${loaded.source})`);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error("pi-vida: damage-control rules failed to load:", msg);
			rules = EMPTY;
			if (ctx.hasUI) ctx.ui.notify(`Damage-Control: failed to load rules: ${msg}`, "error");
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		let violationReason: string | null = null;
		let shouldAsk = false;

		const inputPaths: string[] = [];
		if (isToolCallEventType("read", event) || isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			inputPaths.push(event.input.path);
		} else if (isToolCallEventType("grep", event) || isToolCallEventType("find", event) || isToolCallEventType("ls", event)) {
			inputPaths.push(event.input.path || ".");
		}

		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			for (const p of inputPaths) {
				if (!underCwd(resolvePath(p, ctx.cwd), ctx.cwd)) {
					violationReason = `write/edit outside cwd: ${p}`;
					break;
				}
			}
		}

		if (!violationReason) {
			for (const p of inputPaths) {
				const resolved = resolvePath(p, ctx.cwd);
				for (const zap of rules.zeroAccessPaths) {
					if (isPathMatch(resolved, zap, ctx.cwd)) {
						violationReason = `Access to zero-access path restricted: ${zap}`;
						break;
					}
				}
				if (violationReason) break;
			}
		}

		if (!violationReason && isToolCallEventType("grep", event) && event.input.glob) {
			for (const zap of rules.zeroAccessPaths) {
				if (event.input.glob.includes(zap) || isPathMatch(event.input.glob, zap, ctx.cwd)) {
					violationReason = `Glob matches zero-access path: ${zap}`;
					break;
				}
			}
		}

		if (!violationReason && isToolCallEventType("bash", event)) {
			const command = event.input.command;
			for (const rule of rules.bashToolPatterns) {
				if (rule.re.test(command)) {
					violationReason = rule.reason;
					shouldAsk = !!rule.ask;
					break;
				}
			}
			if (!violationReason) {
				const tokens = command.split(/\s+/).map(stripToken).filter(Boolean);
				for (const tok of tokens) {
					const resolved = resolvePath(tok, ctx.cwd);
					for (const zap of rules.zeroAccessPaths) {
						if (isPathMatch(resolved, zap, ctx.cwd) || isPathMatch(tok, zap, ctx.cwd)) {
							violationReason = `Bash command references zero-access path: ${zap}`;
							break;
						}
					}
					if (violationReason) break;
				}
			}
			if (!violationReason) {
				const writes = bashWriteTargets(command);
				if (writes.unresolvable) violationReason = "Bash write target is not statically resolvable";
				for (const t of writes.targets) {
					if (violationReason) break;
					if (!underCwd(resolvePath(t, ctx.cwd), ctx.cwd)) violationReason = `Bash write outside cwd: ${t}`;
				}
			}
			if (!violationReason) {
				const risk = expansionOperandRisk(command);
				if (risk) violationReason = `Bash ${risk}; restate with explicit paths`;
			}
			if (!violationReason) {
				const hasDeleteOrMove = /\brm\b/.test(command) || /\bmv\b/.test(command);
				if (hasDeleteOrMove) {
					for (const ndp of rules.noDeletePaths) {
						const expanded = expandTilde(ndp);
						if (commandReferencesPath(command, ndp) || (expanded !== ndp && commandReferencesPath(command, expanded))) {
							violationReason = `Bash command attempts to delete/move protected path: ${ndp}`;
							break;
						}
					}
				}
			}
		}

		if (!violationReason && (isToolCallEventType("write", event) || isToolCallEventType("edit", event))) {
			for (const p of inputPaths) {
				const resolved = resolvePath(p, ctx.cwd);
				for (const rop of rules.readOnlyPaths) {
					if (isPathMatch(resolved, rop, ctx.cwd)) {
						violationReason = `Modification of read-only path restricted: ${rop}`;
						break;
					}
				}
				if (violationReason) break;
			}
		}

		if (!violationReason) return { block: false };

		const invocation = isToolCallEventType("bash", event) ? event.input.command : JSON.stringify(event.input);

		if (shouldAsk && ctx.hasUI) {
			const confirmed = await ctx.ui.confirm(
				"Damage-Control",
				`${violationReason}\n\n${invocation}\n\nProceed?`,
				{ timeout: 30000 },
			);
			if (confirmed) {
				pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: "confirmed_by_user" });
				return { block: false };
			}
			pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: "blocked_by_user" });
			return { block: true, reason: continueFeedback(event.toolName, `${violationReason} (user denied)`, invocation) };
		}

		if (ctx.hasUI) ctx.ui.notify(`Damage-Control: blocked ${event.toolName} (${violationReason})`);
		pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: "blocked" });
		return { block: true, reason: continueFeedback(event.toolName, violationReason, invocation) };
	});
}
