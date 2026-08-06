import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { loadPresets } from "../src/presets";
import {
	createKeybindings,
	createTestEnvironment,
	createTheme,
	type SkillFixture,
} from "./helpers/config-manager-harness";

const env = createTestEnvironment();
beforeEach(() => env.setup());
afterEach(() => env.teardown());
const {
	createHarness,
	readAgentSettings,
	writeAgentSettings,
	writePresets,
	writeProjectResourceSettings,
} = env;

function presetBranchEntry(name: string, tools: string[]) {
	return {
		type: "custom",
		customType: "pi-config-manager-state",
		data: {
			version: 2,
			enabledSkills: [],
			disabledSkills: [],
			enabledContexts: [],
			disabledContexts: [],
			preset: {
				name,
				customTools: false,
				appliedTools: tools,
				originalState: {
					provider: "fixture",
					model: "base",
					thinkingLevel: "medium",
					tools: ["read", "bash"],
				},
			},
		},
	};
}

function emptyPromptOptions(selectedTools: string[]) {
	return {
		selectedTools,
		toolSnippets: {},
		skills: [],
		contextFiles: [],
	};
}

describe("manager behavior contract", () => {
	test("registers the public commands and applies global tool defaults on startup", async () => {
		writeFileSync(
			join(env.agentDir, "resource-settings.json"),
			`${JSON.stringify({
				version: 1,
				disabledTools: ["bash"],
				disabledSkills: [],
				disabledContexts: [],
			})}\n`,
			"utf8",
		);
		const harness = createHarness();
		await harness.start();
		try {
			expect([...harness.commands.keys()].sort()).toEqual([
				"config-manager",
				"contexts",
				"extensions",
				"preset",
				"prompts",
				"skills",
				"themes",
				"tools",
			]);
			expect(harness.flags.has("preset")).toBe(true);
			expect(harness.shortcuts.size).toBe(1);
			expect(harness.getActiveTools()).toEqual(["read"]);
			expect(harness.widgets.has("pi-config-manager")).toBe(true);
			const state = harness.emissions
				.filter((event) => event.name === "config-manager:state-changed")
				.at(-1)?.data;
			expect(state).toMatchObject({
				baseTools: ["read"],
				tools: { active: 1, total: 2 },
			});
		} finally {
			await harness.shutdown();
		}
	});

	test("stages prompt and theme settings and reloads after saving", async () => {
		mkdirSync(join(env.agentDir, "prompts"), { recursive: true });
		mkdirSync(join(env.agentDir, "themes"), { recursive: true });
		writeFileSync(join(env.agentDir, "prompts", "review.md"), "# Review\n");
		writeFileSync(join(env.agentDir, "themes", "fixture.json"), "{}\n");
		const harness = createHarness({ confirm: true });
		await harness.start();
		try {
			const rendered: string[] = [];
			harness.setCustomImplementation(async (factory) => {
				let result: "close" | "save" = "close";
				const component = await factory(
					{ requestRender() {} },
					createTheme(),
					createKeybindings(),
					(value: "close" | "save") => {
						result = value;
					},
				);
				rendered.push(component.render(180).join("\n"));
				component.handleInput(" ");
				rendered.push(component.render(180).join("\n"));
				component.handleInput("S");
				return result;
			});

			await harness.commands.get("prompts").handler("", harness.ctx);
			expect(readAgentSettings().prompts).toEqual(["-prompts/review.md"]);
			expect(harness.getReloads()).toBe(1);
			await harness.commands.get("themes").handler("", harness.ctx);
			expect(readAgentSettings().themes).toEqual(["-themes/fixture.json"]);
			expect(harness.getReloads()).toBe(2);
			const output = rendered.join("\n");
			expect(output).toContain("[Prompt Templates]");
			expect(output).toContain("[Themes]");
			expect(output).toContain("View/Edit: Pi settings");
			expect(output).toContain("staged");
			expect(output).toContain("reload required");
		} finally {
			await harness.shutdown();
		}
	});

	test("re-enables a skill disabled in native Pi settings", async () => {
		const skillPath = join(env.agentDir, "skills", "hidden", "SKILL.md");
		mkdirSync(join(env.agentDir, "skills", "hidden"), { recursive: true });
		writeFileSync(
			skillPath,
			"---\nname: hidden\ndescription: Hidden skill\n---\n",
		);
		writeAgentSettings({ skills: ["-skills/hidden/SKILL.md"] });
		const harness = createHarness({ confirm: true, skills: [] });
		await harness.start();
		try {
			let renderedBefore = "";
			let renderedAfter = "";
			harness.setCustomImplementation(async (factory) => {
				let result: "close" | "save" = "close";
				const component = await factory(
					{ requestRender() {} },
					createTheme(),
					createKeybindings(),
					(value: "close" | "save") => {
						result = value;
					},
				);
				renderedBefore = component.render(180).join("\n");
				component.handleInput(" ");
				renderedAfter = component.render(180).join("\n");
				component.handleInput("S");
				return result;
			});

			await harness.commands.get("skills").handler("", harness.ctx);
			expect(renderedBefore).toContain("hidden");
			expect(renderedBefore).toContain(
				"not loaded by Pi settings · reload required",
			);
			expect(renderedAfter).toContain("enable staged · reload required");
			expect(readAgentSettings().skills).toEqual(["+skills/hidden/SKILL.md"]);
			expect(harness.getReloads()).toBe(1);
		} finally {
			await harness.shutdown();
		}
	});

	test("defers an early layer clear until the tool policy is initialized", async () => {
		const harness = createHarness({
			tools: [
				{ name: "read" },
				{ name: "bash" },
				{ name: "edit" },
				{ name: "write" },
			],
			activeTools: ["read", "bash", "edit", "write"],
		});
		harness.events.emit("config-manager:layer-clear", { id: "plan-mode" });
		expect(harness.getActiveTools()).toEqual(["read", "bash", "edit", "write"]);
		await harness.start();
		try {
			expect(harness.getActiveTools()).toEqual([
				"read",
				"bash",
				"edit",
				"write",
			]);
		} finally {
			await harness.shutdown();
		}
	});

	test("stores an early layer set and applies it after initialization", async () => {
		const harness = createHarness({
			tools: [
				{ name: "read" },
				{ name: "bash" },
				{ name: "edit" },
				{ name: "write" },
			],
			activeTools: ["read", "bash", "edit", "write"],
		});
		harness.events.emit("config-manager:layer-set", {
			id: "plan-mode",
			disableTools: ["edit", "write"],
			requireTools: ["read"],
		});
		expect(harness.getActiveTools()).toEqual(["read", "bash", "edit", "write"]);
		await harness.start();
		try {
			expect(harness.getActiveTools()).toEqual(["read", "bash"]);
			harness.events.emit("config-manager:layer-clear", { id: "plan-mode" });
			expect(harness.getActiveTools()).toEqual([
				"read",
				"bash",
				"edit",
				"write",
			]);
		} finally {
			await harness.shutdown();
		}
	});

	test("uses the final early event for an idempotent runtime layer", async () => {
		const harness = createHarness({
			tools: [{ name: "read" }, { name: "write" }],
			activeTools: ["read", "write"],
		});
		const layer = {
			id: "read-only",
			disableTools: ["write"],
			requireTools: ["read"],
		};
		harness.events.emit("config-manager:layer-set", layer);
		harness.events.emit("config-manager:layer-set", layer);
		harness.events.emit("config-manager:layer-clear", { id: "read-only" });
		harness.events.emit("config-manager:layer-clear", { id: "read-only" });
		await harness.start();
		expect(harness.getActiveTools()).toEqual(["read", "write"]);
		await harness.shutdown();
		harness.events.emit("config-manager:layer-set", layer);
		expect(harness.getActiveTools()).toEqual(["read", "write"]);
	});

	test("shows effective runtime tool state and locks constrained toggles", async () => {
		const harness = createHarness({
			tools: [
				{ name: "read", description: "Read files" },
				{ name: "edit", description: "Edit files" },
				{ name: "grep", description: "Search files" },
			],
			activeTools: ["read", "edit"],
		});
		harness.events.emit("config-manager:layer-set", {
			id: "plan-mode",
			disableTools: ["edit"],
			requireTools: ["grep"],
		});
		await harness.start();
		try {
			expect(new Set(harness.getActiveTools())).toEqual(
				new Set(["read", "grep"]),
			);

			let rendered = "";
			let renderedNarrow = "";
			harness.setCustomImplementation(async (factory) => {
				let result: "close" | "save" = "close";
				const component = await factory(
					{ requestRender() {} },
					createTheme(),
					createKeybindings(),
					(value: "close" | "save") => {
						result = value;
					},
				);
				rendered = component.render(180).join("\n");
				renderedNarrow = component.render(72).join("\n");
				component.handleInput(" ");
				component.handleInput("down");
				component.handleInput(" ");
				component.handleInput("escape");
				return result;
			});

			await harness.commands.get("tools").handler("", harness.ctx);
			expect(rendered).toContain("View: Effective");
			expect(rendered).toContain("Edit: Global");
			expect(rendered).toContain("Constraints: plan-mode");
			expect(rendered).toContain("🔒 edit  inactive · blocked by plan-mode");
			expect(rendered).toContain("🔒 grep  active · required by plan-mode");
			expect(renderedNarrow).toContain("View: Effective · Edit: Global");
			expect(renderedNarrow).toContain("Constraints: plan-mode");
			expect(renderedNarrow).toContain("🔒 edit");
			expect(existsSync(join(env.agentDir, "resource-settings.json"))).toBe(
				false,
			);
			expect(
				harness.notifications.some((notification) =>
					notification.message.includes(
						'Tool "edit" is blocked by runtime constraint "plan-mode"',
					),
				),
			).toBe(true);
			expect(
				harness.notifications.some((notification) =>
					notification.message.includes(
						'Tool "grep" is required by runtime constraint "plan-mode"',
					),
				),
			).toBe(true);
			expect(new Set(harness.getActiveTools())).toEqual(
				new Set(["read", "grep"]),
			);
		} finally {
			await harness.shutdown();
		}
	});

	test("locks project-disabled resources that the Global target cannot enable", async () => {
		const contextPath = join(env.cwd, "AGENTS.md");
		writeProjectResourceSettings({
			version: 1,
			enabledTools: [],
			disabledTools: ["edit"],
			disabledSkills: ["alpha"],
			disabledContexts: [contextPath],
		});
		const harness = createHarness({
			trusted: true,
			tools: [{ name: "edit" }, { name: "read" }],
			activeTools: ["edit", "read"],
			skills: [
				{
					name: "alpha",
					description: "Alpha skill",
					path: "/skills/alpha/SKILL.md",
				},
			],
			promptOptions: {
				selectedTools: ["read"],
				toolSnippets: {},
				skills: [
					{
						name: "alpha",
						description: "Alpha skill",
						filePath: "/skills/alpha/SKILL.md",
					},
				],
				contextFiles: [{ path: contextPath, content: "instructions" }],
			},
		});
		await harness.start();
		try {
			const rendered: string[] = [];
			harness.setCustomImplementation(async (factory) => {
				let result: "close" | "save" = "close";
				const component = await factory(
					{ requestRender() {} },
					createTheme(),
					createKeybindings(),
					(value: "close" | "save") => {
						result = value;
					},
				);
				rendered.push(component.render(180).join("\n"));
				component.handleInput(" ");
				component.handleInput("tab");
				rendered.push(component.render(180).join("\n"));
				component.handleInput(" ");
				component.handleInput("tab");
				rendered.push(component.render(180).join("\n"));
				component.handleInput(" ");
				component.handleInput("escape");
				return result;
			});

			await harness.commands.get("tools").handler("", harness.ctx);
			expect(harness.getActiveTools()).toEqual(["read"]);
			expect(rendered[0]).toContain("Constraints: project settings");
			expect(rendered[0]).toContain(
				"🔒 edit  inactive · blocked by project settings",
			);
			expect(rendered[1]).toContain(
				"🔒 alpha  disabled · blocked by project settings",
			);
			expect(rendered[2]).toContain(
				"🔒 AGENTS.md  disabled · blocked by project settings",
			);
			expect(harness.notifications).toHaveLength(3);
			expect(
				harness.notifications.every((notification) =>
					notification.message.includes("disabled by project settings"),
				),
			).toBe(true);
			expect(existsSync(join(env.agentDir, "resource-settings.json"))).toBe(
				false,
			);
		} finally {
			await harness.shutdown();
		}
	});

	test("preserves preset session, runtime-layer, and external-tool precedence", async () => {
		writePresets({ focus: { tools: ["read"] } });
		const harness = createHarness({
			tools: [
				{ name: "read" },
				{ name: "bash" },
				{ name: "edit" },
				{ name: "questionnaire" },
			],
			activeTools: ["read", "bash", "edit"],
			branch: [
				{
					type: "custom",
					customType: "pi-config-manager-state",
					data: {
						version: 2,
						tools: ["edit", "missing-tool"],
						enabledSkills: [],
						disabledSkills: [],
						enabledContexts: [],
						disabledContexts: [],
						preset: {
							name: "focus",
							customTools: true,
							appliedTools: ["read"],
							originalState: {
								provider: "fixture",
								model: "base",
								thinkingLevel: "medium",
								tools: ["read", "bash", "edit"],
							},
						},
					},
				},
			],
		});
		await harness.start();
		try {
			expect(harness.getActiveTools()).toEqual(["edit"]);
			harness.events.emit("config-manager:layer-set", {
				id: "plan-mode",
				disableTools: ["edit"],
				requireTools: ["bash", "missing-tool"],
			});
			expect(harness.getActiveTools()).toEqual(["bash"]);
			harness.setExternalActiveTools(["bash", "questionnaire"]);
			await harness.trigger("turn_start");
			expect(harness.getActiveTools()).toEqual(["questionnaire", "bash"]);
			harness.events.emit("config-manager:layer-clear", { id: "plan-mode" });
			expect(harness.getActiveTools()).toEqual(["edit", "questionnaire"]);
		} finally {
			await harness.shutdown();
		}
	});

	test("discards resource session overrides when no preset is active", async () => {
		const harness = createHarness({
			tools: [{ name: "read" }, { name: "bash" }],
			activeTools: ["read", "bash"],
			branch: [
				{
					type: "custom",
					customType: "pi-config-manager-state",
					data: {
						version: 2,
						tools: ["read"],
						enabledSkills: ["hidden-skill"],
						disabledSkills: ["other-skill"],
						enabledContexts: ["/hidden/context.md"],
						disabledContexts: ["/other/context.md"],
					},
				},
			],
		});
		await harness.start();
		try {
			expect(new Set(harness.getActiveTools())).toEqual(
				new Set(["read", "bash"]),
			);
		} finally {
			await harness.shutdown();
		}
	});

	test("ignores legacy and version 1 session entries after the breaking state reset", async () => {
		const harness = createHarness({
			tools: [{ name: "read" }, { name: "bash" }],
			activeTools: ["read", "bash"],
			branch: [
				{
					type: "custom",
					customType: "pi-config-manager-state",
					data: { version: 1, tools: ["bash"] },
				},
				{
					type: "custom",
					customType: "tools-config",
					data: { enabledTools: ["bash"] },
				},
			],
		});
		await harness.start();
		try {
			expect(harness.getActiveTools()).toEqual(["read", "bash"]);
		} finally {
			await harness.shutdown();
		}
	});

	test("loads global presets and overlays only trusted project presets", () => {
		writePresets({
			shared: { model: "global", tools: ["read"] },
			globalOnly: { instructions: "global" },
		});
		writePresets(
			{
				shared: { model: "project", tools: [] },
				projectOnly: { thinkingLevel: "high" },
			},
			join(env.cwd, ".pi"),
		);
		expect(loadPresets(env.cwd, false)).toEqual({
			shared: { model: "global", tools: ["read"] },
			globalOnly: { instructions: "global" },
		});
		expect(loadPresets(env.cwd, true)).toEqual({
			shared: { model: "project", tools: [] },
			globalOnly: { instructions: "global" },
			projectOnly: { thinkingLevel: "high" },
		});
	});

	test("keeps all default tools active when no preset is selected", async () => {
		const harness = createHarness({
			tools: [{ name: "read" }, { name: "bash" }, { name: "herdr_agent" }],
			activeTools: ["read", "bash", "herdr_agent"],
		});
		await harness.start();
		try {
			expect(harness.getActiveTools()).toEqual(["read", "bash", "herdr_agent"]);
			expect(
				harness.emissions.some((event) => event.name.startsWith("preset:")),
			).toBe(false);
		} finally {
			await harness.shutdown();
		}
	});

	test("applies and clears an integrated preset", async () => {
		writePresets({
			focus: {
				provider: "fixture",
				model: "focused",
				thinkingLevel: "high",
				tools: ["read"],
				skills: ["alpha"],
				instructions: "FOCUS INSTRUCTIONS",
			},
		});
		const skills: SkillFixture[] = [
			{ name: "alpha", description: "Alpha", path: "/skills/alpha/SKILL.md" },
			{ name: "beta", description: "Beta", path: "/skills/beta/SKILL.md" },
		];
		const promptSkills = skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			filePath: skill.path,
			baseDir: "/skills",
			sourceInfo: {
				path: skill.path,
				source: "fixture",
				scope: "temporary" as const,
				origin: "top-level" as const,
			},
			disableModelInvocation: false,
		}));
		const systemPrompt = `Base${formatSkillsForPrompt(promptSkills)}`;
		const promptOptions = {
			selectedTools: ["read", "bash"],
			toolSnippets: {},
			skills: promptSkills,
			contextFiles: [],
		};
		const harness = createHarness({
			tools: [{ name: "read" }, { name: "bash" }],
			activeTools: ["read", "bash"],
			skills,
			systemPrompt,
			promptOptions,
			models: [
				{ provider: "fixture", id: "base" },
				{ provider: "fixture", id: "focused" },
			],
		});
		await harness.start();
		try {
			await harness.commands.get("preset").handler("focus", harness.ctx);
			expect(harness.getActiveTools()).toEqual(["read"]);
			expect(harness.getModel().id).toBe("focused");
			expect(harness.getThinkingLevel()).toBe("high");
			const result = await harness.trigger("before_agent_start", {
				systemPrompt,
				systemPromptOptions: promptOptions,
			});
			expect(result.systemPrompt).toContain("alpha");
			expect(result.systemPrompt).not.toContain("beta");
			expect(result.systemPrompt).toEndWith("FOCUS INSTRUCTIONS");
			const state = harness.entries
				.filter((entry) => entry.customType === "pi-config-manager-state")
				.at(-1)?.data;
			expect(state).toMatchObject({
				version: 2,
				preset: {
					name: "focus",
					customTools: false,
					appliedTools: ["read"],
				},
			});

			const shortcut = Array.from(harness.shortcuts.values())[0];
			await shortcut.handler(harness.ctx);
			expect(harness.getActiveTools()).toEqual(["read", "bash"]);
			expect(harness.getModel().id).toBe("base");
			expect(harness.getThinkingLevel()).toBe("medium");
		} finally {
			await harness.shutdown();
		}
	});

	test("restores version 2 preset policy from the active session branch", async () => {
		writePresets({
			review: { tools: ["read"], instructions: "REVIEW MODE" },
		});
		const harness = createHarness({
			tools: [{ name: "read" }, { name: "bash" }],
			activeTools: ["read", "bash"],
			branch: [presetBranchEntry("review", ["read"])],
		});
		await harness.start();
		try {
			expect(harness.getActiveTools()).toEqual(["read"]);
			const result = await harness.trigger("before_agent_start", {
				systemPrompt: "Base",
				systemPromptOptions: emptyPromptOptions(["read"]),
			});
			expect(result.systemPrompt).toBe("Base\n\nREVIEW MODE");
		} finally {
			await harness.shutdown();
		}
	});

	test("restores a different preset after session tree navigation", async () => {
		writePresets({
			review: { tools: ["read"], instructions: "REVIEW MODE" },
			focus: { tools: ["bash"], instructions: "FOCUS MODE" },
		});
		const branch = [presetBranchEntry("review", ["read"])];
		const harness = createHarness({
			tools: [{ name: "read" }, { name: "bash" }],
			activeTools: ["read", "bash"],
			branch,
		});
		await harness.start();
		try {
			branch[0] = presetBranchEntry("focus", ["bash"]);
			await harness.trigger("session_tree");
			expect(harness.getActiveTools()).toEqual(["bash"]);
			const result = await harness.trigger("before_agent_start", {
				systemPrompt: "Base",
				systemPromptOptions: emptyPromptOptions(["bash"]),
			});
			expect(result.systemPrompt).toBe("Base\n\nFOCUS MODE");
		} finally {
			await harness.shutdown();
		}
	});
});
