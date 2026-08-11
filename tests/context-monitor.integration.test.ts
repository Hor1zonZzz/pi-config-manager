import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import {
	createKeybindings,
	createTestEnvironment,
	createTheme,
	formatContextSection,
	navigateToManagerTab,
	type ContextFixture,
	type SkillFixture,
} from "./helpers/config-manager-harness";

const env = createTestEnvironment();
beforeEach(() => env.setup());
afterEach(() => env.teardown());
const { createHarness, writePresets } = env;

describe("prompt and context behavior", () => {
	test("filters disabled skills and contexts from the standard system prompt", async () => {
		writePresets({
			focus: { tools: ["read"], skills: ["alpha", "beta"] },
		});
		const skills: SkillFixture[] = [
			{
				name: "alpha",
				description: "Alpha skill",
				path: "/skills/alpha/SKILL.md",
			},
			{
				name: "beta",
				description: "Beta skill",
				path: "/skills/beta/SKILL.md",
			},
		];
		const contexts: ContextFixture[] = [
			{ path: "/project/AGENTS.md", content: "Project instructions" },
			{ path: "/project/EXTRA.md", content: "Extra instructions" },
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
		const systemPrompt = [
			"Base prompt",
			formatSkillsForPrompt(promptSkills),
			formatContextSection(contexts),
		].join("");
		const promptOptions = {
			selectedTools: ["read"],
			toolSnippets: {},
			skills: promptSkills,
			contextFiles: contexts,
		};
		const harness = createHarness({
			tools: [{ name: "read" }],
			activeTools: ["read"],
			skills,
			branch: [
				{
					type: "custom",
					customType: "pi-config-manager-state",
					data: {
						version: 2,
						tools: ["read"],
						enabledSkills: [],
						disabledSkills: ["beta"],
						enabledContexts: [],
						disabledContexts: ["/project/EXTRA.md"],
						preset: {
							name: "focus",
							customTools: true,
							appliedTools: ["read"],
							originalState: {
								provider: "fixture",
								model: "base",
								thinkingLevel: "medium",
								tools: ["read"],
							},
						},
					},
				},
			],
			systemPrompt,
			promptOptions,
		});
		await harness.start();
		try {
			const result = await harness.trigger("before_agent_start", {
				systemPrompt,
				systemPromptOptions: promptOptions,
			});
			expect(result?.systemPrompt).toContain("alpha");
			expect(result?.systemPrompt).not.toContain("beta");
			expect(result?.systemPrompt).toContain("/project/AGENTS.md");
			expect(result?.systemPrompt).not.toContain("/project/EXTRA.md");
			expect(harness.notifications).toEqual([]);
		} finally {
			await harness.shutdown();
		}
	});

	test("shows prompt sources together with context files", async () => {
		writePresets({ focus: { instructions: "PRESET INSTRUCTIONS" } });
		const contexts = [
			{ path: "/project/AGENTS.md", content: "PROJECT CONTEXT" },
		];
		const customPrompt = "CUSTOM SYSTEM PROMPT";
		const appendedPrompt = "APPENDED SYSTEM PROMPT";
		const promptOptions = {
			customPrompt,
			appendSystemPrompt: appendedPrompt,
			selectedTools: ["read"],
			toolSnippets: {},
			skills: [],
			contextFiles: contexts,
		};
		const basePrompt = `${customPrompt}\n\n${appendedPrompt}${formatContextSection(contexts)}\nCurrent working directory: /project`;
		const harness = createHarness({
			tools: [{ name: "read" }],
			activeTools: ["read"],
			systemPrompt: basePrompt,
			promptOptions,
		});
		await harness.start();
		try {
			await harness.commands.get("preset").handler("focus", harness.ctx);
			const result = await harness.trigger("before_agent_start", {
				systemPrompt: basePrompt,
				systemPromptOptions: promptOptions,
			});
			harness.setSystemPrompt(result.systemPrompt);
			await harness.trigger("agent_start");

			const rendered: string[] = [];
			harness.setCustomImplementation(async (factory) => {
				let resultValue: "close" | "save" = "close";
				const component = await factory(
					{ requestRender() {} },
					createTheme(),
					createKeybindings(),
					(value: "close" | "save") => {
						resultValue = value;
					},
				);
				navigateToManagerTab(component, "contexts");
				for (let index = 0; index < 4; index += 1) {
					rendered.push(component.render(180).join("\n"));
					component.handleInput("down");
				}
				component.handleInput("escape");
				return resultValue;
			});

			await harness.commands.get("config-manager").handler("", harness.ctx);
			const output = rendered.join("\n");
			expect(output).toContain("[Contexts]");
			expect(output).toContain("System Prompt Sources");
			expect(output).toContain("Context Files");
			expect(output).toContain("Effective Prompt");
			expect(output).toContain("Custom System Prompt");
			expect(output).toContain("CUSTOM SYSTEM PROMPT");
			expect(output).toContain("Appended System Prompt");
			expect(output).toContain("APPENDED SYSTEM PROMPT");
			expect(output).toContain("AGENTS.md");
			expect(output).toContain("PROJECT CONTEXT");
			expect(output).toContain("Preset Instructions");
			expect(output).toContain("PRESET INSTRUCTIONS");
			expect(output).toContain("active · found in effective prompt");
			expect(output).toContain(
				"source paths unavailable through Extension API",
			);
		} finally {
			await harness.shutdown();
		}
	});

	test("counts SYSTEM, APPEND_SYSTEM, and context files together", async () => {
		const context = { path: "/project/AGENTS.md", content: "instructions" };
		const promptOptions = {
			customPrompt: "CUSTOM",
			appendSystemPrompt: "APPENDED",
			selectedTools: ["read"],
			toolSnippets: {},
			skills: [],
			contextFiles: [context],
		};
		const harness = createHarness({ promptOptions });
		await harness.start();
		try {
			await harness.trigger("before_agent_start", {
				systemPrompt: `CUSTOM\n\nAPPENDED${formatContextSection([context])}`,
				systemPromptOptions: promptOptions,
			});
			const widgetFactory = harness.widgets.get("pi-config-manager");
			const widget = widgetFactory({ requestRender() {} }, createTheme());
			expect(widget.render(180).join("\n")).toContain("contexts 3/3");

			let overview = "";
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
				overview = component.render(180).join("\n");
				component.handleInput("escape");
				return result;
			});
			await harness.commands.get("config-manager").handler("", harness.ctx);
			expect(overview).toContain("Contexts  3/3 loaded context resources");
		} finally {
			await harness.shutdown();
		}
	});

	test("shows an appended prompt source without any context files", async () => {
		const harness = createHarness({
			systemPrompt: "Base\n\nAPPEND ONLY",
			promptOptions: {
				appendSystemPrompt: "APPEND ONLY",
				selectedTools: ["read"],
				toolSnippets: {},
				skills: [],
				contextFiles: [],
			},
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
				navigateToManagerTab(component, "contexts");
				rendered = component.render(180).join("\n");
				component.handleInput("escape");
				return result;
			});

			await harness.commands.get("config-manager").handler("", harness.ctx);
			expect(rendered).toContain("[Contexts]");
			expect(rendered).toContain("Appended System Prompt");
			expect(rendered).toContain("APPEND ONLY");
			expect(rendered).not.toContain("No matching resources");
		} finally {
			await harness.shutdown();
		}
	});

	test("verifies all enabled and disabled context presence states", async () => {
		const contexts: ContextFixture[] = [
			{ path: "/project/enabled-found.md", content: "enabled found" },
			{ path: "/project/enabled-missing.md", content: "enabled missing" },
			{ path: "/project/disabled-absent.md", content: "disabled absent" },
			{ path: "/project/disabled-found.md", content: "disabled found" },
		];
		writeFileSync(
			join(env.agentDir, "resource-settings.json"),
			`${JSON.stringify({
				version: 1,
				disabledTools: [],
				disabledSkills: [],
				disabledContexts: [contexts[2]?.path, contexts[3]?.path],
			})}\n`,
			"utf8",
		);
		const finalPrompt = `Base${formatContextSection([
			contexts[0]!,
			contexts[3]!,
		])}`;
		const harness = createHarness({
			systemPrompt: finalPrompt,
			promptOptions: {
				selectedTools: ["read"],
				toolSnippets: {},
				skills: [],
				contextFiles: contexts,
			},
		});
		await harness.start();
		try {
			await harness.trigger("agent_start");
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
				navigateToManagerTab(component, "contexts");
				for (let index = 0; index < contexts.length; index += 1) {
					rendered.push(component.render(180).join("\n"));
					component.handleInput("down");
				}
				component.handleInput("escape");
				return result;
			});

			await harness.commands.get("config-manager").handler("", harness.ctx);
			const output = rendered.join("\n");
			expect(output).toContain("enabled · found in effective prompt");
			expect(output).toContain("enabled · NOT FOUND in effective prompt");
			expect(output).toContain("disabled · absent from effective prompt");
			expect(output).toContain("disabled · FOUND IN EFFECTIVE PROMPT");
		} finally {
			await harness.shutdown();
		}
	});

	test("detects a disabled skill reintroduced into the effective prompt", async () => {
		const skill = {
			name: "blocked-skill",
			description: "Blocked skill",
			path: "/skills/blocked/SKILL.md",
		};
		writeFileSync(
			join(env.agentDir, "resource-settings.json"),
			`${JSON.stringify({
				version: 1,
				disabledTools: [],
				disabledSkills: [skill.name],
				disabledContexts: [],
			})}\n`,
			"utf8",
		);
		const promptSkill = {
			name: skill.name,
			description: skill.description,
			filePath: skill.path,
			baseDir: "/skills/blocked",
			disableModelInvocation: false,
		};
		const finalPrompt = `Base${formatSkillsForPrompt([promptSkill as any])}`;
		const harness = createHarness({
			skills: [skill],
			systemPrompt: finalPrompt,
			promptOptions: {
				selectedTools: ["read"],
				toolSnippets: {},
				skills: [promptSkill],
				contextFiles: [],
			},
		});
		await harness.start();
		try {
			await harness.trigger("agent_start");
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
				navigateToManagerTab(component, "skills");
				rendered = component.render(180).join("\n");
				component.handleInput("escape");
				return result;
			});

			await harness.commands.get("config-manager").handler("", harness.ctx);
			expect(rendered).toContain("disabled · FOUND IN EFFECTIVE PROMPT");
		} finally {
			await harness.shutdown();
		}
	});

	test("filters every duplicate standard skill and context section", async () => {
		const skills = [
			{
				name: "alpha",
				description: "Alpha skill",
				filePath: "/skills/alpha/SKILL.md",
				baseDir: "/skills/alpha",
			},
			{
				name: "beta",
				description: "Beta skill",
				filePath: "/skills/beta/SKILL.md",
				baseDir: "/skills/beta",
			},
		];
		const contexts = [
			{ path: "/project/A.md", content: "A" },
			{ path: "/project/B.md", content: "B" },
		];
		writeFileSync(
			join(env.agentDir, "resource-settings.json"),
			`${JSON.stringify({
				version: 1,
				disabledTools: [],
				disabledSkills: ["beta"],
				disabledContexts: ["/project/B.md"],
			})}\n`,
			"utf8",
		);
		const skillsSection = formatSkillsForPrompt(skills as any);
		const contextsSection = formatContextSection(contexts);
		const systemPrompt = `Base${skillsSection}${contextsSection}${skillsSection}${contextsSection}`;
		const promptOptions = {
			selectedTools: ["read"],
			toolSnippets: {},
			skills,
			contextFiles: contexts,
		};
		const harness = createHarness({ systemPrompt, promptOptions });
		await harness.start();
		try {
			const result = await harness.trigger("before_agent_start", {
				systemPrompt,
				systemPromptOptions: promptOptions,
			});
			expect(result.systemPrompt).not.toContain("/skills/beta/SKILL.md");
			expect(result.systemPrompt).not.toContain("/project/B.md");
			expect(
				result.systemPrompt.match(/\/skills\/alpha\/SKILL\.md/g),
			).toHaveLength(2);
			expect(result.systemPrompt.match(/\/project\/A\.md/g)).toHaveLength(2);
		} finally {
			await harness.shutdown();
		}
	});

	test("reports a prompt filtering failure on every affected run", async () => {
		const context = { path: "/project/B.md", content: "B" };
		writeFileSync(
			join(env.agentDir, "resource-settings.json"),
			`${JSON.stringify({
				version: 1,
				disabledTools: [],
				disabledSkills: [],
				disabledContexts: [context.path],
			})}\n`,
			"utf8",
		);
		const promptOptions = {
			selectedTools: ["read"],
			toolSnippets: {},
			skills: [],
			contextFiles: [context],
		};
		const harness = createHarness({ promptOptions });
		await harness.start();
		try {
			for (let run = 0; run < 2; run += 1) {
				await harness.trigger("before_agent_start", {
					systemPrompt: "custom prompt without the standard context block",
					systemPromptOptions: promptOptions,
				});
			}
			expect(
				harness.notifications.filter((notification) =>
					notification.message.includes(
						"Disabled Context Files could not be removed",
					),
				),
			).toHaveLength(2);
		} finally {
			await harness.shutdown();
		}
	});

	test("refreshes a pre-run prompt preview when the manager reopens", async () => {
		const harness = createHarness({
			tools: [
				{
					name: "read",
					description: "Read files",
					promptGuidelines: ["Use read carefully"],
				},
			],
			activeTools: ["read"],
			systemPrompt: "FIRST PREVIEW",
			promptOptions: {
				selectedTools: ["read"],
				toolSnippets: { read: "Read files" },
				promptGuidelines: ["Use read carefully"],
				skills: [],
				contextFiles: [],
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
				navigateToManagerTab(component, "tools");
				rendered.push(component.render(180).join("\n"));
				component.handleInput("escape");
				return result;
			});

			await harness.commands.get("config-manager").handler("", harness.ctx);
			harness.setSystemPrompt("SECOND PREVIEW");
			await harness.commands.get("config-manager").handler("", harness.ctx);
			expect(rendered[0]).toContain("FIRST PREVIEW");
			expect(rendered[1]).toContain("SECOND PREVIEW");
			expect(rendered[1]).not.toContain("FIRST PREVIEW");
		} finally {
			await harness.shutdown();
		}
	});

	test("publishes current skill and context counts after global changes", async () => {
		const context = { path: "/project/AGENTS.md", content: "instructions" };
		const skill = {
			name: "alpha",
			description: "Alpha skill",
			path: "/skills/alpha/SKILL.md",
		};
		const harness = createHarness({
			skills: [skill],
			promptOptions: {
				selectedTools: ["read"],
				toolSnippets: {},
				skills: [skill],
				contextFiles: [context],
			},
		});
		await harness.start();
		try {
			let targetTab: "skills" | "contexts" = "skills";
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
				navigateToManagerTab(component, targetTab);
				component.handleInput(" ");
				component.handleInput("escape");
				return result;
			});
			await harness.commands.get("config-manager").handler("", harness.ctx);
			let state = harness.emissions
				.filter((event) => event.name === "config-manager:state-changed")
				.at(-1)?.data;
			expect(state.skills).toEqual({ enabled: 0, total: 1 });
			targetTab = "contexts";
			await harness.commands.get("config-manager").handler("", harness.ctx);
			state = harness.emissions
				.filter((event) => event.name === "config-manager:state-changed")
				.at(-1)?.data;
			expect(state.contexts).toEqual({ enabled: 0, total: 1 });
		} finally {
			await harness.shutdown();
		}
	});
});
