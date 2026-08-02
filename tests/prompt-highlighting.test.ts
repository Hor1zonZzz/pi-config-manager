import { describe, expect, test } from "bun:test";
import { getHighlightedLineIndexes } from "../src/prompt-highlighting";

describe("prompt highlighting", () => {
	test("highlights only the selected skill's name, description, and location", () => {
		const prompt = [
			"<available_skills>",
			"  <skill>",
			"    <name>alpha</name>",
			"    <description>Alpha skill</description>",
			"    <location>/skills/alpha/SKILL.md</location>",
			"  </skill>",
			"  <skill>",
			"    <name>beta</name>",
			"    <description>Related to alpha</description>",
			"    <location>/skills/alpha-copy/SKILL.md</location>",
			"  </skill>",
			"</available_skills>",
		].join("\n");

		expect(
			[...getHighlightedLineIndexes(prompt, { kind: "skill-fields", skillName: "alpha" })],
		).toEqual([2, 3, 4]);
	});

	test("handles reordered and compact skill fields without escaping the block", () => {
		const prompt = [
			"<available_skills>",
			"<skill><location>/skills/alpha/SKILL.md</location>",
			"<description>Alpha skill</description><name>alpha</name></skill>",
			"<skill>",
			"<name>beta</name>",
			"<description>mentions alpha</description>",
			"<location>/skills/alpha-copy/SKILL.md</location>",
			"</skill></available_skills>",
		].join("\n");

		expect(
			[...getHighlightedLineIndexes(prompt, { kind: "skill-fields", skillName: "alpha" })].sort(
				(a, b) => a - b,
			),
		).toEqual([1, 2]);
	});

	test("matches multiline skill fields only inside the selected block", () => {
		const prompt = [
			"<skill>",
			"<name>",
			"alpha",
			"</name>",
			"<description>first line",
			"second line</description>",
			"<location>/skills/alpha/SKILL.md</location>",
			"</skill>",
			"<description>alpha outside a skill</description>",
		].join("\n");

		expect(
			[...getHighlightedLineIndexes(prompt, { kind: "skill-fields", skillName: "alpha" })],
		).toEqual([1, 2, 3, 4, 5, 6]);
	});

	test("matches exact lines for non-skill prompt resources", () => {
		const prompt = [
			"System prompt guidelines:",
			"  - Read files safely",
			"  - Read files safely when needed",
		].join("\n");

		expect(
			[
				...getHighlightedLineIndexes(prompt, {
					kind: "exact-lines",
					lines: ["- Read files safely"],
				}),
			],
		).toEqual([1]);
	});

	test("preserves substring matching for existing non-skill monitors", () => {
		const prompt = [
			"System prompt guidelines:",
			"  - Read files safely",
			"  - Read files safely when needed",
		].join("\n");

		expect(
			[
				...getHighlightedLineIndexes(prompt, {
					kind: "contains-lines",
					lines: ["- Read files safely"],
				}),
			],
		).toEqual([1, 2]);
	});
});
