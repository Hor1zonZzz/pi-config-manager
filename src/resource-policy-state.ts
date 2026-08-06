import type {
	ManagerSnapshot,
	ResourceSettings,
	SessionResourceState,
} from "./types";

export type ToggleableResourceTab = "tools" | "skills" | "contexts";
export type PersistentResourceKind = ToggleableResourceTab;

export function uniqueSorted(values: Iterable<string>): string[] {
	return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

export function isResourceEnabled(
	snapshot: ManagerSnapshot,
	tab: ToggleableResourceTab,
	id: string,
): boolean {
	if (tab === "tools") return snapshot.activeTools.has(id);
	if (tab === "skills") return snapshot.enabledSkills.has(id);
	return snapshot.enabledContexts.has(id);
}

export function isProjectResourceDisabled(
	settings: ResourceSettings,
	tab: ToggleableResourceTab,
	id: string,
): boolean {
	if (tab === "tools") return settings.disabledTools.includes(id);
	if (tab === "skills") return settings.disabledSkills.includes(id);
	return settings.disabledContexts.includes(id);
}

export function resetSessionResourceOverrides(
	state: SessionResourceState,
): SessionResourceState {
	return {
		...state,
		tools: undefined,
		enabledSkills: [],
		disabledSkills: [],
		enabledContexts: [],
		disabledContexts: [],
	};
}

export function toggleSessionResourceOverride(
	state: SessionResourceState,
	tab: "skills" | "contexts",
	id: string,
	enabled: boolean,
): SessionResourceState {
	const enabledKey = tab === "skills" ? "enabledSkills" : "enabledContexts";
	const disabledKey = tab === "skills" ? "disabledSkills" : "disabledContexts";
	const enabledValues = state[enabledKey].filter((value) => value !== id);
	const disabledValues = state[disabledKey].filter((value) => value !== id);
	if (enabled) disabledValues.push(id);
	else enabledValues.push(id);
	return {
		...state,
		[enabledKey]: uniqueSorted(enabledValues),
		[disabledKey]: uniqueSorted(disabledValues),
	};
}

export function updateGlobalResourceSettings(
	settings: ResourceSettings,
	kind: PersistentResourceKind,
	name: string,
	enabled: boolean,
): ResourceSettings {
	if (kind === "tools") {
		const enabledTools = new Set(settings.enabledTools);
		const disabledTools = new Set(settings.disabledTools);
		if (enabled) {
			enabledTools.add(name);
			disabledTools.delete(name);
		} else {
			enabledTools.delete(name);
			disabledTools.add(name);
		}
		return {
			...settings,
			enabledTools: uniqueSorted(enabledTools),
			disabledTools: uniqueSorted(disabledTools),
		};
	}
	const key = kind === "skills" ? "disabledSkills" : "disabledContexts";
	const values = new Set(settings[key]);
	if (enabled) values.delete(name);
	else values.add(name);
	return { ...settings, [key]: uniqueSorted(values) };
}
