import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectSkillDirs,
	manifestEntries,
	parsePacksConfig,
	planInstall,
	repoCacheDir,
	sourcesToSync,
} from "./skills-bootstrap.ts";

const VALID = `
packs:
  ruby-core-skills: igmarin/ruby-core-skills
skills:
  tdd: igmarin/elixir-phoenix-skills
  herdr: herdrdev/herdr
`;

describe("parsePacksConfig", () => {
	test("parses packs and skills sections", () => {
		const c = parsePacksConfig(VALID);
		expect(c.packs["ruby-core-skills"]).toBe("igmarin/ruby-core-skills");
		expect(c.skills["tdd"]).toBe("igmarin/elixir-phoenix-skills");
	});

	test("accepts absolute local paths as sources", () => {
		const c = parsePacksConfig("packs:\n  p: /tmp/repo\n");
		expect(c.packs["p"]).toBe("/tmp/repo");
	});

	test("empty sections are allowed", () => {
		expect(parsePacksConfig("packs: {}\n")).toEqual({ packs: {}, skills: {} });
	});

	test("rejects non-mapping, unknown keys, bad names, and bad sources", () => {
		expect(() => parsePacksConfig("- a\n- b")).toThrow("expected a mapping");
		expect(() => parsePacksConfig("bogus: {}\n")).toThrow("unknown key");
		expect(() => parsePacksConfig("packs: {p: not-a-repo}\n")).toThrow("owner/repo");
		expect(() => parsePacksConfig("skills: [a, b]\n")).toThrow("must be a mapping");
		expect(() => parsePacksConfig("skills: {'bad name': o/r}\n")).toThrow("bad skills name");
	});
});

describe("collectSkillDirs", () => {
	test("lists only dirs containing SKILL.md, sorted", () => {
		const repo = mkdtempSync(join(tmpdir(), "repo-"));
		mkdirSync(join(repo, "skills", "b"), { recursive: true });
		mkdirSync(join(repo, "skills", "a"), { recursive: true });
		mkdirSync(join(repo, "skills", "readme-only"), { recursive: true });
		writeFileSync(join(repo, "skills", "b", "SKILL.md"), "# b");
		writeFileSync(join(repo, "skills", "a", "SKILL.md"), "# a");
		writeFileSync(join(repo, "skills", "readme-only", "README.md"), "# r");
		expect(collectSkillDirs(repo)).toEqual(["a", "b"]);
	});

	test("missing skills dir yields empty", () => {
		expect(collectSkillDirs(mkdtempSync(join(tmpdir(), "repo-")))).toEqual([]);
	});
});

describe("planInstall", () => {
	test("packs contribute all repo skills to repos and manifest", () => {
		const plan = planInstall(parsePacksConfig(VALID), () => ["alpha", "beta"]);
		expect(plan.repos["igmarin/ruby-core-skills"]).toEqual(["alpha", "beta"]);
		expect(plan.repos["igmarin/elixir-phoenix-skills"]).toEqual(["tdd"]);
		expect(plan.repos["herdrdev/herdr"]).toEqual(["herdr"]);
		expect(plan.manifest["ruby-core-skills:alpha"]).toEqual({ path: "alpha" });
		expect(plan.manifest["ruby-core-skills:beta"]).toEqual({ path: "beta" });
		// Individual skills never create manifest entries — they are not packs.
		expect(plan.manifest["tdd"]).toBeUndefined();
	});

	test("a repo referenced by pack and skill is synced once", () => {
		const c = parsePacksConfig(`
packs:
  agnostic-planning-skills: igmarin/agnostic-planning-skills
skills:
  requirements-clarifier: igmarin/agnostic-planning-skills
`);
		const plan = planInstall(c, () => ["requirements-clarifier", "create-prd"]);
		expect(plan.repos["igmarin/agnostic-planning-skills"]).toEqual([
			"requirements-clarifier",
			"create-prd",
		]);
	});
});

describe("repoCacheDir", () => {
	test("github sources never collide on basename", () => {
		expect(repoCacheDir("a/skills", "/cache")).not.toBe(repoCacheDir("b/skills", "/cache"));
		expect(repoCacheDir("a/skills", "/cache")).toBe("/cache/a__skills");
	});
});

describe("manifestEntries", () => {
	test("records only skills present in the skills home", () => {
		const home = mkdtempSync(join(tmpdir(), "skills-"));
		mkdirSync(join(home, "alpha"), { recursive: true });
		writeFileSync(join(home, "alpha", "SKILL.md"), "# a");
		const entries = manifestEntries(
			{ "pack:alpha": { path: "alpha" }, "pack:missing": { path: "missing" } },
			home,
		);
		expect(Object.keys(entries)).toEqual(["pack:alpha"]);
	});
});

describe("planInstall with allowlist", () => {
	const PACKS_AND_SKILLS = `
packs:
  ruby-core-skills: igmarin/ruby-core-skills
  elixir-phoenix-skills: igmarin/elixir-phoenix-skills
skills:
  tdd: igmarin/elixir-phoenix-skills
  herdr: herdrdev/herdr
`;

	test("keeps only allowlisted packs, their skills, and skills sources", () => {
		const c = parsePacksConfig(PACKS_AND_SKILLS);
		const plan = planInstall(c, () => ["alpha", "beta"], ["ruby-core-skills", "tdd"]);
		// Elixir pack is not on this vida: not synced, not linked, not manifest.
		expect(Object.keys(plan.repos)).toEqual(["igmarin/ruby-core-skills", "igmarin/elixir-phoenix-skills"]);
		expect(plan.repos["igmarin/ruby-core-skills"]).toEqual(["alpha", "beta"]);
		// tdd's source is synced only for the individual skill link.
		expect(plan.repos["igmarin/elixir-phoenix-skills"]).toEqual(["tdd"]);
		expect(plan.manifest["ruby-core-skills:alpha"]).toEqual({ path: "alpha" });
		expect(plan.manifest["elixir-phoenix-skills:alpha"]).toBeUndefined();
		expect(plan.manifest["tdd"]).toBeUndefined();
	});

	test("unknown allowlist name fails closed", () => {
		const c = parsePacksConfig(PACKS_AND_SKILLS);
		expect(() => planInstall(c, () => ["alpha"], ["ruby-core-skills", "no-such-name"])).toThrow(
			"not in packs.yaml",
		);
	});

	test("empty allowlist installs nothing", () => {
		const c = parsePacksConfig(PACKS_AND_SKILLS);
		const plan = planInstall(c, () => ["alpha"], []);
		expect(plan.repos).toEqual({});
		expect(plan.manifest).toEqual({});
	});
});

describe("sourcesToSync", () => {
	const SHARED = parsePacksConfig(`
packs:
  agnostic-planning-skills: igmarin/agnostic-planning-skills
  ruby-core-skills: igmarin/ruby-core-skills
skills:
  requirements-clarifier: igmarin/agnostic-planning-skills
`);

	test("no allowlist syncs every referenced source", () => {
		expect(sourcesToSync(SHARED)).toEqual([
			"igmarin/agnostic-planning-skills",
			"igmarin/ruby-core-skills",
		]);
	});

	test("a shared source syncs when either of its names is allowlisted", () => {
		// requirements-clarifier (skill) shares the agnostic pack's repo; the
		// pack itself is not allowlisted but its source must still sync.
		expect(sourcesToSync(SHARED, ["requirements-clarifier", "ruby-core-skills"]).sort()).toEqual([
			"igmarin/agnostic-planning-skills",
			"igmarin/ruby-core-skills",
		]);
	});

	test("empty allowlist syncs nothing", () => {
		expect(sourcesToSync(SHARED, [])).toEqual([]);
	});
});
