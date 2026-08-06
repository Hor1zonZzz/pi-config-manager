import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	type KeybindingsManager,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ViewItem } from "./context-monitor";
import {
	getHighlightedLineIndexes,
	promptContainsTarget,
} from "./prompt-highlighting";
import { buildResourceViewItems } from "./resource-view-items";
import type {
	ManagerSnapshot,
	PackageResourceChange,
	ResourceTab,
} from "./types";

const MONITOR_SCROLL_STEP = 3;
const TABS: ResourceTab[] = [
	"overview",
	"tools",
	"skills",
	"contexts",
	"prompts",
	"themes",
	"extensions",
];
const LABELS: Record<ResourceTab, string> = {
	overview: "Overview",
	tools: "Tools",
	skills: "Skills",
	contexts: "Contexts",
	prompts: "Prompt Templates",
	themes: "Themes",
	extensions: "Extensions",
};
const PACKAGE_RESOURCE_TABS = new Set<ResourceTab>([
	"prompts",
	"themes",
	"extensions",
]);

function padToWidth(text: string, width: number): string {
	const fitted = truncateToWidth(text, Math.max(1, width), "");
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function renderPane(
	title: string,
	content: string[],
	width: number,
	height: number,
	theme: Theme,
	accentBorder = false,
): string[] {
	const safeWidth = Math.max(4, width);
	const safeHeight = Math.max(3, height);
	const innerWidth = safeWidth - 2;
	const borderColor = accentBorder ? "borderAccent" : "borderMuted";
	const border = (text: string) => theme.fg(borderColor, text);
	const titleText = truncateToWidth(` ${title} `, innerWidth, "");
	const topFill = "─".repeat(Math.max(0, innerWidth - visibleWidth(titleText)));
	const lines = [
		`${border("╭")}${theme.fg(accentBorder ? "accent" : "muted", titleText)}${border(`${topFill}╮`)}`,
	];
	for (let index = 0; index < safeHeight - 2; index += 1) {
		lines.push(
			`${border("│")}${padToWidth(content[index] ?? "", innerWidth)}${border("│")}`,
		);
	}
	lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
	return lines;
}

export class ConfigManagerView implements Component, Focusable {
	private readonly search = new Input();
	private tab: ResourceTab;
	private selected = 0;
	private monitorScroll = 0;
	private monitorItemId?: string;
	private monitorContent?: string;
	private activePane: "resources" | "monitor" = "resources";
	private _focused = false;

	constructor(
		initialTab: ResourceTab,
		private readonly getSnapshot: () => ManagerSnapshot,
		private readonly stagedPackageResources: Map<string, PackageResourceChange>,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly onToggle: (tab: ResourceTab, id: string) => void,
		private readonly onDone: (action: "close" | "save") => void,
	) {
		this.tab = initialTab;
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.search.focused = value;
	}

	invalidate(): void {
		this.search.invalidate();
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onDone("close");
			return;
		}
		if (this.keybindings.matches(data, "tui.input.tab")) {
			this.changeTab(1);
			return;
		}
		const items = this.filteredItems();
		const selectedItem = items[this.selected];
		if (this.keybindings.matches(data, "tui.editor.cursorRight")) {
			if (selectedItem?.monitor) this.activePane = "monitor";
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorLeft")) {
			this.activePane = "resources";
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			if (this.activePane === "monitor" && selectedItem?.monitor) {
				this.monitorScroll = Math.max(
					0,
					this.monitorScroll - MONITOR_SCROLL_STEP,
				);
				return;
			}
			this.selected = Math.max(0, this.selected - 1);
			this.monitorScroll = 0;
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			if (this.activePane === "monitor" && selectedItem?.monitor) {
				this.monitorScroll += MONITOR_SCROLL_STEP;
				return;
			}
			this.selected = Math.min(
				Math.max(0, items.length - 1),
				this.selected + 1,
			);
			this.monitorScroll = 0;
			return;
		}
		if (data === " " || this.keybindings.matches(data, "tui.select.confirm")) {
			const item = items[this.selected];
			if (item?.enabled !== undefined) this.onToggle(this.tab, item.id);
			return;
		}
		if (data === "S" && this.stagedPackageResources.size > 0) {
			this.onDone("save");
			return;
		}
		const before = this.search.getValue();
		this.search.handleInput(data);
		if (before !== this.search.getValue()) {
			this.selected = 0;
			this.monitorScroll = 0;
			this.activePane = "resources";
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const snapshot = this.getSnapshot();
		const items = this.filteredItems();
		this.selected = Math.min(this.selected, Math.max(0, items.length - 1));
		const selectedItem = items[this.selected];
		if (!selectedItem?.monitor) this.activePane = "resources";
		const terminalRows = process.stdout.rows || 24;
		const overlayBudget = Math.max(1, Math.floor(terminalRows * 0.9) - 2);
		const paneHeight = Math.max(3, Math.min(16, overlayBudget - 6));
		const tabs = TABS.map((tab) => {
			const label = LABELS[tab];
			return tab === this.tab
				? this.theme.fg("accent", this.theme.bold(`[${label}]`))
				: this.theme.fg("muted", label);
		}).join("  ");
		const title = truncateToWidth(
			this.theme.fg(
				"accent",
				this.theme.bold("Pi Config Manager · Context Monitor"),
			),
			safeWidth,
		);
		if (safeWidth < 4) return [title];
		let targetLabel: string;
		if (PACKAGE_RESOURCE_TABS.has(this.tab)) {
			targetLabel = this.theme.fg("success", "View/Edit: Pi settings");
		} else if (snapshot.presetName) {
			targetLabel = `${this.theme.fg("accent", "View: Effective")} · ${this.theme.fg("warning", `Edit: Session · ${snapshot.presetName}`)}`;
		} else {
			targetLabel = `${this.theme.fg("accent", "View: Effective")} · ${this.theme.fg("success", "Edit: Global")}`;
		}
		const constraintIds = Array.from(
			new Set(
				Array.from(snapshot.runtimeToolControls.values()).map(
					(control) => control.layerId,
				),
			),
		);
		if (
			!snapshot.presetName &&
			(snapshot.projectDisabledTools.size > 0 ||
				snapshot.projectDisabledSkills.size > 0 ||
				snapshot.projectDisabledContexts.size > 0)
		) {
			constraintIds.push("project settings");
		}
		const tabLine = truncateToWidth(
			snapshot.ready
				? tabs
				: `${tabs}  ${this.theme.fg("warning", "loading resources…")}`,
			safeWidth,
		);
		const targetLine = truncateToWidth(targetLabel, safeWidth);
		const constraintLine = truncateToWidth(
			PACKAGE_RESOURCE_TABS.has(this.tab)
				? this.theme.fg("dim", "Constraints: n/a")
				: constraintIds.length > 0
					? this.theme.fg("warning", `Constraints: ${constraintIds.join(", ")}`)
					: this.theme.fg("dim", "Constraints: none"),
			safeWidth,
		);
		if (overlayBudget < 9) {
			return [
				title,
				tabLine,
				targetLine,
				constraintLine,
				truncateToWidth(`> ${this.search.getValue()}`, safeWidth, ""),
				truncateToWidth(
					this.theme.fg("warning", "Terminal too small for Context Monitor"),
					safeWidth,
					"",
				),
			].slice(0, overlayBudget);
		}
		const lines = [
			title,
			tabLine,
			targetLine,
			constraintLine,
			truncateToWidth(`> ${this.search.getValue()}`, safeWidth, ""),
		];

		if (safeWidth >= 68) {
			const leftWidth = Math.max(24, Math.floor(safeWidth * 0.34));
			const rightWidth = Math.max(4, safeWidth - leftWidth - 1);
			const left = renderPane(
				"Resources",
				this.renderResourceRows(items, paneHeight - 2),
				leftWidth,
				paneHeight,
				this.theme,
				this.activePane === "resources",
			);
			const right = renderPane(
				selectedItem?.monitor?.title ?? "Details",
				this.renderMonitorRows(selectedItem, rightWidth - 2, paneHeight - 2),
				rightWidth,
				paneHeight,
				this.theme,
				this.activePane === "monitor" && Boolean(selectedItem?.monitor),
			);
			for (let index = 0; index < paneHeight; index += 1) {
				lines.push(
					`${padToWidth(left[index] ?? "", leftWidth)} ${right[index] ?? ""}`,
				);
			}
		} else {
			lines.push(
				...renderPane(
					"Resources · widen terminal for monitor",
					this.renderResourceRows(items, paneHeight - 2),
					safeWidth,
					paneHeight,
					this.theme,
				),
			);
		}

		const saveHint =
			PACKAGE_RESOURCE_TABS.has(this.tab) ||
			(this.tab === "skills" && snapshot.unloadedSkills.length > 0)
				? " · S save + reload"
				: "";
		lines.push(
			truncateToWidth(
				this.theme.fg(
					"dim",
					`Type search · Tab tabs · ←/→ panes · ↑/↓ move or scroll · Space toggle${saveHint} · Esc close`,
				),
				safeWidth,
			),
		);
		return lines;
	}

	private renderResourceRows(items: ViewItem[], height: number): string[] {
		if (items.length === 0)
			return [this.theme.fg("muted", "  No matching resources")];
		const start = Math.max(
			0,
			Math.min(this.selected - Math.floor(height / 2), items.length - height),
		);
		return items.slice(start, start + height).map((item, offset) => {
			const index = start + offset;
			const cursor =
				index === this.selected ? this.theme.fg("accent", "> ") : "  ";
			const check =
				item.enabled === undefined
					? "  "
					: item.enabled
						? this.theme.fg("success", "● ")
						: this.theme.fg("dim", "○ ");
			const lock = item.locked ? this.theme.fg("warning", "🔒 ") : "";
			const pending = this.stagedPackageResources.has(item.id)
				? this.theme.fg("warning", " staged")
				: "";
			return `${cursor}${check}${lock}${item.label}${this.theme.fg("dim", `  ${item.state}`)}${pending}`;
		});
	}

	private renderMonitorRows(
		item: ViewItem | undefined,
		width: number,
		height: number,
	): string[] {
		if (!item) return [this.theme.fg("muted", " No resource selected")];
		if (!item.monitor) {
			return item.detail
				.split("\n")
				.flatMap((line) =>
					wrapTextWithAnsi(this.theme.fg("dim", ` ${line}`), width),
				);
		}

		const monitor = item.monitor;
		const safeWidth = Math.max(1, width);
		const headerRows: string[] = [];
		const contentRows: string[] = [];
		const highlightedLines = monitor.highlightTarget
			? getHighlightedLineIndexes(monitor.content, monitor.highlightTarget)
			: new Set<number>();
		const hasHighlight =
			!monitor.highlightTarget ||
			promptContainsTarget(monitor.content, monitor.highlightTarget);
		let statusIcon = "○";
		if (monitor.statusColor === "success") statusIcon = "●";
		else if (monitor.statusColor === "error") statusIcon = "!";
		const addHeader = (line: string) => {
			headerRows.push(...wrapTextWithAnsi(line, safeWidth));
		};
		addHeader(
			this.theme.fg(monitor.statusColor, ` ${statusIcon} ${monitor.status}`),
		);
		addHeader(this.theme.fg("dim", ` channel: ${monitor.channel}`));
		addHeader(
			this.theme.fg("dim", ` source: ${item.detail.replace(/\n/g, " · ")}`),
		);
		if (monitor.note) {
			addHeader(this.theme.fg("warning", ` note: ${monitor.note}`));
		}
		if (!hasHighlight && monitor.presenceExpected !== false) {
			addHeader(
				this.theme.fg(
					"warning",
					" selected resource was not found in this captured system prompt",
				),
			);
		}
		headerRows.push("");

		let highlightedRow = -1;
		for (const [lineIndex, rawLine] of monitor.content.split("\n").entries()) {
			const highlighted = rawLine.length > 0 && highlightedLines.has(lineIndex);
			if (highlighted && highlightedRow < 0) {
				highlightedRow = contentRows.length;
			}
			const styled = rawLine
				? highlighted
					? this.theme.bg("selectedBg", this.theme.fg("text", ` ${rawLine}`))
					: this.theme.fg("accent", ` ${rawLine}`)
				: "";
			contentRows.push(...wrapTextWithAnsi(styled, safeWidth));
		}

		if (headerRows.length >= height) return headerRows.slice(0, height);
		let viewportHeight = Math.max(1, height - headerRows.length);
		let maxScroll = Math.max(0, contentRows.length - viewportHeight);
		if (maxScroll > 0) {
			viewportHeight = Math.max(1, viewportHeight - 1);
			maxScroll = Math.max(0, contentRows.length - viewportHeight);
		}
		if (
			this.monitorItemId !== item.id ||
			this.monitorContent !== monitor.content
		) {
			this.monitorItemId = item.id;
			this.monitorContent = monitor.content;
			this.monitorScroll = Math.max(
				0,
				highlightedRow - Math.floor(viewportHeight / 2),
			);
		}
		this.monitorScroll = Math.min(this.monitorScroll, maxScroll);
		const visible = [
			...headerRows,
			...contentRows.slice(
				this.monitorScroll,
				this.monitorScroll + viewportHeight,
			),
		];
		if (maxScroll > 0) {
			visible.push(
				truncateToWidth(
					this.theme.fg(
						"dim",
						` ↑/↓ · ${this.monitorScroll + 1}-${Math.min(contentRows.length, this.monitorScroll + viewportHeight)}/${contentRows.length}`,
					),
					safeWidth,
					"",
				),
			);
		}
		return visible.slice(0, height);
	}

	private allItems(): ViewItem[] {
		return buildResourceViewItems(
			this.tab,
			this.getSnapshot(),
			this.stagedPackageResources,
		);
	}

	private filteredItems(): ViewItem[] {
		const query = this.search.getValue().trim().toLowerCase();
		const items = this.allItems();
		return query
			? items.filter((item) =>
					`${item.label} ${item.state} ${item.detail}`
						.toLowerCase()
						.includes(query),
				)
			: items;
	}

	private changeTab(offset: number): void {
		const index = TABS.indexOf(this.tab);
		this.tab = TABS[(index + offset + TABS.length) % TABS.length] ?? "overview";
		this.selected = 0;
		this.monitorScroll = 0;
		this.activePane = "resources";
	}
}
