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
import { describePreset, type PresetsConfig } from "./presets";
import type { ToggleableResourceTab } from "./resource-policy-state";
import type { ManagerSnapshot, ResourceTab } from "./types";

interface ManagerDialogOptions {
	getSnapshot: () => ManagerSnapshot;
	prepare: () => void;
	togglePolicyResource: (
		tab: ToggleableResourceTab,
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
	options.prepare();
	await ctx.ui.custom<void>(
		(tui, theme, keybindings, done) =>
			new ConfigManagerView(
				initialTab,
				options.getSnapshot,
				theme,
				keybindings,
				(tab, id) => {
					if (tab === "overview") return;
					options.togglePolicyResource(tab, id, ctx);
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
				const second = `  tools ${snapshot.activeTools.size}/${snapshot.tools.length} · skills ${snapshot.enabledSkills.size}/${snapshot.skills.length} · contexts ${contextCount}${snapshot.presetName ? ` · preset ${snapshot.presetName}` : ""}`;
				return [
					first,
					truncateToWidth(theme.fg("muted", second), width),
				];
			},
			invalidate() {},
		};
	});
}
