import {
	App,
	Component,
	MarkdownPostProcessorContext,
	MarkdownRenderer,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	setIcon,
	Setting,
	TFile,
} from "obsidian";

import {
	Decoration,
	DecorationSet,
	EditorView,
	PluginSpec,
	PluginValue,
	ViewPlugin,
	ViewUpdate,
	WidgetType,
} from "@codemirror/view";

import { RangeSetBuilder } from "@codemirror/state";

// ─── Settings ─────────────────────────────────────────────────────────────────

interface RndSettings {
	useCustomButtonText: boolean;
	customButtonText: string;
	includeDone: boolean;
	addDoneTimestamp: boolean;
}

const DEFAULT_SETTINGS: RndSettings = {
	useCustomButtonText: false,
	customButtonText: "",
	includeDone: false,
	addDoneTimestamp: false,
};

const DEFAULT_BUTTON_TEXT = "🎲";

// ─── Timestamp ────────────────────────────────────────────────────────────────

// Tasks-compatible format: ✅ YYYY-MM-DD
const TIMESTAMP_RE = /\s✅\s\d{4}-\d{2}-\d{2}$/;

function buildTimestamp(): string {
	const d    = new Date();
	const yyyy = d.getFullYear();
	const mm   = String(d.getMonth() + 1).padStart(2, "0");
	const dd   = String(d.getDate()).padStart(2, "0");
	return ` ✅ ${yyyy}-${mm}-${dd}`;
}

function stripTimestamp(line: string): string {
	return line.replace(TIMESTAMP_RE, "");
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ListItem {
	text: string;             // item text without bullet/number/checkbox prefix
	lineIndex: number;
	isCheckbox: boolean;
	isDone: boolean;
	orderedNumber: number | null;
}

// ─── Markdown parsing ─────────────────────────────────────────────────────────

const HEADING_RE   = /^(#{1,6})\s+(.*)$/;
const ORDERED_RE   = /^(\s*)(\d+)\.\s(\[( |x|X)\]\s)?(.+)/;
const UNORDERED_RE = /^(\s*)-\s(\[( |x|X)\]\s)?(.+)/;
// Matches {{rnd}} or {{rnd:flags}} — group 1 captures the optional flags string
const RND_RE       = /\{\{rnd(?::([^}]*))?\}\}/g;

interface RndOverrides {
	includeDone?: boolean;
	addDoneTimestamp?: boolean;
}

// Parses the comma-separated flags from a {{rnd:flags}} match.
// Unrecognized flags are ignored. Within a pair (done/nodone, ts/nots),
// the last flag encountered wins.
function parseRndFlags(raw: string | undefined): RndOverrides {
	const overrides: RndOverrides = {};
	if (!raw) return overrides;

	const flags = raw.split(",").map(f => f.trim().toLowerCase()).filter(f => f.length > 0);
	for (const flag of flags) {
		switch (flag) {
			case "done":   overrides.includeDone = true;  break;
			case "nodone": overrides.includeDone = false; break;
			case "ts":     overrides.addDoneTimestamp = true;  break;
			case "nots":   overrides.addDoneTimestamp = false; break;
			// unrecognized flags are silently ignored
		}
	}
	return overrides;
}

function stripMarkdown(text: string): string {
	return text
		.replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, (_match: string, link: string, alias?: string) => alias ? alias.slice(1) : link)
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/_([^_]+)_/g, "$1")
		.replace(/~~([^~]+)~~/g, "$1")
		.replace(/\{\{rnd(?::[^}]*)?\}\}/g, "")
		.trim();
}

function headingLevel(line: string): number {
	const m = line.match(HEADING_RE);
	return m ? m[1].length : 0;
}

function headingText(line: string): string | null {
	const m = line.match(HEADING_RE);
	if (!m) return null;
	return stripMarkdown(m[2]);
}

function findScopeHeading(lines: string[], triggerLineIndex: number): string | null {
	const triggerLine = lines[triggerLineIndex];
	if (headingLevel(triggerLine) > 0) {
		const text = headingText(triggerLine);
		return text && text.length > 0 ? text : null;
	}
	for (let i = triggerLineIndex - 1; i >= 0; i--) {
		const text = headingText(lines[i]);
		if (text !== null) return text.length > 0 ? text : null;
	}
	return null;
}

function getScopeLines(lines: string[], triggerLineIndex: number): { start: number; end: number } {
	const triggerLine         = lines[triggerLineIndex];
	const triggerHeadingLevel = headingLevel(triggerLine);

	if (triggerHeadingLevel > 0) {
		const start = triggerLineIndex + 1;
		let end = lines.length;
		for (let i = start; i < lines.length; i++) {
			const lvl = headingLevel(lines[i]);
			if (lvl > 0 && lvl <= triggerHeadingLevel) { end = i; break; }
		}
		return { start, end };
	}

	let scopeLevel = 0;
	for (let i = triggerLineIndex - 1; i >= 0; i--) {
		const lvl = headingLevel(lines[i]);
		if (lvl > 0) { scopeLevel = lvl; break; }
	}

	const start = triggerLineIndex + 1;
	if (scopeLevel === 0) return { start, end: lines.length };

	let end = lines.length;
	for (let i = start; i < lines.length; i++) {
		const lvl = headingLevel(lines[i]);
		if (lvl > 0 && lvl <= scopeLevel) { end = i; break; }
	}
	return { start, end };
}

function computeOrderedNumber(lines: string[], lineIndex: number, indent: string): number {
	let count = 1;
	for (let i = lineIndex - 1; i >= 0; i--) {
		const m = lines[i].match(ORDERED_RE);
		if (m && m[1] === indent) {
			count++;
		} else if (lines[i].trim() === "") {
			continue;
		} else {
			break;
		}
	}
	return count;
}

function extractListItems(lines: string[], start: number, end: number, includeDone: boolean): ListItem[] {
	const items: ListItem[] = [];
	for (let i = start; i < end; i++) {
		const line = lines[i];

		const om = line.match(ORDERED_RE);
		if (om) {
			const indent       = om[1];
			const checkboxChar = om[4];
			const isCheckbox   = checkboxChar !== undefined;
			const isDone       = isCheckbox && checkboxChar.toLowerCase() === "x";
			if (isDone && !includeDone) continue;
			items.push({
				text: om[5].trim(),
				lineIndex: i,
				isCheckbox,
				isDone,
				orderedNumber: computeOrderedNumber(lines, i, indent),
			});
			continue;
		}

		const um = line.match(UNORDERED_RE);
		if (um) {
			const checkboxChar = um[3];
			const isCheckbox   = checkboxChar !== undefined;
			const isDone       = isCheckbox && checkboxChar.toLowerCase() === "x";
			if (isDone && !includeDone) continue;
			items.push({
				text: um[4].trim(),
				lineIndex: i,
				isCheckbox,
				isDone,
				orderedNumber: null,
			});
		}
	}
	return items;
}

// ─── Modal ────────────────────────────────────────────────────────────────────

class RandomPickModal extends Modal {
	private allItems: ListItem[];
	private pool: ListItem[];
	private currentItem: ListItem | null;
	private includeDone: boolean;
	private addDoneTimestamp: boolean;
	private onToggleDone: (item: ListItem, markDone: boolean) => Promise<void>;
	private scopeHeading: string | null;
	private sourcePath: string;
	private resultEl!: HTMLElement;
	private resultTextWrapEl!: HTMLElement;
	private copyBtnEl!: HTMLElement;
	private againBtnEl!: HTMLButtonElement;
	private toggleBtnEl: HTMLButtonElement | null = null;
	private goToBtnEl!: HTMLButtonElement;
	private renderComponent: Component;

	constructor(
		app: App,
		items: ListItem[],
		scopeHeading: string | null,
		includeDone: boolean,
		addDoneTimestamp: boolean,
		sourcePath: string,
		onToggleDone: (item: ListItem, markDone: boolean) => Promise<void>
	) {
		super(app);
		this.allItems         = [...items];
		this.includeDone      = includeDone;
		this.addDoneTimestamp = addDoneTimestamp;
		this.scopeHeading     = scopeHeading;
		this.sourcePath       = sourcePath;
		this.onToggleDone     = onToggleDone;
		this.pool             = this.buildPool();
		this.currentItem      = this.pick(null);
		this.renderComponent  = new Component();
	}

	private buildPool(): ListItem[] {
		return this.includeDone
			? this.allItems
			: this.allItems.filter(i => !i.isDone);
	}

	// Returns null when pool is empty
	private pick(exclude: ListItem | null): ListItem | null {
		if (this.pool.length === 0) return null;
		const candidates = exclude
			? this.pool.filter(i => i.lineIndex !== exclude.lineIndex)
			: this.pool;
		const source = candidates.length > 0 ? candidates : this.pool;
		return source[Math.floor(Math.random() * source.length)];
	}

	onOpen() {
		this.renderComponent.load();
		const { contentEl } = this;
		contentEl.addClass("rnd-modal");

		const labelText = this.scopeHeading
			? `Random pick from ${this.scopeHeading}`
			: "Random pick";
		contentEl.createEl("p", { cls: "rnd-modal__label", text: labelText });

		this.resultEl = contentEl.createEl("div", { cls: "rnd-modal__result" });
		this.resultTextWrapEl = this.resultEl.createEl("div", { cls: "rnd-modal__result-content" });

		this.copyBtnEl = this.resultEl.createEl("div", {
			cls: "clickable-icon rnd-modal__copy-btn",
		});
		this.copyBtnEl.setAttribute("aria-label", "Copy result");
		this.copyBtnEl.setAttribute("role", "button");
		setIcon(this.copyBtnEl, "copy");
		this.copyBtnEl.addEventListener("click", () => void this.copyResult());

		void this.renderResult();

		const btnRow = contentEl.createEl("div", { cls: "rnd-modal__buttons" });

		this.againBtnEl = btnRow.createEl("button", {
			cls:  "rnd-modal__btn rnd-modal__btn--primary",
			text: "Roll again",
		});
		this.againBtnEl.addEventListener("click", () => {
			this.currentItem = this.pick(this.currentItem);
			void this.renderResult();
			this.updateToggleBtn();
			this.updateAgainBtn();
		});
		this.updateAgainBtn();

		const hasAnyCheckbox = this.allItems.some(i => i.isCheckbox);
		if (hasAnyCheckbox) {
			this.toggleBtnEl = btnRow.createEl("button", {
				cls:  "rnd-modal__btn rnd-modal__btn--secondary",
				text: "",
			});
			this.updateToggleBtn();
			this.toggleBtnEl.addEventListener("click", () => {
				void (async () => {
					const item = this.currentItem;
					if (!item || !item.isCheckbox) return;

					const markDone = !item.isDone;
					await this.onToggleDone(item, markDone);
					item.isDone = markDone;

					// Update item text to reflect timestamp change in the modal
					if (markDone && this.addDoneTimestamp) {
						item.text = item.text + buildTimestamp();
					} else if (!markDone) {
						item.text = stripTimestamp(item.text);
					}

					new Notice(markDone
						? `Marked done: ${item.text}`
						: `Marked undone: ${item.text}`
					);

					this.pool = this.buildPool();
					await this.renderResult();
					this.updateToggleBtn();
					this.updateAgainBtn();
				})();
			});
		}

		this.goToBtnEl = btnRow.createEl("button", {
			cls:  "rnd-modal__btn rnd-modal__btn--secondary rnd-modal__goto-btn",
			text: "Go to line",
		});
		this.goToBtnEl.addEventListener("click", () => {
			if (!this.currentItem) return;
			this.goToLine(this.currentItem.lineIndex);
			this.close();
		});
	}

	// Opens the source file at the given line (0-indexed), places the cursor
	// at the end of the line, and scrolls it into view.
	private goToLine(lineIndex: number) {
		const file = this.app.vault.getAbstractFileByPath(this.sourcePath);
		if (!(file instanceof TFile)) return;

		void this.app.workspace.getLeaf(false).openFile(file).then(() => {
			const leaf = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!leaf) return;

			const editor = leaf.editor;
			const lineText = editor.getLine(lineIndex) ?? "";
			const pos = { line: lineIndex, ch: lineText.length };

			editor.setCursor(pos);
			editor.scrollIntoView({ from: pos, to: pos }, true);
		});
	}

	private async renderResult() {
		this.resultTextWrapEl.empty();
		this.renderComponent.unload();
		this.renderComponent = new Component();
		this.renderComponent.load();

		if (!this.currentItem) {
			this.resultTextWrapEl.createEl("span", {
				cls:  "rnd-modal__result-empty",
				text: "No items available.",
			});
			this.copyBtnEl.addClass("is-hidden");
			return;
		}
		this.copyBtnEl.removeClass("is-hidden");

		const item = this.currentItem;
		const container = item.isDone
			? this.resultTextWrapEl.createEl("s", { cls: "rnd-modal__result-done" })
			: this.resultTextWrapEl;

		if (item.orderedNumber !== null) {
			container.createEl("span", { cls: "rnd-modal__result-num", text: `${item.orderedNumber}. ` });
		}

		const mdContainer = container.createEl("span", { cls: "rnd-modal__result-text" });
		await MarkdownRenderer.render(
			this.app,
			item.text,
			mdContainer,
			this.sourcePath,
			this.renderComponent
		);

		// MarkdownRenderer wraps in <p>; unwrap for inline display
		const p = mdContainer.querySelector("p");
		if (p) {
			while (p.firstChild) mdContainer.insertBefore(p.firstChild, p);
			p.remove();
		}
	}

	// Copy the rendered result with rich formatting, falling back to plain text.
	private async copyResult() {
		if (!this.currentItem) return;

		// Read-only: copying existing rendered DOM to the clipboard, not writing
		// user input back into the page (no injection risk).
		const html = this.resultTextWrapEl.innerHTML;
		const text = this.resultTextWrapEl.innerText;

		try {
			if (navigator.clipboard && "write" in navigator.clipboard) {
				const clipboardData: Record<string, Blob> = {
					"text/html":  new Blob([html], { type: "text/html" }),
					"text/plain": new Blob([text], { type: "text/plain" }),
				};
				const item: ClipboardItem = new ClipboardItem(clipboardData);
				await navigator.clipboard.write([item]);
			} else {
				await navigator.clipboard.writeText(text);
			}
		} catch {
			// Fallback if rich write is blocked for any reason
			await navigator.clipboard.writeText(text);
		}

		// Brief visual confirmation: swap icon to a checkmark, then back
		setIcon(this.copyBtnEl, "check");
		window.setTimeout(() => {
			if (this.copyBtnEl) setIcon(this.copyBtnEl, "copy");
		}, 500);
	}

	private updateAgainBtn() {
		// Disabled when pool has nothing other than the current item
		const canRoll = this.pool.length > 1 ||
			(this.pool.length === 1 && this.currentItem !== null && this.pool[0].lineIndex !== this.currentItem.lineIndex);
		this.againBtnEl.disabled = !canRoll;
	}

	private updateToggleBtn() {
		if (!this.toggleBtnEl) return;
		if (!this.currentItem || !this.currentItem.isCheckbox) {
			this.toggleBtnEl.addClass("is-hidden");
			return;
		}
		this.toggleBtnEl.removeClass("is-hidden");
		this.toggleBtnEl.textContent = this.currentItem.isDone ? "Mark undone" : "Mark done";
	}

	onClose() {
		this.renderComponent.unload();
		this.contentEl.empty();
	}
}

// ─── CM6 Widget ───────────────────────────────────────────────────────────────

class RndWidget extends WidgetType {
	constructor(
		private readonly plugin: RandomListPlugin,
		private readonly lineIndex: number,
		private readonly flagsRaw: string | undefined
	) { super(); }

	toDOM(): HTMLElement {
		const btn = createEl("button");
		btn.className = "clickable-icon rnd-trigger";
		btn.setAttribute("aria-label", "Pick a random list item");
		this.plugin.renderButtonContent(btn);

		btn.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.plugin.openModal(this.lineIndex, this.flagsRaw);
		});

		return btn;
	}

	eq(other: RndWidget): boolean {
		return other.lineIndex === this.lineIndex &&
		       other.flagsRaw === this.flagsRaw &&
		       other.plugin.getButtonText() === this.plugin.getButtonText() &&
		       other.plugin.settingsVersion === this.plugin.settingsVersion;
	}

	ignoreEvent() { return false; }
}

// ─── CM6 ViewPlugin ───────────────────────────────────────────────────────────

function buildRndDecorations(view: EditorView, plugin: RandomListPlugin): DecorationSet {
	const builder   = new RangeSetBuilder<Decoration>();
	const { doc, selection } = view.state;
	const selRanges = Array.from({ length: selection.ranges.length }, (_, i) => selection.ranges[i]);

	// Only scan visible ranges for performance
	for (const { from, to } of view.visibleRanges) {
		const startLine = doc.lineAt(from).number;
		const endLine   = doc.lineAt(to).number;

		for (let i = startLine; i <= endLine; i++) {
			const line = doc.line(i);
			RND_RE.lastIndex = 0;
			let match: RegExpExecArray | null;

			while ((match = RND_RE.exec(line.text)) !== null) {
				const tokenFrom = line.from + match.index;
				const tokenTo   = tokenFrom + match[0].length;
				const cursorInside = selRanges.some(r => r.from <= tokenTo && r.to >= tokenFrom);
				if (cursorInside) continue;
				builder.add(tokenFrom, tokenTo, Decoration.replace({
					widget: new RndWidget(plugin, i - 1, match[1]),
				}));
			}
		}
	}
	return builder.finish();
}

class RndViewPlugin implements PluginValue {
	decorations: DecorationSet;

	constructor(view: EditorView, private plugin: RandomListPlugin) {
		this.decorations = buildRndDecorations(view, plugin);
	}

	update(update: ViewUpdate) {
		if (update.docChanged || update.selectionSet || update.viewportChanged) {
			this.decorations = buildRndDecorations(update.view, this.plugin);
		}
	}

	destroy() {}
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class RndSettingTab extends PluginSettingTab {
	plugin: RandomListPlugin;

	constructor(app: App, plugin: RandomListPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Button text")
			.setDesc("Use the default dice icon, or enter your own label.")
			.addDropdown(drop => drop
				.addOption("default", "Default (dice icon)")
				.addOption("custom", "Custom")
				.setValue(this.plugin.settings.useCustomButtonText ? "custom" : "default")
				.onChange(async (val) => {
					this.plugin.settings.useCustomButtonText = val === "custom";
					await this.plugin.saveSettings();
					this.display();
				})
			);

		if (this.plugin.settings.useCustomButtonText) {
			new Setting(containerEl)
				.setName("Custom button label")
				.setDesc("Text shown on the inline button.")
				.addText(text => text
					.setPlaceholder("Pick, roll, ?")
					.setValue(this.plugin.settings.customButtonText)
					.onChange(async (val) => {
						this.plugin.settings.customButtonText = val;
						await this.plugin.saveSettings();
					})
				);
		}

		new Setting(containerEl)
			.setName("Include done items")
			.setDesc("When enabled, checked-off items are included in the random pool (shown with strikethrough).")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.includeDone)
				.onChange(async (val) => {
					this.plugin.settings.includeDone = val;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Done timestamp")
			.setDesc("Append a tasks-compatible timestamp (✅ yyyy-mm-dd) when marking an item done. Removed when marking undone.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.addDoneTimestamp)
				.onChange(async (val) => {
					this.plugin.settings.addDoneTimestamp = val;
					await this.plugin.saveSettings();
				})
			);
	}
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class RandomListPlugin extends Plugin {
	settings!: RndSettings;
	settingsVersion = 0;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new RndSettingTab(this.app, this));

		this.registerMarkdownPostProcessor((el, ctx) => this.processElement(el, ctx));

		const viewPluginSpec: PluginSpec<RndViewPlugin> = {
			decorations: (v) => v.decorations,
		};
		this.registerEditorExtension(
			ViewPlugin.define((view) => new RndViewPlugin(view, this), viewPluginSpec)
		);

		this.addCommand({
			id: "random-pick-whole-document",
			name: "Whole document",
			callback: () => { void this.runCommandWholeDoc(); },
		});

		this.addCommand({
			id: "random-pick-cursor-position",
			name: "From current position",
			editorCallback: (editor) => { void this.runCommandCursor(editor); },
		});
	}

	onunload() {}

	async loadSettings() {
		const loaded = (await this.loadData()) as Partial<RndSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.settingsVersion++;
		this.forceDecorationRebuild();
	}

	// Dispatch a no-op transaction on every open editor to trigger decoration rebuild.
	private forceDecorationRebuild() {
		this.app.workspace.iterateAllLeaves(leaf => {
			const view = leaf.view;
			// @ts-expect-error — accessing the CM6 editor view through Obsidian's internal property
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- `cm` is Obsidian's undocumented internal property exposing the CM6 EditorView; no public type exists for it.
			const editorView = (view.editor?.cm) as EditorView | undefined;
			if (editorView) {
				editorView.dispatch({});
			}
		});
	}

	getButtonText(): string {
		return this.settings.useCustomButtonText
			? (this.settings.customButtonText || DEFAULT_BUTTON_TEXT)
			: DEFAULT_BUTTON_TEXT;
	}

	// Renders the button's inner content: Lucide "dices" icon by default,
	// or plain custom text when the user has set one.
	renderButtonContent(btn: HTMLElement) {
		btn.empty();
		if (this.settings.useCustomButtonText && this.settings.customButtonText) {
			btn.textContent = this.settings.customButtonText;
			btn.removeClass("rnd-trigger--icon");
		} else {
			setIcon(btn, "dices");
			btn.addClass("rnd-trigger--icon");
		}
	}

	// ── Open modal (CM6 path) ─────────────────────────────────────────────────

	async openModal(triggerLineIndex: number, flagsRaw?: string) {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) { new Notice("No active file."); return; }
		const content = await this.app.vault.read(activeFile);
		this.showModal(content.split("\n"), triggerLineIndex, activeFile, parseRndFlags(flagsRaw));
	}

	private showModal(lines: string[], triggerLineIndex: number, file: TFile, overrides: RndOverrides = {}) {
		const includeDone      = overrides.includeDone      ?? this.settings.includeDone;
		const addDoneTimestamp = overrides.addDoneTimestamp ?? this.settings.addDoneTimestamp;

		const { start, end } = getScopeLines(lines, triggerLineIndex);
		const items = extractListItems(lines, start, end, includeDone);

		if (items.length === 0) {
			new Notice("No list items found in scope.");
			return;
		}

		new RandomPickModal(
			this.app,
			items,
			findScopeHeading(lines, triggerLineIndex),
			includeDone,
			addDoneTimestamp,
			file.path,
			async (item, markDone) => { await this.toggleItemDone(file, item, markDone, addDoneTimestamp); }
		).open();
	}

	// ── Commands ──────────────────────────────────────────────────────────────

	private async runCommandWholeDoc() {
		const file = this.app.workspace.getActiveFile();
		if (!file) { new Notice("No active file."); return; }

		const content = await this.app.vault.read(file);
		const lines   = content.split("\n");
		const items   = extractListItems(lines, 0, lines.length, this.settings.includeDone);

		if (items.length === 0) {
			new Notice("No list items found in document.");
			return;
		}

		new RandomPickModal(
			this.app,
			items,
			null,
			this.settings.includeDone,
			this.settings.addDoneTimestamp,
			file.path,
			async (item, markDone) => { await this.toggleItemDone(file, item, markDone, this.settings.addDoneTimestamp); }
		).open();
	}

	private async runCommandCursor(editor: import("obsidian").Editor) {
		const file = this.app.workspace.getActiveFile();
		if (!file) { new Notice("No active file."); return; }

		const content        = await this.app.vault.read(file);
		const lines          = content.split("\n");
		const triggerLineIndex = editor.getCursor().line;

		this.showModal(lines, triggerLineIndex, file);
	}

	// ── Reading mode ──────────────────────────────────────────────────────────

	private processElement(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		const nodes: Text[] = [];
		let node: Text | null;
		while ((node = walker.nextNode() as Text | null)) {
			if (node.textContent && /\{\{rnd(?::[^}]*)?\}\}/.test(node.textContent)) nodes.push(node);
		}
		for (const n of nodes) this.replaceTextNode(n, ctx);
	}

	private replaceTextNode(textNode: Text, ctx: MarkdownPostProcessorContext) {
		const parent = textNode.parentNode;
		if (!parent) return;
		const ownerDoc = textNode.ownerDocument;
		const text = textNode.textContent;

		const matchRe = /\{\{rnd(?::([^}]*))?\}\}/g;
		const frag = ownerDoc.createDocumentFragment();
		let lastIndex = 0;
		let occurrence = 0;
		let match: RegExpExecArray | null;

		while ((match = matchRe.exec(text)) !== null) {
			const before = text.slice(lastIndex, match.index);
			if (before) frag.appendChild(ownerDoc.createTextNode(before));
			frag.appendChild(this.createReadingBtn(ctx, occurrence, match[1]));
			lastIndex = match.index + match[0].length;
			occurrence++;
		}
		const rest = text.slice(lastIndex);
		if (rest) frag.appendChild(ownerDoc.createTextNode(rest));

		parent.replaceChild(frag, textNode);
	}

	private createReadingBtn(ctx: MarkdownPostProcessorContext, occurrenceIndex: number, flagsRaw: string | undefined): HTMLElement {
		const btn = createEl("button");
		btn.className = "clickable-icon rnd-trigger";
		btn.setAttribute("aria-label", "Pick a random list item");
		this.renderButtonContent(btn);

		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			void (async () => {
				const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
				if (!(file instanceof TFile)) { new Notice("Could not find the note file."); return; }

				const content = await this.app.vault.read(file);
				const lines   = content.split("\n");

				// Find the nth (occurrenceIndex) occurrence of {{rnd}} within the section
				const sectionInfo = ctx.getSectionInfo(btn);
				let triggerLine   = 0;
				let found         = 0;

				const lineStart = sectionInfo?.lineStart ?? 0;
				const lineEnd   = sectionInfo?.lineEnd   ?? lines.length - 1;
				const lineRe    = /\{\{rnd(?::[^}]*)?\}\}/;

				for (let i = lineStart; i <= lineEnd; i++) {
					if (lineRe.test(lines[i] ?? "")) {
						if (found === occurrenceIndex) { triggerLine = i; break; }
						found++;
					}
				}

				this.showModal(lines, triggerLine, file, parseRndFlags(flagsRaw));
			})();
		});

		return btn;
	}

	// ── Toggle done ───────────────────────────────────────────────────────────

	async toggleItemDone(file: TFile, item: ListItem, markDone: boolean, addDoneTimestamp: boolean) {
		const content = await this.app.vault.read(file);
		const lines   = content.split("\n");
		let line      = lines[item.lineIndex];

		if (markDone) {
			line = line.replace(/^(\s*(?:-|\d+\.)\s)\[ \]/, "$1[x]");
			if (addDoneTimestamp) line = line + buildTimestamp();
		} else {
			line = line.replace(/^(\s*(?:-|\d+\.)\s)\[x\]/i, "$1[ ]");
			line = stripTimestamp(line);
		}

		lines[item.lineIndex] = line;
		await this.app.vault.modify(file, lines.join("\n"));
	}
}
