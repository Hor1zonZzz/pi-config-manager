import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { PolicyManager } from "./policy-manager";
import type { PresetController } from "./preset-controller";
import { installPresetEditor } from "./preset-editor";
import { loadPresets } from "./presets";
import { applySystemPromptPolicy } from "./system-prompt-policy";
import type { ToolRuntimeController } from "./tool-runtime-controller";
import { loadGlobalSettings, loadProjectSettings } from "./storage";
import type {
	ManagerSnapshot,
	ResourceSettings,
	SessionResourceState,
} from "./types";

interface RuntimeLifecycleHost {
	getSnapshot: () => ManagerSnapshot;
	setSnapshot: (snapshot: ManagerSnapshot) => void;
	getSessionState: () => SessionResourceState;
	setSettings: (
		globalSettings: ResourceSettings,
		projectSettings: ResourceSettings,
	) => void;
	restoreSession: (ctx: ExtensionContext) => void;
	updatePromptInventory: (options: BuildSystemPromptOptions) => void;
	refreshSkillsFromCommands: () => void;
	installHud: (ctx: ExtensionContext) => void;
	scheduleSettledRefresh: (ctx: ExtensionContext) => void;
	requestHudRender: () => void;
	shutdown: (ctx: ExtensionContext) => void;
}

export class RuntimeLifecycleController {
	constructor(
		private readonly pi: ExtensionAPI,
		private readonly policy: PolicyManager,
		private readonly presetController: PresetController,
		private readonly toolController: ToolRuntimeController,
		private readonly host: RuntimeLifecycleHost,
	) {}

	register(): void {
		this.pi.on("input", (event, ctx) => this.handleInput(event.text, ctx));
		this.pi.on("before_agent_start", (event, ctx) =>
			this.beforeAgentStart(event.systemPrompt, event.systemPromptOptions, ctx),
		);
		this.pi.on("agent_start", (_event, ctx) => this.agentStart(ctx));
		this.pi.on("turn_start", () => this.toolController.updateInventory());
		this.pi.on("session_start", async (_event, ctx) => this.sessionStart(ctx));
		this.pi.on("session_tree", (_event, ctx) => this.sessionTree(ctx));
		this.pi.on("session_shutdown", (_event, ctx) => this.sessionShutdown(ctx));
	}

	private handleInput(text: string, ctx: ExtensionContext) {
		if (text.startsWith("/skill:")) this.host.refreshSkillsFromCommands();
		const name = text.match(/^\/skill:([^\s]+)/)?.[1];
		const snapshot = this.host.getSnapshot();
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

	private beforeAgentStart(
		systemPrompt: string,
		systemPromptOptions: BuildSystemPromptOptions,
		ctx: ExtensionContext,
	) {
		this.host.updatePromptInventory(systemPromptOptions);
		this.toolController.updateInventory();
		const snapshot = this.host.getSnapshot();
		const result = applySystemPromptPolicy({
			systemPrompt,
			systemPromptOptions,
			enabledSkills: snapshot.enabledSkills,
			contexts: snapshot.contexts,
			enabledContexts: snapshot.enabledContexts,
			presetInstructions: this.presetController.active?.instructions,
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

	private agentStart(ctx: ExtensionContext): void {
		this.host.setSnapshot({
			...this.host.getSnapshot(),
			effectiveSystemPrompt: {
				content: ctx.getSystemPrompt(),
				capturedAt: Date.now(),
				source: "agent-start",
			},
		});
		this.host.requestHudRender();
	}

	private async sessionStart(ctx: ExtensionContext): Promise<void> {
		const initialTools = this.pi.getActiveTools();
		this.presetController.clearEditor();
		const globalSettings = loadGlobalSettings();
		const projectSettings = loadProjectSettings(
			ctx.cwd,
			ctx.isProjectTrusted(),
		);
		this.host.setSettings(globalSettings, projectSettings);
		this.presetController.setPresets(
			loadPresets(ctx.cwd, ctx.isProjectTrusted()),
		);
		this.host.restoreSession(ctx);
		const presetFlag = this.pi.getFlag("preset");
		if (typeof presetFlag === "string" && presetFlag) {
			this.presetController.clearActiveForFlag();
		}
		this.toolController.beginSession({
			defaultTools: initialTools,
			globalSettings,
			projectSettings,
			sessionState: this.host.getSessionState(),
		});
		if (typeof presetFlag !== "string" || !presetFlag) {
			this.presetController.restore(ctx);
		}
		this.resetSnapshot();
		this.toolController.updateInventory();
		this.host.refreshSkillsFromCommands();
		installPresetEditor(
			ctx,
			() => this.presetController.label(),
			(editor) => {
				this.presetController.setEditor(editor);
			},
		);
		this.host.installHud(ctx);
		await this.applyPresetFlag(presetFlag, ctx);
		this.presetController.updateStatus(ctx);
		this.toolController.updateInventory();
		this.toolController.markReady();
		this.host.scheduleSettledRefresh(ctx);
	}

	private resetSnapshot(): void {
		const snapshot = this.host.getSnapshot();
		this.host.setSnapshot({
			...snapshot,
			ready: false,
			customPromptActive: false,
			customSystemPrompt: undefined,
			appendedSystemPrompt: undefined,
			presetInstructions: this.presetController.active?.instructions,
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
			presetName: this.presetController.activeName,
		});
	}

	private async applyPresetFlag(
		presetFlag: unknown,
		ctx: ExtensionContext,
	): Promise<void> {
		if (typeof presetFlag !== "string" || !presetFlag) return;
		const preset = this.presetController.get(presetFlag);
		if (preset) {
			await this.presetController.apply(presetFlag, preset, ctx);
			ctx.ui.notify(`Preset "${presetFlag}" activated`, "info");
			return;
		}
		ctx.ui.notify(
			`Unknown preset "${presetFlag}". Available: ${this.presetController.availableNames()}`,
			"warning",
		);
	}

	private sessionTree(ctx: ExtensionContext): void {
		this.toolController.beginTransition();
		this.policy.clearExternalTools();
		this.presetController.setPresets(
			loadPresets(ctx.cwd, ctx.isProjectTrusted()),
		);
		this.host.restoreSession(ctx);
		this.policy.setSessionState(this.host.getSessionState());
		this.presetController.restore(ctx);
		this.toolController.updateInventory();
		const snapshot = this.host.getSnapshot();
		this.host.setSnapshot({
			...snapshot,
			effectiveSystemPrompt: undefined,
			enabledSkills: this.policy.resolveEnabledSkills(snapshot.skills),
			enabledContexts: this.policy.resolveEnabledContexts(snapshot.contexts),
		});
		this.presetController.updateStatus(ctx);
		this.toolController.updateInventory();
		this.toolController.markReady();
	}

	private sessionShutdown(ctx: ExtensionContext): void {
		this.toolController.stop();
		this.host.shutdown(ctx);
	}
}
