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
} from "./resource-inventory";
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
import { registerRuntimeLifecycle } from "./runtime-lifecycle";
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
	type ManagerState,
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
	let state: ManagerState = {
		ready: false,
		customSystemPrompt: undefined,
		appendedSystemPrompt: undefined,
		contextsKnown: false,
		tools: [],
		toolSnippets: {},
		activeTools: new Set(),
		runtimeToolControls: new Map(),
		skills: [],
		contexts: [],
	};
	const toolController = new ToolRuntimeController(pi, policy, {
		getState: () => state,
		setState: (nextState) => {
			state = nextState;
		},
		requestHudRender: () => requestHudRender?.(),
		emitStateChanged,
	});
	const presetController = new PresetController(pi, policy, {
		getSessionState: () => sessionState,
		setSessionState: (state) => {
			sessionState = state;
		},
		reconcileTools: () => toolController.reconcile(),
		persistSession,
	});
	registerRuntimeLifecycle(pi, policy, presetController, toolController, {
		getState: () => state,
		setState: (nextState) => {
			state = nextState;
		},
		getSnapshot: getManagerSnapshot,
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
	});

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
		if (state.effectiveSystemPrompt?.source === "agent-start") return;
		const currentPrompt = ctx.getSystemPrompt();
		state = {
			...state,
			effectiveSystemPrompt: currentPrompt
				? {
						content: currentPrompt,
						source: "command",
					}
				: undefined,
		};
	}

	function getManagerSnapshot(): ManagerSnapshot {
		return {
			...state,
			customPromptActive: Boolean(state.customSystemPrompt),
			presetInstructions: presetController.active?.instructions,
			projectDisabledTools: new Set(projectSettings.disabledTools),
			enabledSkills: policy.resolveEnabledSkills(state.skills),
			projectDisabledSkills: new Set(projectSettings.disabledSkills),
			enabledContexts: policy.resolveEnabledContexts(state.contexts),
			projectDisabledContexts: new Set(projectSettings.disabledContexts),
			presetName: presetController.activeName,
		};
	}

	function updatePromptInventory(options: BuildSystemPromptOptions): void {
		state = {
			...state,
			...buildPromptResourceInventory(options),
			ready: true,
			contextsKnown: true,
		};
		requestHudRender?.();
	}

	function refreshSkillsFromCommands(): void {
		state = {
			...state,
			ready: true,
			skills: buildLoadedSkillInventory(pi.getCommands(), state.skills),
		};
		requestHudRender?.();
		emitStateChanged();
	}

	function scheduleSettledRefresh(): void {
		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = setTimeout(() => {
			settleTimer = undefined;
			toolController.updateInventory();
			refreshSkillsFromCommands();
		}, 500);
	}

	function publicSnapshot() {
		return buildPublicSnapshot(getManagerSnapshot(), policy.resolveBaseTools());
	}

	function toggleSessionResource(
		tab: ToggleableResourceTab,
		id: string,
	): void {
		const snapshot = getManagerSnapshot();
		if (tab === "tools") {
			const wasEffective = snapshot.activeTools.has(id);
			policy.removeExternalTool(id);
			const base = policy.resolveBaseTools();
			if (wasEffective) base.delete(id);
			else base.add(id);
			sessionState.tools = uniqueSorted(base);
			policy.setSessionState(sessionState);
			toolController.reconcile();
			persistSession();
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
		persistSession();
		requestHudRender?.();
		emitStateChanged();
	}

	function setGlobalResource(
		kind: ToggleableResourceTab,
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
		const snapshot = getManagerSnapshot();
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
			toggleSessionResource(tab, id);
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
			prepare: () => {
				updatePromptInventory(ctx.getSystemPromptOptions());
				toolController.updateInventory();
				refreshPromptPreview(ctx);
			},
			togglePolicyResource: applyToggleableResourceChange,
		});
	}

	function installHud(ctx: ExtensionContext): void {
		installResourceHud(ctx, getManagerSnapshot, (requestRender) => {
			requestHudRender = requestRender;
		});
	}

	registerManagerCommands(pi, presetController, { showManager });

	pi.events.on("config-manager:layer-set", (event) => {
		toolController.handleLayerSet(event);
	});
	pi.events.on("config-manager:layer-clear", (event) => {
		toolController.handleLayerClear(event);
	});
	pi.events.on("config-manager:request-snapshot", () => {
		emitStateChanged();
	});
}
