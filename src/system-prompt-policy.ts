import {
	formatSkillsForPrompt,
	type BuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import { formatContextSection } from "./context-monitor";
import type { ContextRecord } from "./types";

interface SystemPromptPolicyOptions {
	systemPrompt: string;
	systemPromptOptions: BuildSystemPromptOptions;
	enabledSkills: Set<string>;
	contexts: ContextRecord[];
	enabledContexts: Set<string>;
	presetInstructions?: string;
}

export interface SystemPromptPolicyResult {
	systemPrompt: string;
	skillFilterMissed: boolean;
	contextFilterMissed: boolean;
}

export function applySystemPromptPolicy(
	options: SystemPromptPolicyOptions,
): SystemPromptPolicyResult {
	const originalSkills = formatSkillsForPrompt(
		options.systemPromptOptions.skills ?? [],
	);
	const filteredSkills = formatSkillsForPrompt(
		(options.systemPromptOptions.skills ?? []).filter((skill) =>
			options.enabledSkills.has(skill.name),
		),
	);
	const originalContexts = formatContextSection(options.contexts);
	const filteredContexts = formatContextSection(
		options.contexts.filter((context) =>
			options.enabledContexts.has(context.path),
		),
	);
	let systemPrompt = options.systemPrompt;
	const readAvailable =
		!options.systemPromptOptions.selectedTools ||
		options.systemPromptOptions.selectedTools.includes("read");
	let skillFilterMissed = false;
	let contextFilterMissed = false;

	if (originalSkills && systemPrompt.includes(originalSkills)) {
		systemPrompt = systemPrompt.replaceAll(originalSkills, filteredSkills);
	} else if (
		readAvailable &&
		originalSkills &&
		filteredSkills !== originalSkills
	) {
		skillFilterMissed = true;
	}
	if (originalContexts && systemPrompt.includes(originalContexts)) {
		systemPrompt = systemPrompt.replaceAll(originalContexts, filteredContexts);
	} else if (originalContexts && filteredContexts !== originalContexts) {
		contextFilterMissed = true;
	}
	if (options.presetInstructions) {
		systemPrompt = `${systemPrompt}\n\n${options.presetInstructions}`;
	}
	return { systemPrompt, skillFilterMissed, contextFilterMissed };
}
