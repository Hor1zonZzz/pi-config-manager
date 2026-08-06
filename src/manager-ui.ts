import {
	DynamicBorder,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { ConfigManagerView } from "./config-manager-view";
import { packageKindForTab, packageResourceId } from "./resource-view-items";
import { isDirectFilePackage, savePackageResourceChanges } from "./extensions";
import { describePreset, type PresetsConfig } from "./presets";
import type {
	ManagerSnapshot,
	PackageResourceChange,
	ResourceTab,
} from "./types";

interface ManagerDialogOptions {
	getSnapshot: () => ManagerSnapshot;
	prepare: (ctx: ExtensionCommandContext) => Promise<void>;
	togglePolicyResource: (
		tab: "tools" | "skills" | "contexts",
		id: string,
		ctx: ExtensionCommandContext,
	) => void;
}

export async function selectPreset(
	ctx: ExtensionContext,
	presets: PresetsConfig,
	activePresetName: string | undefined,
): Promise<string | null> {
	const names = Object.keys(presets);
	if (names.length === 0) {
		ctx.ui.notify(
			"No presets defined in global or project presets.json",
			"warning",
		);
		return null;
	}
	const items: SelectItem[] = names.flatMap((name) => {
		const preset = presets[name];
		return preset
			? [
					{
						value: name,
						label: name === activePresetName ? `${name} (active)` : name,
						description: describePreset(preset),
					},
				]
			: [];
	});
	items.push({
		value: "(none)",
		label: "(none)",
		description: "Clear active preset, restore defaults",
	});
	return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		container.addChild(
			new Text(theme.fg("accent", theme.bold("Select Preset"))),
		);
		const list = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(
			new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")),
		);
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

export async function openConfigManager(
	initialTab: ResourceTab,
	ctx: ExtensionCommandContext,
	options: ManagerDialogOptions,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Pi Config Manager requires TUI mode", "error");
		return;
	}
	await options.prepare(ctx);
	const stagedPackageResources = new Map<string, PackageResourceChange>();
	const action = await ctx.ui.custom<"close" | "save">(
		(tui, theme, keybindings, done) =>
			new ConfigManagerView(
				initialTab,
				options.getSnapshot,
				stagedPackageResources,
				theme,
				keybindings,
				(tab, id) => {
					const snapshot = options.getSnapshot();
					const packageKind = packageKindForTab(tab);
					if (packageKind) {
						const resource = snapshot[packageKind].find(
							(item) => packageResourceId(packageKind, item) === id,
						);
						if (!resource) return;
						if (
							packageKind === "extensions" &&
							resource.path.includes("pi-config-manager")
						) {
							ctx.ui.notify(
								"Pi Config Manager cannot disable itself from the active manager.",
								"warning",
							);
							return;
						}
						if (
							packageKind === "extensions" &&
							isDirectFilePackage(resource, ctx.cwd)
						) {
							ctx.ui.notify(
								"Pi does not support per-extension filters for a package source that directly names one extension file.",
								"warning",
							);
							return;
						}
						const current =
							stagedPackageResources.get(id)?.enabled ?? resource.enabled;
						stagedPackageResources.set(id, {
							kind: packageKind,
							resource,
							enabled: !current,
						});
					} else if (tab === "skills") {
						const unloaded = snapshot.unloadedSkills.find(
							(skill) =>
								skill.nativeResource &&
								packageResourceId("skills", skill.nativeResource) === id,
						);
						if (unloaded?.nativeResource) {
							const current = stagedPackageResources.get(id)?.enabled ?? false;
							stagedPackageResources.set(id, {
								kind: "skills",
								resource: unloaded.nativeResource,
								enabled: !current,
							});
						} else {
							options.togglePolicyResource(tab, id, ctx);
						}
					} else if (tab === "tools" || tab === "contexts") {
						options.togglePolicyResource(tab, id, ctx);
					}
					tui.requestRender();
				},
				done,
			),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "92%",
				minWidth: 72,
				maxHeight: "90%",
				margin: 1,
			},
		},
	);
	if (action !== "save" || stagedPackageResources.size === 0) return;
	const confirmed = await ctx.ui.confirm(
		"Save package resource changes?",
		"Package resource changes require Pi to reload. Save and reload now?",
	);
	if (!confirmed) return;
	try {
		await savePackageResourceChanges(
			ctx.cwd,
			ctx.isProjectTrusted(),
			Array.from(stagedPackageResources.values()),
		);
		await ctx.reload();
	} catch (error) {
		ctx.ui.notify(
			`Could not save package resource settings: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
	}
}

export function installResourceHud(
	ctx: ExtensionContext,
	getSnapshot: () => ManagerSnapshot,
	onRenderReady: (requestRender: () => void) => void,
): void {
	ctx.ui.setWidget("pi-config-manager", (tui, theme) => {
		onRenderReady(() => tui.requestRender());
		return {
			render(width: number) {
				const snapshot = getSnapshot();
				if (!snapshot.ready) {
					return [
						truncateToWidth(
							theme.fg("dim", "Resources · loading…"),
							Math.max(1, width),
						),
					];
				}
				const first = truncateToWidth(
					theme.fg("accent", theme.bold("Resources")),
					Math.max(1, width),
				);
				const contextCount = snapshot.contextsKnown
					? `${snapshot.enabledContexts.size}/${snapshot.contexts.length}`
					: "…";
				const extensionCount = snapshot.extensionsKnown
					? `${snapshot.extensions.filter((item) => item.enabled).length}/${snapshot.extensions.length}`
					: "…";
				const promptCount = snapshot.promptsKnown
					? `${snapshot.prompts.filter((item) => item.enabled).length}/${snapshot.prompts.length}`
					: "…";
				const themeCount = snapshot.themesKnown
					? `${snapshot.themes.filter((item) => item.enabled).length}/${snapshot.themes.length}`
					: "…";
				const second = `  tools ${snapshot.activeTools.size}/${snapshot.tools.length} · skills ${snapshot.enabledSkills.size}/${snapshot.skills.length}+${snapshot.unloadedSkills.length} unloaded · contexts ${contextCount}`;
				const third = `  extensions ${extensionCount} · prompts ${promptCount} · themes ${themeCount}${snapshot.presetName ? ` · preset ${snapshot.presetName}` : ""}`;
				return [
					first,
					truncateToWidth(theme.fg("muted", second), width),
					truncateToWidth(theme.fg("dim", third), width),
				];
			},
			invalidate() {},
		};
	});
}
