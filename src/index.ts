import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	buildLoadedSkillInventory,
	buildPromptResourceInventory,
	buildPublicSnapshot,
	buildUnloadedSkillInventory,
} from "./resource-inventory";
import { resolvePackageResources } from "./extensions";
import { registerManagerCommands } from "./manager-commands";
import { installResourceHud, openConfigManager } from "./manager-ui";
import { PolicyManager } from "./policy-manager";
import {
	isProjectResourceDisabled,
	isResourceEnabled,
	toggleSessionResourceOverride,
	uniqueSorted,
	updateGlobalResourceSettings,
	type ToggleableResourceTab,
} from "./resource-policy-state";
import { PresetController } from "./preset-controller";
import { RuntimeLifecycleController } from "./runtime-lifecycle";
import { ToolRuntimeController } from "./tool-runtime-controller";
import {
	cloneSessionState,
	loadGlobalSettings,
	loadProjectSettings,
	normalizeSessionState,
	saveGlobalSettings,
} from "./storage";
import {
	DEFAULT_SESSION_STATE,
	type ManagerSnapshot,
	type ResourceSettings,
	type ResourceTab,
	type SessionResourceState,
} from "./types";

const SESSION_ENTRY = "pi-config-manager-state";

export default function piConfigManager(pi: ExtensionAPI) {
	let globalSettings: ResourceSettings = loadGlobalSettings();
	let projectSettings: ResourceSettings = loadProjectSettings(
		process.cwd(),
		false,
	);
	let sessionState: SessionResourceState = cloneSessionState(
		DEFAULT_SESSION_STATE,
	);
	const policy = new PolicyManager({
		defaultTools: [],
		globalSettings,
		projectSettings,
		sessionState,
	});
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
	const toolController = new ToolRuntimeController(pi, policy, {
		getSnapshot: () => snapshot,
		setSnapshot: (nextSnapshot) => {
			snapshot = nextSnapshot;
		},
		requestHudRender: () => requestHudRender?.(),
		emitStateChanged,
	});
	const presetController = new PresetController(pi, policy, {
		getSessionState: () => sessionState,
		setSessionState: (state) => {
			sessionState = state;
		},
		getSnapshot: () => snapshot,
		setSnapshot: (nextSnapshot) => {
			snapshot = nextSnapshot;
		},
		reconcileTools: () => toolController.reconcile(),
		persistSession,
		requestHudRender: () => requestHudRender?.(),
	});
	const lifecycleController = new RuntimeLifecycleController(
		pi,
		policy,
		presetController,
		toolController,
		{
			getSnapshot: () => snapshot,
			setSnapshot: (nextSnapshot) => {
				snapshot = nextSnapshot;
			},
			getSessionState: () => sessionState,
			setSettings: (nextGlobalSettings, nextProjectSettings) => {
				globalSettings = nextGlobalSettings;
				projectSettings = nextProjectSettings;
			},
			restoreSession,
			updatePromptInventory,
			refreshSkillsFromCommands,
			installHud,
			scheduleSettledRefresh,
			requestHudRender: () => requestHudRender?.(),
			shutdown: (ctx) => {
				if (settleTimer) clearTimeout(settleTimer);
				settleTimer = undefined;
				ctx.ui.setWidget("pi-config-manager", undefined);
				requestHudRender = undefined;
			},
		},
	);

	function persistSession(): void {
		pi.appendEntry(SESSION_ENTRY, cloneSessionState(sessionState));
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

	function updatePromptInventory(options: BuildSystemPromptOptions): void {
		const inventory = buildPromptResourceInventory(options);
		snapshot = {
			...snapshot,
			...inventory,
			ready: true,
			enabledSkills: policy.resolveEnabledSkills(inventory.skills),
			contextsKnown: true,
			enabledContexts: policy.resolveEnabledContexts(inventory.contexts),
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
			const unloadedSkills = buildUnloadedSkillInventory(
				resources.skills,
				loadedSkillPaths,
				ctx.cwd,
			);
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
		const skills = buildLoadedSkillInventory(pi.getCommands(), snapshot.skills);
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
			toolController.updateInventory();
			refreshSkillsFromCommands();
			void refreshPackageResources(ctx);
		}, 500);
	}

	function publicSnapshot() {
		return buildPublicSnapshot(snapshot, policy.resolveBaseTools());
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
			sessionState.tools = uniqueSorted(base);
			if (sessionState.preset) sessionState.preset.customTools = true;
			policy.setSessionState(sessionState);
			toolController.reconcile();
			persistSession();
			presetController.updateStatus(ctx);
			return;
		}
		const resourceTab = tab === "skills" ? "skills" : "contexts";
		const enabled = isResourceEnabled(snapshot, resourceTab, id);
		sessionState = toggleSessionResourceOverride(
			sessionState,
			resourceTab,
			id,
			enabled,
		);
		policy.setSessionState(sessionState);
		if (resourceTab === "skills") {
			snapshot = {
				...snapshot,
				enabledSkills: policy.resolveEnabledSkills(snapshot.skills),
			};
		} else {
			snapshot = {
				...snapshot,
				enabledContexts: policy.resolveEnabledContexts(snapshot.contexts),
			};
		}
		persistSession();
		requestHudRender?.();
		emitStateChanged();
	}

	function setGlobalResource(
		kind: "tools" | "skills" | "contexts",
		name: string,
		enabled: boolean,
		ctx: ExtensionContext,
	): void {
		if (kind === "tools" && !enabled) policy.removeExternalTool(name);
		globalSettings = updateGlobalResourceSettings(
			globalSettings,
			kind,
			name,
			enabled,
		);
		policy.setSettings(globalSettings, projectSettings);
		saveGlobalSettings(globalSettings);
		snapshot = {
			...snapshot,
			enabledSkills: policy.resolveEnabledSkills(snapshot.skills),
			enabledContexts: policy.resolveEnabledContexts(snapshot.contexts),
		};
		toolController.updateInventory();
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
			!presetController.activeName &&
			isProjectResourceDisabled(projectSettings, tab, id);
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
		} else if (presetController.activeName) {
			toggleSessionResource(tab, id, ctx);
		} else {
			setGlobalResource(tab, id, !isResourceEnabled(snapshot, tab, id), ctx);
		}
		updatePromptInventory(ctx.getSystemPromptOptions());
		toolController.updateInventory();
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
				toolController.updateInventory();
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

	registerManagerCommands(pi, presetController, {
		showManager,
		setGlobalResource,
	});

	pi.events.on("config-manager:layer-set", (event) => {
		toolController.handleLayerSet(event);
	});
	pi.events.on("config-manager:layer-clear", (event) => {
		toolController.handleLayerClear(event);
	});
	pi.events.on("config-manager:request-snapshot", () => {
		emitStateChanged();
	});

	lifecycleController.register();
}
