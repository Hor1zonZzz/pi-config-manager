import { describe, expect, test } from "bun:test";
import { PolicyManager } from "../src/policy-manager";
import {
	DEFAULT_RESOURCE_SETTINGS,
	DEFAULT_SESSION_STATE,
	type ResourceSettings,
	type SessionResourceState,
} from "../src/types";

function resources(overrides: Partial<ResourceSettings> = {}): ResourceSettings {
	return {
		...DEFAULT_RESOURCE_SETTINGS,
		...overrides,
		enabledTools: [...(overrides.enabledTools ?? [])],
		disabledTools: [...(overrides.disabledTools ?? [])],
		disabledSkills: [...(overrides.disabledSkills ?? [])],
		disabledContexts: [...(overrides.disabledContexts ?? [])],
	};
}

function session(overrides: Partial<SessionResourceState> = {}): SessionResourceState {
	return {
		...DEFAULT_SESSION_STATE,
		...overrides,
		enabledSkills: [...(overrides.enabledSkills ?? [])],
		disabledSkills: [...(overrides.disabledSkills ?? [])],
		enabledContexts: [...(overrides.enabledContexts ?? [])],
		disabledContexts: [...(overrides.disabledContexts ?? [])],
	};
}

function manager(options: {
	defaults?: string[];
	global?: Partial<ResourceSettings>;
	project?: Partial<ResourceSettings>;
	session?: Partial<SessionResourceState>;
} = {}) {
	const policy = new PolicyManager({
		defaultTools: options.defaults ?? ["read", "bash"],
		globalSettings: resources(options.global),
		projectSettings: resources(options.project),
		sessionState: session(options.session),
	});
	policy.setDiscoveredTools(["read", "bash", "edit", "write", "search"]);
	return policy;
}

describe("PolicyManager", () => {
	test("combines explicit global enables and disables with Pi defaults", () => {
		const policy = manager({
			global: {
				enabledTools: ["search"],
				disabledTools: ["bash"],
			},
		});
		expect(Array.from(policy.resolveEffectiveTools()).sort()).toEqual([
			"read",
			"search",
		]);
	});

	test("applies profile, session, and runtime policy in deterministic layers", () => {
		const policy = manager();
		policy.setProfile({
			id: "deep-code",
			tools: ["read", "bash", "edit", "write"],
		});
		expect(Array.from(policy.resolveBaseTools()).sort()).toEqual([
			"bash",
			"edit",
			"read",
			"write",
		]);

		policy.setSessionState(session({ tools: ["read", "edit"] }));
		policy.setRuntimeLayer({
			id: "plan-mode",
			disableTools: ["edit", "write"],
			requireTools: ["bash"],
		});
		expect(Array.from(policy.resolveEffectiveTools()).sort()).toEqual([
			"bash",
			"read",
		]);
		expect(policy.resolveRuntimeToolControls().get("edit")).toEqual({
			layerId: "plan-mode",
			action: "disable",
		});
		expect(policy.resolveRuntimeToolControls().get("bash")).toEqual({
			layerId: "plan-mode",
			action: "require",
		});

		policy.clearRuntimeLayer("plan-mode");
		expect(Array.from(policy.resolveEffectiveTools()).sort()).toEqual([
			"edit",
			"read",
		]);
	});

	test("keeps runtime layer updates idempotent", () => {
		const policy = manager();
		const layer = {
			id: "read-only",
			disableTools: ["write", "edit", "edit"],
			requireTools: ["read", "read"],
		};
		expect(policy.setRuntimeLayer(layer)).toBe(true);
		expect(policy.setRuntimeLayer(layer)).toBe(false);
		policy.setRuntimeLayer({
			id: "force-edit",
			disableTools: [],
			requireTools: ["edit"],
		});
		expect(policy.resolveRuntimeToolControls().get("edit")).toEqual({
			layerId: "force-edit",
			action: "require",
		});
		expect(policy.resolveEffectiveTools().has("edit")).toBe(true);
		expect(policy.clearRuntimeLayer("force-edit")).toBe(true);
		expect(policy.resolveRuntimeToolControls().get("edit")).toEqual({
			layerId: "read-only",
			action: "disable",
		});
		expect(policy.resolveEffectiveTools().has("edit")).toBe(false);

		expect(
			policy.setRuntimeLayer({
				id: "read-only",
				disableTools: ["edit"],
				requireTools: ["edit"],
			}),
		).toBe(true);
		expect(policy.resolveRuntimeToolControls().get("edit")).toEqual({
			layerId: "read-only",
			action: "require",
		});
		expect(policy.resolveEffectiveTools().has("edit")).toBe(true);
		expect(policy.clearRuntimeLayer("missing")).toBe(false);
		expect(policy.clearRuntimeLayer("read-only")).toBe(true);
		expect(policy.resolveRuntimeToolControls().has("edit")).toBe(false);
	});
});
