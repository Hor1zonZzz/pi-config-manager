import { basename, dirname } from "node:path";
import {
	DynamicBorder,
	formatSkillsForPrompt,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Skill,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	type Focusable,
	Input,
	Key,
	type KeybindingsManager,
	type SelectItem,
	SelectList,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	isDirectFilePackage,
	resolveExtensions,
	saveExtensionChanges,
} from "./extensions";
import { PolicyManager } from "./policy-manager";
import {
	installPresetEditor,
	type PresetBorderEditor,
} from "./preset-editor";
import {
	describePreset,
	loadPresets,
	type Preset,
	type PresetsConfig,
} from "./presets";
import {
	cloneSessionState,
	loadGlobalSettings,
	loadProjectSettings,
	normalizeSessionState,
	saveGlobalSettings,
} from "./storage";
import {
	DEFAULT_SESSION_STATE,
	type ContextRecord,
	type ExtensionChange,
	type ManagerSnapshot,
	type PresetOriginalState,
	type ResourceSettings,
	type ResourceTab,
	type RuntimeLayer,
	type SessionResourceState,
	type SkillRecord,
	type ToolRecord,
} from "./types";

const SESSION_ENTRY = "pi-config-manager-state";
const MONITOR_SCROLL_STEP = 3;
const TABS: ResourceTab[] = [
	"overview",
	"tools",
	"skills",
	"contexts",
	"extensions",
];
const LABELS: Record<ResourceTab, string> = {
	overview: "Overview",
	tools: "Tools",
	skills: "Skills",
	contexts: "Contexts",
	extensions: "Extensions",
};

interface MonitorPayload {
	title: string;
	channel: string;
	status: string;
	statusColor: "success" | "warning" | "dim";
	content: string;
	highlights?: string[];
	note?: string;
}

interface ViewItem {
	id: string;
	label: string;
	enabled?: boolean;
	state: string;
	detail: string;
	monitor?: MonitorPayload;
}

type ToggleableResourceTab = "tools" | "skills" | "contexts";
type PolicyPhase = "collecting" | "initializing" | "ready" | "stopped";

function isResourceEnabled(
	snapshot: ManagerSnapshot,
	tab: ToggleableResourceTab,
	id: string,
): boolean {
	if (tab === "tools") return snapshot.activeTools.has(id);
	if (tab === "skills") return snapshot.enabledSkills.has(id);
	return snapshot.enabledContexts.has(id);
}

function unique(values: Iterable<string>): string[] {
	return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function formatContextSection(files: ContextRecord[]): string {
	if (files.length === 0) return "";
	let result =
		"\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
	for (const file of files) {
		result += `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
	}
	return `${result}</project_context>\n`;
}

function sourceDetail(sourceInfo: ToolRecord["sourceInfo"]): string {
	if (!sourceInfo) return "unknown source";
	return `${sourceInfo.scope ?? "unknown"} · ${sourceInfo.source ?? "unknown"} · ${sourceInfo.path ?? "unknown path"}`;
}

function stringifyJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return "[schema could not be serialized]";
	}
}

function padToWidth(text: string, width: number): string {
	const fitted = truncateToWidth(text, Math.max(1, width), "");
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function showCapturedSystemPrompt(
	snapshot: ManagerSnapshot,
	monitor: MonitorPayload,
	showFullPrompt: boolean,
): MonitorPayload {
	const captured = snapshot.effectiveSystemPrompt;
	if (!showFullPrompt || !captured) return monitor;
	const isAgentPrompt = captured.source === "agent-start";
	return {
		...monitor,
		title: `${isAgentPrompt ? "Effective Prompt" : "Prompt Preview"} · ${monitor.title}`,
		channel: isAgentPrompt
			? "effective Pi system prompt"
			: "current Pi system prompt preview",
		status: isAgentPrompt
			? "captured after the latest agent start"
			: "captured before an agent run",
		statusColor: "success",
		content: captured.content,
		note: [
			monitor.status,
			isAgentPrompt
				? "This cached prompt reflects the latest agent run; current policy changes appear after the next run."
				: "This preview has not passed through this turn's before_agent_start handlers.",
			monitor.note,
		]
			.filter(Boolean)
			.join(" "),
	};
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

class ConfigManagerView implements Component, Focusable {
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
		private readonly stagedExtensions: Map<string, ExtensionChange>,
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
		if (data === "S" && this.tab === "extensions") {
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
		const paneHeight = Math.max(3, Math.min(16, overlayBudget - 4));
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
		const scopeLabel =
			this.tab === "extensions"
				? this.theme.fg("success", "Target: Pi settings")
				: snapshot.presetName
					? this.theme.fg(
							"warning",
							`Target: Session · ${snapshot.presetName}`,
						)
					: this.theme.fg("success", "Target: Global");
		const tabLine = truncateToWidth(
			`${snapshot.ready ? tabs : `${tabs}  ${this.theme.fg("warning", "loading resources…")}`}  ·  ${scopeLabel}`,
			safeWidth,
		);
		if (overlayBudget < 7) {
			return [
				title,
				tabLine,
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

		const saveHint = this.tab === "extensions" ? " · S save + reload" : "";
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
			const pending =
				this.tab === "extensions" && this.stagedExtensions.has(item.id)
					? this.theme.fg("warning", " staged")
					: "";
			return `${cursor}${check}${item.label}${this.theme.fg("dim", `  ${item.state}`)}${pending}`;
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
		const rows: string[] = [];
		const highlights = monitor.highlights ?? [];
		const hasHighlight =
			highlights.length === 0 ||
			highlights.some((highlight) => monitor.content.includes(highlight));
		let highlightedRow = -1;
		const addWrapped = (line: string) => {
			rows.push(...wrapTextWithAnsi(line, safeWidth));
		};
		addWrapped(
			this.theme.fg(
				monitor.statusColor,
				` ${monitor.statusColor === "success" ? "●" : "○"} ${monitor.status}`,
			),
		);
		addWrapped(this.theme.fg("dim", ` channel: ${monitor.channel}`));
		addWrapped(
			this.theme.fg("dim", ` source: ${item.detail.replace(/\n/g, " · ")}`),
		);
		if (monitor.note) {
			addWrapped(this.theme.fg("warning", ` note: ${monitor.note}`));
		}
		if (!hasHighlight) {
			addWrapped(
				this.theme.fg(
					"warning",
					" selected resource was not found in this captured system prompt",
				),
			);
		}
		rows.push("");
		for (const rawLine of monitor.content.split("\n")) {
			const highlighted = Boolean(
				rawLine && highlights.some((highlight) => rawLine.includes(highlight)),
			);
			if (highlighted && highlightedRow < 0) highlightedRow = rows.length;
			const styled = rawLine
				? highlighted
					? this.theme.bg("selectedBg", this.theme.fg("text", ` ${rawLine}`))
					: this.theme.fg("accent", ` ${rawLine}`)
				: "";
			addWrapped(styled);
		}

		const viewportHeight = Math.max(1, height - (rows.length > height ? 1 : 0));
		const maxScroll = Math.max(0, rows.length - viewportHeight);
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
		const visible = rows.slice(
			this.monitorScroll,
			this.monitorScroll + viewportHeight,
		);
		if (maxScroll > 0) {
			visible.push(
				truncateToWidth(
					this.theme.fg(
						"dim",
						` ↑/↓ · ${this.monitorScroll + 1}-${Math.min(rows.length, this.monitorScroll + viewportHeight)}/${rows.length}`,
					),
					safeWidth,
					"",
				),
			);
		}
		return visible;
	}

	private allItems(): ViewItem[] {
		const snapshot = this.getSnapshot();
		if (this.tab === "overview") {
			return [
				{
					id: "tools",
					label: "Tools",
					state: `${snapshot.activeTools.size}/${snapshot.tools.length}`,
					detail: "Pi-discovered tools and their effective active state.",
				},
				{
					id: "skills",
					label: "Skills",
					state: `${snapshot.enabledSkills.size}/${snapshot.skills.length}`,
					detail:
						"Pi-loaded skills enabled by manager policy. Catalog visibility also depends on read and manual-only metadata.",
				},
				{
					id: "contexts",
					label: "Contexts",
					state: snapshot.contextsKnown
						? `${snapshot.enabledContexts.size}/${snapshot.contexts.length}`
						: "loading",
					detail: "Pi-loaded context files exposed to the model.",
				},
				{
					id: "extensions",
					label: "Extensions",
					state: snapshot.extensionsKnown
						? `${snapshot.extensions.filter((item) => item.enabled).length}/${snapshot.extensions.length}`
						: "loading",
					detail: "Pi-resolved extension resources. Changes require reload.",
				},
			];
		}
		if (this.tab === "tools")
			return snapshot.tools.map((tool) => {
				const active = snapshot.activeTools.has(tool.name);
				const systemPromptVisible = active && !snapshot.customPromptActive;
				return {
					id: tool.name,
					label: tool.name,
					enabled: active,
					state: active ? "active" : "inactive",
					detail: sourceDetail(tool.sourceInfo),
					monitor: showCapturedSystemPrompt(
						snapshot,
						{
							title: `Tool · ${tool.name}`,
							channel: "provider tools payload",
							status: active
								? "active · definition expected on the next provider request"
								: "inactive · definition excluded by current policy",
							statusColor: active ? "success" : "dim",
							note: !active
								? "Pi does not expose an inactive tool's promptSnippet."
								: snapshot.customPromptActive &&
										(tool.promptSnippet || tool.promptGuidelines?.length)
									? "A custom system prompt is active, so Pi omits this tool's prompt snippet and guidelines."
									: undefined,
							content: [
								"Pi tool definition (provider serialization may vary):",
								stringifyJson({
									name: tool.name,
									description: tool.description,
									parameters: tool.parameters,
								}),
								...(active && tool.promptSnippet
									? [
											"",
											systemPromptVisible
												? "System prompt Available tools entry:"
												: "Prompt snippet:",
											`- ${tool.name}: ${tool.promptSnippet}`,
										]
									: []),
								...(!active
									? ["", "Prompt snippet: unavailable while inactive"]
									: []),
								...(tool.promptGuidelines?.length
									? [
											"",
											active && systemPromptVisible
												? "System prompt guidelines:"
												: active
													? "Prompt guidelines:"
													: "Declared prompt guidelines (inactive):",
											...tool.promptGuidelines.map((line) => `- ${line}`),
										]
									: []),
							].join("\n"),
							highlights: systemPromptVisible
								? [
										...(tool.promptSnippet
											? [`- ${tool.name}: ${tool.promptSnippet}`]
											: []),
										...(tool.promptGuidelines ?? [])
											.map((line) => line.trim())
											.filter(Boolean)
											.map((line) => `- ${line}`),
									]
								: undefined,
						},
						active,
					),
				};
			});
		if (this.tab === "skills")
			return snapshot.skills.map((skill) => {
				const enabled = snapshot.enabledSkills.has(skill.name);
				const readAvailable = snapshot.activeTools.has("read");
				const catalogVisible =
					enabled && readAvailable && !skill.disableModelInvocation;
				const status = !enabled
					? "disabled by current policy"
					: skill.disableModelInvocation
						? "manual invocation only · omitted from the skill catalog"
						: !readAvailable
							? "enabled, but read is inactive · catalog omitted"
							: "enabled · expected in the next base system prompt";
				return {
					id: skill.name,
					label: skill.name,
					enabled,
					state: enabled ? "enabled" : "disabled",
					detail: skill.path,
					monitor: showCapturedSystemPrompt(
						snapshot,
						{
							title: `Skill · ${skill.name}`,
							channel: "system prompt skill catalog",
							status,
							statusColor: catalogVisible ? "success" : "warning",
							note: "This previews Pi's base prompt; later extension prompt rewrites can still differ.",
							content: formatSkillsForPrompt([
								{
									name: skill.name,
									description: skill.description,
									filePath: skill.path,
									baseDir: dirname(skill.path),
									sourceInfo: {
										path: skill.path,
										source: "pi-config-manager-preview",
										scope: "temporary",
										origin: "top-level",
									},
									disableModelInvocation: false,
								} satisfies Skill,
							]).trim(),
							highlights: [skill.name],
						},
						catalogVisible,
					),
				};
			});
		if (this.tab === "contexts")
			return snapshot.contexts.map((context) => {
				const enabled = snapshot.enabledContexts.has(context.path);
				return {
					id: context.path,
					label: basename(context.path),
					enabled,
					state: enabled ? "enabled" : "disabled",
					detail: context.path,
					monitor: showCapturedSystemPrompt(
						snapshot,
						{
							title: `Context · ${basename(context.path)}`,
							channel: "system prompt project_context section",
							status: enabled
								? "enabled · expected in the next base system prompt"
								: "disabled by current policy",
							statusColor: enabled ? "success" : "warning",
							note: "This previews Pi's base prompt; later extension prompt rewrites can still differ.",
							content: formatContextSection([context]).trim(),
							highlights: [`<project_instructions path="${context.path}">`],
						},
						enabled,
					),
				};
			});
		return snapshot.extensions.map((extension) => {
			const staged = this.stagedExtensions.get(extension.path);
			const enabled = staged?.enabled ?? extension.enabled;
			return {
				id: extension.path,
				label: basename(extension.path),
				enabled,
				state: enabled ? "enabled" : "disabled",
				detail: `${extension.metadata.scope}/${extension.metadata.origin} · ${extension.metadata.source}\n${extension.path}`,
			};
		});
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

export default function piConfigManager(pi: ExtensionAPI) {
	let globalSettings: ResourceSettings = loadGlobalSettings();
	let projectSettings: ResourceSettings = loadProjectSettings(
		process.cwd(),
		false,
	);
	let sessionState: SessionResourceState = cloneSessionState(
		DEFAULT_SESSION_STATE,
	);
	let presets: PresetsConfig = {};
	let activePresetName: string | undefined;
	let activePreset: Preset | undefined;
	let activePresetEditor: PresetBorderEditor | undefined;
	const policy = new PolicyManager({
		defaultTools: [],
		globalSettings,
		projectSettings,
		sessionState,
	});
	let lastAppliedTools = new Set<string>();
	let hasAppliedTools = false;
	let policyPhase: PolicyPhase = "collecting";
	let runtimePolicyDirty = false;
	let toolsInventoryUpdating = false;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	let requestHudRender: (() => void) | undefined;
	const promptWarnings = new Set<"skills" | "contexts">();
	let snapshot: ManagerSnapshot = {
		ready: false,
		customPromptActive: false,
		contextsKnown: false,
		extensionsKnown: false,
		tools: [],
		toolSnippets: {},
		activeTools: new Set(),
		skills: [],
		enabledSkills: new Set(),
		contexts: [],
		enabledContexts: new Set(),
		extensions: [],
	};

	function persistSession(): void {
		pi.appendEntry(SESSION_ENTRY, cloneSessionState(sessionState));
	}

	function resetSessionResourceOverrides(): void {
		sessionState.tools = undefined;
		sessionState.enabledSkills = [];
		sessionState.disabledSkills = [];
		sessionState.enabledContexts = [];
		sessionState.disabledContexts = [];
	}

	function restoreSession(ctx: ExtensionContext): void {
		sessionState = cloneSessionState(DEFAULT_SESSION_STATE);
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== SESSION_ENTRY) continue;
			const restored = normalizeSessionState(entry.data);
			if (restored) sessionState = restored;
		}
	}

	function reconcileTools(): void {
		pi.setActiveTools(Array.from(policy.resolveEffectiveTools()));
		lastAppliedTools = new Set(pi.getActiveTools());
		hasAppliedTools = true;
		snapshot = { ...snapshot, activeTools: new Set(lastAppliedTools) };
		requestHudRender?.();
		pi.events.emit("config-manager:state-changed", publicSnapshot());
	}

	function getGlobalSnapshot(): ManagerSnapshot {
		return {
			...snapshot,
			activeTools: policy.resolveGlobalDefaultTools(),
			enabledSkills: policy.resolveGlobalDefaultSkills(snapshot.skills),
			enabledContexts: policy.resolveGlobalDefaultContexts(snapshot.contexts),
		};
	}

	function getManagerSnapshot(): ManagerSnapshot {
		return activePresetName ? snapshot : getGlobalSnapshot();
	}

	function updateToolsInventory(): void {
		if (toolsInventoryUpdating) {
			runtimePolicyDirty = true;
			return;
		}
		toolsInventoryUpdating = true;
		try {
			do {
				runtimePolicyDirty = false;
				if (hasAppliedTools) {
					policy.observeExternalTools(
						pi
							.getActiveTools()
							.filter((name) => !lastAppliedTools.has(name)),
					);
				}
				const allTools = pi.getAllTools();
				policy.setDiscoveredTools(allTools.map((tool) => tool.name));
				snapshot = {
					...snapshot,
					tools: allTools
						.map((tool) => ({
							name: tool.name,
							description: tool.description,
							promptSnippet: snapshot.toolSnippets[tool.name],
							parameters: tool.parameters,
							promptGuidelines: tool.promptGuidelines,
							sourceInfo: tool.sourceInfo,
						}))
						.sort((a, b) => a.name.localeCompare(b.name)),
				};
				reconcileTools();
			} while (runtimePolicyDirty);
		} finally {
			toolsInventoryUpdating = false;
		}
	}

	function getPresetLabel(): string {
		const mode = activePresetName ?? "default";
		return sessionState.preset?.customTools
			? `${mode} (custom tools)`
			: mode;
	}

	function updatePresetStatus(ctx: ExtensionContext): void {
		snapshot = { ...snapshot, presetName: activePresetName };
		ctx.ui.setStatus("preset", undefined);
		ctx.ui.setWidget("preset", undefined);
		activePresetEditor?.requestRender();
		requestHudRender?.();
	}

	function setPresetPolicy(
		name: string,
		preset: Preset,
		tools: string[] | undefined,
	): void {
		policy.setProfile({ id: name, tools, skills: preset.skills });
		snapshot = {
			...snapshot,
			enabledSkills: policy.resolveEnabledSkills(snapshot.skills),
			enabledContexts: policy.resolveEnabledContexts(snapshot.contexts),
		};
	}

	function currentOriginalState(ctx: ExtensionContext): PresetOriginalState {
		return {
			provider: ctx.model?.provider,
			model: ctx.model?.id,
			thinkingLevel: pi.getThinkingLevel(),
			tools: Array.from(policy.resolveBaseTools()),
		};
	}

	function validatedPresetTools(
		name: string,
		preset: Preset,
		ctx: ExtensionContext,
	): string[] | undefined {
		if (!preset.tools) return undefined;
		const discovered = new Set(pi.getAllTools().map((tool) => tool.name));
		const valid = preset.tools.filter((tool) => discovered.has(tool));
		const invalid = preset.tools.filter((tool) => !discovered.has(tool));
		if (invalid.length > 0) {
			ctx.ui.notify(
				`Preset "${name}": Unknown tools: ${invalid.join(", ")}`,
				"warning",
			);
		}
		return unique(valid);
	}

	async function applyPreset(
		name: string,
		preset: Preset,
		ctx: ExtensionContext,
	): Promise<void> {
		const originalState =
			sessionState.preset?.originalState ?? currentOriginalState(ctx);
		const configuredTools = validatedPresetTools(name, preset, ctx);
		const appliedTools =
			configuredTools ?? Array.from(policy.resolveConfiguredTools());

		if (preset.provider && preset.model) {
			const model = ctx.modelRegistry.find(preset.provider, preset.model);
			if (!model) {
				ctx.ui.notify(
					`Preset "${name}": Model ${preset.provider}/${preset.model} not found`,
					"warning",
				);
			} else if (!(await pi.setModel(model))) {
				ctx.ui.notify(
					`Preset "${name}": No API key for ${preset.provider}/${preset.model}`,
					"warning",
				);
			}
		}
		if (preset.thinkingLevel) pi.setThinkingLevel(preset.thinkingLevel);

		activePresetName = name;
		activePreset = preset;
		resetSessionResourceOverrides();
		sessionState.preset = {
			name,
			customTools: false,
			appliedTools,
			originalState,
		};
		policy.setSessionState(sessionState);
		setPresetPolicy(name, preset, appliedTools);
		reconcileTools();
		persistSession();
		updatePresetStatus(ctx);
	}

	async function clearPreset(ctx: ExtensionContext): Promise<void> {
		const originalState = sessionState.preset?.originalState;
		activePresetName = undefined;
		activePreset = undefined;
		policy.setProfile(undefined);
		sessionState.preset = undefined;
		resetSessionResourceOverrides();
		policy.setSessionState(sessionState);
		if (originalState?.provider && originalState.model) {
			const model = ctx.modelRegistry.find(
				originalState.provider,
				originalState.model,
			);
			if (model) await pi.setModel(model);
		}
		if (originalState) pi.setThinkingLevel(originalState.thinkingLevel);
		snapshot = {
			...snapshot,
			enabledSkills: policy.resolveEnabledSkills(snapshot.skills),
			enabledContexts: policy.resolveEnabledContexts(snapshot.contexts),
		};
		reconcileTools();
		persistSession();
		updatePresetStatus(ctx);
	}

	function restorePresetPolicy(ctx: ExtensionContext): void {
		const state = sessionState.preset;
		const preset = state ? presets[state.name] : undefined;
		if (!state || !preset) {
			activePresetName = undefined;
			activePreset = undefined;
			policy.setProfile(undefined);
			if (state) sessionState.preset = undefined;
			resetSessionResourceOverrides();
			policy.setSessionState(sessionState);
			updatePresetStatus(ctx);
			return;
		}
		activePresetName = state.name;
		activePreset = preset;
		const tools =
			state.appliedTools ??
			preset.tools?.filter((tool) =>
				pi.getAllTools().some((candidate) => candidate.name === tool),
			);
		setPresetPolicy(state.name, preset, tools);
		updatePresetStatus(ctx);
	}

	async function showPresetSelector(ctx: ExtensionContext): Promise<void> {
		const names = Object.keys(presets);
		if (names.length === 0) {
			ctx.ui.notify("No presets defined in global or project presets.json", "warning");
			return;
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
		const result = await ctx.ui.custom<string | null>(
			(tui, theme, _keybindings, done) => {
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
			},
		);
		if (!result) return;
		if (result === "(none)") {
			await clearPreset(ctx);
			ctx.ui.notify("Preset cleared, defaults restored", "info");
			return;
		}
		const preset = presets[result];
		if (!preset) return;
		await applyPreset(result, preset, ctx);
		ctx.ui.notify(`Preset "${result}" activated`, "info");
	}

	async function cyclePreset(ctx: ExtensionContext): Promise<void> {
		const names = Object.keys(presets).sort((a, b) => a.localeCompare(b));
		if (names.length === 0) {
			ctx.ui.notify("No presets defined in global or project presets.json", "warning");
			return;
		}
		const cycle = ["(none)", ...names];
		const current = activePresetName ?? "(none)";
		const currentIndex = cycle.indexOf(current);
		const next = cycle[currentIndex < 0 ? 0 : (currentIndex + 1) % cycle.length];
		if (!next) return;
		if (next === "(none)") {
			await clearPreset(ctx);
			ctx.ui.notify("Preset cleared, defaults restored", "info");
			return;
		}
		const preset = presets[next];
		if (!preset) return;
		await applyPreset(next, preset, ctx);
		ctx.ui.notify(`Preset "${next}" activated`, "info");
	}

	function updatePromptInventory(options: BuildSystemPromptOptions): void {
		const skills: SkillRecord[] = (options.skills ?? [])
			.map((skill: any) => ({
				name: skill.name,
				description: skill.description ?? "No description",
				path: skill.path ?? skill.filePath ?? "Path unavailable",
				disableModelInvocation: skill.disableModelInvocation === true,
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
		const contexts: ContextRecord[] = (options.contextFiles ?? []).map(
			(file) => ({ path: file.path, content: file.content }),
		);
		const toolSnippets = Object.fromEntries(
			Object.entries(options.toolSnippets ?? {}).filter(
				([, snippet]) => typeof snippet === "string" && snippet.length > 0,
			),
		);
		snapshot = {
			...snapshot,
			ready: true,
			customPromptActive: Boolean(options.customPrompt),
			toolSnippets,
			skills,
			enabledSkills: policy.resolveEnabledSkills(skills),
			contextsKnown: true,
			contexts,
			enabledContexts: policy.resolveEnabledContexts(contexts),
		};
		requestHudRender?.();
	}

	async function refreshExtensions(ctx: ExtensionContext): Promise<void> {
		try {
			const extensions = await resolveExtensions(
				ctx.cwd,
				ctx.isProjectTrusted(),
			);
			snapshot = { ...snapshot, extensionsKnown: true, extensions };
			requestHudRender?.();
		} catch (error) {
			ctx.ui.notify(
				`Could not resolve extensions: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	}

	function refreshSkillsFromCommands(): void {
		const existingSkills = new Map(
			snapshot.skills.map((skill) => [skill.name, skill]),
		);
		const skills = pi
			.getCommands()
			.filter((command) => command.source === "skill")
			.map((command) => {
				const name = command.name.replace(/^skill:/, "");
				return {
					name,
					description: command.description ?? "No description",
					path: command.sourceInfo.path,
					disableModelInvocation:
						existingSkills.get(name)?.disableModelInvocation,
				};
			})
			.sort((a, b) => a.name.localeCompare(b.name));
		snapshot = {
			...snapshot,
			ready: true,
			skills,
			enabledSkills: policy.resolveEnabledSkills(skills),
		};
		requestHudRender?.();
	}

	function scheduleSettledRefresh(ctx: ExtensionContext): void {
		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = setTimeout(() => {
			settleTimer = undefined;
			updateToolsInventory();
			refreshSkillsFromCommands();
			void refreshExtensions(ctx);
		}, 500);
	}

	function publicSnapshot() {
		return {
			ready: snapshot.ready,
			baseTools: Array.from(policy.resolveBaseTools()),
			tools: {
				active: snapshot.activeTools.size,
				total: snapshot.tools.length,
			},
			skills: {
				enabled: snapshot.enabledSkills.size,
				total: snapshot.skills.length,
			},
			contexts: {
				enabled: snapshot.enabledContexts.size,
				total: snapshot.contexts.length,
			},
			extensions: {
				enabled: snapshot.extensions.filter((item) => item.enabled).length,
				total: snapshot.extensions.length,
			},
		};
	}

	function toggleSessionResource(
		tab: ResourceTab,
		id: string,
		ctx: ExtensionContext,
	): void {
		if (tab === "tools") {
			const wasEffective = snapshot.activeTools.has(id);
			policy.removeExternalTool(id);
			const base = policy.resolveBaseTools();
			if (wasEffective) base.delete(id);
			else base.add(id);
			sessionState.tools = unique(base);
			if (sessionState.preset) sessionState.preset.customTools = true;
			policy.setSessionState(sessionState);
			reconcileTools();
			persistSession();
			updatePresetStatus(ctx);
			return;
		}
		if (tab === "skills") {
			const enabled = snapshot.enabledSkills.has(id);
			sessionState.enabledSkills = sessionState.enabledSkills.filter(
				(name) => name !== id,
			);
			sessionState.disabledSkills = sessionState.disabledSkills.filter(
				(name) => name !== id,
			);
			if (enabled) sessionState.disabledSkills.push(id);
			else sessionState.enabledSkills.push(id);
			sessionState.enabledSkills = unique(sessionState.enabledSkills);
			sessionState.disabledSkills = unique(sessionState.disabledSkills);
			policy.setSessionState(sessionState);
			snapshot = {
				...snapshot,
				enabledSkills: policy.resolveEnabledSkills(snapshot.skills),
			};
			persistSession();
			requestHudRender?.();
			return;
		}
		if (tab === "contexts") {
			const enabled = snapshot.enabledContexts.has(id);
			sessionState.enabledContexts = sessionState.enabledContexts.filter(
				(path) => path !== id,
			);
			sessionState.disabledContexts = sessionState.disabledContexts.filter(
				(path) => path !== id,
			);
			if (enabled) sessionState.disabledContexts.push(id);
			else sessionState.enabledContexts.push(id);
			sessionState.enabledContexts = unique(sessionState.enabledContexts);
			sessionState.disabledContexts = unique(sessionState.disabledContexts);
			policy.setSessionState(sessionState);
			snapshot = {
				...snapshot,
				enabledContexts: policy.resolveEnabledContexts(snapshot.contexts),
			};
			persistSession();
			requestHudRender?.();
		}
	}

	function setGlobalResource(
		kind: "tools" | "skills" | "contexts",
		name: string,
		enabled: boolean,
		ctx: ExtensionContext,
	): void {
		if (kind === "tools") {
			const enabledTools = new Set(globalSettings.enabledTools);
			const disabledTools = new Set(globalSettings.disabledTools);
			if (enabled) {
				enabledTools.add(name);
				disabledTools.delete(name);
			} else {
				enabledTools.delete(name);
				disabledTools.add(name);
				policy.removeExternalTool(name);
			}
			globalSettings = {
				...globalSettings,
				enabledTools: unique(enabledTools),
				disabledTools: unique(disabledTools),
			};
		} else {
			const key = kind === "skills" ? "disabledSkills" : "disabledContexts";
			const values = new Set(globalSettings[key]);
			if (enabled) values.delete(name);
			else values.add(name);
			globalSettings = { ...globalSettings, [key]: unique(values) };
		}
		policy.setSettings(globalSettings, projectSettings);
		saveGlobalSettings(globalSettings);
		updateToolsInventory();
		snapshot = {
			...snapshot,
			enabledSkills: policy.resolveEnabledSkills(snapshot.skills),
			enabledContexts: policy.resolveEnabledContexts(snapshot.contexts),
		};
		ctx.ui.notify(
			`Global ${kind} setting updated: ${name} ${enabled ? "enabled" : "disabled"}`,
			"info",
		);
		requestHudRender?.();
	}

	async function showManager(
		initialTab: ResourceTab,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Pi Config Manager requires TUI mode", "error");
			return;
		}
		if (!snapshot.effectiveSystemPrompt) {
			const currentPrompt = ctx.getSystemPrompt();
			if (currentPrompt) {
				snapshot = {
					...snapshot,
					effectiveSystemPrompt: {
						content: currentPrompt,
						capturedAt: Date.now(),
						source: "command",
					},
				};
			}
		}
		updatePromptInventory(ctx.getSystemPromptOptions());
		updateToolsInventory();
		await refreshExtensions(ctx);
		const staged = new Map<string, ExtensionChange>();
		const action = await ctx.ui.custom<"close" | "save">(
			(tui, theme, keybindings, done) =>
				new ConfigManagerView(
					initialTab,
					getManagerSnapshot,
					staged,
					theme,
					keybindings,
					(tab, id) => {
						if (tab === "extensions") {
							const resource = snapshot.extensions.find(
								(item) => item.path === id,
							);
							if (!resource) return;
							if (resource.path.includes("pi-config-manager")) {
								ctx.ui.notify(
									"Pi Config Manager cannot disable itself from the active manager.",
									"warning",
								);
								return;
							}
							if (isDirectFilePackage(resource, ctx.cwd)) {
								ctx.ui.notify(
									"Pi does not support per-extension filters for a package source that directly names one extension file.",
									"warning",
								);
								return;
							}
							const current = staged.get(id)?.enabled ?? resource.enabled;
							staged.set(id, { resource, enabled: !current });
						} else if (tab !== "overview" && activePresetName) {
							toggleSessionResource(tab, id, ctx);
							updatePromptInventory(ctx.getSystemPromptOptions());
							updateToolsInventory();
						} else if (tab !== "overview") {
							const globalSnapshot = getGlobalSnapshot();
							setGlobalResource(
								tab,
								id,
								!isResourceEnabled(globalSnapshot, tab, id),
								ctx,
							);
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
		if (action !== "save" || staged.size === 0) return;
		const confirmed = await ctx.ui.confirm(
			"Save extension changes?",
			"Extension changes require Pi to reload. Save and reload now?",
		);
		if (!confirmed) return;
		try {
			await saveExtensionChanges(
				ctx.cwd,
				ctx.isProjectTrusted(),
				Array.from(staged.values()),
			);
			await ctx.reload();
		} catch (error) {
			ctx.ui.notify(
				`Could not save extension settings: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	}

	function installHud(ctx: ExtensionContext): void {
		ctx.ui.setWidget("pi-config-manager", (tui, theme) => {
			requestHudRender = () => tui.requestRender();
			return {
				render(width: number) {
					if (!snapshot.ready)
						return [
							truncateToWidth(
								theme.fg("dim", "Resources · loading…"),
								Math.max(1, width),
							),
						];
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
					const second = `  tools ${snapshot.activeTools.size}/${snapshot.tools.length} · skills ${snapshot.enabledSkills.size}/${snapshot.skills.length} · contexts ${contextCount}`;
					const third = `  extensions ${extensionCount}${snapshot.presetName ? ` · preset ${snapshot.presetName}` : ""}`;
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

	function registerResourceCommand(
		name: string,
		tab: ResourceTab,
		kind: "tools" | "skills" | "contexts",
	) {
		pi.registerCommand(name, {
			description: `Manage ${name} through Pi Config Manager`,
			handler: async (args, ctx) => {
				const parts = args.trim().split(/\s+/).filter(Boolean);
				if (
					parts[0] === "global" &&
					(parts[1] === "enable" || parts[1] === "disable") &&
					parts[2]
				) {
					setGlobalResource(
						kind,
						parts.slice(2).join(" "),
						parts[1] === "enable",
						ctx,
					);
					return;
				}
				await showManager(tab, ctx);
			},
		});
	}

	pi.registerCommand("config-manager", {
		description: "Manage Pi tools, skills, contexts, and extensions",
		handler: async (_args, ctx) => showManager("overview", ctx),
	});
	registerResourceCommand("tools", "tools", "tools");
	registerResourceCommand("skills", "skills", "skills");
	registerResourceCommand("contexts", "contexts", "contexts");
	pi.registerCommand("extensions", {
		description: "Manage Pi extensions",
		handler: async (_args, ctx) => showManager("extensions", ctx),
	});
	pi.registerCommand("preset", {
		description: "Switch preset configuration",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				await showPresetSelector(ctx);
				return;
			}
			const preset = presets[name];
			if (!preset) {
				const available = Object.keys(presets).join(", ") || "(none defined)";
				ctx.ui.notify(
					`Unknown preset "${name}". Available: ${available}`,
					"error",
				);
				return;
			}
			await applyPreset(name, preset, ctx);
			ctx.ui.notify(`Preset "${name}" activated`, "info");
		},
	});
	pi.registerShortcut(Key.ctrlShift("u"), {
		description: "Cycle presets",
		handler: cyclePreset,
	});
	pi.registerFlag("preset", {
		description: "Preset configuration to use",
		type: "string",
	});

	pi.events.on("config-manager:layer-set", (event) => {
		if (policyPhase === "stopped") return;
		const data = event as {
			id?: unknown;
			disableTools?: unknown;
			requireTools?: unknown;
		};
		if (typeof data.id !== "string") return;
		const toolNames = (value: unknown): string[] =>
			Array.isArray(value)
				? unique(
						value.filter(
							(item): item is string => typeof item === "string",
						),
					)
				: [];
		const layer: RuntimeLayer = {
			id: data.id,
			disableTools: toolNames(data.disableTools),
			requireTools: toolNames(data.requireTools),
		};
		if (!policy.setRuntimeLayer(layer)) return;
		runtimePolicyDirty = true;
		if (policyPhase === "ready") updateToolsInventory();
	});
	pi.events.on("config-manager:layer-clear", (event) => {
		if (policyPhase === "stopped") return;
		const id = (event as { id?: unknown }).id;
		if (typeof id !== "string" || !policy.clearRuntimeLayer(id)) return;
		runtimePolicyDirty = true;
		if (policyPhase === "ready") updateToolsInventory();
	});
	pi.events.on("config-manager:request-snapshot", () => {
		pi.events.emit("config-manager:state-changed", publicSnapshot());
	});

	pi.on("input", (event, ctx) => {
		if (event.text.startsWith("/skill:")) refreshSkillsFromCommands();
		const match = event.text.match(/^\/skill:([^\s]+)/);
		const name = match?.[1];
		if (
			!name ||
			!snapshot.skills.some((skill) => skill.name === name) ||
			snapshot.enabledSkills.has(name)
		)
			return;
		ctx.ui.notify(
			`Skill "${name}" is disabled. Use /skills to enable it.`,
			"warning",
		);
		return { action: "handled" };
	});

	pi.on("before_agent_start", (event, ctx) => {
		updatePromptInventory(event.systemPromptOptions);
		updateToolsInventory();
		const originalSkills = formatSkillsForPrompt(
			event.systemPromptOptions.skills ?? [],
		);
		const filteredSkills = formatSkillsForPrompt(
			(event.systemPromptOptions.skills ?? []).filter((skill) =>
				snapshot.enabledSkills.has(skill.name),
			),
		);
		const originalContexts = formatContextSection(snapshot.contexts);
		const filteredContexts = formatContextSection(
			snapshot.contexts.filter((context) =>
				snapshot.enabledContexts.has(context.path),
			),
		);
		let systemPrompt = event.systemPrompt;
		const readAvailable =
			!event.systemPromptOptions.selectedTools ||
			event.systemPromptOptions.selectedTools.includes("read");
		if (originalSkills && systemPrompt.includes(originalSkills)) {
			systemPrompt = systemPrompt.replace(originalSkills, filteredSkills);
		} else if (
			readAvailable &&
			originalSkills &&
			filteredSkills !== originalSkills &&
			!promptWarnings.has("skills")
		) {
			promptWarnings.add("skills");
			ctx.ui.notify(
				"Disabled Skills could not be removed from this custom system prompt; leaving the prompt unchanged.",
				"warning",
			);
		}
		if (originalContexts && systemPrompt.includes(originalContexts)) {
			systemPrompt = systemPrompt.replace(originalContexts, filteredContexts);
		} else if (
			originalContexts &&
			filteredContexts !== originalContexts &&
			!promptWarnings.has("contexts")
		) {
			promptWarnings.add("contexts");
			ctx.ui.notify(
				"Disabled Context Files could not be removed from this custom system prompt; leaving the prompt unchanged.",
				"warning",
			);
		}
		if (activePreset?.instructions) {
			systemPrompt = `${systemPrompt}\n\n${activePreset.instructions}`;
		}
		return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
	});

	pi.on("agent_start", (_event, ctx) => {
		snapshot = {
			...snapshot,
			effectiveSystemPrompt: {
				content: ctx.getSystemPrompt(),
				capturedAt: Date.now(),
				source: "agent-start",
			},
		};
		requestHudRender?.();
	});

	pi.on("turn_start", () => {
		updateToolsInventory();
	});

	pi.on("session_start", async (_event, ctx) => {
		policyPhase = "initializing";
		promptWarnings.clear();
		const initialTools = pi.getActiveTools();
		lastAppliedTools = new Set();
		hasAppliedTools = false;
		activePresetEditor = undefined;
		globalSettings = loadGlobalSettings();
		projectSettings = loadProjectSettings(ctx.cwd, ctx.isProjectTrusted());
		presets = loadPresets(ctx.cwd, ctx.isProjectTrusted());
		restoreSession(ctx);
		const presetFlag = pi.getFlag("preset");
		if (typeof presetFlag === "string" && presetFlag) {
			resetSessionResourceOverrides();
			sessionState.preset = undefined;
			activePresetName = undefined;
			activePreset = undefined;
		}
		policy.initialize({
			defaultTools: initialTools,
			globalSettings,
			projectSettings,
			sessionState,
		});
		if (typeof presetFlag !== "string" || !presetFlag) {
			restorePresetPolicy(ctx);
		}
		snapshot = {
			...snapshot,
			ready: false,
			customPromptActive: false,
			effectiveSystemPrompt: undefined,
			contextsKnown: false,
			extensionsKnown: false,
			skills: [],
			contexts: [],
			extensions: [],
			presetName: activePresetName,
		};
		updateToolsInventory();
		refreshSkillsFromCommands();
		installPresetEditor(ctx, getPresetLabel, (editor) => {
			activePresetEditor = editor;
		});
		installHud(ctx);
		if (typeof presetFlag === "string" && presetFlag) {
			const preset = presets[presetFlag];
			if (preset) {
				await applyPreset(presetFlag, preset, ctx);
				ctx.ui.notify(`Preset "${presetFlag}" activated`, "info");
			} else {
				const available = Object.keys(presets).join(", ") || "(none defined)";
				ctx.ui.notify(
					`Unknown preset "${presetFlag}". Available: ${available}`,
					"warning",
				);
			}
		}
		updatePresetStatus(ctx);
		updateToolsInventory();
		policyPhase = "ready";
		scheduleSettledRefresh(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		policyPhase = "initializing";
		policy.clearExternalTools();
		presets = loadPresets(ctx.cwd, ctx.isProjectTrusted());
		restoreSession(ctx);
		policy.setSessionState(sessionState);
		restorePresetPolicy(ctx);
		updateToolsInventory();
		snapshot = {
			...snapshot,
			effectiveSystemPrompt: undefined,
			enabledSkills: policy.resolveEnabledSkills(snapshot.skills),
			enabledContexts: policy.resolveEnabledContexts(snapshot.contexts),
		};
		updatePresetStatus(ctx);
		updateToolsInventory();
		policyPhase = "ready";
	});
	pi.on("session_shutdown", (_event, ctx) => {
		policyPhase = "stopped";
		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = undefined;
		ctx.ui.setWidget("pi-config-manager", undefined);
		requestHudRender = undefined;
	});
}
