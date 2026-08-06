import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
	CONFIG_DIR_NAME,
	DefaultPackageManager,
	getAgentDir,
	SettingsManager,
	type PackageSource,
	type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import type {
	ExtensionChange,
	PackageResourceCatalog,
	PackageResourceChange,
	PackageResourceKind,
} from "./types";

function normalizePattern(pattern: string): string {
	return pattern.replaceAll("\\", "/").replace(/^\.\//, "");
}

function stripMarker(pattern: string): string {
	return normalizePattern(
		pattern.startsWith("+") ||
			pattern.startsWith("-") ||
			pattern.startsWith("!")
			? pattern.slice(1)
			: pattern,
	);
}

function createSettingsManager(cwd: string, trusted: boolean): SettingsManager {
	return SettingsManager.create(cwd, getAgentDir(), {
		projectTrusted: trusted,
	});
}

function canonicalBase(resource: ResolvedResource, cwd: string): string {
	return (
		resource.metadata.baseDir ??
		(resource.metadata.scope === "project"
			? join(cwd, CONFIG_DIR_NAME)
			: getAgentDir())
	);
}

function resourcePattern(resource: ResolvedResource, cwd: string): string {
	return normalizePattern(
		relative(canonicalBase(resource, cwd), resource.path),
	);
}

export function isDirectFilePackage(
	resource: ResolvedResource,
	cwd: string,
): boolean {
	if (resource.metadata.origin !== "package") return false;
	let source = resource.metadata.source;
	if (source.startsWith("~/")) source = join(homedir(), source.slice(2));
	if (/^(npm:|git:|https?:)/.test(source)) return false;
	const candidates = source.startsWith("/")
		? [source]
		: [
				resolve(getAgentDir(), source),
				resolve(cwd, source),
				resolve(cwd, CONFIG_DIR_NAME, source),
			];
	return candidates.some((candidate) => candidate === resolve(resource.path));
}

function packageSource(entry: PackageSource): string {
	return typeof entry === "string" ? entry : entry.source;
}

function equivalentPatterns(
	resource: ResolvedResource,
	cwd: string,
): Set<string> {
	const scopeBase =
		resource.metadata.scope === "project"
			? join(cwd, CONFIG_DIR_NAME)
			: getAgentDir();
	return new Set([
		resourcePattern(resource, cwd),
		normalizePattern(resource.path),
		normalizePattern(relative(scopeBase, resource.path)),
	]);
}

function replaceResourceOverride(
	entries: string[],
	aliases: Set<string>,
	override: string,
): string[] {
	return [
		...entries.filter(
			(entry) => !/^[+\-!]/.test(entry) || !aliases.has(stripMarker(entry)),
		),
		override,
	];
}

function updateTopLevelPaths(
	paths: string[],
	change: PackageResourceChange,
	cwd: string,
): string[] {
	return replaceResourceOverride(
		paths,
		equivalentPatterns(change.resource, cwd),
		`${change.enabled ? "+" : "-"}${resourcePattern(change.resource, cwd)}`,
	);
}

function applyPackageChanges(
	packages: PackageSource[],
	changes: PackageResourceChange[],
	cwd: string,
): PackageSource[] {
	const updatedPackages = [...packages];
	for (const change of changes) {
		const source = change.resource.metadata.source;
		const packageIndex = updatedPackages.findIndex(
			(entry) => packageSource(entry) === source,
		);
		if (packageIndex < 0) continue;
		const currentEntry = updatedPackages[packageIndex];
		if (!currentEntry) continue;
		const packageEntry: Exclude<PackageSource, string> =
			typeof currentEntry === "string"
				? { source: currentEntry }
				: { ...currentEntry };
		const current = packageEntry[change.kind];
		const pattern = resourcePattern(change.resource, cwd);
		const aliases = equivalentPatterns(change.resource, cwd);

		if (current?.length === 0 && packageEntry.autoload !== false) {
			if (change.enabled) {
				packageEntry[change.kind] = [pattern];
			}
		} else {
			packageEntry[change.kind] = replaceResourceOverride(
				current ?? [],
				aliases,
				`${change.enabled ? "+" : "-"}${pattern}`,
			);
		}
		updatedPackages[packageIndex] = packageEntry;
	}
	return updatedPackages;
}

function getTopLevelPaths(
	settingsManager: SettingsManager,
	kind: PackageResourceKind,
	project: boolean,
): string[] {
	const settings = project
		? settingsManager.getProjectSettings()
		: settingsManager.getGlobalSettings();
	return [...(settings[kind] ?? [])];
}

function setTopLevelPaths(
	settingsManager: SettingsManager,
	kind: PackageResourceKind,
	project: boolean,
	paths: string[],
): void {
	if (kind === "extensions") {
		if (project) settingsManager.setProjectExtensionPaths(paths);
		else settingsManager.setExtensionPaths(paths);
		return;
	}
	if (kind === "skills") {
		if (project) settingsManager.setProjectSkillPaths(paths);
		else settingsManager.setSkillPaths(paths);
		return;
	}
	if (kind === "prompts") {
		if (project) settingsManager.setProjectPromptTemplatePaths(paths);
		else settingsManager.setPromptTemplatePaths(paths);
		return;
	}
	if (project) settingsManager.setProjectThemePaths(paths);
	else settingsManager.setThemePaths(paths);
}

export async function resolvePackageResources(
	cwd: string,
	trusted: boolean,
): Promise<PackageResourceCatalog> {
	const settingsManager = createSettingsManager(cwd, trusted);
	const resolved = await new DefaultPackageManager({
		cwd,
		agentDir: getAgentDir(),
		settingsManager,
	}).resolve(async () => "skip");
	return {
		extensions: [...resolved.extensions].sort((a, b) =>
			a.path.localeCompare(b.path),
		),
		skills: [...resolved.skills].sort((a, b) => a.path.localeCompare(b.path)),
		prompts: [...resolved.prompts].sort((a, b) => a.path.localeCompare(b.path)),
		themes: [...resolved.themes].sort((a, b) => a.path.localeCompare(b.path)),
	};
}

export async function resolveExtensions(
	cwd: string,
	trusted: boolean,
): Promise<ResolvedResource[]> {
	const resources = await resolvePackageResources(cwd, trusted);
	return resources.extensions;
}

export async function savePackageResourceChanges(
	cwd: string,
	trusted: boolean,
	changes: PackageResourceChange[],
): Promise<void> {
	if (changes.length === 0) return;
	const settingsManager = createSettingsManager(cwd, trusted);
	const topLevelPaths = new Map<string, string[]>();
	const globalPackageChanges: PackageResourceChange[] = [];
	const projectPackageChanges: PackageResourceChange[] = [];

	for (const change of changes) {
		if (
			change.kind === "extensions" &&
			isDirectFilePackage(change.resource, cwd)
		) {
			throw new Error(
				`Pi cannot apply per-extension package filters to direct file source ${change.resource.metadata.source}`,
			);
		}
		const project = change.resource.metadata.scope === "project";
		if (project && !trusted) continue;
		if (change.resource.metadata.origin === "package") {
			(project ? projectPackageChanges : globalPackageChanges).push(change);
			continue;
		}
		const key = `${project ? "project" : "global"}:${change.kind}`;
		const current =
			topLevelPaths.get(key) ??
			getTopLevelPaths(settingsManager, change.kind, project);
		topLevelPaths.set(key, updateTopLevelPaths(current, change, cwd));
	}

	for (const [key, paths] of topLevelPaths) {
		const [scope, kind] = key.split(":") as [
			"global" | "project",
			PackageResourceKind,
		];
		setTopLevelPaths(settingsManager, kind, scope === "project", paths);
	}
	if (globalPackageChanges.length > 0) {
		settingsManager.setPackages(
			applyPackageChanges(
				settingsManager.getGlobalSettings().packages ?? [],
				globalPackageChanges,
				cwd,
			),
		);
	}
	if (trusted && projectPackageChanges.length > 0) {
		settingsManager.setProjectPackages(
			applyPackageChanges(
				settingsManager.getProjectSettings().packages ?? [],
				projectPackageChanges,
				cwd,
			),
		);
	}
	await settingsManager.flush();
	const errors = settingsManager.drainErrors();
	if (errors.length > 0) {
		throw new Error(
			errors
				.map((record) => `${record.scope}: ${record.error.message}`)
				.join("; "),
		);
	}
}

export async function saveExtensionChanges(
	cwd: string,
	trusted: boolean,
	changes: ExtensionChange[],
): Promise<void> {
	await savePackageResourceChanges(
		cwd,
		trusted,
		changes.map((change) => ({ ...change, kind: "extensions" })),
	);
}
