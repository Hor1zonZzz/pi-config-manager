import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { PolicyManager } from "./policy-manager";
import type { PresetController } from "./preset-controller";
import { loadPresets } from "./presets";
import { applySystemPromptPolicy } from "./system-prompt-policy";
import type { ToolRuntimeController } from "./tool-runtime-controller";
import { loadGlobalSettings, loadProjectSettings } from "./storage";
import type {
	ManagerSnapshot,
	ManagerState,
	ResourceSettings,
	SessionResourceState,
} from "./types";

interface RuntimeLifecycleHost {
	getState: () => ManagerState;
	setState: (state: ManagerState) => void;
	getSnapshot: () => ManagerSnapshot;
	getSessionState: () => SessionResourceState;
	setSettings: (
		globalSettings: ResourceSettings,
		projectSettings: ResourceSettings,
	) => void;
	restoreSession: (ctx: ExtensionContext) => void;
	updatePromptInventory: (options: BuildSystemPromptOptions) => void;
	refreshSkillsFromCommands: () => void;
	installHud: (ctx: ExtensionContext) => void;
	scheduleSettledRefresh: () => void;
	requestHudRender: () => void;
	shutdown: (ctx: ExtensionContext) => void;
}

export function registerRuntimeLifecycle(
	pi: ExtensionAPI,
	policy: PolicyManager,
	presetController: PresetController,
	toolController: ToolRuntimeController,
	host: RuntimeLifecycleHost,
): void {
	function handleInput(text: string, ctx: ExtensionContext) {
		if (text.startsWith("/skill:")) host.refreshSkillsFromCommands();
		const name = text.match(/^\/skill:([^\s]+)/)?.[1];
		const snapshot = host.getSnapshot();
		if (
			!name ||
			!snapshot.skills.some((skill) => skill.name === name) ||
			snapshot.enabledSkills.has(name)
		) {
			return;
		}
		ctx.ui.notify(
			`Skill "${name}" is disabled. Use /config-manager to enable it.`,
			"warning",
		);
		return { action: "handled" as const };
	}

	function beforeAgentStart(
		systemPrompt: string,
		systemPromptOptions: BuildSystemPromptOptions,
		ctx: ExtensionContext,
	) {
		host.updatePromptInventory(systemPromptOptions);
		toolController.updateInventory();
		const snapshot = host.getSnapshot();
		const result = applySystemPromptPolicy({
			systemPrompt,
			systemPromptOptions,
			enabledSkills: snapshot.enabledSkills,
			contexts: snapshot.contexts,
			enabledContexts: snapshot.enabledContexts,
			presetInstructions: snapshot.presetInstructions,
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
		return result.systemPrompt === systemPrompt
			? undefined
			: { systemPrompt: result.systemPrompt };
	}

	function agentStart(ctx: ExtensionContext): void {
		host.setState({
			...host.getState(),
			effectiveSystemPrompt: {
				content: ctx.getSystemPrompt(),
				source: "agent-start",
			},
		});
		host.requestHudRender();
	}

	function resetState(): void {
		host.setState({
			...host.getState(),
			ready: false,
			customSystemPrompt: undefined,
			appendedSystemPrompt: undefined,
			effectiveSystemPrompt: undefined,
			contextsKnown: false,
			skills: [],
			contexts: [],
		});
	}

	async function applyPresetFlag(
		presetFlag: unknown,
		ctx: ExtensionContext,
	): Promise<void> {
		if (typeof presetFlag !== "string" || !presetFlag) return;
		const preset = presetController.get(presetFlag);
		if (preset) {
			await presetController.apply(presetFlag, preset, ctx);
			ctx.ui.notify(`Preset "${presetFlag}" activated`, "info");
			return;
		}
		ctx.ui.notify(
			`Unknown preset "${presetFlag}". Available: ${presetController.availableNames()}`,
			"warning",
		);
	}

	async function sessionStart(ctx: ExtensionContext): Promise<void> {
		const initialTools = pi.getActiveTools();
		const globalSettings = loadGlobalSettings();
		const projectSettings = loadProjectSettings(
			ctx.cwd,
			ctx.isProjectTrusted(),
		);
		host.setSettings(globalSettings, projectSettings);
		presetController.setPresets(loadPresets(ctx.cwd, ctx.isProjectTrusted()));
		host.restoreSession(ctx);
		const presetFlag = pi.getFlag("preset");
		if (typeof presetFlag === "string" && presetFlag) {
			presetController.clearActiveForFlag();
		}
		toolController.beginSession({
			defaultTools: initialTools,
			globalSettings,
			projectSettings,
			sessionState: host.getSessionState(),
		});
		if (typeof presetFlag !== "string" || !presetFlag) {
			presetController.restore();
		}
		resetState();
		toolController.updateInventory();
		host.refreshSkillsFromCommands();
		host.installHud(ctx);
		await applyPresetFlag(presetFlag, ctx);
		toolController.updateInventory();
		toolController.markReady();
		host.scheduleSettledRefresh();
	}

	function sessionTree(ctx: ExtensionContext): void {
		toolController.beginTransition();
		policy.clearExternalTools();
		presetController.setPresets(loadPresets(ctx.cwd, ctx.isProjectTrusted()));
		host.restoreSession(ctx);
		policy.setSessionState(host.getSessionState());
		presetController.restore();
		toolController.updateInventory();
		host.setState({
			...host.getState(),
			effectiveSystemPrompt: undefined,
		});
		toolController.updateInventory();
		toolController.markReady();
	}

	function sessionShutdown(ctx: ExtensionContext): void {
		toolController.stop();
		host.shutdown(ctx);
	}

	pi.on("input", (event, ctx) => handleInput(event.text, ctx));
	pi.on("before_agent_start", (event, ctx) =>
		beforeAgentStart(event.systemPrompt, event.systemPromptOptions, ctx),
	);
	pi.on("agent_start", (_event, ctx) => agentStart(ctx));
	pi.on("turn_start", () => toolController.updateInventory());
	pi.on("session_start", async (_event, ctx) => sessionStart(ctx));
	pi.on("session_tree", (_event, ctx) => sessionTree(ctx));
	pi.on("session_shutdown", (_event, ctx) => sessionShutdown(ctx));
}
