/**
 * Tests for argExpand.expandArgs. The extension test-gap audit for the
 * remaining unspecced files lives in issue #104 — UI-wiring extensions are
 * intentionally untested (their logic sits in already-tested helpers).
 */

import { describe, expect, test } from "bun:test";
import { expandArgs } from "./argExpand.ts";

describe("expandArgs", () => {
	test("$ARGUMENTS and $@ expand to the full args string", () => {
		expect(expandArgs("run $ARGUMENTS", "a b c")).toBe("run a b c");
		expect(expandArgs("run $@", "a b c")).toBe("run a b c");
	});

	test("$1..$9 expand to positional words", () => {
		expect(expandArgs("$1 $2 $3", "one two three")).toBe("one two three");
		expect(expandArgs("first=$1 last=$3", "one two three")).toBe("first=one last=three");
	});

	test("out-of-range positionals expand to empty", () => {
		expect(expandArgs("[$2]", "only")).toBe("[]");
		expect(expandArgs("$9", "a b")).toBe("");
	});

	test("mixed placeholders expand independently", () => {
		expect(expandArgs("cmd $1 then $ARGUMENTS", "x y")).toBe("cmd x then x y");
	});

	test("empty args blank every placeholder", () => {
		expect(expandArgs("$1|$ARGUMENTS|$@", "")).toBe("||");
	});

	test("extra whitespace still splits positionally", () => {
		expect(expandArgs("$1-$2", "  a   b  ")).toBe("a-b");
	});

	test("templates without placeholders pass through", () => {
		expect(expandArgs("plain text $x $-ok", "a b")).toBe("plain text $x $-ok");
	});

	test("$N is a multi-digit positional, not $1 + literal", () => {
		const args = "a b c d e f g h i ten";
		expect(expandArgs("$10", args)).toBe("ten");
		expect(expandArgs("$10", "a b")).toBe("");
	});

	test("expansion is single-pass: arg values are never re-expanded", () => {
		expect(expandArgs("$1", "$2")).toBe("$2");
	});

	test("$0 is out of range — parts are 1-indexed", () => {
		expect(expandArgs("$0", "a b")).toBe("");
	});

	test("trailing text after $N is literal: $1abc expands $1, keeps abc", () => {
		expect(expandArgs("$1abc", "one two")).toBe("oneabc");
		expect(expandArgs("$10abc", "a b c d e f g h i ten")).toBe("tenabc");
	});
});
