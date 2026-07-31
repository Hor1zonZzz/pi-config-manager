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
	disabledTools: string[];
	disabledSkills: string[];
	disabledContexts: string[];
}

export interface SessionResourceState {
	version: 1;
	tools?: string[];
	enabledSkills: string[];
	disabledSkills: string[];
	enabledContexts: string[];
	disabledContexts: string[];
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
	skills: SkillRecord[];
	enabledSkills: Set<string>;
	contexts: ContextRecord[];
	enabledContexts: Set<string>;
	extensions: ResolvedResource[];
	presetName?: string;
}

export interface ExtensionChange {
	resource: ResolvedResource;
	enabled: boolean;
}

export const DEFAULT_RESOURCE_SETTINGS: ResourceSettings = {
	version: 1,
	disabledTools: [],
	disabledSkills: [],
	disabledContexts: [],
};

export const DEFAULT_SESSION_STATE: SessionResourceState = {
	version: 1,
	enabledSkills: [],
	disabledSkills: [],
	enabledContexts: [],
	disabledContexts: [],
};
