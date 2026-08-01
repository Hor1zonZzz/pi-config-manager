import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { PresetThinkingLevel } from "./types";

export interface Preset {
	provider?: string;
	model?: string;
	thinkingLevel?: PresetThinkingLevel;
	tools?: string[];
	skills?: string[];
	instructions?: string;
}

export interface PresetsConfig {
	[name: string]: Preset;
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

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return Array.from(
		new Set(value.filter((item): item is string => typeof item === "string")),
	);
}

function normalizePreset(value: unknown): Preset | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const data = value as Record<string, unknown>;
	const thinkingLevel = THINKING_LEVELS.has(
		data.thinkingLevel as PresetThinkingLevel,
	)
		? (data.thinkingLevel as PresetThinkingLevel)
		: undefined;
	const preset: Preset = {};
	if (typeof data.provider === "string") preset.provider = data.provider;
	if (typeof data.model === "string") preset.model = data.model;
	if (thinkingLevel) preset.thinkingLevel = thinkingLevel;
	const tools = stringArray(data.tools);
	if (tools) preset.tools = tools;
	const skills = stringArray(data.skills);
	if (skills) preset.skills = skills;
	if (typeof data.instructions === "string")
		preset.instructions = data.instructions;
	return preset;
}

function loadPresetFile(path: string): PresetsConfig {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const presets: PresetsConfig = {};
		for (const [name, value] of Object.entries(parsed)) {
			const preset = normalizePreset(value);
			if (preset) presets[name] = preset;
		}
		return presets;
	} catch (error) {
		console.error(`Failed to load presets from ${path}: ${String(error)}`);
		return {};
	}
}

/** Load global presets, then overlay trusted project-local presets by name. */
export function loadPresets(cwd: string, trusted: boolean): PresetsConfig {
	const globalPresets = loadPresetFile(join(getAgentDir(), "presets.json"));
	const projectPresets = trusted
		? loadPresetFile(join(cwd, CONFIG_DIR_NAME, "presets.json"))
		: {};
	return { ...globalPresets, ...projectPresets };
}

export function describePreset(preset: Preset): string {
	const parts: string[] = [];
	if (preset.provider && preset.model)
		parts.push(`${preset.provider}/${preset.model}`);
	if (preset.thinkingLevel) parts.push(`thinking:${preset.thinkingLevel}`);
	if (preset.tools) parts.push(`tools:${preset.tools.join(",")}`);
	if (preset.skills) parts.push(`skills:${preset.skills.join(",")}`);
	if (preset.instructions) {
		const text =
			preset.instructions.length > 30
				? `${preset.instructions.slice(0, 27)}...`
				: preset.instructions;
		parts.push(`"${text}"`);
	}
	return parts.join(" | ");
}
