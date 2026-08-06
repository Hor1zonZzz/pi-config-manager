import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	createKeybindings,
	createTestEnvironment,
	createTheme,
} from "./helpers/config-manager-harness";

const env = createTestEnvironment();
beforeEach(() => env.setup());
afterEach(() => env.teardown());
const { createHarness, readResourceSettings, writePresets } = env;

describe("resource manager behavior", () => {
	test("opens the global defaults target and persists tool toggles for new sessions", async () => {
		const harness = createHarness({
			tools: [
				{
					name: "read",
					description: "Read files",
					promptGuidelines: ["Use read carefully"],
				},
			],
			activeTools: ["read"],
			systemPrompt: "",
			promptOptions: {
				selectedTools: ["read"],
				toolSnippets: { read: "Read files safely" },
				skills: [],
				contextFiles: [],
			},
		});
		await harness.start();
		try {
			let overlayOptions: any;
			let rendered: string[] = [];
			let renderRequests = 0;
			harness.setCustomImplementation(async (factory, customOptions) => {
				overlayOptions = customOptions;
				let result: "close" | "save" = "close";
				const component = await factory(
					{ requestRender: () => renderRequests++ },
					createTheme(),
					createKeybindings(),
					(value: "close" | "save") => {
						result = value;
					},
				);
				rendered = component.render(100);
				component.handleInput("right");
				component.handleInput("down");
				rendered.push(...component.render(100));
				component.handleInput("left");
				component.handleInput(" ");
				component.handleInput("escape");
				return result;
			});

			await harness.commands.get("tools").handler("", harness.ctx);
			expect(overlayOptions).toEqual({
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "92%",
					minWidth: 72,
					maxHeight: "90%",
					margin: 1,
				},
			});
			const renderedText = rendered.join("\n");
			expect(renderedText).toContain("Pi Config Manager · Context Monitor");
			expect(renderedText).toContain("[Tools]");
			expect(renderedText).toContain("View: Effective");
			expect(renderedText).toContain("Edit: Global");
			expect(renderedText).not.toContain("G target");
			expect(renderedText).toContain("System prompt Available tools entry:");
			expect(renderedText).toContain("- read: Read files safely");
			expect(renderedText).toContain("System prompt guidelines:");
			expect(renderedText).toContain("- Use read carefully");
			expect(harness.getActiveTools()).toEqual([]);
			expect(readResourceSettings()).toEqual({
				version: 1,
				enabledTools: [],
				disabledTools: ["read"],
				disabledSkills: [],
				disabledContexts: [],
			});
			expect(
				harness.entries.some(
					(entry) => entry.customType === "pi-config-manager-state",
				),
			).toBe(false);
			const nextSession = createHarness({
				tools: [{ name: "read", description: "Read files" }],
				activeTools: ["read"],
			});
			await nextSession.start();
			try {
				expect(nextSession.getActiveTools()).toEqual([]);
			} finally {
				await nextSession.shutdown();
			}
			expect(renderRequests).toBeGreaterThan(0);
		} finally {
			await harness.shutdown();
		}
	});

	test("persistently enables a tool that Pi initially registered as inactive", async () => {
		const harness = createHarness({
			tools: [
				{ name: "ast_grep_search", description: "Search syntax trees" },
				{ name: "read", description: "Read files" },
			],
			activeTools: ["read"],
		});
		await harness.start();
		try {
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
				component.handleInput(" ");
				component.handleInput("escape");
				return result;
			});

			await harness.commands.get("tools").handler("", harness.ctx);
			expect(harness.getActiveTools().sort()).toEqual([
				"ast_grep_search",
				"read",
			]);
			expect(readResourceSettings()).toEqual({
				version: 1,
				enabledTools: ["ast_grep_search"],
				disabledTools: [],
				disabledSkills: [],
				disabledContexts: [],
			});

			const nextSession = createHarness({
				tools: [{ name: "ast_grep_search" }, { name: "read" }],
				activeTools: ["read"],
			});
			await nextSession.start();
			try {
				expect(nextSession.getActiveTools().sort()).toEqual([
					"ast_grep_search",
					"read",
				]);
			} finally {
				await nextSession.shutdown();
			}
		} finally {
			await harness.shutdown();
		}
	});

	test("shows and edits the current session when a preset is active", async () => {
		writePresets({ focus: { tools: ["read"] } });
		const harness = createHarness({
			tools: [
				{ name: "read", description: "Read files" },
				{ name: "bash", description: "Run commands" },
			],
			activeTools: ["read", "bash"],
		});
		await harness.start();
		try {
			await harness.commands.get("preset").handler("focus", harness.ctx);
			let rendered = "";
			let extensionsRendered = "";
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
				rendered = component.render(100).join("\n");
				component.handleInput(" ");
				component.handleInput("tab");
				component.handleInput("tab");
				component.handleInput("tab");
				component.handleInput("tab");
				component.handleInput("tab");
				extensionsRendered = component.render(100).join("\n");
				component.handleInput("escape");
				return result;
			});

			await harness.commands.get("tools").handler("", harness.ctx);
			expect(rendered).toContain("View: Effective");
			expect(rendered).toContain("Edit: Session · focus");
			expect(rendered).not.toContain("G target");
			expect(extensionsRendered).toContain("View/Edit: Pi settings");
			expect(extensionsRendered).not.toContain("Edit: Session");
			expect(existsSync(join(env.agentDir, "resource-settings.json"))).toBe(
				false,
			);
			expect(new Set(harness.getActiveTools())).toEqual(
				new Set(["read", "bash"]),
			);
			const state = harness.entries
				.filter((entry) => entry.customType === "pi-config-manager-state")
				.at(-1)?.data;
			expect(state.preset).toMatchObject({
				name: "focus",
				customTools: true,
				appliedTools: ["read"],
			});
			expect(new Set(state.tools)).toEqual(new Set(["read", "bash"]));
		} finally {
			await harness.shutdown();
		}
	});

	test("resets preset session overrides when switching and clearing presets", async () => {
		writePresets({
			focus: { tools: ["read"] },
			review: {},
		});
		const contextPath = "/project/AGENTS.md";
		const harness = createHarness({
			tools: [{ name: "read" }, { name: "bash" }],
			activeTools: ["read", "bash"],
			promptOptions: {
				selectedTools: ["read", "bash"],
				toolSnippets: {},
				skills: [],
				contextFiles: [{ path: contextPath, content: "instructions" }],
			},
		});
		await harness.start();
		try {
			await harness.commands.get("preset").handler("focus", harness.ctx);
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
				component.handleInput(" ");
				component.handleInput("escape");
				return result;
			});
			await harness.commands.get("contexts").handler("", harness.ctx);
			let state = harness.entries
				.filter((entry) => entry.customType === "pi-config-manager-state")
				.at(-1)?.data;
			expect(state.disabledContexts).toEqual([contextPath]);

			await harness.commands.get("preset").handler("review", harness.ctx);
			state = harness.entries
				.filter((entry) => entry.customType === "pi-config-manager-state")
				.at(-1)?.data;
			expect(state.disabledContexts).toEqual([]);
			expect(state.enabledContexts).toEqual([]);
			expect(state.tools).toBeUndefined();
			expect(new Set(harness.getActiveTools())).toEqual(
				new Set(["read", "bash"]),
			);
			const publicState = harness.emissions
				.filter((event) => event.name === "config-manager:state-changed")
				.at(-1)?.data;
			expect(publicState.contexts).toEqual({ enabled: 1, total: 1 });

			const shortcut = Array.from(harness.shortcuts.values())[0];
			await shortcut.handler(harness.ctx);
			state = harness.entries
				.filter((entry) => entry.customType === "pi-config-manager-state")
				.at(-1)?.data;
			expect(state.preset).toBeUndefined();
			expect(state.tools).toBeUndefined();
			expect(state.enabledSkills).toEqual([]);
			expect(state.disabledSkills).toEqual([]);
			expect(state.enabledContexts).toEqual([]);
			expect(state.disabledContexts).toEqual([]);
			expect(new Set(harness.getActiveTools())).toEqual(
				new Set(["read", "bash"]),
			);
			expect(existsSync(join(env.agentDir, "resource-settings.json"))).toBe(
				false,
			);
		} finally {
			await harness.shutdown();
		}
	});

	test("persists skill toggles from the global target", async () => {
		const harness = createHarness({
			tools: [{ name: "read", description: "Read files" }],
			activeTools: ["read"],
			skills: [
				{
					name: "alpha",
					description: "Alpha skill",
					path: "/skills/alpha/SKILL.md",
				},
			],
		});
		await harness.start();
		try {
			let rendered = "";
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
				rendered = component.render(100).join("\n");
				component.handleInput(" ");
				component.handleInput("escape");
				return result;
			});

			await harness.commands.get("skills").handler("", harness.ctx);
			expect(rendered).toContain("View: Effective");
			expect(rendered).toContain("Edit: Global");
			expect(readResourceSettings()).toEqual({
				version: 1,
				enabledTools: [],
				disabledTools: [],
				disabledSkills: ["alpha"],
				disabledContexts: [],
			});
		} finally {
			await harness.shutdown();
		}
	});
});
