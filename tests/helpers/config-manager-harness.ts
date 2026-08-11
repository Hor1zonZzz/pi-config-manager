import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piConfigManager from "../../src/index";

export interface ToolFixture {
	name: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: unknown;
	sourceInfo?: unknown;
}

export interface SkillFixture {
	name: string;
	description: string;
	path: string;
	disableModelInvocation?: boolean;
}

export interface ContextFixture {
	path: string;
	content: string;
}

export interface HarnessOptions {
	tools?: ToolFixture[];
	activeTools?: string[];
	skills?: SkillFixture[];
	branch?: any[];
	trusted?: boolean;
	systemPrompt?: string;
	promptOptions?: Record<string, unknown>;
	presetFlag?: string;
	models?: Array<{ provider: string; id: string; authenticated?: boolean }>;
}

export function formatContextSection(files: ContextFixture[]): string {
	if (files.length === 0) return "";
	let result =
		"\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
	for (const file of files) {
		result += `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
	}
	return `${result}</project_context>\n`;
}

export function createTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
}

export function navigateToManagerTab(
	component: { handleInput(data: string): void },
	tab: "overview" | "tools" | "skills" | "contexts",
): void {
	const tabs = ["overview", "tools", "skills", "contexts"] as const;
	const tabIndex = tabs.indexOf(tab);
	for (let index = 0; index < tabIndex; index += 1) {
		component.handleInput("tab");
	}
}

export function createKeybindings() {
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

export function createTestEnvironment() {
	const tempRoots: string[] = [];
	let agentDir = "";
	let cwd = "";
	let originalHome: string | undefined;

	function setup(): void {
		agentDir = mkdtempSync(join(tmpdir(), "pi-config-manager-agent-"));
		cwd = mkdtempSync(join(tmpdir(), "pi-config-manager-project-"));
		tempRoots.push(agentDir, cwd);
		originalHome = process.env.HOME;
		process.env.HOME = agentDir;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	}

	function teardown(): void {
		delete process.env.PI_CODING_AGENT_DIR;
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		while (tempRoots.length > 0) {
			rmSync(tempRoots.pop()!, { recursive: true, force: true });
		}
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
		const flags = new Map<string, any>();
		const shortcuts = new Map<string, any>();
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
		let systemPrompt = options.systemPrompt ?? "fixture system prompt";
		let customImplementation:
			| ((factory: any, customOptions: any) => Promise<any>)
			| undefined;
		let thinkingLevel = "medium";
		let currentModel = { provider: "fixture", id: "base", authenticated: true };
		const models = options.models ?? [currentModel];

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
			registerFlag(name: string, flag: any) {
				flags.set(name, flag);
			},
			getFlag(name: string) {
				return name === "preset" ? options.presetFlag : undefined;
			},
			registerShortcut(key: string, shortcut: any) {
				shortcuts.set(key, shortcut);
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
			getThinkingLevel() {
				return thinkingLevel;
			},
			setThinkingLevel(level: string) {
				thinkingLevel = level;
			},
			async setModel(model: any) {
				if (model.authenticated === false) return false;
				currentModel = model;
				return true;
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
				if (!customImplementation) return undefined;
				return customImplementation(factory, customOptions);
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
			get model() {
				return currentModel;
			},
			modelRegistry: {
				find(provider: string, id: string) {
					return models.find(
						(model) => model.provider === provider && model.id === id,
					);
				},
			},
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
			flags,
			shortcuts,
			emissions,
			entries,
			events,
			notifications,
			widgets,
			getActiveTools: () => [...activeTools],
			getModel: () => currentModel,
			getThinkingLevel: () => thinkingLevel,
			setExternalActiveTools: (names: string[]) => {
				activeTools = [...names];
			},
			setSystemPrompt(value: string) {
				systemPrompt = value;
			},
			setCustomImplementation(implementation: typeof customImplementation) {
				customImplementation = implementation;
			},
			start,
			shutdown,
			trigger,
		};
	}


	function readResourceSettings(): any {
		return JSON.parse(
			readFileSync(join(agentDir, "resource-settings.json"), "utf8"),
		);
	}

	function writeProjectResourceSettings(value: unknown) {
		const configDir = join(cwd, ".pi");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "resource-settings.json"),
			`${JSON.stringify(value, null, 2)}\n`,
			"utf8",
		);
	}

	function writePresets(value: unknown, root = agentDir) {
		mkdirSync(root, { recursive: true });
		writeFileSync(
			join(root, "presets.json"),
			`${JSON.stringify(value, null, 2)}\n`,
			"utf8",
		);
	}

	return {
		get agentDir() {
			return agentDir;
		},
		get cwd() {
			return cwd;
		},
		setup,
		teardown,
		createHarness,
		readResourceSettings,
		writeProjectResourceSettings,
		writePresets,
	};
}
