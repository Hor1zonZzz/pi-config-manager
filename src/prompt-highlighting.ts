export type PromptHighlightTarget =
	| {
			kind: "contains-lines";
			lines: readonly string[];
	  }
	| {
			kind: "text-span";
			text: string;
	  };

function lineIndexAt(content: string, offset: number): number {
	return content.slice(0, offset).split("\n").length - 1;
}

function addTextSpanLineIndexes(
	indexes: Set<number>,
	content: string,
	spanStart: number,
	spanEnd: number,
): void {
	if (spanEnd <= spanStart) return;
	const first = lineIndexAt(content, spanStart);
	const last = lineIndexAt(content, spanEnd - 1);
	for (let index = first; index <= last; index += 1) indexes.add(index);
}

export function getHighlightedLineIndexes(
	content: string,
	target: PromptHighlightTarget,
): Set<number> {
	if (target.kind === "contains-lines") {
		return new Set(
			content
				.split("\n")
				.flatMap((line, index) =>
					target.lines.some((marker) => line.includes(marker)) ? [index] : [],
				),
		);
	}

	const highlighted = new Set<number>();
	if (target.text.length === 0) return highlighted;
	for (let cursor = 0; cursor < content.length; ) {
		const start = content.indexOf(target.text, cursor);
		if (start < 0) break;
		addTextSpanLineIndexes(
			highlighted,
			content,
			start,
			start + target.text.length,
		);
		cursor = start + target.text.length;
	}
	return highlighted;
}

export function promptContainsTarget(
	content: string,
	target: PromptHighlightTarget,
): boolean {
	if (target.kind === "text-span") {
		return target.text.length > 0 && content.includes(target.text);
	}
	if (target.lines.length === 0) return true;
	const lines = content.split("\n");
	return target.lines.every((marker) =>
		lines.some((line) => line.includes(marker)),
	);
}
