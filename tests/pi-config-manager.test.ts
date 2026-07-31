import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import piConfigManager from "../src/index";
import {
	isDirectFilePackage,
	saveExtensionChanges,
} from "../src/extensions";
import {
	cloneSessionState,
	normalizeResourceSettings,
	normalizeSessionState,
} from "../src/storage";
import { DEFAULT_SESSION_STATE } from "../src/types";

interface ToolFixture {
	name: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: unknown;
	sourceInfo?: unknown;
}

interface SkillFixture {
	name: string;
	description: string;
	path: string;
	disableModelInvocation?: boolean;
}

interface ContextFixture {
	path: string;
	content: string;
}

interface HarnessOptions {
	tools?: ToolFixture[];
	activeTools?: string[];
	skills?: SkillFixture[];
	branch?: any[];
	trusted?: boolean;
	systemPrompt?: string;
	promptOptions?: Record<string, unknown>;
}

const tempRoots: string[] = [];
let agentDir = "";
let cwd = "";

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-config-manager-agent-"));
	cwd = mkdtempSync(join(tmpdir(), "pi-config-manager-project-"));
	tempRoots.push(agentDir, cwd);
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	while (tempRoots.length > 0) {
		rmSync(tempRoots.pop()!, { recursive: true, force: true });
	}
});

function formatContextSection(files: ContextFixture[]): string {
	if (files.length === 0) return "";
	let result =
		"\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
	for (const file of files) {
		result += `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
	}
	return `${result}</project_context>\n`;
}

function createTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
}

function createKeybindings() {
	const bindings: Record<string, string[]> = {
		"tui.select.cancel": ["escape", "ctrl+c"],
		"tui.input.tab": ["tab"],
		"tui.editor.cursorRight": ["right"],
		"tui.editor.cursorLeft": ["left"],
		"tui.select.up": ["up"],
		"tui.select.down": ["down"],
		"tui.select.confirm": ["enter"],
	};
	return {
		matches(data: string, action: string) {
			return bindings[action]?.includes(data) ?? false;
		},
	};
}

function createHarness(options: HarnessOptions = {}) {
	const tools = (
		options.tools ?? [
			{ name: "read", description: "Read files" },
			{ name: "bash", description: "Run commands" },
		]
	).map((tool) => ({
		parameters: {},
		sourceInfo: {
			path: `<fixture:${tool.name}>`,
			source: "fixture",
			scope: "temporary",
			origin: "top-level",
		},
		...tool,
	}));
	let activeTools = [
		...(options.activeTools ?? tools.map((tool) => tool.name)),
	];
	const commands = new Map<string, any>();
	const lifecycle = new Map<string, Array<(event: any, ctx: any) => any>>();
	const eventListeners = new Map<string, Array<(event: any) => any>>();
	const emissions: Array<{ name: string; data: any }> = [];
	const entries: Array<{ customType: string; data: any }> = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const widgets = new Map<string, any>();
	const skills = options.skills ?? [];
	const branch = options.branch ?? [];
	const promptOptions = options.promptOptions ?? {
		selectedTools: activeTools,
		tools: [],
		toolSnippets: {},
		skills,
		contextFiles: [],
	};
	const systemPrompt = options.systemPrompt ?? "fixture system prompt";
	let customImplementation:
		| ((factory: any, customOptions: any) => Promise<any>)
		| undefined;

	const events = {
		on(name: string, handler: (event: any) => any) {
			const handlers = eventListeners.get(name) ?? [];
			handlers.push(handler);
			eventListeners.set(name, handlers);
		},
		emit(name: string, data: any) {
			emissions.push({ name, data });
			for (const handler of eventListeners.get(name) ?? []) handler(data);
		},
	};

	const pi = {
		events,
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		on(name: string, handler: (event: any, ctx: any) => any) {
			const handlers = lifecycle.get(name) ?? [];
			handlers.push(handler);
			lifecycle.set(name, handlers);
		},
		appendEntry(customType: string, data: any) {
			entries.push({ customType, data });
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names: string[]) {
			const known = new Set(tools.map((tool) => tool.name));
			activeTools = names.filter((name) => known.has(name));
		},
		getAllTools() {
			return tools;
		},
		getCommands() {
			return skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: {
					path: skill.path,
					source: "fixture",
					scope: "temporary",
					origin: "top-level",
				},
			}));
		},
	};

	const ui = {
		theme: createTheme(),
		notify(message: string, type?: string) {
			notifications.push({ message, type });
		},
		setWidget(name: string, value: any) {
			if (value === undefined) widgets.delete(name);
			else widgets.set(name, value);
		},
		async custom(factory: any, customOptions: any) {
			if (!customImplementation) return "close";
			return customImplementation(factory, customOptions);
		},
		async confirm() {
			return false;
		},
	};

	const ctx = {
		cwd,
		mode: "tui",
		hasUI: true,
		ui,
		sessionManager: {
			getBranch: () => branch,
		},
		isProjectTrusted: () => options.trusted ?? false,
		getSystemPrompt: () => systemPrompt,
		getSystemPromptOptions: () => promptOptions,
	};

	piConfigManager(pi as any);

	async function trigger(name: string, event: any = {}) {
		let result: any;
		for (const handler of lifecycle.get(name) ?? []) {
			const current = await handler(event, ctx);
			if (current !== undefined) result = current;
		}
		return result;
	}

	async function start() {
		await trigger("session_start", { reason: "startup" });
	}

	async function shutdown() {
		await trigger("session_shutdown", { reason: "quit" });
	}

	return {
		commands,
		ctx,
		emissions,
		entries,
		events,
		notifications,
		widgets,
		getActiveTools: () => [...activeTools],
		setExternalActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
		setCustomImplementation(implementation: typeof customImplementation) {
			customImplementation = implementation;
		},
		start,
		shutdown,
		trigger,
	};
}

function writeAgentSettings(value: unknown) {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify(value, null, 2)}\n`,
		"utf8",
	);
}

function readAgentSettings(): any {
	return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
}

function readResourceSettings(): any {
	return JSON.parse(
		readFileSync(join(agentDir, "resource-settings.json"), "utf8"),
	);
}

describe("storage compatibility", () => {
	test("normalizes resource and session state without sharing mutable arrays", () => {
		expect(
			normalizeResourceSettings({
				disabledTools: ["write", 42, "read", "write"],
				disabledSkills: ["zeta", "alpha"],
			}),
		).toEqual({
			version: 1,
			disabledTools: ["read", "write"],
			disabledSkills: ["alpha", "zeta"],
			disabledContexts: [],
		});
		expect(normalizeSessionState({ version: 2 })).toBeUndefined();

		const normalized = normalizeSessionState({
			version: 1,
			tools: ["bash", "read", "bash"],
			enabledSkills: ["browser"],
			disabledSkills: [],
			enabledContexts: [],
			disabledContexts: ["/tmp/AGENTS.md"],
		});
		expect(normalized).toEqual({
			version: 1,
			tools: ["bash", "read"],
			enabledSkills: ["browser"],
			disabledSkills: [],
			enabledContexts: [],
			disabledContexts: ["/tmp/AGENTS.md"],
		});

		const cloned = cloneSessionState(normalized ?? DEFAULT_SESSION_STATE);
		cloned.enabledSkills.push("changed");
		expect(normalized?.enabledSkills).toEqual(["browser"]);
	});
});

describe("extension settings compatibility", () => {
	test("identifies only local package entries that directly name the extension file", () => {
		const extensionPath = join(cwd, "direct-extension.ts");
		const base = {
			path: extensionPath,
			enabled: true,
			metadata: {
				scope: "project",
				origin: "package",
				source: extensionPath,
				baseDir: cwd,
			},
		};
		expect(isDirectFilePackage(base as any, cwd)).toBe(true);
		expect(
			isDirectFilePackage(
				{
					...base,
					metadata: { ...base.metadata, source: "npm:fixture" },
				} as any,
				cwd,
			),
		).toBe(false);
		expect(
			isDirectFilePackage(
				{
					...base,
					metadata: { ...base.metadata, origin: "top-level" },
				} as any,
				cwd,
			),
		).toBe(false);
	});

	test("replaces top-level extension overrides without duplicating old markers", async () => {
		writeAgentSettings({
			extensions: ["extensions/other.ts", "-extensions/fixture.ts"],
		});
		const resource = {
			path: join(agentDir, "extensions", "fixture.ts"),
			enabled: false,
			metadata: {
				scope: "user",
				origin: "top-level",
				source: "auto",
				baseDir: agentDir,
			},
		};

		await saveExtensionChanges(cwd, false, [
			{ resource: resource as any, enabled: true },
		]);
		expect(readAgentSettings().extensions).toEqual([
			"extensions/other.ts",
			"+extensions/fixture.ts",
		]);
	});

	test("updates package extension filters while preserving unrelated filters", async () => {
		writeAgentSettings({
			packages: [
				{
					source: "npm:fixture",
					extensions: ["extensions/*.ts", "-extensions/fixture.ts"],
					skills: ["skills"],
				},
			],
		});
		const resource = {
			path: join(cwd, "package", "extensions", "fixture.ts"),
			enabled: false,
			metadata: {
				scope: "user",
				origin: "package",
				source: "npm:fixture",
				baseDir: join(cwd, "package"),
			},
		};

		await saveExtensionChanges(cwd, false, [
			{ resource: resource as any, enabled: true },
		]);
		const [pkg] = readAgentSettings().packages;
		expect(pkg.extensions).toEqual([
			"extensions/*.ts",
			"+extensions/fixture.ts",
		]);
		expect(pkg.skills).toEqual(["skills"]);
	});
});

describe("manager behavior contract", () => {
	test("registers the public commands and applies global tool defaults on startup", async () => {
		writeFileSync(
			join(agentDir, "resource-settings.json"),
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
				"skills",
				"tools",
			]);
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

	test("preserves session, preset, runtime-layer, and external-tool precedence", async () => {
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
						version: 1,
						tools: ["edit", "missing-tool"],
						enabledSkills: [],
						disabledSkills: [],
						enabledContexts: [],
						disabledContexts: [],
					},
				},
			],
		});
		await harness.start();
		try {
			expect(harness.getActiveTools()).toEqual(["edit"]);

			harness.events.emit("preset:tools-changed", {
				tools: ["read"],
				resetSessionOverride: false,
			});
			expect(harness.getActiveTools()).toEqual(["edit"]);

			harness.events.emit("preset:tools-changed", {
				tools: ["read"],
				resetSessionOverride: true,
			});
			expect(harness.getActiveTools()).toEqual(["read"]);

			harness.events.emit("config-manager:layer-set", {
				id: "plan-mode",
				disableTools: ["read"],
				requireTools: ["bash", "missing-tool"],
			});
			expect(harness.getActiveTools()).toEqual(["bash"]);

			harness.setExternalActiveTools(["bash", "questionnaire"]);
			await harness.trigger("turn_start");
			expect(harness.getActiveTools()).toEqual(["questionnaire", "bash"]);

			harness.events.emit("config-manager:layer-clear", { id: "plan-mode" });
			expect(harness.getActiveTools()).toEqual(["read", "questionnaire"]);

			harness.events.emit("config-manager:layer-set", {
				id: "malformed-layer",
				disableTools: "read",
				requireTools: { name: "bash" },
			});
			expect(harness.getActiveTools()).toEqual(["read", "questionnaire"]);
		} finally {
			await harness.shutdown();
		}
	});

	test("restores legacy tool and skill session entries", async () => {
		const harness = createHarness({
			tools: [{ name: "read" }, { name: "bash" }],
			activeTools: ["read", "bash"],
			skills: [
				{ name: "alpha", description: "Alpha", path: "/skills/alpha/SKILL.md" },
				{ name: "beta", description: "Beta", path: "/skills/beta/SKILL.md" },
			],
			branch: [
				{
					type: "custom",
					customType: "tools-config",
					data: { enabledTools: ["bash"] },
				},
				{
					type: "custom",
					customType: "skills-manager-state",
					data: {
						mode: "override",
						enabledSkills: ["alpha"],
						disabledSkills: ["beta"],
					},
				},
			],
		});
		await harness.start();
		try {
			expect(harness.getActiveTools()).toEqual(["bash"]);
			const snapshotRequestCount = harness.emissions.filter(
				(event) => event.name === "config-manager:state-changed",
			).length;
			expect(snapshotRequestCount).toBeGreaterThan(0);
		} finally {
			await harness.shutdown();
		}
	});

	test("filters disabled skills and contexts from the standard system prompt", async () => {
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
						version: 1,
						tools: ["read"],
						enabledSkills: [],
						disabledSkills: ["beta"],
						enabledContexts: [],
						disabledContexts: ["/project/EXTRA.md"],
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

	test("opens default scope and persists tool toggles for new sessions", async () => {
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
			expect(renderedText).toContain(
				"Pi Config Manager · Context Monitor",
			);
			expect(renderedText).toContain("[Tools]");
			expect(renderedText).toContain("Scope: Default");
			expect(renderedText).toContain("System prompt Available tools entry:");
			expect(renderedText).toContain("- read: Read files safely");
			expect(renderedText).toContain("System prompt guidelines:");
			expect(renderedText).toContain("- Use read carefully");
			expect(harness.getActiveTools()).toEqual([]);
			expect(readResourceSettings()).toEqual({
				version: 1,
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

	test("switches to session scope without changing global defaults", async () => {
		const harness = createHarness({
			tools: [{ name: "read", description: "Read files" }],
			activeTools: ["read"],
		});
		await harness.start();
		try {
			let defaultView = "";
			let sessionView = "";
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
				defaultView = component.render(100).join("\n");
				component.handleInput("G");
				sessionView = component.render(100).join("\n");
				component.handleInput(" ");
				component.handleInput("escape");
				return result;
			});

			await harness.commands.get("tools").handler("", harness.ctx);
			expect(defaultView).toContain("Scope: Default");
			expect(sessionView).toContain("Scope: Session");
			expect(existsSync(join(agentDir, "resource-settings.json"))).toBe(false);
			expect(
				harness.entries.some(
					(entry) =>
						entry.customType === "pi-config-manager-state" &&
						Array.isArray(entry.data.tools) &&
						entry.data.tools.length === 0,
				),
			).toBe(true);
		} finally {
			await harness.shutdown();
		}
	});

	test("persists skill toggles from default scope", async () => {
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
			expect(rendered).toContain("Scope: Default");
			expect(readResourceSettings()).toEqual({
				version: 1,
				disabledTools: [],
				disabledSkills: ["alpha"],
				disabledContexts: [],
			});
		} finally {
			await harness.shutdown();
		}
	});
});
