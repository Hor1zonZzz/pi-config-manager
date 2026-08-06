import { basename, dirname } from "node:path";
import {
	getAgentDir,
	loadSkills,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { resolvedSourceInfo } from "./resource-view-items";
import { resolvePackageResources } from "./extensions";
import {
	installResourceHud,
	openConfigManager,
	selectPreset,
} from "./manager-ui";
import { PolicyManager } from "./policy-manager";
import { applySystemPromptPolicy } from "./system-prompt-policy";
import { installPresetEditor, type PresetBorderEditor } from "./preset-editor";
import { loadPresets, type Preset, type PresetsConfig } from "./presets";
import {
	cloneSessionState,
	loadGlobalSettings,
	loadProjectSettings,
	normalizeSessionState,
	saveGlobalSettings,
} from "./storage";
import {
	DEFAULT_SESSION_STATE,
	type ContextRecord,
	type ManagerSnapshot,
	type PresetOriginalState,
	type ResourceSettings,
	type ResourceTab,
	type RuntimeLayer,
	type SessionResourceState,
	type SkillRecord,
} from "./types";

const SESSION_ENTRY = "pi-config-manager-state";
type ToggleableResourceTab = "tools" | "skills" | "contexts";
type PolicyPhase = "collecting" | "initializing" | "ready" | "stopped";

function isResourceEnabled(
	snapshot: ManagerSnapshot,
	tab: ToggleableResourceTab,
	id: string,
): boolean {
	if (tab === "tools") return snapshot.activeTools.has(id);
	if (tab === "skills") return snapshot.enabledSkills.has(id);
	return snapshot.enabledContexts.has(id);
}

function unique(values: Iterable<string>): string[] {
	return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

export default function piConfigManager(pi: ExtensionAPI) {
	let globalSettings: ResourceSettings = loadGlobalSettings();
	let projectSettings: ResourceSettings = loadProjectSettings(
		process.cwd(),
		false,
	);
	let sessionState: SessionResourceState = cloneSessionState(
		DEFAULT_SESSION_STATE,
	);
	let presets: PresetsConfig = {};
	let activePresetName: string | undefined;
	let activePreset: Preset | undefined;
	let activePresetEditor: PresetBorderEditor | undefined;
	const policy = new PolicyManager({
		defaultTools: [],
		globalSettings,
		projectSettings,
		sessionState,
	});
	let lastAppliedTools = new Set<string>();
	let hasAppliedTools = false;
	let policyPhase: PolicyPhase = "collecting";
	let runtimePolicyDirty = false;
	let toolsInventoryUpdating = false;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	let requestHudRender: (() => void) | undefined;
	let snapshot: ManagerSnapshot = {
		ready: false,
		customPromptActive: false,
		customSystemPrompt: undefined,
		appendedSystemPrompt: undefined,
		presetInstructions: undefined,
		contextsKnown: false,
		extensionsKnown: false,
		promptsKnown: false,
		themesKnown: false,
		tools: [],
		toolSnippets: {},
		activeTools: new Set(),
		runtimeToolControls: new Map(),
		projectDisabledTools: new Set(),
		skills: [],
		unloadedSkills: [],
		enabledSkills: new Set(),
		projectDisabledSkills: new Set(),
		contexts: [],
		enabledContexts: new Set(),
		projectDisabledContexts: new Set(),
		extensions: [],
		prompts: [],
		themes: [],
	};

	function persistSession(): void {
		pi.appendEntry(SESSION_ENTRY, cloneSessionState(sessionState));
	}

	function resetSessionResourceOverrides(): void {
		sessionState.tools = undefined;
		sessionState.enabledSkills = [];
		sessionState.disabledSkills = [];
		sessionState.enabledContexts = [];
		sessionState.disabledContexts = [];
	}

	function restoreSession(ctx: ExtensionContext): void {
		sessionState = cloneSessionState(DEFAULT_SESSION_STATE);
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== SESSION_ENTRY)
				continue;
			const restored = normalizeSessionState(entry.data);
			if (restored) sessionState = restored;
		}
	}

	function reconcileTools(): void {
		pi.setActiveTools(Array.from(policy.resolveEffectiveTools()));
		lastAppliedTools = new Set(pi.getActiveTools());
		hasAppliedTools = true;
		snapshot = {
			...snapshot,
			activeTools: new Set(lastAppliedTools),
			runtimeToolControls: policy.resolveRuntimeToolControls(),
		};
		requestHudRender?.();
		emitStateChanged();
	}

	function emitStateChanged(): void {
		pi.events.emit("config-manager:state-changed", publicSnapshot());
	}

	function refreshPromptPreview(ctx: ExtensionContext): void {
		if (snapshot.effectiveSystemPrompt?.source === "agent-start") return;
		const currentPrompt = ctx.getSystemPrompt();
		snapshot = {
			...snapshot,
			effectiveSystemPrompt: currentPrompt
				? {
						content: currentPrompt,
						capturedAt: Date.now(),
						source: "command",
					}
				: undefined,
		};
	}

	function getManagerSnapshot(): ManagerSnapshot {
		return {
			...snapshot,
			projectDisabledTools: new Set(projectSettings.disabledTools),
			projectDisabledSkills: new Set(projectSettings.disabledSkills),
			projectDisabledContexts: new Set(projectSettings.disabledContexts),
		};
	}

	function updateToolsInventory(): void {
		if (toolsInventoryUpdating) {
			runtimePolicyDirty = true;
			return;
		}
		toolsInventoryUpdating = true;
		try {
			do {
				runtimePolicyDirty = false;
				if (hasAppliedTools) {
					policy.observeExternalTools(
						pi.getActiveTools().filter((name) => !lastAppliedTools.has(name)),
					);
				}
				const allTools = pi.getAllTools();
				policy.setDiscoveredTools(allTools.map((tool) => tool.name));
				snapshot = {
					...snapshot,
					tools: allTools
						.map((tool) => ({
							name: tool.name,
							description: tool.description,
							promptSnippet: snapshot.toolSnippets[tool.name],
							parameters: tool.parameters,
							promptGuidelines: tool.promptGuidelines,
							sourceInfo: tool.sourceInfo,
						}))
						.sort((a, b) => a.name.localeCompare(b.name)),
				};
				reconcileTools();
			} while (runtimePolicyDirty);
		} finally {
			toolsInventoryUpdating = false;
		}
	}

	function getPresetLabel(): string {
		const mode = activePresetName ?? "default";
		return sessionState.preset?.customTools ? `${mode} (custom tools)` : mode;
	}

	function updatePresetStatus(ctx: ExtensionContext): void {
		snapshot = {
			...snapshot,
			presetName: activePresetName,
			presetInstructions: activePreset?.instructions,
		};
		ctx.ui.setStatus("preset", undefined);
		ctx.ui.setWidget("preset", undefined);
		activePresetEditor?.requestRender();
		requestHudRender?.();
	}

	function setPresetPolicy(
		name: string,
		preset: Preset,
		tools: string[] | undefined,
	): void {
		policy.setProfile({ id: name, tools, skills: preset.skills });
		snapshot = {
			...snapshot,
			enabledSkills: policy.resolveEnabledSkills(snapshot.skills),
			enabledContexts: policy.resolveEnabledContexts(snapshot.contexts),
		};
	}

	function currentOriginalState(ctx: ExtensionContext): PresetOriginalState {
		return {
			provider: ctx.model?.provider,
			model: ctx.model?.id,
			thinkingLevel: pi.getThinkingLevel(),
			tools: Array.from(policy.resolveBaseTools()),
		};
	}

	function validatedPresetTools(
		name: string,
		preset: Preset,
		ctx: ExtensionContext,
	): string[] | undefined {
		if (!preset.tools) return undefined;
		const discovered = new Set(pi.getAllTools().map((tool) => tool.name));
		const valid = preset.tools.filter((tool) => discovered.has(tool));
		const invalid = preset.tools.filter((tool) => !discovered.has(tool));
		if (invalid.length > 0) {
			ctx.ui.notify(
				`Preset "${name}": Unknown tools: ${invalid.join(", ")}`,
				"warning",
			);
		}
		return unique(valid);
	}

	async function applyPreset(
		name: string,
		preset: Preset,
		ctx: ExtensionContext,
	): Promise<void> {
		const originalState =
			sessionState.preset?.originalState ?? currentOriginalState(ctx);
		const configuredTools = validatedPresetTools(name, preset, ctx);
		const appliedTools =
			configuredTools ?? Array.from(policy.resolveConfiguredTools());

		if (preset.provider && preset.model) {
			const model = ctx.modelRegistry.find(preset.provider, preset.model);
			if (!model) {
				ctx.ui.notify(
					`Preset "${name}": Model ${preset.provider}/${preset.model} not found`,
					"warning",
				);
			} else if (!(await pi.setModel(model))) {
				ctx.ui.notify(
					`Preset "${name}": No API key for ${preset.provider}/${preset.model}`,
					"warning",
				);
			}
		}
		if (preset.thinkingLevel) pi.setThinkingLevel(preset.thinkingLevel);

		activePresetName = name;
		activePreset = preset;
		resetSessionResourceOverrides();
		sessionState.preset = {
			name,
			customTools: false,
			appliedTools,
			originalState,
		};
		policy.setSessionState(sessionState);
		setPresetPolicy(name, preset, appliedTools);
		reconcileTools();
		persistSession();
		updatePresetStatus(ctx);
	}

	async function clearPreset(ctx: ExtensionContext): Promise<void> {
		const originalState = sessionState.preset?.originalState;
		activePresetName = undefined;
		activePreset = undefined;
		policy.setProfile(undefined);
		sessionState.preset = undefined;
		resetSessionResourceOverrides();
		policy.setSessionState(sessionState);
		if (originalState?.provider && originalState.model) {
			const model = ctx.modelRegistry.find(
				originalState.provider,
				originalState.model,
			);
			if (model) await pi.setModel(model);
		}
		if (originalState) pi.setThinkingLevel(originalState.thinkingLevel);
		snapshot = {
			...snapshot,
			enabledSkills: policy.resolveEnabledSkills(snapshot.skills),
			enabledContexts: policy.resolveEnabledContexts(snapshot.contexts),
		};
		reconcileTools();
		persistSession();
		updatePresetStatus(ctx);
	}

	function restorePresetPolicy(ctx: ExtensionContext): void {
		const state = sessionState.preset;
		const preset = state ? presets[state.name] : undefined;
		if (!state || !preset) {
			activePresetName = undefined;
			activePreset = undefined;
			policy.setProfile(undefined);
			if (state) sessionState.preset = undefined;
			resetSessionResourceOverrides();
			policy.setSessionState(sessionState);
			updatePresetStatus(ctx);
			return;
		}
		activePresetName = state.name;
		activePreset = preset;
		const tools =
			state.appliedTools ??
			preset.tools?.filter((tool) =>
				pi.getAllTools().some((candidate) => candidate.name === tool),
			);
		setPresetPolicy(state.name, preset, tools);
		updatePresetStatus(ctx);
	}

	async function showPresetSelector(ctx: ExtensionContext): Promise<void> {
		const result = await selectPreset(ctx, presets, activePresetName);
		if (!result) return;
		if (result === "(none)") {
			await clearPreset(ctx);
			ctx.ui.notify("Preset cleared, defaults restored", "info");
			return;
		}
		const preset = presets[result];
		if (!preset) return;
		await applyPreset(result, preset, ctx);
		ctx.ui.notify(`Preset "${result}" activated`, "info");
	}

	async function cyclePreset(ctx: ExtensionContext): Promise<void> {
		const names = Object.keys(presets).sort((a, b) => a.localeCompare(b));
		if (names.length === 0) {
			ctx.ui.notify(
				"No presets defined in global or project presets.json",
				"warning",
			);
			return;
		}
		const cycle = ["(none)", ...names];
		const current = activePresetName ?? "(none)";
		const currentIndex = cycle.indexOf(current);
		const next =
			cycle[currentIndex < 0 ? 0 : (currentIndex + 1) % cycle.length];
		if (!next) return;
		if (next === "(none)") {
			await clearPreset(ctx);
			ctx.ui.notify("Preset cleared, defaults restored", "info");
			return;
		}
		const preset = presets[next];
		if (!preset) return;
		await applyPreset(next, preset, ctx);
		ctx.ui.notify(`Preset "${next}" activated`, "info");
	}

	function updatePromptInventory(options: BuildSystemPromptOptions): void {
		const skills: SkillRecord[] = (options.skills ?? [])
			.map((skill: any) => ({
				name: skill.name,
				description: skill.description ?? "No description",
				path: skill.path ?? skill.filePath ?? "Path unavailable",
				disableModelInvocation: skill.disableModelInvocation === true,
				sourceInfo: skill.sourceInfo,
				loaded: true,
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
		const contexts: ContextRecord[] = (options.contextFiles ?? []).map(
			(file) => ({ path: file.path, content: file.content }),
		);
		const toolSnippets = Object.fromEntries(
			Object.entries(options.toolSnippets ?? {}).filter(
				([, snippet]) => typeof snippet === "string" && snippet.length > 0,
			),
		);
		snapshot = {
			...snapshot,
			ready: true,
			customPromptActive: Boolean(options.customPrompt),
			customSystemPrompt: options.customPrompt,
			appendedSystemPrompt: options.appendSystemPrompt,
			toolSnippets,
			skills,
			enabledSkills: policy.resolveEnabledSkills(skills),
			contextsKnown: true,
			contexts,
			enabledContexts: policy.resolveEnabledContexts(contexts),
		};
		requestHudRender?.();
	}

	async function refreshPackageResources(ctx: ExtensionContext): Promise<void> {
		try {
			const resources = await resolvePackageResources(
				ctx.cwd,
				ctx.isProjectTrusted(),
			);
			const loadedSkillPaths = new Set(
				snapshot.skills.map((skill) => skill.path),
			);
			const unloadedSkills = resources.skills
				.flatMap((resource): SkillRecord[] => {
					if (resource.enabled || loadedSkillPaths.has(resource.path))
						return [];
					const loaded = loadSkills({
						cwd: ctx.cwd,
						agentDir: getAgentDir(),
						skillPaths: [resource.path],
						includeDefaults: false,
					}).skills[0];
					return [
						{
							name:
								loaded?.name ??
								(basename(resource.path).toLowerCase() === "skill.md"
									? basename(dirname(resource.path))
									: basename(resource.path).replace(/\.md$/i, "")),
							description:
								loaded?.description ?? "Disabled in Pi resource settings",
							path: resource.path,
							disableModelInvocation: loaded?.disableModelInvocation,
							sourceInfo: resolvedSourceInfo(resource),
							loaded: false,
							nativeResource: resource,
						},
					];
				})
				.sort((a, b) => a.name.localeCompare(b.name));
			snapshot = {
				...snapshot,
				extensionsKnown: true,
				promptsKnown: true,
				themesKnown: true,
				extensions: resources.extensions,
				prompts: resources.prompts,
				themes: resources.themes,
				unloadedSkills,
			};
			requestHudRender?.();
			emitStateChanged();
		} catch (error) {
			ctx.ui.notify(
				`Could not resolve package resources: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	}

	function refreshSkillsFromCommands(): void {
		const existingSkills = new Map(
			snapshot.skills.map((skill) => [skill.name, skill]),
		);
		const skills = pi
			.getCommands()
			.filter((command) => command.source === "skill")
			.map((command) => {
				const name = command.name.replace(/^skill:/, "");
				return {
					name,
					description: command.description ?? "No description",
					path: command.sourceInfo.path,
					disableModelInvocation:
						existingSkills.get(name)?.disableModelInvocation,
					sourceInfo: command.sourceInfo,
					loaded: true,
				};
			})
			.sort((a, b) => a.name.localeCompare(b.name));
		snapshot = {
			...snapshot,
			ready: true,
			skills,
			enabledSkills: policy.resolveEnabledSkills(skills),
		};
		requestHudRender?.();
		emitStateChanged();
	}

	function scheduleSettledRefresh(ctx: ExtensionContext): void {
		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = setTimeout(() => {
			settleTimer = undefined;
			updateToolsInventory();
			refreshSkillsFromCommands();
			void refreshPackageResources(ctx);
		}, 500);
	}

	function publicSnapshot() {
		return {
			ready: snapshot.ready,
			baseTools: Array.from(policy.resolveBaseTools()),
			tools: {
				active: snapshot.activeTools.size,
				total: snapshot.tools.length,
			},
			skills: {
				enabled: snapshot.enabledSkills.size,
				total: snapshot.skills.length + snapshot.unloadedSkills.length,
				unloaded: snapshot.unloadedSkills.length,
			},
			contexts: {
				enabled: snapshot.enabledContexts.size,
				total: snapshot.contexts.length,
			},
			prompts: {
				enabled: snapshot.prompts.filter((item) => item.enabled).length,
				total: snapshot.prompts.length,
			},
			themes: {
				enabled: snapshot.themes.filter((item) => item.enabled).length,
				total: snapshot.themes.length,
			},
			extensions: {
				enabled: snapshot.extensions.filter((item) => item.enabled).length,
				total: snapshot.extensions.length,
			},
		};
	}

	function toggleSessionResource(
		tab: ToggleableResourceTab,
		id: string,
		ctx: ExtensionContext,
	): void {
		if (tab === "tools") {
			const wasEffective = snapshot.activeTools.has(id);
			policy.removeExternalTool(id);
			const base = policy.resolveBaseTools();
			if (wasEffective) base.delete(id);
			else base.add(id);
			sessionState.tools = unique(base);
			if (sessionState.preset) sessionState.preset.customTools = true;
			policy.setSessionState(sessionState);
			reconcileTools();
			persistSession();
			updatePresetStatus(ctx);
			return;
		}
		if (tab === "skills") {
			const enabled = snapshot.enabledSkills.has(id);
			sessionState.enabledSkills = sessionState.enabledSkills.filter(
				(name) => name !== id,
			);
			sessionState.disabledSkills = sessionState.disabledSkills.filter(
				(name) => name !== id,
			);
			if (enabled) sessionState.disabledSkills.push(id);
			else sessionState.enabledSkills.push(id);
			sessionState.enabledSkills = unique(sessionState.enabledSkills);
			sessionState.disabledSkills = unique(sessionState.disabledSkills);
			policy.setSessionState(sessionState);
			snapshot = {
				...snapshot,
				enabledSkills: policy.resolveEnabledSkills(snapshot.skills),
			};
			persistSession();
			requestHudRender?.();
			emitStateChanged();
			return;
		}
		if (tab === "contexts") {
			const enabled = snapshot.enabledContexts.has(id);
			sessionState.enabledContexts = sessionState.enabledContexts.filter(
				(path) => path !== id,
			);
			sessionState.disabledContexts = sessionState.disabledContexts.filter(
				(path) => path !== id,
			);
			if (enabled) sessionState.disabledContexts.push(id);
			else sessionState.enabledContexts.push(id);
			sessionState.enabledContexts = unique(sessionState.enabledContexts);
			sessionState.disabledContexts = unique(sessionState.disabledContexts);
			policy.setSessionState(sessionState);
			snapshot = {
				...snapshot,
				enabledContexts: policy.resolveEnabledContexts(snapshot.contexts),
			};
			persistSession();
			requestHudRender?.();
			emitStateChanged();
		}
	}

	function setGlobalResource(
		kind: "tools" | "skills" | "contexts",
		name: string,
		enabled: boolean,
		ctx: ExtensionContext,
	): void {
		if (kind === "tools") {
			const enabledTools = new Set(globalSettings.enabledTools);
			const disabledTools = new Set(globalSettings.disabledTools);
			if (enabled) {
				enabledTools.add(name);
				disabledTools.delete(name);
			} else {
				enabledTools.delete(name);
				disabledTools.add(name);
				policy.removeExternalTool(name);
			}
			globalSettings = {
				...globalSettings,
				enabledTools: unique(enabledTools),
				disabledTools: unique(disabledTools),
			};
		} else {
			const key = kind === "skills" ? "disabledSkills" : "disabledContexts";
			const values = new Set(globalSettings[key]);
			if (enabled) values.delete(name);
			else values.add(name);
			globalSettings = { ...globalSettings, [key]: unique(values) };
		}
		policy.setSettings(globalSettings, projectSettings);
		saveGlobalSettings(globalSettings);
		snapshot = {
			...snapshot,
			enabledSkills: policy.resolveEnabledSkills(snapshot.skills),
			enabledContexts: policy.resolveEnabledContexts(snapshot.contexts),
		};
		updateToolsInventory();
		ctx.ui.notify(
			`Global ${kind} setting updated: ${name} ${enabled ? "enabled" : "disabled"}`,
			"info",
		);
		requestHudRender?.();
	}

	function applyToggleableResourceChange(
		tab: ToggleableResourceTab,
		id: string,
		ctx: ExtensionCommandContext,
	): void {
		const runtimeControl =
			tab === "tools" ? snapshot.runtimeToolControls.get(id) : undefined;
		const projectLocked =
			!activePresetName &&
			(tab === "tools"
				? projectSettings.disabledTools.includes(id)
				: tab === "skills"
					? projectSettings.disabledSkills.includes(id)
					: projectSettings.disabledContexts.includes(id));
		if (runtimeControl) {
			ctx.ui.notify(
				`Tool "${id}" is ${runtimeControl.action === "disable" ? "blocked" : "required"} by runtime constraint "${runtimeControl.layerId}". Clear that constraint before changing its effective state.`,
				"warning",
			);
		} else if (projectLocked) {
			ctx.ui.notify(
				`Resource "${id}" is disabled by project settings. Edit .pi/resource-settings.json to change its effective state.`,
				"warning",
			);
		} else if (activePresetName) {
			toggleSessionResource(tab, id, ctx);
		} else {
			setGlobalResource(tab, id, !isResourceEnabled(snapshot, tab, id), ctx);
		}
		updatePromptInventory(ctx.getSystemPromptOptions());
		updateToolsInventory();
		refreshPromptPreview(ctx);
	}

	async function showManager(
		initialTab: ResourceTab,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		await openConfigManager(initialTab, ctx, {
			getSnapshot: getManagerSnapshot,
			prepare: async () => {
				updatePromptInventory(ctx.getSystemPromptOptions());
				updateToolsInventory();
				refreshPromptPreview(ctx);
				await refreshPackageResources(ctx);
			},
			togglePolicyResource: applyToggleableResourceChange,
		});
	}

	function installHud(ctx: ExtensionContext): void {
		installResourceHud(ctx, getManagerSnapshot, (requestRender) => {
			requestHudRender = requestRender;
		});
	}

	function registerResourceCommand(
		name: string,
		tab: ResourceTab,
		kind: "tools" | "skills" | "contexts",
	) {
		pi.registerCommand(name, {
			description: `Manage ${name} through Pi Config Manager`,
			handler: async (args, ctx) => {
				const parts = args.trim().split(/\s+/).filter(Boolean);
				if (
					parts[0] === "global" &&
					(parts[1] === "enable" || parts[1] === "disable") &&
					parts[2]
				) {
					setGlobalResource(
						kind,
						parts.slice(2).join(" "),
						parts[1] === "enable",
						ctx,
					);
					return;
				}
				await showManager(tab, ctx);
			},
		});
	}

	pi.registerCommand("config-manager", {
		description:
			"Manage Pi tools, skills, contexts, prompts, themes, and extensions",
		handler: async (_args, ctx) => showManager("overview", ctx),
	});
	registerResourceCommand("tools", "tools", "tools");
	registerResourceCommand("skills", "skills", "skills");
	registerResourceCommand("contexts", "contexts", "contexts");
	pi.registerCommand("prompts", {
		description: "Manage Pi prompt templates",
		handler: async (_args, ctx) => showManager("prompts", ctx),
	});
	pi.registerCommand("themes", {
		description: "Manage Pi themes",
		handler: async (_args, ctx) => showManager("themes", ctx),
	});
	pi.registerCommand("extensions", {
		description: "Manage Pi extensions",
		handler: async (_args, ctx) => showManager("extensions", ctx),
	});
	pi.registerCommand("preset", {
		description: "Switch preset configuration",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				await showPresetSelector(ctx);
				return;
			}
			const preset = presets[name];
			if (!preset) {
				const available = Object.keys(presets).join(", ") || "(none defined)";
				ctx.ui.notify(
					`Unknown preset "${name}". Available: ${available}`,
					"error",
				);
				return;
			}
			await applyPreset(name, preset, ctx);
			ctx.ui.notify(`Preset "${name}" activated`, "info");
		},
	});
	pi.registerShortcut(Key.ctrlShift("u"), {
		description: "Cycle presets",
		handler: cyclePreset,
	});
	pi.registerFlag("preset", {
		description: "Preset configuration to use",
		type: "string",
	});

	pi.events.on("config-manager:layer-set", (event) => {
		if (policyPhase === "stopped") return;
		const data = event as {
			id?: unknown;
			disableTools?: unknown;
			requireTools?: unknown;
		};
		if (typeof data.id !== "string") return;
		const toolNames = (value: unknown): string[] =>
			Array.isArray(value)
				? unique(
						value.filter((item): item is string => typeof item === "string"),
					)
				: [];
		const layer: RuntimeLayer = {
			id: data.id,
			disableTools: toolNames(data.disableTools),
			requireTools: toolNames(data.requireTools),
		};
		if (!policy.setRuntimeLayer(layer)) return;
		runtimePolicyDirty = true;
		if (policyPhase === "ready") updateToolsInventory();
	});
	pi.events.on("config-manager:layer-clear", (event) => {
		if (policyPhase === "stopped") return;
		const id = (event as { id?: unknown }).id;
		if (typeof id !== "string" || !policy.clearRuntimeLayer(id)) return;
		runtimePolicyDirty = true;
		if (policyPhase === "ready") updateToolsInventory();
	});
	pi.events.on("config-manager:request-snapshot", () => {
		emitStateChanged();
	});

	pi.on("input", (event, ctx) => {
		if (event.text.startsWith("/skill:")) refreshSkillsFromCommands();
		const match = event.text.match(/^\/skill:([^\s]+)/);
		const name = match?.[1];
		if (
			!name ||
			!snapshot.skills.some((skill) => skill.name === name) ||
			snapshot.enabledSkills.has(name)
		)
			return;
		ctx.ui.notify(
			`Skill "${name}" is disabled. Use /skills to enable it.`,
			"warning",
		);
		return { action: "handled" };
	});

	pi.on("before_agent_start", (event, ctx) => {
		updatePromptInventory(event.systemPromptOptions);
		updateToolsInventory();
		const result = applySystemPromptPolicy({
			systemPrompt: event.systemPrompt,
			systemPromptOptions: event.systemPromptOptions,
			enabledSkills: snapshot.enabledSkills,
			contexts: snapshot.contexts,
			enabledContexts: snapshot.enabledContexts,
			presetInstructions: activePreset?.instructions,
		});
		if (result.skillFilterMissed) {
			ctx.ui.notify(
				"Disabled Skills could not be removed from this custom system prompt; leaving the prompt unchanged.",
				"warning",
			);
		}
		if (result.contextFilterMissed) {
			ctx.ui.notify(
				"Disabled Context Files could not be removed from this custom system prompt; leaving the prompt unchanged.",
				"warning",
			);
		}
		return result.systemPrompt === event.systemPrompt
			? undefined
			: { systemPrompt: result.systemPrompt };
	});

	pi.on("agent_start", (_event, ctx) => {
		snapshot = {
			...snapshot,
			effectiveSystemPrompt: {
				content: ctx.getSystemPrompt(),
				capturedAt: Date.now(),
				source: "agent-start",
			},
		};
		requestHudRender?.();
	});

	pi.on("turn_start", () => {
		updateToolsInventory();
	});

	pi.on("session_start", async (_event, ctx) => {
		policyPhase = "initializing";
		const initialTools = pi.getActiveTools();
		lastAppliedTools = new Set();
		hasAppliedTools = false;
		activePresetEditor = undefined;
		globalSettings = loadGlobalSettings();
		projectSettings = loadProjectSettings(ctx.cwd, ctx.isProjectTrusted());
		presets = loadPresets(ctx.cwd, ctx.isProjectTrusted());
		restoreSession(ctx);
		const presetFlag = pi.getFlag("preset");
		if (typeof presetFlag === "string" && presetFlag) {
			resetSessionResourceOverrides();
			sessionState.preset = undefined;
			activePresetName = undefined;
			activePreset = undefined;
		}
		policy.initialize({
			defaultTools: initialTools,
			globalSettings,
			projectSettings,
			sessionState,
		});
		if (typeof presetFlag !== "string" || !presetFlag) {
			restorePresetPolicy(ctx);
		}
		snapshot = {
			...snapshot,
			ready: false,
			customPromptActive: false,
			customSystemPrompt: undefined,
			appendedSystemPrompt: undefined,
			presetInstructions: activePreset?.instructions,
			effectiveSystemPrompt: undefined,
			contextsKnown: false,
			extensionsKnown: false,
			promptsKnown: false,
			themesKnown: false,
			skills: [],
			unloadedSkills: [],
			contexts: [],
			extensions: [],
			prompts: [],
			themes: [],
			presetName: activePresetName,
		};
		updateToolsInventory();
		refreshSkillsFromCommands();
		installPresetEditor(ctx, getPresetLabel, (editor) => {
			activePresetEditor = editor;
		});
		installHud(ctx);
		if (typeof presetFlag === "string" && presetFlag) {
			const preset = presets[presetFlag];
			if (preset) {
				await applyPreset(presetFlag, preset, ctx);
				ctx.ui.notify(`Preset "${presetFlag}" activated`, "info");
			} else {
				const available = Object.keys(presets).join(", ") || "(none defined)";
				ctx.ui.notify(
					`Unknown preset "${presetFlag}". Available: ${available}`,
					"warning",
				);
			}
		}
		updatePresetStatus(ctx);
		updateToolsInventory();
		policyPhase = "ready";
		scheduleSettledRefresh(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		policyPhase = "initializing";
		policy.clearExternalTools();
		presets = loadPresets(ctx.cwd, ctx.isProjectTrusted());
		restoreSession(ctx);
		policy.setSessionState(sessionState);
		restorePresetPolicy(ctx);
		updateToolsInventory();
		snapshot = {
			...snapshot,
			effectiveSystemPrompt: undefined,
			enabledSkills: policy.resolveEnabledSkills(snapshot.skills),
			enabledContexts: policy.resolveEnabledContexts(snapshot.contexts),
		};
		updatePresetStatus(ctx);
		updateToolsInventory();
		policyPhase = "ready";
	});
	pi.on("session_shutdown", (_event, ctx) => {
		policyPhase = "stopped";
		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = undefined;
		ctx.ui.setWidget("pi-config-manager", undefined);
		requestHudRender = undefined;
	});
}
