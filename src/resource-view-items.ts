import { basename, dirname } from "node:path";
import {
	formatSkillsForPrompt,
	type ResolvedResource,
	type Skill,
	type SourceInfo,
} from "@earendil-works/pi-coding-agent";
import {
	formatContextSection,
	getPromptSourceItems,
	showCapturedSystemPrompt,
	type ViewItem,
} from "./context-monitor";
import type {
	ManagerSnapshot,
	PackageResourceChange,
	PackageResourceKind,
	ResourceTab,
	ToolRecord,
} from "./types";

export function packageKindForTab(
	tab: ResourceTab,
): Exclude<PackageResourceKind, "skills"> | undefined {
	if (tab === "prompts" || tab === "themes" || tab === "extensions") {
		return tab;
	}
	return undefined;
}

export function packageResourceId(
	kind: PackageResourceKind,
	resource: ResolvedResource,
): string {
	return `${kind}:${resource.path}`;
}

function resourceSourceDetail(resource: ResolvedResource): string {
	return `${resource.metadata.scope}/${resource.metadata.origin} · ${resource.metadata.source}\n${resource.path}`;
}

export function resolvedSourceInfo(resource: ResolvedResource): SourceInfo {
	return {
		path: resource.path,
		source: resource.metadata.source,
		scope: resource.metadata.scope,
		origin: resource.metadata.origin,
		baseDir: resource.metadata.baseDir,
	};
}

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

export function buildResourceViewItems(
	tab: ResourceTab,
	snapshot: ManagerSnapshot,
	stagedPackageResources: Map<string, PackageResourceChange>,
): ViewItem[] {
	if (tab === "overview") {
		const promptSourceCount =
			Number(Boolean(snapshot.customSystemPrompt)) +
			Number(Boolean(snapshot.appendedSystemPrompt)) +
			Number(Boolean(snapshot.presetInstructions));
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
				state: `${snapshot.enabledSkills.size}/${snapshot.skills.length} loaded · ${snapshot.unloadedSkills.length} unloaded`,
				detail:
					"Pi-loaded skills use manager policy; skills disabled in Pi settings require reload.",
			},
			{
				id: "contexts",
				label: "Contexts",
				state: snapshot.contextsKnown
					? `${snapshot.enabledContexts.size}/${snapshot.contexts.length} files · ${promptSourceCount} prompt sources`
					: "loading",
				detail:
					"Toggle Pi-loaded context files and inspect read-only system prompt sources.",
			},
			{
				id: "prompts",
				label: "Prompt Templates",
				state: snapshot.promptsKnown
					? `${snapshot.prompts.filter((item) => item.enabled).length}/${snapshot.prompts.length}`
					: "loading",
				detail: "Pi-resolved prompt templates. Changes require reload.",
			},
			{
				id: "themes",
				label: "Themes",
				state: snapshot.themesKnown
					? `${snapshot.themes.filter((item) => item.enabled).length}/${snapshot.themes.length}`
					: "loading",
				detail: "Pi-resolved themes. Changes require reload.",
			},
			{
				id: "extensions",
				label: "Extensions",
				state: snapshot.extensionsKnown
					? `${snapshot.extensions.filter((item) => item.enabled).length}/${snapshot.extensions.length}`
					: "loading",
				detail: "Pi-resolved extension resources. Changes require reload.",
			},
		];
	}
	if (tab === "tools")
		return snapshot.tools.map((tool) => {
			const active = snapshot.activeTools.has(tool.name);
			const runtimeControl = snapshot.runtimeToolControls.get(tool.name);
			const projectLocked =
				!snapshot.presetName &&
				!runtimeControl &&
				snapshot.projectDisabledTools.has(tool.name);
			const controlState = runtimeControl
				? ` · ${runtimeControl.action === "disable" ? "blocked" : "required"} by ${runtimeControl.layerId}`
				: projectLocked
					? " · blocked by project settings"
					: "";
			const systemPromptVisible = active && !snapshot.customPromptActive;
			return {
				id: tool.name,
				label: tool.name,
				enabled: active,
				locked: Boolean(runtimeControl || projectLocked),
				state: `${active ? "active" : "inactive"}${controlState}`,
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
						note: !active
							? "Pi does not expose an inactive tool's promptSnippet."
							: snapshot.customPromptActive &&
									(tool.promptSnippet || tool.promptGuidelines?.length)
								? "A custom system prompt is active, so Pi omits this tool's prompt snippet and guidelines."
								: undefined,
						content: [
							"Pi tool definition (provider serialization may vary):",
							stringifyJson({
								name: tool.name,
								description: tool.description,
								parameters: tool.parameters,
							}),
							...(active && tool.promptSnippet
								? [
										"",
										systemPromptVisible
											? "System prompt Available tools entry:"
											: "Prompt snippet:",
										`- ${tool.name}: ${tool.promptSnippet}`,
									]
								: []),
							...(!active
								? ["", "Prompt snippet: unavailable while inactive"]
								: []),
							...(tool.promptGuidelines?.length
								? [
										"",
										active && systemPromptVisible
											? "System prompt guidelines:"
											: active
												? "Prompt guidelines:"
												: "Declared prompt guidelines (inactive):",
										...tool.promptGuidelines.map((line) => `- ${line}`),
									]
								: []),
						].join("\n"),
						highlightTarget: systemPromptVisible
							? {
									kind: "contains-lines",
									lines: [
										...(tool.promptSnippet
											? [`- ${tool.name}: ${tool.promptSnippet}`]
											: []),
										...(tool.promptGuidelines ?? [])
											.map((line) => line.trim())
											.filter(Boolean)
											.map((line) => `- ${line}`),
									],
								}
							: undefined,
					},
					{ showFullPrompt: active },
				),
			};
		});
	if (tab === "skills") {
		const loadedItems = snapshot.skills.map((skill) => {
			const enabled = snapshot.enabledSkills.has(skill.name);
			const projectLocked =
				!snapshot.presetName &&
				snapshot.projectDisabledSkills.has(skill.name);
			const readAvailable = snapshot.activeTools.has("read");
			const catalogVisible =
				enabled && readAvailable && !skill.disableModelInvocation;
			let presenceStateLabel = "catalog omitted";
			if (!enabled) presenceStateLabel = "disabled";
			else if (catalogVisible) presenceStateLabel = "enabled";
			let status = "enabled · expected in the next base system prompt";
			if (!enabled) status = "disabled by current policy";
			else if (skill.disableModelInvocation) {
				status = "manual invocation only · omitted from the skill catalog";
			} else if (!readAvailable) {
				status = "enabled, but read is inactive · catalog omitted";
			}
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
						status,
						statusColor: catalogVisible ? "success" : "warning",
						note: "This previews Pi's base prompt; later extension prompt rewrites can still differ.",
						content: formatSkillsForPrompt([
							{
								name: skill.name,
								description: skill.description,
								filePath: skill.path,
								baseDir: dirname(skill.path),
								sourceInfo: {
									path: skill.path,
									source: "pi-config-manager-preview",
									scope: "temporary",
									origin: "top-level",
								},
								disableModelInvocation: false,
							} satisfies Skill,
						]).trim(),
						highlightTarget: {
							kind: "skill-fields",
							skillName: skill.name,
						},
					},
					{
						showFullPrompt: true,
						expectation: {
							shouldBePresent: catalogVisible,
							stateLabel: presenceStateLabel,
						},
					},
				),
			};
		});
		const unloadedItems = snapshot.unloadedSkills.flatMap((skill) => {
			const resource = skill.nativeResource;
			if (!resource) return [];
			const id = packageResourceId("skills", resource);
			const staged = stagedPackageResources.get(id);
			const enabled = staged?.enabled ?? false;
			return [
				{
					id,
					label: skill.name,
					enabled,
					state: staged
						? `${enabled ? "enable" : "disable"} staged · reload required`
						: "not loaded by Pi settings · reload required",
					detail: resourceSourceDetail(resource),
					monitor: showCapturedSystemPrompt(
						snapshot,
						{
							title: `Skill · ${skill.name}`,
							channel: "system prompt skill catalog",
							status: "not loaded by Pi settings",
							statusColor: "dim",
							content: formatSkillsForPrompt([
								{
									name: skill.name,
									description: skill.description,
									filePath: skill.path,
									baseDir: dirname(skill.path),
									sourceInfo:
										skill.sourceInfo ?? resolvedSourceInfo(resource),
									disableModelInvocation: false,
								} satisfies Skill,
							]).trim(),
							highlightTarget: {
								kind: "skill-fields",
								skillName: skill.name,
							},
							note: "Press Space to stage enabling this skill in Pi settings, then S to save and reload.",
						},
						{
							showFullPrompt: true,
							expectation: {
								shouldBePresent: false,
								stateLabel: "not loaded",
							},
						},
					),
				},
			];
		});
		return [...loadedItems, ...unloadedItems];
	}
	if (tab === "contexts") {
		const contextItems = snapshot.contexts.map((context) => {
			const enabled = snapshot.enabledContexts.has(context.path);
			const projectLocked =
				!snapshot.presetName &&
				snapshot.projectDisabledContexts.has(context.path);
			return {
				id: context.path,
				label: basename(context.path),
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
							kind: "contains-lines" as const,
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
		});
		return [...getPromptSourceItems(snapshot), ...contextItems];
	}
	const packageKind = packageKindForTab(tab);
	if (!packageKind) return [];
	return snapshot[packageKind].map((resource) => {
		const id = packageResourceId(packageKind, resource);
		const staged = stagedPackageResources.get(id);
		const enabled = staged?.enabled ?? resource.enabled;
		return {
			id,
			label: basename(resource.path),
			enabled,
			state: `${enabled ? "enabled" : "disabled"} · reload required`,
			detail: resourceSourceDetail(resource),
		};
	});
}


