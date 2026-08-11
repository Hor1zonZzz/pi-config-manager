import type { SourceInfo } from "@earendil-works/pi-coding-agent";

export type ResourceTab = "overview" | "tools" | "skills" | "contexts";

export interface ResourceSettings {
	version: 1;
	enabledTools: string[];
	disabledTools: string[];
	disabledSkills: string[];
	disabledContexts: string[];
}

export const PRESET_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type PresetThinkingLevel = (typeof PRESET_THINKING_LEVELS)[number];

export function isPresetThinkingLevel(
	value: unknown,
): value is PresetThinkingLevel {
	return (
		typeof value === "string" &&
		PRESET_THINKING_LEVELS.some((level) => level === value)
	);
}

export interface PresetOriginalState {
	provider?: string;
	model?: string;
	thinkingLevel: PresetThinkingLevel;
}

export interface PresetSessionState {
	name: string;
	appliedTools?: string[];
	originalState: PresetOriginalState;
}

export interface SessionResourceState {
	version: 2;
	tools?: string[];
	enabledSkills: string[];
	disabledSkills: string[];
	enabledContexts: string[];
	disabledContexts: string[];
	preset?: PresetSessionState;
}

export interface ToolRecord {
	name: string;
	description: string;
	promptSnippet?: string;
	parameters: unknown;
	promptGuidelines?: string[];
	sourceInfo?: SourceInfo;
}

export interface SkillRecord {
	name: string;
	description: string;
	path: string;
	disableModelInvocation?: boolean;
	sourceInfo?: SourceInfo;
}

export interface ContextRecord {
	path: string;
	content: string;
}

export interface RuntimeLayer {
	id: string;
	disableTools: string[];
	requireTools: string[];
}

export interface RuntimeToolControl {
	layerId: string;
	action: "disable" | "require";
}

export interface EffectiveSystemPrompt {
	content: string;
	source: "command" | "agent-start";
}

export interface ManagerState {
	ready: boolean;
	customSystemPrompt?: string;
	appendedSystemPrompt?: string;
	contextsKnown: boolean;
	tools: ToolRecord[];
	toolSnippets: Record<string, string>;
	effectiveSystemPrompt?: EffectiveSystemPrompt;
	activeTools: Set<string>;
	runtimeToolControls: Map<string, RuntimeToolControl>;
	skills: SkillRecord[];
	contexts: ContextRecord[];
}

export interface ManagerSnapshot extends ManagerState {
	customPromptActive: boolean;
	presetInstructions?: string;
	projectDisabledTools: Set<string>;
	enabledSkills: Set<string>;
	projectDisabledSkills: Set<string>;
	enabledContexts: Set<string>;
	projectDisabledContexts: Set<string>;
	presetName?: string;
}

export const DEFAULT_RESOURCE_SETTINGS: ResourceSettings = {
	version: 1,
	enabledTools: [],
	disabledTools: [],
	disabledSkills: [],
	disabledContexts: [],
};

export const DEFAULT_SESSION_STATE: SessionResourceState = {
	version: 2,
	enabledSkills: [],
	disabledSkills: [],
	enabledContexts: [],
	disabledContexts: [],
};
