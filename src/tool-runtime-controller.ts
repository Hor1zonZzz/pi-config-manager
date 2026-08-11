import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PolicyManager, PolicyInitialization } from "./policy-manager";
import { uniqueSorted } from "./resource-policy-state";
import type { ManagerState, RuntimeLayer } from "./types";

type PolicyPhase = "collecting" | "initializing" | "ready" | "stopped";

interface ToolRuntimeHost {
	getState: () => ManagerState;
	setState: (state: ManagerState) => void;
	requestHudRender: () => void;
	emitStateChanged: () => void;
}

export class ToolRuntimeController {
	private lastAppliedTools = new Set<string>();
	private hasAppliedTools = false;
	private phase: PolicyPhase = "collecting";
	private runtimePolicyDirty = false;
	private inventoryUpdating = false;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly policy: PolicyManager,
		private readonly host: ToolRuntimeHost,
	) {}

	beginSession(input: PolicyInitialization): void {
		this.phase = "initializing";
		this.lastAppliedTools = new Set();
		this.hasAppliedTools = false;
		this.policy.initialize(input);
	}

	beginTransition(): void {
		this.phase = "initializing";
	}

	markReady(): void {
		this.phase = "ready";
	}

	stop(): void {
		this.phase = "stopped";
	}

	reconcile(): void {
		this.pi.setActiveTools(Array.from(this.policy.resolveEffectiveTools()));
		this.lastAppliedTools = new Set(this.pi.getActiveTools());
		this.hasAppliedTools = true;
		this.host.setState({
			...this.host.getState(),
			activeTools: new Set(this.lastAppliedTools),
			runtimeToolControls: this.policy.resolveRuntimeToolControls(),
		});
		this.host.requestHudRender();
		this.host.emitStateChanged();
	}

	updateInventory(): void {
		if (this.inventoryUpdating) {
			this.runtimePolicyDirty = true;
			return;
		}
		this.inventoryUpdating = true;
		try {
			do {
				this.runtimePolicyDirty = false;
				if (this.hasAppliedTools) {
					this.policy.observeExternalTools(
						this.pi
							.getActiveTools()
							.filter((name) => !this.lastAppliedTools.has(name)),
					);
				}
				const state = this.host.getState();
				const allTools = this.pi.getAllTools();
				this.policy.setDiscoveredTools(allTools.map((tool) => tool.name));
				this.host.setState({
					...state,
					tools: allTools
						.map((tool) => ({
							name: tool.name,
							description: tool.description,
							promptSnippet: state.toolSnippets[tool.name],
							parameters: tool.parameters,
							promptGuidelines: tool.promptGuidelines,
							sourceInfo: tool.sourceInfo,
						}))
						.sort((a, b) => a.name.localeCompare(b.name)),
				});
				this.reconcile();
			} while (this.runtimePolicyDirty);
		} finally {
			this.inventoryUpdating = false;
		}
	}

	handleLayerSet(event: unknown): void {
		if (this.phase === "stopped") return;
		const data = event as {
			id?: unknown;
			disableTools?: unknown;
			requireTools?: unknown;
		};
		if (typeof data.id !== "string") return;
		const layer: RuntimeLayer = {
			id: data.id,
			disableTools: this.toolNames(data.disableTools),
			requireTools: this.toolNames(data.requireTools),
		};
		if (!this.policy.setRuntimeLayer(layer)) return;
		this.runtimePolicyDirty = true;
		if (this.phase === "ready") this.updateInventory();
	}

	handleLayerClear(event: unknown): void {
		if (this.phase === "stopped") return;
		const id = (event as { id?: unknown }).id;
		if (typeof id !== "string" || !this.policy.clearRuntimeLayer(id)) return;
		this.runtimePolicyDirty = true;
		if (this.phase === "ready") this.updateInventory();
	}

	private toolNames(value: unknown): string[] {
		if (!Array.isArray(value)) return [];
		return uniqueSorted(
			value.filter((item): item is string => typeof item === "string"),
		);
	}
}
