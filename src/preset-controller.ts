import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { selectPreset } from "./manager-ui";
import type { PolicyManager } from "./policy-manager";
import type { PresetBorderEditor } from "./preset-editor";
import type { Preset, PresetsConfig } from "./presets";
import {
	resetSessionResourceOverrides,
	uniqueSorted,
} from "./resource-policy-state";
import type {
	ManagerSnapshot,
	PresetOriginalState,
	SessionResourceState,
} from "./types";

interface PresetControllerHost {
	getSessionState: () => SessionResourceState;
	setSessionState: (state: SessionResourceState) => void;
	getSnapshot: () => ManagerSnapshot;
	setSnapshot: (snapshot: ManagerSnapshot) => void;
	reconcileTools: () => void;
	persistSession: () => void;
	requestHudRender: () => void;
}

export class PresetController {
	private presets: PresetsConfig = {};
	private activePresetName?: string;
	private activePreset?: Preset;
	private editor?: PresetBorderEditor;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly policy: PolicyManager,
		private readonly host: PresetControllerHost,
	) {}

	get activeName(): string | undefined {
		return this.activePresetName;
	}

	get active(): Preset | undefined {
		return this.activePreset;
	}

	setPresets(presets: PresetsConfig): void {
		this.presets = presets;
	}

	clearEditor(): void {
		this.editor = undefined;
	}

	setEditor(editor: PresetBorderEditor): void {
		this.editor = editor;
	}

	label(): string {
		const mode = this.activePresetName ?? "default";
		return this.host.getSessionState().preset?.customTools
			? `${mode} (custom tools)`
			: mode;
	}

	clearActiveForFlag(): void {
		const state = resetSessionResourceOverrides(this.host.getSessionState());
		state.preset = undefined;
		this.host.setSessionState(state);
		this.activePresetName = undefined;
		this.activePreset = undefined;
	}

	updateStatus(ctx: ExtensionContext): void {
		this.host.setSnapshot({
			...this.host.getSnapshot(),
			presetName: this.activePresetName,
			presetInstructions: this.activePreset?.instructions,
		});
		ctx.ui.setStatus("preset", undefined);
		ctx.ui.setWidget("preset", undefined);
		this.editor?.requestRender();
		this.host.requestHudRender();
	}

	private setPolicy(preset: Preset, tools: string[] | undefined): void {
		this.policy.setProfile({ tools, skills: preset.skills });
		const snapshot = this.host.getSnapshot();
		this.host.setSnapshot({
			...snapshot,
			enabledSkills: this.policy.resolveEnabledSkills(snapshot.skills),
			enabledContexts: this.policy.resolveEnabledContexts(snapshot.contexts),
		});
	}

	private currentOriginalState(ctx: ExtensionContext): PresetOriginalState {
		return {
			provider: ctx.model?.provider,
			model: ctx.model?.id,
			thinkingLevel: this.pi.getThinkingLevel(),
			tools: Array.from(this.policy.resolveBaseTools()),
		};
	}

	private validatedTools(
		name: string,
		preset: Preset,
		ctx: ExtensionContext,
	): string[] | undefined {
		if (!preset.tools) return undefined;
		const discovered = new Set(this.pi.getAllTools().map((tool) => tool.name));
		const valid = preset.tools.filter((tool) => discovered.has(tool));
		const invalid = preset.tools.filter((tool) => !discovered.has(tool));
		if (invalid.length > 0) {
			ctx.ui.notify(
				`Preset "${name}": Unknown tools: ${invalid.join(", ")}`,
				"warning",
			);
		}
		return uniqueSorted(valid);
	}

	private async applyModelAndThinking(
		name: string,
		preset: Preset,
		ctx: ExtensionContext,
	): Promise<void> {
		if (preset.provider && preset.model) {
			const model = ctx.modelRegistry.find(preset.provider, preset.model);
			if (!model) {
				ctx.ui.notify(
					`Preset "${name}": Model ${preset.provider}/${preset.model} not found`,
					"warning",
				);
			} else if (!(await this.pi.setModel(model))) {
				ctx.ui.notify(
					`Preset "${name}": No API key for ${preset.provider}/${preset.model}`,
					"warning",
				);
			}
		}
		if (preset.thinkingLevel) this.pi.setThinkingLevel(preset.thinkingLevel);
	}

	async apply(
		name: string,
		preset: Preset,
		ctx: ExtensionContext,
	): Promise<void> {
		const currentState = this.host.getSessionState();
		const originalState =
			currentState.preset?.originalState ?? this.currentOriginalState(ctx);
		const configuredTools = this.validatedTools(name, preset, ctx);
		const appliedTools =
			configuredTools ?? Array.from(this.policy.resolveConfiguredTools());
		await this.applyModelAndThinking(name, preset, ctx);

		this.activePresetName = name;
		this.activePreset = preset;
		const state = resetSessionResourceOverrides(currentState);
		state.preset = {
			name,
			customTools: false,
			appliedTools,
			originalState,
		};
		this.host.setSessionState(state);
		this.policy.setSessionState(state);
		this.setPolicy(preset, appliedTools);
		this.host.reconcileTools();
		this.host.persistSession();
		this.updateStatus(ctx);
	}

	async clear(ctx: ExtensionContext): Promise<void> {
		const currentState = this.host.getSessionState();
		const originalState = currentState.preset?.originalState;
		this.activePresetName = undefined;
		this.activePreset = undefined;
		this.policy.setProfile(undefined);
		const state = resetSessionResourceOverrides(currentState);
		state.preset = undefined;
		this.host.setSessionState(state);
		this.policy.setSessionState(state);
		if (originalState?.provider && originalState.model) {
			const model = ctx.modelRegistry.find(
				originalState.provider,
				originalState.model,
			);
			if (model) await this.pi.setModel(model);
		}
		if (originalState) this.pi.setThinkingLevel(originalState.thinkingLevel);
		const snapshot = this.host.getSnapshot();
		this.host.setSnapshot({
			...snapshot,
			enabledSkills: this.policy.resolveEnabledSkills(snapshot.skills),
			enabledContexts: this.policy.resolveEnabledContexts(snapshot.contexts),
		});
		this.host.reconcileTools();
		this.host.persistSession();
		this.updateStatus(ctx);
	}

	restore(ctx: ExtensionContext): void {
		let state = this.host.getSessionState();
		const presetState = state.preset;
		const preset = presetState ? this.presets[presetState.name] : undefined;
		if (!presetState || !preset) {
			this.activePresetName = undefined;
			this.activePreset = undefined;
			this.policy.setProfile(undefined);
			if (presetState) state.preset = undefined;
			state = resetSessionResourceOverrides(state);
			this.host.setSessionState(state);
			this.policy.setSessionState(state);
			this.updateStatus(ctx);
			return;
		}
		this.activePresetName = presetState.name;
		this.activePreset = preset;
		const tools =
			presetState.appliedTools ??
			preset.tools?.filter((tool) =>
				this.pi.getAllTools().some((candidate) => candidate.name === tool),
			);
		this.setPolicy(preset, tools);
		this.updateStatus(ctx);
	}

	async showSelector(ctx: ExtensionContext): Promise<void> {
		const result = await selectPreset(ctx, this.presets, this.activePresetName);
		if (!result) return;
		if (result === "(none)") {
			await this.clear(ctx);
			ctx.ui.notify("Preset cleared, defaults restored", "info");
			return;
		}
		const preset = this.presets[result];
		if (!preset) return;
		await this.apply(result, preset, ctx);
		ctx.ui.notify(`Preset "${result}" activated`, "info");
	}

	async cycle(ctx: ExtensionContext): Promise<void> {
		const names = Object.keys(this.presets).sort((a, b) => a.localeCompare(b));
		if (names.length === 0) {
			ctx.ui.notify(
				"No presets defined in global or project presets.json",
				"warning",
			);
			return;
		}
		const cycle = ["(none)", ...names];
		const current = this.activePresetName ?? "(none)";
		const currentIndex = cycle.indexOf(current);
		const next =
			cycle[currentIndex < 0 ? 0 : (currentIndex + 1) % cycle.length];
		if (!next) return;
		if (next === "(none)") {
			await this.clear(ctx);
			ctx.ui.notify("Preset cleared, defaults restored", "info");
			return;
		}
		const preset = this.presets[next];
		if (!preset) return;
		await this.apply(next, preset, ctx);
		ctx.ui.notify(`Preset "${next}" activated`, "info");
	}

	get(name: string): Preset | undefined {
		return this.presets[name];
	}

	availableNames(): string {
		return Object.keys(this.presets).join(", ") || "(none defined)";
	}
}
