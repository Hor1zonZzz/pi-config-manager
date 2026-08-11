import type {
	ResolvedResource,
	SourceInfo,
} from "@earendil-works/pi-coding-agent";

export type ResourceTab =
	| "overview"
	| "tools"
	| "skills"
	| "contexts"
	| "prompts"
	| "themes"
	| "extensions";

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
	tools: string[];
}

export interface PresetSessionState {
	name: string;
	customTools: boolean;
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

export interface ManagerSnapshot {
	ready: boolean;
	customPromptActive: boolean;
	customSystemPrompt?: string;
	appendedSystemPrompt?: string;
	presetInstructions?: string;
	contextsKnown: boolean;
	extensionsKnown: boolean;
	promptsKnown: boolean;
	themesKnown: boolean;
	tools: ToolRecord[];
	toolSnippets: Record<string, string>;
	effectiveSystemPrompt?: EffectiveSystemPrompt;
	activeTools: Set<string>;
	runtimeToolControls: Map<string, RuntimeToolControl>;
	projectDisabledTools: Set<string>;
	skills: SkillRecord[];
	enabledSkills: Set<string>;
	projectDisabledSkills: Set<string>;
	contexts: ContextRecord[];
	enabledContexts: Set<string>;
	projectDisabledContexts: Set<string>;
	extensions: ResolvedResource[];
	prompts: ResolvedResource[];
	themes: ResolvedResource[];
	presetName?: string;
}

export type PackageResourceKind = "extensions" | "prompts" | "themes";

export interface PackageResourceCatalog {
	extensions: ResolvedResource[];
	prompts: ResolvedResource[];
	themes: ResolvedResource[];
}

export interface PackageResourceChange {
	kind: PackageResourceKind;
	resource: ResolvedResource;
	enabled: boolean;
}

export interface ExtensionChange {
	resource: ResolvedResource;
	enabled: boolean;
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
