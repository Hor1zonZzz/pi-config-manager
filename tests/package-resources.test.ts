import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	isDirectFilePackage,
	resolveExtensions,
	resolvePackageResources,
	saveExtensionChanges,
	savePackageResourceChanges,
} from "../src/extensions";
import { createTestEnvironment } from "./helpers/config-manager-harness";

const env = createTestEnvironment();
beforeEach(() => env.setup());
afterEach(() => env.teardown());
const { readAgentSettings, writeAgentSettings } = env;

describe("package resource settings compatibility", () => {
	test("identifies only local package entries that directly name the extension file", () => {
		const extensionPath = join(env.cwd, "direct-extension.ts");
		const base = {
			path: extensionPath,
			enabled: true,
			metadata: {
				scope: "project",
				origin: "package",
				source: extensionPath,
				baseDir: env.cwd,
			},
		};
		expect(isDirectFilePackage(base as any, env.cwd)).toBe(true);
		expect(
			isDirectFilePackage(
				{
					...base,
					metadata: { ...base.metadata, source: "npm:fixture" },
				} as any,
				env.cwd,
			),
		).toBe(false);
		expect(
			isDirectFilePackage(
				{
					...base,
					metadata: { ...base.metadata, origin: "top-level" },
				} as any,
				env.cwd,
			),
		).toBe(false);
	});

	test("replaces top-level extension overrides without duplicating old markers", async () => {
		writeAgentSettings({
			extensions: ["extensions/other.ts", "-extensions/fixture.ts"],
		});
		const resource = {
			path: join(env.agentDir, "extensions", "fixture.ts"),
			enabled: false,
			metadata: {
				scope: "user",
				origin: "top-level",
				source: "auto",
				baseDir: env.agentDir,
			},
		};

		await saveExtensionChanges(env.cwd, false, [
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
			path: join(env.cwd, "package", "extensions", "fixture.ts"),
			enabled: false,
			metadata: {
				scope: "user",
				origin: "package",
				source: "npm:fixture",
				baseDir: join(env.cwd, "package"),
			},
		};

		await saveExtensionChanges(env.cwd, false, [
			{ resource: resource as any, enabled: true },
		]);
		const [pkg] = readAgentSettings().packages;
		expect(pkg.extensions).toEqual([
			"extensions/*.ts",
			"+extensions/fixture.ts",
		]);
		expect(pkg.skills).toEqual(["skills"]);
	});

	test("resolves all native package resource kinds with their enabled state", async () => {
		mkdirSync(join(env.agentDir, "extensions"), { recursive: true });
		mkdirSync(join(env.agentDir, "skills", "hidden"), { recursive: true });
		mkdirSync(join(env.agentDir, "prompts"), { recursive: true });
		mkdirSync(join(env.agentDir, "themes"), { recursive: true });
		writeFileSync(
			join(env.agentDir, "extensions", "fixture.ts"),
			"export default () => {};\n",
		);
		writeFileSync(
			join(env.agentDir, "skills", "hidden", "SKILL.md"),
			"---\nname: hidden\ndescription: Hidden skill\n---\n",
		);
		writeFileSync(join(env.agentDir, "prompts", "review.md"), "# Review\n");
		writeFileSync(join(env.agentDir, "themes", "fixture.json"), "{}\n");
		writeAgentSettings({
			extensions: ["-extensions/fixture.ts"],
			skills: ["-skills/hidden/SKILL.md"],
			prompts: ["-prompts/review.md"],
			themes: ["-themes/fixture.json"],
		});

		const resources = await resolvePackageResources(env.cwd, false);
		expect(await resolveExtensions(env.cwd, false)).toEqual(
			resources.extensions,
		);
		expect(resources.extensions).toHaveLength(1);
		expect(resources.skills).toHaveLength(1);
		expect(resources.prompts).toHaveLength(1);
		expect(resources.themes).toHaveLength(1);
		expect(
			[
				...resources.extensions,
				...resources.skills,
				...resources.prompts,
				...resources.themes,
			].every((resource) => resource.enabled === false),
		).toBe(true);
	});

	test("writes prompt and theme overrides through native Pi settings", async () => {
		writeAgentSettings({
			prompts: ["prompts/other.md", "-prompts/review.md"],
			themes: ["-themes/fixture.json"],
		});
		const prompt = {
			path: join(env.agentDir, "prompts", "review.md"),
			enabled: false,
			metadata: {
				scope: "user",
				origin: "top-level",
				source: "auto",
				baseDir: env.agentDir,
			},
		};
		const theme = {
			path: join(env.agentDir, "themes", "fixture.json"),
			enabled: false,
			metadata: {
				scope: "user",
				origin: "top-level",
				source: "auto",
				baseDir: env.agentDir,
			},
		};

		await savePackageResourceChanges(env.cwd, false, [
			{ kind: "prompts", resource: prompt as any, enabled: true },
			{ kind: "themes", resource: theme as any, enabled: true },
		]);
		const settings = readAgentSettings();
		expect(settings.prompts).toEqual([
			"prompts/other.md",
			"+prompts/review.md",
		]);
		expect(settings.themes).toEqual(["+themes/fixture.json"]);
	});

	test("writes trusted project resource overrides to project settings", async () => {
		const configDir = join(env.cwd, ".pi");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "settings.json"),
			`${JSON.stringify({ prompts: ["-prompts/review.md"] })}\n`,
		);
		const prompt = {
			path: join(configDir, "prompts", "review.md"),
			enabled: false,
			metadata: {
				scope: "project",
				origin: "top-level",
				source: "auto",
				baseDir: configDir,
			},
		};

		await savePackageResourceChanges(env.cwd, true, [
			{ kind: "prompts", resource: prompt as any, enabled: true },
		]);
		const settings = JSON.parse(
			readFileSync(join(configDir, "settings.json"), "utf8"),
		);
		expect(settings.prompts).toEqual(["+prompts/review.md"]);
	});
});
