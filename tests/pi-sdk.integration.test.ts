import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	createKeybindings,
	createTestEnvironment,
	createTheme,
	navigateToManagerTab,
} from "./helpers/config-manager-harness";

const env = createTestEnvironment();
beforeEach(() => env.setup());
afterEach(() => env.teardown());

const extensionPath = resolve(import.meta.dir, "../src/index.ts");
const promptFixture = {
	customPrompt: "SDK CUSTOM SYSTEM PROMPT",
	appendedPrompt: "SDK APPEND_SYSTEM CONTENT",
	contextContent: "SDK AGENTS CONTEXT",
};

interface ProbeCapture {
	options?: BuildSystemPromptOptions;
	commands: string[];
}

function createInteractiveUi(rendered: string[]) {
	let editorFactory: unknown;
	return {
		theme: createTheme(),
		async select() {
			return undefined;
		},
		async confirm() {
			return false;
		},
		async input() {
			return undefined;
		},
		notify() {},
		onTerminalInput() {
			return () => {};
		},
		setStatus() {},
		setWorkingMessage() {},
		setWorkingVisible() {},
		setWorkingIndicator() {},
		setHiddenThinkingLabel() {},
		setWidget() {},
		setFooter() {},
		setHeader() {},
		setTitle() {},
		async custom(factory: any) {
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
			for (let index = 0; index < 4; index += 1) {
				rendered.push(component.render(180).join("\n"));
				if (index === 2) {
					component.handleInput("right");
					for (let scroll = 0; scroll < 20; scroll += 1) {
						component.handleInput("down");
						rendered.push(component.render(180).join("\n"));
					}
					component.handleInput("left");
				}
				component.handleInput("down");
			}
			component.handleInput("escape");
			return result;
		},
		pasteToEditor() {},
		setEditorText() {},
		getEditorText() {
			return "";
		},
		async editor() {
			return undefined;
		},
		addAutocompleteProvider() {},
		setEditorComponent(factory: unknown) {
			editorFactory = factory;
		},
		getEditorComponent() {
			return editorFactory;
		},
		getAllThemes() {
			return [];
		},
		getTheme() {
			return undefined;
		},
		setTheme() {
			return { success: true };
		},
		getToolsExpanded() {
			return false;
		},
		setToolsExpanded() {},
	};
}

function writePromptResources(): void {
	mkdirSync(env.agentDir, { recursive: true });
	writeFileSync(
		`${env.agentDir}/SYSTEM.md`,
		`${promptFixture.customPrompt}\n`,
		"utf8",
	);
	writeFileSync(
		`${env.agentDir}/APPEND_SYSTEM.md`,
		`${promptFixture.appendedPrompt}\n`,
		"utf8",
	);
	writeFileSync(
		`${env.agentDir}/AGENTS.md`,
		`${promptFixture.contextContent}\n`,
		"utf8",
	);
}

function createProbe(capture: ProbeCapture) {
	return (pi: ExtensionAPI) => {
		pi.registerCommand("__config-manager-sdk-probe", {
			description: "Capture the real command context for integration testing",
			handler: async (_args, ctx) => {
				capture.options = ctx.getSystemPromptOptions();
				capture.commands = pi.getCommands().map((command) => command.name);
			},
		});
	};
}

async function createLoadedResources(capture: ProbeCapture) {
	writePromptResources();
	const settingsManager = SettingsManager.create(env.cwd, env.agentDir);
	const loader = new DefaultResourceLoader({
		cwd: env.cwd,
		agentDir: env.agentDir,
		settingsManager,
		additionalExtensionPaths: [extensionPath],
		extensionFactories: [
			{ name: "config-manager-sdk-probe", factory: createProbe(capture) },
		],
	});
	await loader.reload();
	return { loader, settingsManager };
}

function expectLoadedPromptResources(loader: DefaultResourceLoader): void {
	expect(loader.getSystemPrompt()).toContain(promptFixture.customPrompt);
	expect(loader.getAppendSystemPrompt().join("\n")).toContain(
		promptFixture.appendedPrompt,
	);
	expect(loader.getAgentsFiles().agentsFiles).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				content: expect.stringContaining(promptFixture.contextContent),
			}),
		]),
	);
}

function expectIntegratedBehavior(
	capture: ProbeCapture,
	rendered: string[],
	systemPrompt: string,
	extensionErrors: unknown[],
): void {
	expect(capture.options?.customPrompt).toContain(promptFixture.customPrompt);
	expect(capture.options?.appendSystemPrompt).toContain(
		promptFixture.appendedPrompt,
	);
	expect(capture.options?.contextFiles).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				content: expect.stringContaining(promptFixture.contextContent),
			}),
		]),
	);
	expect(
		capture.commands
			.filter((name) => name !== "__config-manager-sdk-probe")
			.sort(),
	).toEqual(["config-manager", "preset"]);
	const output = rendered.join("\n");
	for (const marker of [
		"[Contexts]",
		"Custom System Prompt",
		promptFixture.customPrompt,
		"Appended System Prompt",
		promptFixture.appendedPrompt,
		"AGENTS.md",
		promptFixture.contextContent,
	]) {
		expect(output).toContain(marker);
	}
	for (const marker of Object.values(promptFixture)) {
		expect(systemPrompt).toContain(marker);
	}
	expect(extensionErrors).toEqual([]);
}

describe("real Pi SDK integration", () => {
	test("loads Pi prompt resources and exposes them through /config-manager", async () => {
		const capture: ProbeCapture = { commands: [] };
		const { loader, settingsManager } = await createLoadedResources(capture);
		expectLoadedPromptResources(loader);
		const rendered: string[] = [];
		const extensionErrors: unknown[] = [];
		const { session } = await createAgentSession({
			cwd: env.cwd,
			agentDir: env.agentDir,
			resourceLoader: loader,
			settingsManager,
			sessionManager: SessionManager.inMemory(env.cwd),
			noTools: "all",
		});
		try {
			await session.bindExtensions({
				mode: "tui",
				uiContext: createInteractiveUi(rendered) as any,
				onError: (error) => extensionErrors.push(error),
			});
			await session.prompt("/__config-manager-sdk-probe");
			await session.prompt("/config-manager");
			expectIntegratedBehavior(
				capture,
				rendered,
				session.agent.state.systemPrompt,
				extensionErrors,
			);
		} finally {
			// The extension intentionally performs one delayed settled-state refresh.
			// Let it finish even after an assertion failure, before removing temp files.
			await Bun.sleep(550);
			session.dispose();
		}
	});
});
