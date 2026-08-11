import { describe, expect, test } from "bun:test";
import {
	getHighlightedLineIndexes,
	promptContainsTarget,
} from "../src/prompt-highlighting";

describe("prompt highlighting", () => {
	test("highlights only the selected skill's formatted field block", () => {
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
		const target = {
			kind: "text-span" as const,
			text: [
				"    <name>alpha</name>",
				"    <description>Alpha skill</description>",
				"    <location>/skills/alpha/SKILL.md</location>",
			].join("\n"),
		};

		expect([...getHighlightedLineIndexes(prompt, target)]).toEqual([2, 3, 4]);
		expect(promptContainsTarget(prompt, target)).toBe(true);
	});

	test("matches configured line markers by substring", () => {
		const prompt = [
			"System prompt guidelines:",
			"  - Read files safely",
			"  - Read files safely when needed",
		].join("\n");

		expect([
			...getHighlightedLineIndexes(prompt, {
				kind: "contains-lines",
				lines: ["- Read files safely"],
			}),
		]).toEqual([1, 2]);
	});

	test("highlights multiline prompt-source text spans", () => {
		const prompt = [
			"Base prompt",
			"First appended line",
			"Second appended line",
			"Current working directory: /project",
		].join("\n");
		const target = {
			kind: "text-span" as const,
			text: "First appended line\nSecond appended line",
		};

		expect([...getHighlightedLineIndexes(prompt, target)]).toEqual([1, 2]);
		expect(promptContainsTarget(prompt, target)).toBe(true);
		expect(
			promptContainsTarget(prompt, {
				kind: "text-span",
				text: "First appended line\nMissing line",
			}),
		).toBe(false);
	});

	test("requires every requested marker for aggregate prompt sources", () => {
		const prompt = [
			'<project_instructions path="/project/A.md">',
			'<project_instructions path="/project/B.md">',
		].join("\n");

		expect(
			promptContainsTarget(prompt, {
				kind: "contains-lines",
				lines: [
					'<project_instructions path="/project/A.md">',
					'<project_instructions path="/project/B.md">',
				],
			}),
		).toBe(true);
		expect(
			promptContainsTarget(prompt, {
				kind: "contains-lines",
				lines: [
					'<project_instructions path="/project/A.md">',
					'<project_instructions path="/project/C.md">',
				],
			}),
		).toBe(false);
	});
});
