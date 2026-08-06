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
import type { MonitorPayload, ViewItem } from "./context-monitor";
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

interface MonitorViewportOptions {
	item: ViewItem;
	content: string;
	headerRows: string[];
	contentRows: string[];
	highlightedRow: number;
	width: number;
	height: number;
}

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
		if (this.handlePaneNavigation(data, selectedItem)) return;
		if (this.handleVerticalNavigation(data, selectedItem, items.length)) return;
		if (this.handleResourceAction(data, items)) return;
		this.updateSearch(data);
	}

	private handlePaneNavigation(
		data: string,
		selectedItem: ViewItem | undefined,
	): boolean {
		if (this.keybindings.matches(data, "tui.editor.cursorRight")) {
			if (selectedItem?.monitor) this.activePane = "monitor";
			return true;
		}
		if (!this.keybindings.matches(data, "tui.editor.cursorLeft")) return false;
		this.activePane = "resources";
		return true;
	}

	private handleVerticalNavigation(
		data: string,
		selectedItem: ViewItem | undefined,
		itemCount: number,
	): boolean {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveVertically(-1, selectedItem, itemCount);
			return true;
		}
		if (!this.keybindings.matches(data, "tui.select.down")) return false;
		this.moveVertically(1, selectedItem, itemCount);
		return true;
	}

	private moveVertically(
		direction: -1 | 1,
		selectedItem: ViewItem | undefined,
		itemCount: number,
	): void {
		if (this.activePane === "monitor" && selectedItem?.monitor) {
			this.monitorScroll = Math.max(
				0,
				this.monitorScroll + direction * MONITOR_SCROLL_STEP,
			);
			return;
		}
		this.selected = Math.max(
			0,
			Math.min(Math.max(0, itemCount - 1), this.selected + direction),
		);
		this.monitorScroll = 0;
	}

	private handleResourceAction(data: string, items: ViewItem[]): boolean {
		const confirm =
			data === " " || this.keybindings.matches(data, "tui.select.confirm");
		if (confirm) {
			const item = items[this.selected];
			if (item?.enabled !== undefined) this.onToggle(this.tab, item.id);
			return true;
		}
		if (data !== "S" || this.stagedPackageResources.size === 0) return false;
		this.onDone("save");
		return true;
	}

	private updateSearch(data: string): void {
		const before = this.search.getValue();
		this.search.handleInput(data);
		if (before === this.search.getValue()) return;
		this.selected = 0;
		this.monitorScroll = 0;
		this.activePane = "resources";
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const snapshot = this.getSnapshot();
		const items = this.filteredItems();
		this.selected = Math.min(this.selected, Math.max(0, items.length - 1));
		const selectedItem = items[this.selected];
		if (!selectedItem?.monitor) this.activePane = "resources";
		const title = this.renderTitle(safeWidth);
		if (safeWidth < 4) return [title];

		const overlayBudget = Math.max(
			1,
			Math.floor((process.stdout.rows || 24) * 0.9) - 2,
		);
		const header = this.renderHeader(snapshot, safeWidth, title);
		if (overlayBudget < 9) {
			return this.renderSmallTerminal(header, safeWidth, overlayBudget);
		}

		const paneHeight = Math.max(3, Math.min(16, overlayBudget - 6));
		const lines = [...header];
		if (safeWidth >= 68) {
			lines.push(
				...this.renderWideLayout(items, selectedItem, safeWidth, paneHeight),
			);
		} else {
			lines.push(...this.renderCompactLayout(items, safeWidth, paneHeight));
		}
		lines.push(this.renderFooter(snapshot, safeWidth));
		return lines;
	}

	private renderTitle(width: number): string {
		return truncateToWidth(
			this.theme.fg(
				"accent",
				this.theme.bold("Pi Config Manager · Context Monitor"),
			),
			width,
		);
	}

	private renderHeader(
		snapshot: ManagerSnapshot,
		width: number,
		title: string,
	): string[] {
		const tabs = TABS.map((tab) => {
			const label = LABELS[tab];
			return tab === this.tab
				? this.theme.fg("accent", this.theme.bold(`[${label}]`))
				: this.theme.fg("muted", label);
		}).join("  ");
		const tabContent = snapshot.ready
			? tabs
			: `${tabs}  ${this.theme.fg("warning", "loading resources…")}`;
		return [
			title,
			truncateToWidth(tabContent, width),
			truncateToWidth(this.renderTargetLabel(snapshot), width),
			truncateToWidth(this.renderConstraintLabel(snapshot), width),
			truncateToWidth(`> ${this.search.getValue()}`, width, ""),
		];
	}

	private renderTargetLabel(snapshot: ManagerSnapshot): string {
		if (PACKAGE_RESOURCE_TABS.has(this.tab)) {
			return this.theme.fg("success", "View/Edit: Pi settings");
		}
		const view = this.theme.fg("accent", "View: Effective");
		if (snapshot.presetName) {
			return `${view} · ${this.theme.fg("warning", `Edit: Session · ${snapshot.presetName}`)}`;
		}
		return `${view} · ${this.theme.fg("success", "Edit: Global")}`;
	}

	private renderConstraintLabel(snapshot: ManagerSnapshot): string {
		if (PACKAGE_RESOURCE_TABS.has(this.tab)) {
			return this.theme.fg("dim", "Constraints: n/a");
		}
		const constraintIds = Array.from(
			new Set(
				Array.from(snapshot.runtimeToolControls.values()).map(
					(control) => control.layerId,
				),
			),
		);
		const projectConstrained =
			!snapshot.presetName &&
			(snapshot.projectDisabledTools.size > 0 ||
				snapshot.projectDisabledSkills.size > 0 ||
				snapshot.projectDisabledContexts.size > 0);
		if (projectConstrained) constraintIds.push("project settings");
		if (constraintIds.length === 0) {
			return this.theme.fg("dim", "Constraints: none");
		}
		return this.theme.fg("warning", `Constraints: ${constraintIds.join(", ")}`);
	}

	private renderSmallTerminal(
		header: string[],
		width: number,
		overlayBudget: number,
	): string[] {
		return [
			...header,
			truncateToWidth(
				this.theme.fg("warning", "Terminal too small for Context Monitor"),
				width,
				"",
			),
		].slice(0, overlayBudget);
	}

	private renderWideLayout(
		items: ViewItem[],
		selectedItem: ViewItem | undefined,
		width: number,
		paneHeight: number,
	): string[] {
		const leftWidth = Math.max(24, Math.floor(width * 0.34));
		const rightWidth = Math.max(4, width - leftWidth - 1);
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
		const lines: string[] = [];
		for (let index = 0; index < paneHeight; index += 1) {
			lines.push(
				`${padToWidth(left[index] ?? "", leftWidth)} ${right[index] ?? ""}`,
			);
		}
		return lines;
	}

	private renderCompactLayout(
		items: ViewItem[],
		width: number,
		paneHeight: number,
	): string[] {
		return renderPane(
			"Resources · widen terminal for monitor",
			this.renderResourceRows(items, paneHeight - 2),
			width,
			paneHeight,
			this.theme,
		);
	}

	private renderFooter(snapshot: ManagerSnapshot, width: number): string {
		const canSave =
			PACKAGE_RESOURCE_TABS.has(this.tab) ||
			(this.tab === "skills" && snapshot.unloadedSkills.length > 0);
		const saveHint = canSave ? " · S save + reload" : "";
		return truncateToWidth(
			this.theme.fg(
				"dim",
				`Type search · Tab tabs · ←/→ panes · ↑/↓ move or scroll · Space toggle${saveHint} · Esc close`,
			),
			width,
		);
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
			let check = "  ";
			if (item.enabled === true) check = this.theme.fg("success", "● ");
			if (item.enabled === false) check = this.theme.fg("dim", "○ ");
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
		const safeWidth = Math.max(1, width);
		const headerRows = this.buildMonitorHeaderRows(
			item,
			item.monitor,
			safeWidth,
		);
		const content = this.buildMonitorContentRows(item.monitor, safeWidth);
		return this.renderMonitorViewport({
			item,
			content: item.monitor.content,
			headerRows,
			contentRows: content.rows,
			highlightedRow: content.highlightedRow,
			width: safeWidth,
			height,
		});
	}

	private buildMonitorHeaderRows(
		item: ViewItem,
		monitor: MonitorPayload,
		width: number,
	): string[] {
		const rows: string[] = [];
		const add = (line: string) => {
			rows.push(...wrapTextWithAnsi(line, width));
		};
		let statusIcon = "○";
		if (monitor.statusColor === "success") statusIcon = "●";
		if (monitor.statusColor === "error") statusIcon = "!";
		add(this.theme.fg(monitor.statusColor, ` ${statusIcon} ${monitor.status}`));
		add(this.theme.fg("dim", ` channel: ${monitor.channel}`));
		add(this.theme.fg("dim", ` source: ${item.detail.replace(/\n/g, " · ")}`));
		if (monitor.note) add(this.theme.fg("warning", ` note: ${monitor.note}`));
		const targetMissing =
			monitor.highlightTarget &&
			!promptContainsTarget(monitor.content, monitor.highlightTarget);
		if (targetMissing && monitor.presenceExpected !== false) {
			add(
				this.theme.fg(
					"warning",
					" selected resource was not found in this captured system prompt",
				),
			);
		}
		rows.push("");
		return rows;
	}

	private buildMonitorContentRows(
		monitor: MonitorPayload,
		width: number,
	): { rows: string[]; highlightedRow: number } {
		const highlightedLines = monitor.highlightTarget
			? getHighlightedLineIndexes(monitor.content, monitor.highlightTarget)
			: new Set<number>();
		const rows: string[] = [];
		let highlightedRow = -1;
		for (const [lineIndex, rawLine] of monitor.content.split("\n").entries()) {
			const highlighted = rawLine.length > 0 && highlightedLines.has(lineIndex);
			if (highlighted && highlightedRow < 0) highlightedRow = rows.length;
			let styled = "";
			if (rawLine) styled = this.theme.fg("accent", ` ${rawLine}`);
			if (rawLine && highlighted) {
				styled = this.theme.bg(
					"selectedBg",
					this.theme.fg("text", ` ${rawLine}`),
				);
			}
			rows.push(...wrapTextWithAnsi(styled, width));
		}
		return { rows, highlightedRow };
	}

	private renderMonitorViewport(options: MonitorViewportOptions): string[] {
		const { item, content, headerRows, contentRows, highlightedRow } = options;
		if (headerRows.length >= options.height) {
			return headerRows.slice(0, options.height);
		}
		let viewportHeight = Math.max(1, options.height - headerRows.length);
		let maxScroll = Math.max(0, contentRows.length - viewportHeight);
		if (maxScroll > 0) {
			viewportHeight = Math.max(1, viewportHeight - 1);
			maxScroll = Math.max(0, contentRows.length - viewportHeight);
		}
		if (this.monitorItemId !== item.id || this.monitorContent !== content) {
			this.monitorItemId = item.id;
			this.monitorContent = content;
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
					options.width,
					"",
				),
			);
		}
		return visible.slice(0, options.height);
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
