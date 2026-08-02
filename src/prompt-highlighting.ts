export type PromptHighlightTarget =
	| {
			kind: "exact-lines";
			lines: readonly string[];
	  }
	| {
			kind: "contains-lines";
			lines: readonly string[];
	  }
	| {
			kind: "skill-fields";
			skillName: string;
	  };

const SKILL_OPEN_TAG = "<skill>";
const SKILL_CLOSE_TAG = "</skill>";
const SKILL_FIELD_TAGS = ["name", "description", "location"] as const;

type TagSpan = {
	start: number;
	end: number;
	valueStart: number;
	valueEnd: number;
};

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function findTagSpan(
	content: string,
	tag: string,
	from = 0,
): TagSpan | undefined {
	const openTag = `<${tag}>`;
	const closeTag = `</${tag}>`;
	const start = content.indexOf(openTag, from);
	if (start < 0) return undefined;
	const valueStart = start + openTag.length;
	const valueEnd = content.indexOf(closeTag, valueStart);
	if (valueEnd < 0) return undefined;
	return {
		start,
		end: valueEnd + closeTag.length,
		valueStart,
		valueEnd,
	};
}

function lineStarts(content: string): number[] {
	const starts = [0];
	for (let index = 0; index < content.length; index += 1) {
		if (content[index] === "\n") starts.push(index + 1);
	}
	return starts;
}

function lineIndexAt(starts: number[], offset: number): number {
	let low = 0;
	let high = starts.length;
	while (low + 1 < high) {
		const middle = Math.floor((low + high) / 2);
		if ((starts[middle] ?? 0) <= offset) low = middle;
		else high = middle;
	}
	return low;
}

function addSpanLineIndexes(
	indexes: Set<number>,
	starts: number[],
	spanStart: number,
	spanEnd: number,
): void {
	if (spanEnd <= spanStart) return;
	const first = lineIndexAt(starts, spanStart);
	const last = lineIndexAt(starts, spanEnd - 1);
	for (let index = first; index <= last; index += 1) indexes.add(index);
}

function skillFieldLineIndexes(
	content: string,
	skillName: string,
): Set<number> {
	const targetName = escapeXml(skillName);
	const starts = lineStarts(content);
	for (let cursor = 0; cursor < content.length; ) {
		const skillStart = content.indexOf(SKILL_OPEN_TAG, cursor);
		if (skillStart < 0) break;
		const skillContentStart = skillStart + SKILL_OPEN_TAG.length;
		const skillCloseStart = content.indexOf(
			SKILL_CLOSE_TAG,
			skillContentStart,
		);
		if (skillCloseStart < 0) break;
		const skillEnd = skillCloseStart + SKILL_CLOSE_TAG.length;
		const block = content.slice(skillContentStart, skillCloseStart);
		const nameSpan = findTagSpan(block, "name");

		if (
			nameSpan &&
			block.slice(nameSpan.valueStart, nameSpan.valueEnd).trim() === targetName
		) {
			const highlighted = new Set<number>();
			for (const tag of SKILL_FIELD_TAGS) {
				const fieldSpan = findTagSpan(block, tag);
				if (!fieldSpan) continue;
				addSpanLineIndexes(
					highlighted,
					starts,
					skillContentStart + fieldSpan.start,
					skillContentStart + fieldSpan.end,
				);
			}
			return highlighted;
		}

		cursor = skillEnd;
	}

	return new Set<number>();
}

export function getHighlightedLineIndexes(
	content: string,
	target: PromptHighlightTarget,
): Set<number> {
	if (target.kind === "skill-fields") {
		return skillFieldLineIndexes(content, target.skillName);
	}

	if (target.kind === "exact-lines") {
		const exactLines = new Set(target.lines.map((line) => line.trim()));
		return new Set(
			content
				.split("\n")
				.flatMap((line, index) =>
					exactLines.has(line.trim()) ? [index] : [],
				),
		);
	}

	return new Set(
		content
			.split("\n")
			.flatMap((line, index) =>
				target.lines.some((highlight) => line.includes(highlight))
					? [index]
					: [],
			),
	);
}
