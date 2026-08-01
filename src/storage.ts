import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_RESOURCE_SETTINGS,
	DEFAULT_SESSION_STATE,
	type PresetOriginalState,
	type PresetSessionState,
	type PresetThinkingLevel,
	type ResourceSettings,
	type SessionResourceState,
} from "./types";

const SETTINGS_FILE = "resource-settings.json";
const LEGACY_SKILL_SETTINGS_FILE = "skill-settings.json";

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? Array.from(
				new Set(
					value.filter((item): item is string => typeof item === "string"),
				),
			).sort((a, b) => a.localeCompare(b))
		: [];
}

export function normalizeResourceSettings(value: unknown): ResourceSettings {
	const data =
		value && typeof value === "object"
			? (value as Record<string, unknown>)
			: {};
	return {
		version: 1,
		enabledTools: strings(data.enabledTools),
		disabledTools: strings(data.disabledTools),
		disabledSkills: strings(data.disabledSkills),
		disabledContexts: strings(data.disabledContexts),
	};
}

const THINKING_LEVELS = new Set<PresetThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

function normalizeOriginalState(value: unknown): PresetOriginalState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const data = value as Record<string, unknown>;
	if (
		!THINKING_LEVELS.has(data.thinkingLevel as PresetThinkingLevel) ||
		!Array.isArray(data.tools)
	)
		return undefined;
	return {
		provider: typeof data.provider === "string" ? data.provider : undefined,
		model: typeof data.model === "string" ? data.model : undefined,
		thinkingLevel: data.thinkingLevel as PresetThinkingLevel,
		tools: strings(data.tools),
	};
}

function normalizePresetState(value: unknown): PresetSessionState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const data = value as Record<string, unknown>;
	const originalState = normalizeOriginalState(data.originalState);
	if (typeof data.name !== "string" || !originalState) return undefined;
	return {
		name: data.name,
		customTools: data.customTools === true,
		appliedTools: Array.isArray(data.appliedTools)
			? strings(data.appliedTools)
			: undefined,
		originalState,
	};
}

export function normalizeSessionState(
	value: unknown,
): SessionResourceState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const data = value as Record<string, unknown>;
	if (data.version !== 2) return undefined;
	return {
		version: 2,
		tools: Array.isArray(data.tools) ? strings(data.tools) : undefined,
		enabledSkills: strings(data.enabledSkills),
		disabledSkills: strings(data.disabledSkills),
		enabledContexts: strings(data.enabledContexts),
		disabledContexts: strings(data.disabledContexts),
		preset: normalizePresetState(data.preset),
	};
}

export function loadGlobalSettings(): ResourceSettings {
	const settingsPath = join(getAgentDir(), SETTINGS_FILE);
	try {
		return normalizeResourceSettings(
			JSON.parse(readFileSync(settingsPath, "utf8")),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			return { ...DEFAULT_RESOURCE_SETTINGS };
	}

	try {
		const legacy = JSON.parse(
			readFileSync(join(getAgentDir(), LEGACY_SKILL_SETTINGS_FILE), "utf8"),
		);
		return {
			...DEFAULT_RESOURCE_SETTINGS,
			disabledSkills: strings(legacy?.disabledSkills),
		};
	} catch {
		return { ...DEFAULT_RESOURCE_SETTINGS };
	}
}

export function loadProjectSettings(
	cwd: string,
	trusted: boolean,
): ResourceSettings {
	if (!trusted) return { ...DEFAULT_RESOURCE_SETTINGS };
	try {
		return normalizeResourceSettings(
			JSON.parse(
				readFileSync(join(cwd, CONFIG_DIR_NAME, SETTINGS_FILE), "utf8"),
			),
		);
	} catch {
		return { ...DEFAULT_RESOURCE_SETTINGS };
	}
}

export function saveGlobalSettings(settings: ResourceSettings): void {
	writeAtomic(join(getAgentDir(), SETTINGS_FILE), settings);
}

function writeAtomic(filePath: string, value: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(temporaryPath, filePath);
}

export function cloneSessionState(
	state: SessionResourceState,
): SessionResourceState {
	return {
		...DEFAULT_SESSION_STATE,
		...state,
		tools: state.tools ? [...state.tools] : undefined,
		enabledSkills: [...state.enabledSkills],
		disabledSkills: [...state.disabledSkills],
		enabledContexts: [...state.enabledContexts],
		disabledContexts: [...state.disabledContexts],
		preset: state.preset
			? {
					...state.preset,
					appliedTools: state.preset.appliedTools
						? [...state.preset.appliedTools]
						: undefined,
					originalState: {
						...state.preset.originalState,
						tools: [...state.preset.originalState.tools],
					},
				}
			: undefined,
	};
}
