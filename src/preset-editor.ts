// Preset UI behavior is adapted from Pi Coding Agent's MIT-licensed preset example.
import {
	CustomEditor,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteProvider,
	type EditorComponent,
	type Focusable,
	isFocusable,
	truncateToWidth,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";

type EditorFactory = NonNullable<
	ReturnType<ExtensionContext["ui"]["getEditorComponent"]>
>;

interface PresetEditorFactory extends EditorFactory {
	isPresetEditor?: true;
	baseFactory?: EditorFactory;
}

interface AppEditor extends EditorComponent {
	actionHandlers?: Map<unknown, () => void>;
	onEscape?: () => void;
	onCtrlD?: () => void;
	onPasteImage?: () => void;
	onExtensionShortcut?: (data: string) => boolean;
	getCursor?: () => { line: number; col: number };
	isShowingAutocomplete?: () => boolean;
	canObserveNavigationBoundary?: () => boolean;
}

export class PresetBorderEditor implements EditorComponent, Focusable {
	constructor(
		private readonly editor: EditorComponent,
		private readonly tui: TUI,
		private readonly getLabel: () => string,
	) {}

	get focused(): boolean {
		return isFocusable(this.editor) ? this.editor.focused : false;
	}
	set focused(value: boolean) {
		if (isFocusable(this.editor)) this.editor.focused = value;
	}
	get wantsKeyRelease(): boolean | undefined {
		return this.editor.wantsKeyRelease;
	}
	set wantsKeyRelease(value: boolean | undefined) {
		this.editor.wantsKeyRelease = value;
	}
	get onSubmit(): ((text: string) => void) | undefined {
		return this.editor.onSubmit;
	}
	set onSubmit(handler: ((text: string) => void) | undefined) {
		this.editor.onSubmit = handler;
	}
	get onChange(): ((text: string) => void) | undefined {
		return this.editor.onChange;
	}
	set onChange(handler: ((text: string) => void) | undefined) {
		this.editor.onChange = handler;
	}
	get borderColor(): ((text: string) => string) | undefined {
		return this.editor.borderColor;
	}
	set borderColor(color: ((text: string) => string) | undefined) {
		this.editor.borderColor = color;
	}
	get actionHandlers(): Map<unknown, () => void> {
		const editor = this.editor as AppEditor;
		editor.actionHandlers ??= new Map();
		return editor.actionHandlers;
	}
	get onEscape(): (() => void) | undefined {
		return (this.editor as AppEditor).onEscape;
	}
	set onEscape(handler: (() => void) | undefined) {
		(this.editor as AppEditor).onEscape = handler;
	}
	get onCtrlD(): (() => void) | undefined {
		return (this.editor as AppEditor).onCtrlD;
	}
	set onCtrlD(handler: (() => void) | undefined) {
		(this.editor as AppEditor).onCtrlD = handler;
	}
	get onPasteImage(): (() => void) | undefined {
		return (this.editor as AppEditor).onPasteImage;
	}
	set onPasteImage(handler: (() => void) | undefined) {
		(this.editor as AppEditor).onPasteImage = handler;
	}
	get onExtensionShortcut(): ((data: string) => boolean) | undefined {
		return (this.editor as AppEditor).onExtensionShortcut;
	}
	set onExtensionShortcut(handler: ((data: string) => boolean) | undefined) {
		(this.editor as AppEditor).onExtensionShortcut = handler;
	}
	getText(): string {
		return this.editor.getText();
	}
	getCursor(): { line: number; col: number } | undefined {
		return (this.editor as AppEditor).getCursor?.();
	}
	canObserveNavigationBoundary(): boolean {
		const editor = this.editor as AppEditor;
		if (typeof editor.canObserveNavigationBoundary === "function")
			return editor.canObserveNavigationBoundary();
		return (
			typeof editor.getCursor === "function" &&
			typeof editor.isShowingAutocomplete === "function"
		);
	}
	isShowingAutocomplete(): boolean {
		return (this.editor as AppEditor).isShowingAutocomplete?.() ?? false;
	}
	setText(text: string): void {
		this.editor.setText(text);
	}
	handleInput(data: string): void {
		this.editor.handleInput(data);
	}
	invalidate(): void {
		this.editor.invalidate();
	}
	render(width: number): string[] {
		const lines = this.editor.render(width);
		if (lines.length === 0 || width < 3) return lines;
		const label = truncateToWidth(` ${this.getLabel()} `, width - 2, "");
		const labelWidth = visibleWidth(label);
		if (labelWidth === 0) return lines;
		const remainingWidth = width - labelWidth;
		const border = this.editor.borderColor ?? ((text: string) => text);
		const originalBorder = truncateToWidth(lines[0] ?? "", remainingWidth, "");
		const paddingWidth = Math.max(
			0,
			remainingWidth - visibleWidth(originalBorder),
		);
		lines[0] = originalBorder + border("─".repeat(paddingWidth)) + border(label);
		return lines;
	}
	addToHistory(text: string): void {
		this.editor.addToHistory?.(text);
	}
	insertTextAtCursor(text: string): void {
		this.editor.insertTextAtCursor?.(text);
	}
	getExpandedText(): string {
		return this.editor.getExpandedText?.() ?? this.editor.getText();
	}
	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.editor.setAutocompleteProvider?.(provider);
	}
	setPaddingX(padding: number): void {
		this.editor.setPaddingX?.(padding);
	}
	setAutocompleteMaxVisible(maxVisible: number): void {
		this.editor.setAutocompleteMaxVisible?.(maxVisible);
	}
	requestRender(): void {
		this.tui.requestRender();
	}
}

export function installPresetEditor(
	ctx: ExtensionContext,
	getLabel: () => string,
	onEditor: (editor: PresetBorderEditor) => void,
): void {
	if (ctx.mode !== "tui") return;
	const currentFactory = ctx.ui.getEditorComponent() as
		| PresetEditorFactory
		| undefined;
	const baseFactory = currentFactory?.isPresetEditor
		? currentFactory.baseFactory
		: currentFactory;
	const factory: PresetEditorFactory = (tui, theme, keybindings) => {
		const baseEditor =
			baseFactory?.(tui, theme, keybindings) ??
			new CustomEditor(tui, theme, keybindings);
		const editor = new PresetBorderEditor(baseEditor, tui, getLabel);
		onEditor(editor);
		return editor;
	};
	factory.isPresetEditor = true;
	factory.baseFactory = baseFactory;
	ctx.ui.setEditorComponent(factory);
}
