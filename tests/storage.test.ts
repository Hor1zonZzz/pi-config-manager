import { describe, expect, test } from "bun:test";
import {
	cloneSessionState,
	normalizeResourceSettings,
	normalizeSessionState,
} from "../src/storage";
import { DEFAULT_SESSION_STATE } from "../src/types";

describe("storage compatibility", () => {
	test("normalizes resource and session state without sharing mutable arrays", () => {
		expect(
			normalizeResourceSettings({
				disabledTools: ["write", 42, "read", "write"],
				disabledSkills: ["zeta", "alpha"],
			}),
		).toEqual({
			version: 1,
			enabledTools: [],
			disabledTools: ["read", "write"],
			disabledSkills: ["alpha", "zeta"],
			disabledContexts: [],
		});
		expect(normalizeSessionState({ version: 1 })).toBeUndefined();

		const normalized = normalizeSessionState({
			version: 2,
			tools: ["bash", "read", "bash"],
			enabledSkills: ["browser"],
			disabledSkills: [],
			enabledContexts: [],
			disabledContexts: ["/tmp/AGENTS.md"],
		});
		expect(normalized).toEqual({
			version: 2,
			tools: ["bash", "read"],
			enabledSkills: ["browser"],
			disabledSkills: [],
			enabledContexts: [],
			disabledContexts: ["/tmp/AGENTS.md"],
			preset: undefined,
		});

		const cloned = cloneSessionState(normalized ?? DEFAULT_SESSION_STATE);
		cloned.enabledSkills.push("changed");
		expect(normalized?.enabledSkills).toEqual(["browser"]);
	});
});

