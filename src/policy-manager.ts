import type {
	ContextRecord,
	ResourceSettings,
	RuntimeLayer,
	RuntimeToolControl,
	SessionResourceState,
	SkillRecord,
} from "./types";

export interface ProfilePolicy {
	id: string;
	tools?: string[];
	skills?: string[];
}

export interface PolicyInitialization {
	defaultTools: Iterable<string>;
	globalSettings: ResourceSettings;
	projectSettings: ResourceSettings;
	sessionState: SessionResourceState;
}

function unique(values: Iterable<string>): string[] {
	return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function sameStrings(left: string[], right: string[]): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

/**
 * Pure resource-policy state. Pi lifecycle, persistence, and rendering stay in
 * the extension composition root; first-party features and external layers
 * submit policy here instead of manipulating active tools directly.
 */
export class PolicyManager {
	private defaultTools = new Set<string>();
	private discoveredTools = new Set<string>();
	private externalTools = new Set<string>();
	private globalSettings: ResourceSettings;
	private projectSettings: ResourceSettings;
	private sessionState: SessionResourceState;
	private profile?: ProfilePolicy;
	private readonly runtimeLayers = new Map<string, RuntimeLayer>();

	constructor(initial: PolicyInitialization) {
		this.globalSettings = initial.globalSettings;
		this.projectSettings = initial.projectSettings;
		this.sessionState = initial.sessionState;
		this.defaultTools = new Set(initial.defaultTools);
	}

	initialize(input: PolicyInitialization): void {
		this.defaultTools = new Set(input.defaultTools);
		this.externalTools.clear();
		this.globalSettings = input.globalSettings;
		this.projectSettings = input.projectSettings;
		this.sessionState = input.sessionState;
		this.profile = undefined;
	}

	setSettings(
		globalSettings: ResourceSettings,
		projectSettings: ResourceSettings = this.projectSettings,
	): void {
		this.globalSettings = globalSettings;
		this.projectSettings = projectSettings;
	}

	setSessionState(state: SessionResourceState): void {
		this.sessionState = state;
	}

	setDiscoveredTools(names: Iterable<string>): void {
		this.discoveredTools = new Set(names);
	}

	observeExternalTools(names: Iterable<string>): void {
		for (const name of names) this.externalTools.add(name);
	}

	removeExternalTool(name: string): void {
		this.externalTools.delete(name);
	}

	clearExternalTools(): void {
		this.externalTools.clear();
	}

	setProfile(profile: ProfilePolicy | undefined): void {
		if (!profile) {
			this.profile = undefined;
			return;
		}
		this.profile = {
			id: profile.id,
			tools: profile.tools ? unique(profile.tools) : undefined,
			skills: profile.skills ? unique(profile.skills) : undefined,
		};
	}

	getProfileId(): string | undefined {
		return this.profile?.id;
	}

	resolveBaseTools(): Set<string> {
		const overridden = this.sessionState.tools ?? this.profile?.tools;
		if (overridden) {
			return new Set(
				overridden.filter((name) => this.discoveredTools.has(name)),
			);
		}
		return this.resolveConfiguredTools();
	}

	resolveConfiguredTools(): Set<string> {
		const disabled = this.effectiveDisabledTools();
		return new Set(
			[
				...this.defaultTools,
				...this.globalSettings.enabledTools,
				...this.projectSettings.enabledTools,
			].filter(
				(name) => this.discoveredTools.has(name) && !disabled.has(name),
			),
		);
	}

	resolveEffectiveTools(): Set<string> {
		const effective = this.resolveBaseTools();
		const disabled = this.effectiveDisabledTools();
		for (const name of this.externalTools) {
			if (this.discoveredTools.has(name) && !disabled.has(name))
				effective.add(name);
		}
		for (const layer of this.runtimeLayers.values()) {
			for (const name of layer.disableTools) effective.delete(name);
			for (const name of layer.requireTools) {
				if (this.discoveredTools.has(name)) effective.add(name);
			}
		}
		return effective;
	}

	resolveGlobalDefaultTools(): Set<string> {
		const disabled = new Set(this.globalSettings.disabledTools);
		return new Set(
			[
				...this.defaultTools,
				...this.globalSettings.enabledTools,
				...this.externalTools,
			].filter(
				(name) => this.discoveredTools.has(name) && !disabled.has(name),
			),
		);
	}

	resolveEnabledSkills(skills: SkillRecord[]): Set<string> {
		const disabled = new Set([
			...this.globalSettings.disabledSkills,
			...this.projectSettings.disabledSkills,
		]);
		const enabled = new Set<string>();
		for (const skill of skills) {
			const base = this.profile?.skills
				? this.profile.skills.includes(skill.name)
				: !disabled.has(skill.name);
			if (base) enabled.add(skill.name);
		}
		for (const name of this.sessionState.disabledSkills) enabled.delete(name);
		for (const name of this.sessionState.enabledSkills) {
			if (skills.some((skill) => skill.name === name)) enabled.add(name);
		}
		return enabled;
	}

	resolveGlobalDefaultSkills(skills: SkillRecord[]): Set<string> {
		const disabled = new Set(this.globalSettings.disabledSkills);
		return new Set(
			skills.map((skill) => skill.name).filter((name) => !disabled.has(name)),
		);
	}

	resolveEnabledContexts(contexts: ContextRecord[]): Set<string> {
		const disabled = new Set([
			...this.globalSettings.disabledContexts,
			...this.projectSettings.disabledContexts,
		]);
		const enabled = new Set(
			contexts
				.map((context) => context.path)
				.filter((path) => !disabled.has(path)),
		);
		for (const path of this.sessionState.disabledContexts) enabled.delete(path);
		for (const path of this.sessionState.enabledContexts) {
			if (contexts.some((context) => context.path === path)) enabled.add(path);
		}
		return enabled;
	}

	resolveGlobalDefaultContexts(contexts: ContextRecord[]): Set<string> {
		const disabled = new Set(this.globalSettings.disabledContexts);
		return new Set(
			contexts
				.map((context) => context.path)
				.filter((path) => !disabled.has(path)),
		);
	}

	setRuntimeLayer(layer: RuntimeLayer): boolean {
		const normalized: RuntimeLayer = {
			id: layer.id,
			disableTools: unique(layer.disableTools),
			requireTools: unique(layer.requireTools),
		};
		const current = this.runtimeLayers.get(layer.id);
		if (
			current &&
			sameStrings(current.disableTools, normalized.disableTools) &&
			sameStrings(current.requireTools, normalized.requireTools)
		)
			return false;
		this.runtimeLayers.set(layer.id, normalized);
		return true;
	}

	clearRuntimeLayer(id: string): boolean {
		return this.runtimeLayers.delete(id);
	}

	resolveRuntimeToolControls(): Map<string, RuntimeToolControl> {
		const controls = new Map<string, RuntimeToolControl>();
		for (const layer of this.runtimeLayers.values()) {
			for (const name of layer.disableTools) {
				controls.set(name, { layerId: layer.id, action: "disable" });
			}
			for (const name of layer.requireTools) {
				controls.set(name, { layerId: layer.id, action: "require" });
			}
		}
		return controls;
	}

	private effectiveDisabledTools(): Set<string> {
		return new Set([
			...this.globalSettings.disabledTools,
			...this.projectSettings.disabledTools,
		]);
	}
}
