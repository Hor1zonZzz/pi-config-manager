import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
	CONFIG_DIR_NAME,
	DefaultPackageManager,
	getAgentDir,
	SettingsManager,
	type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionChange } from "./types";

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

function extensionPattern(resource: ResolvedResource, cwd: string): string {
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

function packageSource(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	if (
		entry &&
		typeof entry === "object" &&
		typeof (entry as { source?: unknown }).source === "string"
	) {
		return (entry as { source: string }).source;
	}
	return undefined;
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
		extensionPattern(resource, cwd),
		normalizePattern(resource.path),
		normalizePattern(relative(scopeBase, resource.path)),
	]);
}

function replaceExtensionOverride(
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
	change: ExtensionChange,
	cwd: string,
): string[] {
	return replaceExtensionOverride(
		paths,
		equivalentPatterns(change.resource, cwd),
		`${change.enabled ? "+" : "-"}${extensionPattern(change.resource, cwd)}`,
	);
}

function applyPackageChanges(
	packages: unknown[],
	changes: ExtensionChange[],
	cwd: string,
): unknown[] {
	const updatedPackages = [...packages];
	for (const change of changes) {
		const source = change.resource.metadata.source;
		const packageIndex = updatedPackages.findIndex(
			(entry) => packageSource(entry) === source,
		);
		if (packageIndex < 0) continue;
		const currentEntry = updatedPackages[packageIndex];
		const packageEntry =
			typeof currentEntry === "string"
				? { source: currentEntry }
				: { ...(currentEntry as object) };
		const current = (packageEntry as { extensions?: string[] }).extensions;
		const pattern = extensionPattern(change.resource, cwd);
		const aliases = equivalentPatterns(change.resource, cwd);

		if (
			current?.length === 0 &&
			(packageEntry as { autoload?: boolean }).autoload !== false
		) {
			if (change.enabled)
				(packageEntry as { extensions?: string[] }).extensions = [pattern];
		} else {
			(packageEntry as { extensions?: string[] }).extensions =
				replaceExtensionOverride(
					current ?? [],
					aliases,
					`${change.enabled ? "+" : "-"}${pattern}`,
				);
		}
		updatedPackages[packageIndex] = packageEntry;
	}
	return updatedPackages;
}

export async function resolveExtensions(
	cwd: string,
	trusted: boolean,
): Promise<ResolvedResource[]> {
	const settingsManager = createSettingsManager(cwd, trusted);
	const resolved = await new DefaultPackageManager({
		cwd,
		agentDir: getAgentDir(),
		settingsManager,
	}).resolve(async () => "skip");
	return resolved.extensions.sort((a, b) => a.path.localeCompare(b.path));
}

export async function saveExtensionChanges(
	cwd: string,
	trusted: boolean,
	changes: ExtensionChange[],
): Promise<void> {
	if (changes.length === 0) return;
	const settingsManager = createSettingsManager(cwd, trusted);
	let globalPaths = [...(settingsManager.getGlobalSettings().extensions ?? [])];
	let projectPaths = [
		...(settingsManager.getProjectSettings().extensions ?? []),
	];
	let globalPathsChanged = false;
	let projectPathsChanged = false;
	const globalPackageChanges: ExtensionChange[] = [];
	const projectPackageChanges: ExtensionChange[] = [];

	for (const change of changes) {
		if (isDirectFilePackage(change.resource, cwd)) {
			throw new Error(
				`Pi cannot apply per-extension package filters to direct file source ${change.resource.metadata.source}`,
			);
		}
		const project = change.resource.metadata.scope === "project";
		if (project && !trusted) continue;
		if (change.resource.metadata.origin === "package") {
			(project ? projectPackageChanges : globalPackageChanges).push(change);
		} else if (project) {
			projectPaths = updateTopLevelPaths(projectPaths, change, cwd);
			projectPathsChanged = true;
		} else {
			globalPaths = updateTopLevelPaths(globalPaths, change, cwd);
			globalPathsChanged = true;
		}
	}

	if (globalPathsChanged) settingsManager.setExtensionPaths(globalPaths);
	if (trusted && projectPathsChanged)
		settingsManager.setProjectExtensionPaths(projectPaths);
	if (globalPackageChanges.length > 0) {
		settingsManager.setPackages(
			applyPackageChanges(
				settingsManager.getGlobalSettings().packages ?? [],
				globalPackageChanges,
				cwd,
			) as any,
		);
	}
	if (trusted && projectPackageChanges.length > 0) {
		settingsManager.setProjectPackages(
			applyPackageChanges(
				settingsManager.getProjectSettings().packages ?? [],
				projectPackageChanges,
				cwd,
			) as any,
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
