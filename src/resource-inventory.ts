import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import type { ContextRecord, ManagerSnapshot, SkillRecord } from "./types";

interface PromptResourceInventory {
	customPromptActive: boolean;
	customSystemPrompt?: string;
	appendedSystemPrompt?: string;
	toolSnippets: Record<string, string>;
	skills: SkillRecord[];
	contexts: ContextRecord[];
}

type PromptSkill = NonNullable<BuildSystemPromptOptions["skills"]>[number] & {
	path?: string;
};

type RegisteredCommand = ReturnType<ExtensionAPI["getCommands"]>[number];

function promptSkillPath(skill: PromptSkill): string {
	return skill.path ?? skill.filePath ?? "Path unavailable";
}

export function buildPromptResourceInventory(
	options: BuildSystemPromptOptions,
): PromptResourceInventory {
	const skills: SkillRecord[] = (options.skills ?? [])
		.map((skill) => ({
			name: skill.name,
			description: skill.description ?? "No description",
			path: promptSkillPath(skill),
			disableModelInvocation: skill.disableModelInvocation === true,
			sourceInfo: skill.sourceInfo,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
	const contexts = (options.contextFiles ?? []).map((file) => ({
		path: file.path,
		content: file.content,
	}));
	const toolSnippets = Object.fromEntries(
		Object.entries(options.toolSnippets ?? {}).filter(
			([, snippet]) => typeof snippet === "string" && snippet.length > 0,
		),
	);
	return {
		customPromptActive: Boolean(options.customPrompt),
		customSystemPrompt: options.customPrompt,
		appendedSystemPrompt: options.appendSystemPrompt,
		toolSnippets,
		skills,
		contexts,
	};
}

export function buildLoadedSkillInventory(
	commands: RegisteredCommand[],
	existingSkills: SkillRecord[],
): SkillRecord[] {
	const existing = new Map(existingSkills.map((skill) => [skill.name, skill]));
	const skills: SkillRecord[] = [];
	for (const command of commands) {
		if (command.source !== "skill") continue;
		const name = command.name.replace(/^skill:/, "");
		skills.push({
			name,
			description: command.description ?? "No description",
			path: command.sourceInfo.path,
			disableModelInvocation: existing.get(name)?.disableModelInvocation,
			sourceInfo: command.sourceInfo,
		});
	}
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function enabledResourceCount(resources: ResolvedResource[]): number {
	return resources.filter((resource) => resource.enabled).length;
}

export function buildPublicSnapshot(
	snapshot: ManagerSnapshot,
	baseTools: Iterable<string>,
) {
	return {
		ready: snapshot.ready,
		baseTools: Array.from(baseTools),
		tools: {
			active: snapshot.activeTools.size,
			total: snapshot.tools.length,
		},
		skills: {
			enabled: snapshot.enabledSkills.size,
			total: snapshot.skills.length,
		},
		contexts: {
			enabled: snapshot.enabledContexts.size,
			total: snapshot.contexts.length,
		},
		prompts: {
			enabled: enabledResourceCount(snapshot.prompts),
			total: snapshot.prompts.length,
		},
		themes: {
			enabled: enabledResourceCount(snapshot.themes),
			total: snapshot.themes.length,
		},
		extensions: {
			enabled: enabledResourceCount(snapshot.extensions),
			total: snapshot.extensions.length,
		},
	};
}
