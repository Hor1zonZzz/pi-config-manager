import { basename, dirname } from "node:path";
import {
	formatSkillsForPrompt,
	type Skill,
	type SourceInfo,
} from "@earendil-works/pi-coding-agent";
import {
	countLoadedContextResources,
	formatContextSection,
	getEffectivePromptItem,
	getPromptSourceItems,
	showCapturedSystemPrompt,
	type ViewItem,
} from "./context-monitor";
import type {
	ContextRecord,
	ManagerSnapshot,
	ResourceTab,
	RuntimeToolControl,
	SkillRecord,
	ToolRecord,
} from "./types";

function sourceDetail(sourceInfo: ToolRecord["sourceInfo"]): string {
	if (!sourceInfo) return "unknown source";
	return `${sourceInfo.scope ?? "unknown"} · ${sourceInfo.source ?? "unknown"} · ${sourceInfo.path ?? "unknown path"}`;
}

function stringifyJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return "[schema could not be serialized]";
	}
}

function buildOverviewItems(snapshot: ManagerSnapshot): ViewItem[] {
	const contextResources = countLoadedContextResources(snapshot);
	return [
		{
			id: "tools",
			label: "Tools",
			state: `${snapshot.activeTools.size}/${snapshot.tools.length}`,
			detail: "Pi-discovered tools and their effective active state.",
		},
		{
			id: "skills",
			label: "Skills",
			state: `${snapshot.enabledSkills.size}/${snapshot.skills.length}`,
			detail: "Pi-loaded skills and their effective manager policy state.",
		},
		{
			id: "contexts",
			label: "Contexts",
			state: snapshot.contextsKnown
				? `${contextResources.enabled}/${contextResources.total} loaded context resources`
				: "loading",
			detail:
				"Includes SYSTEM, merged APPEND_SYSTEM, and Pi-loaded context files; preset instructions remain a separate synthetic source.",
		},
	];
}

function toolControlState(
	control: RuntimeToolControl | undefined,
	projectLocked: boolean,
): string {
	if (control) {
		const action = control.action === "disable" ? "blocked" : "required";
		return ` · ${action} by ${control.layerId}`;
	}
	return projectLocked ? " · blocked by project settings" : "";
}

function toolMonitorNote(
	snapshot: ManagerSnapshot,
	tool: ToolRecord,
	active: boolean,
): string | undefined {
	if (!active) return "Pi does not expose an inactive tool's promptSnippet.";
	if (
		snapshot.customPromptActive &&
		(tool.promptSnippet || tool.promptGuidelines?.length)
	) {
		return "A custom system prompt is active, so Pi omits this tool's prompt snippet and guidelines.";
	}
	return undefined;
}

function toolPromptContent(
	tool: ToolRecord,
	active: boolean,
	systemPromptVisible: boolean,
): string {
	const content = [
		"Pi tool definition (provider serialization may vary):",
		stringifyJson({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}),
	];
	if (active && tool.promptSnippet) {
		content.push(
			"",
			systemPromptVisible
				? "System prompt Available tools entry:"
				: "Prompt snippet:",
			`- ${tool.name}: ${tool.promptSnippet}`,
		);
	}
	if (!active) content.push("", "Prompt snippet: unavailable while inactive");
	if (tool.promptGuidelines?.length) {
		let heading = "Declared prompt guidelines (inactive):";
		if (active) heading = "Prompt guidelines:";
		if (active && systemPromptVisible) heading = "System prompt guidelines:";
		content.push(
			"",
			heading,
			...tool.promptGuidelines.map((line) => `- ${line}`),
		);
	}
	return content.join("\n");
}

function toolHighlightTarget(tool: ToolRecord, systemPromptVisible: boolean) {
	if (!systemPromptVisible) return undefined;
	const lines: string[] = [];
	if (tool.promptSnippet) lines.push(`- ${tool.name}: ${tool.promptSnippet}`);
	for (const guideline of tool.promptGuidelines ?? []) {
		const trimmed = guideline.trim();
		if (trimmed) lines.push(`- ${trimmed}`);
	}
	return { kind: "contains-lines" as const, lines };
}

function buildToolItem(snapshot: ManagerSnapshot, tool: ToolRecord): ViewItem {
	const active = snapshot.activeTools.has(tool.name);
	const runtimeControl = snapshot.runtimeToolControls.get(tool.name);
	const projectLocked =
		!snapshot.presetName &&
		!runtimeControl &&
		snapshot.projectDisabledTools.has(tool.name);
	const systemPromptVisible = active && !snapshot.customPromptActive;
	return {
		id: tool.name,
		label: tool.name,
		enabled: active,
		locked: Boolean(runtimeControl || projectLocked),
		state: `${active ? "active" : "inactive"}${toolControlState(runtimeControl, projectLocked)}`,
		detail: sourceDetail(tool.sourceInfo),
		monitor: showCapturedSystemPrompt(
			snapshot,
			{
				title: `Tool · ${tool.name}`,
				channel: "provider tools payload",
				status: active
					? "active · definition expected on the next provider request"
					: "inactive · definition excluded by current policy",
				statusColor: active ? "success" : "dim",
				note: toolMonitorNote(snapshot, tool, active),
				content: toolPromptContent(tool, active, systemPromptVisible),
				highlightTarget: toolHighlightTarget(tool, systemPromptVisible),
			},
			{ showFullPrompt: active },
		),
	};
}

function buildToolItems(snapshot: ManagerSnapshot): ViewItem[] {
	return snapshot.tools.map((tool) => buildToolItem(snapshot, tool));
}

interface SkillPresenceState {
	catalogVisible: boolean;
	presenceStateLabel: string;
	status: string;
}

function skillPresenceState(
	snapshot: ManagerSnapshot,
	skill: SkillRecord,
	enabled: boolean,
): SkillPresenceState {
	const readAvailable = snapshot.activeTools.has("read");
	const catalogVisible =
		enabled && readAvailable && !skill.disableModelInvocation;
	if (!enabled) {
		return {
			catalogVisible,
			presenceStateLabel: "disabled",
			status: "disabled by current policy",
		};
	}
	if (skill.disableModelInvocation) {
		return {
			catalogVisible,
			presenceStateLabel: "catalog omitted",
			status: "manual invocation only · omitted from the skill catalog",
		};
	}
	if (!readAvailable) {
		return {
			catalogVisible,
			presenceStateLabel: "catalog omitted",
			status: "enabled, but read is inactive · catalog omitted",
		};
	}
	return {
		catalogVisible,
		presenceStateLabel: "enabled",
		status: "enabled · expected in the next base system prompt",
	};
}

function previewSkill(skill: SkillRecord, sourceInfo: SourceInfo): Skill {
	return {
		name: skill.name,
		description: skill.description,
		filePath: skill.path,
		baseDir: dirname(skill.path),
		sourceInfo,
		disableModelInvocation: false,
	};
}

function skillPromptPreview(skill: SkillRecord, sourceInfo: SourceInfo) {
	const content = formatSkillsForPrompt([previewSkill(skill, sourceInfo)]).trim();
	const lines = content.split("\n");
	const skillStart = lines.findIndex((line) => line.trim() === "<skill>");
	const skillEnd = lines.findIndex(
		(line, index) => index > skillStart && line.trim() === "</skill>",
	);
	return {
		content,
		highlightTarget: {
			kind: "text-span" as const,
			text:
				skillStart >= 0 && skillEnd > skillStart
					? lines.slice(skillStart + 1, skillEnd).join("\n")
					: content,
		},
	};
}

function buildLoadedSkillItem(
	snapshot: ManagerSnapshot,
	skill: SkillRecord,
): ViewItem {
	const enabled = snapshot.enabledSkills.has(skill.name);
	const projectLocked =
		!snapshot.presetName && snapshot.projectDisabledSkills.has(skill.name);
	const presence = skillPresenceState(snapshot, skill, enabled);
	const sourceInfo: SourceInfo = {
		path: skill.path,
		source: "pi-config-manager-preview",
		scope: "temporary",
		origin: "top-level",
	};
	const preview = skillPromptPreview(skill, sourceInfo);
	return {
		id: skill.name,
		label: skill.name,
		enabled,
		locked: projectLocked,
		state: `${enabled ? "enabled" : "disabled"}${projectLocked ? " · blocked by project settings" : ""}`,
		detail: skill.sourceInfo
			? `${sourceDetail(skill.sourceInfo)}\n${skill.path}`
			: skill.path,
		monitor: showCapturedSystemPrompt(
			snapshot,
			{
				title: `Skill · ${skill.name}`,
				channel: "system prompt skill catalog",
				status: presence.status,
				statusColor: presence.catalogVisible ? "success" : "warning",
				note: "This previews Pi's base prompt; later extension prompt rewrites can still differ.",
				content: preview.content,
				highlightTarget: preview.highlightTarget,
			},
			{
				showFullPrompt: true,
				expectation: {
					shouldBePresent: presence.catalogVisible,
					stateLabel: presence.presenceStateLabel,
				},
			},
		),
	};
}

function buildSkillItems(snapshot: ManagerSnapshot): ViewItem[] {
	return snapshot.skills.map((skill) => buildLoadedSkillItem(snapshot, skill));
}

function buildContextItem(
	snapshot: ManagerSnapshot,
	context: ContextRecord,
): ViewItem {
	const enabled = snapshot.enabledContexts.has(context.path);
	const projectLocked =
		!snapshot.presetName && snapshot.projectDisabledContexts.has(context.path);
	return {
		id: context.path,
		label: basename(context.path),
		group: "Context Files",
		enabled,
		locked: projectLocked,
		state: `${enabled ? "enabled" : "disabled"}${projectLocked ? " · blocked by project settings" : ""}`,
		detail: context.path,
		monitor: showCapturedSystemPrompt(
			snapshot,
			{
				title: `Context · ${basename(context.path)}`,
				channel: "system prompt project_context section",
				status: enabled
					? "enabled · expected in the next base system prompt"
					: "disabled by current policy",
				statusColor: enabled ? "success" : "warning",
				note: "This previews Pi's base prompt; later extension prompt rewrites can still differ.",
				content: formatContextSection([context]).trim(),
				highlightTarget: {
					kind: "contains-lines",
					lines: [`<project_instructions path="${context.path}">`],
				},
			},
			{
				showFullPrompt: true,
				expectation: {
					shouldBePresent: enabled,
					stateLabel: enabled ? "enabled" : "disabled",
				},
			},
		),
	};
}

function buildContextItems(snapshot: ManagerSnapshot): ViewItem[] {
	const effectivePrompt = getEffectivePromptItem(snapshot);
	return [
		...getPromptSourceItems(snapshot),
		...snapshot.contexts.map((context) => buildContextItem(snapshot, context)),
		...(effectivePrompt ? [effectivePrompt] : []),
	];
}

export function buildResourceViewItems(
	tab: ResourceTab,
	snapshot: ManagerSnapshot,
): ViewItem[] {
	if (tab === "overview") return buildOverviewItems(snapshot);
	if (tab === "tools") return buildToolItems(snapshot);
	if (tab === "skills") return buildSkillItems(snapshot);
	if (tab === "contexts") return buildContextItems(snapshot);
	return [];
}
