import type {
	ResolvedResource,
	SourceInfo,
} from "@earendil-works/pi-coding-agent";

export type ResourceTab =
	| "overview"
	| "tools"
	| "skills"
	| "contexts"
	| "extensions";

export interface ResourceSettings {
	version: 1;
	enabledTools: string[];
	disabledTools: string[];
	disabledSkills: string[];
	disabledContexts: string[];
}

export type PresetThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

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
	capturedAt: number;
	source: "command" | "agent-start";
}

export interface ManagerSnapshot {
	ready: boolean;
	customPromptActive: boolean;
	contextsKnown: boolean;
	extensionsKnown: boolean;
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
	presetName?: string;
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
