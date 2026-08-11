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
import { countLoadedContextResources } from "./context-monitor";
import { packageKindForTab, packageResourceId } from "./resource-view-items";
import { isDirectFilePackage, savePackageResourceChanges } from "./extensions";
import { describePreset, type PresetsConfig } from "./presets";
import type {
	ManagerSnapshot,
	PackageResourceChange,
	ResourceTab,
} from "./types";

type PolicyResourceTab = "tools" | "skills" | "contexts";

interface ManagerDialogOptions {
	getSnapshot: () => ManagerSnapshot;
	prepare: (ctx: ExtensionCommandContext) => Promise<void>;
	togglePolicyResource: (
		tab: PolicyResourceTab,
		id: string,
		ctx: ExtensionCommandContext,
	) => void;
}

type ResourceTogglePlan =
	| { action: "ignore" }
	| { action: "reject"; message: string }
	| { action: "policy"; tab: PolicyResourceTab; id: string }
	| { action: "stage"; id: string; change: PackageResourceChange };

interface PlanResourceToggleOptions {
	tab: ResourceTab;
	id: string;
	snapshot: ManagerSnapshot;
	staged: Map<string, PackageResourceChange>;
	cwd: string;
}

function planResourceToggle(
	options: PlanResourceToggleOptions,
): ResourceTogglePlan {
	const { tab, id, snapshot, staged, cwd } = options;
	const packageKind = packageKindForTab(tab);
	if (packageKind) {
		const resource = snapshot[packageKind].find(
			(item) => packageResourceId(packageKind, item) === id,
		);
		if (!resource) return { action: "ignore" };
		if (
			packageKind === "extensions" &&
			resource.path.includes("pi-config-manager")
		) {
			return {
				action: "reject",
				message:
					"Pi Config Manager cannot disable itself from the active manager.",
			};
		}
		if (packageKind === "extensions" && isDirectFilePackage(resource, cwd)) {
			return {
				action: "reject",
				message:
					"Pi does not support per-extension filters for a package source that directly names one extension file.",
			};
		}
		const current = staged.get(id)?.enabled ?? resource.enabled;
		return {
			action: "stage",
			id,
			change: { kind: packageKind, resource, enabled: !current },
		};
	}
	if (tab === "tools" || tab === "skills" || tab === "contexts") {
		return { action: "policy", tab, id };
	}
	return { action: "ignore" };
}

function applyResourceTogglePlan(
	plan: ResourceTogglePlan,
	staged: Map<string, PackageResourceChange>,
	ctx: ExtensionCommandContext,
	options: ManagerDialogOptions,
): boolean {
	if (plan.action === "ignore") return false;
	if (plan.action === "reject") {
		ctx.ui.notify(plan.message, "warning");
		return false;
	}
	if (plan.action === "stage") staged.set(plan.id, plan.change);
	else options.togglePolicyResource(plan.tab, plan.id, ctx);
	return true;
}

async function saveStagedPackageResources(
	ctx: ExtensionCommandContext,
	staged: Map<string, PackageResourceChange>,
): Promise<void> {
	const confirmed = await ctx.ui.confirm(
		"Save package resource changes?",
		"Package resource changes require Pi to reload. Save and reload now?",
	);
	if (!confirmed) return;
	try {
		await savePackageResourceChanges(
			ctx.cwd,
			ctx.isProjectTrusted(),
			Array.from(staged.values()),
		);
		await ctx.reload();
	} catch (error) {
		ctx.ui.notify(
			`Could not save package resource settings: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
	}
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
	const items: SelectItem[] = [];
	for (const name of names) {
		const preset = presets[name];
		if (!preset) continue;
		items.push({
			value: name,
			label: name === activePresetName ? `${name} (active)` : name,
			description: describePreset(preset),
		});
	}
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
					const plan = planResourceToggle({
						tab,
						id,
						snapshot: options.getSnapshot(),
						staged: stagedPackageResources,
						cwd: ctx.cwd,
					});
					if (
						applyResourceTogglePlan(plan, stagedPackageResources, ctx, options)
					) {
						tui.requestRender();
					}
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
	await saveStagedPackageResources(ctx, stagedPackageResources);
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
				const contextResources = countLoadedContextResources(snapshot);
				const contextCount = snapshot.contextsKnown
					? `${contextResources.enabled}/${contextResources.total}`
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
				const second = `  tools ${snapshot.activeTools.size}/${snapshot.tools.length} · skills ${snapshot.enabledSkills.size}/${snapshot.skills.length} · contexts ${contextCount}`;
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
