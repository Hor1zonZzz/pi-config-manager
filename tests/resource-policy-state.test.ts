import { describe, expect, test } from "bun:test";
import {
	resetSessionResourceOverrides,
	toggleSessionResourceOverride,
	updateGlobalResourceSettings,
} from "../src/resource-policy-state";
import {
	DEFAULT_RESOURCE_SETTINGS,
	DEFAULT_SESSION_STATE,
	type SessionResourceState,
} from "../src/types";

describe("resource policy state", () => {
	test("resets resource overrides while preserving preset metadata", () => {
		const state: SessionResourceState = {
			...DEFAULT_SESSION_STATE,
			tools: ["read"],
			enabledSkills: ["alpha"],
			disabledSkills: ["beta"],
			enabledContexts: ["A.md"],
			disabledContexts: ["B.md"],
			preset: {
				name: "focus",
				customTools: true,
				originalState: { thinkingLevel: "medium", tools: ["read"] },
			},
		};

		const reset = resetSessionResourceOverrides(state);
		expect(reset).toMatchObject({
			tools: undefined,
			enabledSkills: [],
			disabledSkills: [],
			enabledContexts: [],
			disabledContexts: [],
			preset: { name: "focus" },
		});
		expect(state.enabledSkills).toEqual(["alpha"]);
	});

	test("moves session skill and context overrides between enabled and disabled", () => {
		let state: SessionResourceState = {
			...DEFAULT_SESSION_STATE,
			enabledSkills: ["alpha"],
			disabledSkills: [],
			enabledContexts: [],
			disabledContexts: ["A.md"],
		};
		state = toggleSessionResourceOverride(state, "skills", "alpha", true);
		state = toggleSessionResourceOverride(state, "contexts", "A.md", false);
		expect(state.enabledSkills).toEqual([]);
		expect(state.disabledSkills).toEqual(["alpha"]);
		expect(state.enabledContexts).toEqual(["A.md"]);
		expect(state.disabledContexts).toEqual([]);
	});

	test("updates persistent settings without disturbing other resource kinds", () => {
		let settings = updateGlobalResourceSettings(
			DEFAULT_RESOURCE_SETTINGS,
			"tools",
			"write",
			false,
		);
		settings = updateGlobalResourceSettings(
			settings,
			"contexts",
			"AGENTS.md",
			false,
		);
		settings = updateGlobalResourceSettings(settings, "tools", "write", true);
		expect(settings).toEqual({
			...DEFAULT_RESOURCE_SETTINGS,
			enabledTools: ["write"],
			disabledContexts: ["AGENTS.md"],
		});
	});
});
