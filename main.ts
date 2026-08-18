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
	SettingDefinitionItem,
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

import {
	buildSkipMask,
	buildTimestamp,
	diceBreakdown,
	extractListItems,
	findScopeHeading,
	getScopeLines,
	inlineCodeRanges,
	isInsideRanges,
	lineMatchesItem,
	parseDiceSuffix,
	parseRndFlags,
	rewriteDoneState,
	findTokenLine,
	RND_RE,
	rollDice,
	stripTimestamp,
} from "./parsing";

import type { DiceRoll, DiceSpec, ListItem, NestingMode, RndOverrides } from "./parsing";

// ─── Settings ─────────────────────────────────────────────────────────────────

// Shared by display() and getSettingDefinitions() so the two renderings of the
// same settings can't drift. The flags line is kept separate from the prose so
// each renderer can join them the way it can afford to.
interface SettingDesc {
	text: string;
	flags?: string;
}

const SETTING_DESC: Record<string, SettingDesc> = {
	useCustomButtonText: {
		text: "Use your own label on the inline button instead of the dice icon.",
	},
	customButtonText: {
		text: "Text shown on the inline button.",
	},
	includeDone: {
		text:  "When enabled, checked-off items are included in the random pool (shown with strikethrough).",
		flags: "Per-button flags: {{rnd:done}}, {{rnd:nodone}}",
	},
	nestingMode: {
		text:  "Which items in an indented list can be picked.",
		flags: "Per-button flags: {{rnd:depth-leaves}}, {{rnd:depth-top}}, {{rnd:depth-all}}",
	},
	noRepeat: {
		text:  "Roll again works through every item in scope before any of them can come up a second time.",
		flags: "Per-button flags: {{rnd:norepeat}}, {{rnd:repeat}}",
	},
	addDoneTimestamp: {
		text:  "Append a tasks-compatible timestamp (✅ yyyy-mm-dd) when marking an item done. Removed when marking undone.",
		flags: "Per-button flags: {{rnd:ts}}, {{rnd:nots}}",
	},
};

// display() rebuilds its settings on every call, so a fragment is safe here and
// buys the flags their own line.
function descFragment(d: SettingDesc): DocumentFragment {
	return createFragment(frag => {
		frag.appendText(d.text);
		if (d.flags) {
			frag.createEl("br");
			frag.appendText(d.flags);
		}
	});
}

// The declarative API keeps a plain string on purpose: a DocumentFragment is
// emptied when it is inserted, so if Obsidian ever re-renders from a cached
// definition array the description would silently vanish. Same words, one line.
function descText(d: SettingDesc): string {
	return d.flags ? `${d.text} ${d.flags}.` : d.text;
}

// A crumb longer than this gets a native tooltip carrying the full text, since
// CSS will be truncating it. Short ones are left alone to avoid tooltip noise.
const CRUMB_TOOLTIP_THRESHOLD = 40;

interface RndSettings {
	useCustomButtonText: boolean;
	customButtonText: string;
	includeDone: boolean;
	addDoneTimestamp: boolean;
	noRepeatUntilExhausted: boolean;
	nestingMode: NestingMode;
}

const DEFAULT_SETTINGS: RndSettings = {
	useCustomButtonText: false,
	customButtonText: "",
	includeDone: false,
	addDoneTimestamp: false,
	noRepeatUntilExhausted: true,
	nestingMode: "leaves",
};

const DEFAULT_BUTTON_TEXT = "🎲";

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Brief visual confirmation on a copy button: swap the icon to a checkmark and
// back. Uses the button's own window so it also fires inside popout windows.
function flashCopyIcon(btn: HTMLElement) {
	setIcon(btn, "check");
	btn.win.setTimeout(() => setIcon(btn, "copy"), 500);
}

// ─── Modal ────────────────────────────────────────────────────────────────────

interface PickModalOptions {
	items: ListItem[];
	scopeHeading: string | null;
	includeDone: boolean;
	addDoneTimestamp: boolean;
	noRepeat: boolean;
	sourcePath: string;
	// Resolves false when the note moved on and nothing was written
	onToggleDone: (item: ListItem, markDone: boolean) => Promise<boolean>;
}

class RandomPickModal extends Modal {
	private allItems: ListItem[];
	private pool: ListItem[];
	private currentItem: ListItem | null;
	private includeDone: boolean;
	private addDoneTimestamp: boolean;
	private noRepeat: boolean;
	// Items already shown in the current cycle, by line index
	private seen = new Set<number>();
	private onToggleDone: (item: ListItem, markDone: boolean) => Promise<boolean>;
	private scopeHeading: string | null;
	private sourcePath: string;
	private resultEl!: HTMLElement;
	private resultTextWrapEl!: HTMLElement;
	private resultBodyEl!: HTMLElement;
	private copyBtnEl!: HTMLButtonElement;
	private againBtnEl!: HTMLButtonElement;
	private toggleBtnEl: HTMLButtonElement | null = null;
	private goToBtnEl!: HTMLButtonElement;
	private renderComponent: Component;

	constructor(app: App, opts: PickModalOptions) {
		super(app);
		this.allItems         = [...opts.items];
		this.includeDone      = opts.includeDone;
		this.addDoneTimestamp = opts.addDoneTimestamp;
		this.noRepeat         = opts.noRepeat;
		this.scopeHeading     = opts.scopeHeading;
		this.sourcePath       = opts.sourcePath;
		this.onToggleDone     = opts.onToggleDone;
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

		if (this.noRepeat) {
			let candidates = this.pool.filter(i => !this.seen.has(i.lineIndex));
			if (candidates.length === 0) {
				// Everything has come up once — refill the bag, still avoiding an
				// immediate repeat of whatever is on screen
				this.seen.clear();
				candidates = exclude ? this.pool.filter(i => i.lineIndex !== exclude.lineIndex) : this.pool;
				if (candidates.length === 0) candidates = this.pool;
			}
			const chosen = candidates[Math.floor(Math.random() * candidates.length)];
			this.seen.add(chosen.lineIndex);
			return chosen;
		}

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
		this.modalEl.addClass("rnd-modal-host");

		// Obsidian's own title slot, so the dialog has an accessible name
		this.titleEl.setText(this.scopeHeading
			? `Random pick from ${this.scopeHeading}`
			: "Random pick");

		this.resultEl = contentEl.createDiv({ cls: "rnd-modal__result" });
		this.resultTextWrapEl = this.resultEl.createDiv({ cls: "rnd-modal__result-content" });

		this.copyBtnEl = this.resultEl.createEl("button", {
			cls: "clickable-icon rnd-modal__copy-btn",
		});
		this.copyBtnEl.setAttribute("aria-label", "Copy result");
		setIcon(this.copyBtnEl, "copy");
		this.copyBtnEl.addEventListener("click", () => void this.copyResult());

		void this.renderResult();

		const btnRow = contentEl.createDiv({ cls: "rnd-modal__buttons" });

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
					if (!await this.onToggleDone(item, markDone)) return;
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

		// Move focus into the dialog and put it on the action people repeat, so
		// Enter rerolls without reaching for the mouse
		this.againBtnEl.focus();
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

	// Renders the ancestor chain above the pick, so a nested result still reads
	// in context — "Tacos al pastor" alone doesn't say which cuisine it came from.
	private renderCrumbs(item: ListItem) {
		if (item.parents.length === 0) return;
		const crumbs = this.resultTextWrapEl.createDiv({ cls: "rnd-modal__crumbs" });
		for (const parent of item.parents) {
			const crumb = crumbs.createSpan({ cls: "rnd-modal__crumb", text: parent });
			// title, not aria-label: the text is already in the accessibility tree,
			// and CSS truncation does not remove it
			if (parent.length > CRUMB_TOOLTIP_THRESHOLD) crumb.title = parent;
		}
	}

	private async renderResult() {
		this.resultTextWrapEl.empty();
		this.renderComponent.unload();
		this.renderComponent = new Component();
		this.renderComponent.load();

		if (!this.currentItem) {
			this.resultBodyEl = this.resultTextWrapEl.createDiv({ cls: "rnd-modal__result-body" });
			this.resultBodyEl.createSpan({
				cls:  "rnd-modal__result-empty",
				text: "No items available.",
			});
			this.copyBtnEl.addClass("rnd-is-hidden");
			return;
		}
		this.copyBtnEl.removeClass("rnd-is-hidden");

		const item = this.currentItem;
		this.renderCrumbs(item);

		// The copy button reads from this element, so the crumbs stay out of it
		this.resultBodyEl = this.resultTextWrapEl.createDiv({ cls: "rnd-modal__result-body" });
		const container = item.isDone
			? this.resultBodyEl.createEl("s", { cls: "rnd-modal__result-done" })
			: this.resultBodyEl;

		if (item.orderedNumber !== null) {
			container.createSpan({ cls: "rnd-modal__result-num", text: `${item.orderedNumber}. ` });
		}

		const mdContainer = container.createSpan({ cls: "rnd-modal__result-text" });
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
		const html = this.resultBodyEl.innerHTML;
		const text = this.resultBodyEl.innerText;

		try {
			const clipboardData: Record<string, Blob> = {
				"text/html":  new Blob([html], { type: "text/html" }),
				"text/plain": new Blob([text], { type: "text/plain" }),
			};
			await navigator.clipboard.write([new ClipboardItem(clipboardData)]);
		} catch {
			// Fallback if rich write is unavailable or blocked
			await navigator.clipboard.writeText(text);
		}

		flashCopyIcon(this.copyBtnEl);
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
			this.toggleBtnEl.addClass("rnd-is-hidden");
			return;
		}
		this.toggleBtnEl.removeClass("rnd-is-hidden");
		this.toggleBtnEl.textContent = this.currentItem.isDone ? "Mark undone" : "Mark done";
	}

	onClose() {
		this.renderComponent.unload();
		this.contentEl.empty();
	}
}

// ─── Dice modal ───────────────────────────────────────────────────────────────

class DiceRollModal extends Modal {
	private spec: DiceSpec;
	private roll: DiceRoll;
	private totalEl!: HTMLElement;
	private breakdownEl!: HTMLElement;
	private copyBtnEl!: HTMLButtonElement;

	constructor(app: App, spec: DiceSpec) {
		super(app);
		this.spec = spec;
		this.roll = rollDice(spec);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("rnd-modal");
		this.modalEl.addClass("rnd-modal-host");
		this.titleEl.setText(`Dice roll ${this.spec.notation}`);

		const resultEl    = contentEl.createDiv({ cls: "rnd-modal__result rnd-modal__result--dice" });
		const contentWrap = resultEl.createDiv({ cls: "rnd-modal__result-content" });
		this.totalEl      = contentWrap.createDiv({ cls: "rnd-modal__dice-total" });
		this.breakdownEl  = contentWrap.createDiv({ cls: "rnd-modal__dice-breakdown" });

		this.copyBtnEl = resultEl.createEl("button", { cls: "clickable-icon rnd-modal__copy-btn" });
		this.copyBtnEl.setAttribute("aria-label", "Copy result");
		setIcon(this.copyBtnEl, "copy");
		this.copyBtnEl.addEventListener("click", () => void this.copyResult());

		this.renderResult();

		const btnRow   = contentEl.createDiv({ cls: "rnd-modal__buttons" });
		const againBtn = btnRow.createEl("button", {
			cls:  "rnd-modal__btn rnd-modal__btn--primary",
			text: "Roll again",
		});
		againBtn.addEventListener("click", () => {
			this.roll = rollDice(this.spec);
			this.renderResult();
		});

		againBtn.focus();
	}

	private renderResult() {
		this.totalEl.setText(String(this.roll.total));

		const breakdown = diceBreakdown(this.spec, this.roll);
		this.breakdownEl.setText(breakdown ?? "");
		this.breakdownEl.toggleClass("rnd-is-hidden", breakdown === null);
	}

	private async copyResult() {
		await navigator.clipboard.writeText(String(this.roll.total));
		flashCopyIcon(this.copyBtnEl);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ─── CM6 Widget ───────────────────────────────────────────────────────────────

class RndWidget extends WidgetType {
	constructor(
		private readonly plugin: RandomListPlugin,
		private readonly lineIndex: number,
		private readonly flagsRaw: string | undefined,
		private readonly dice: DiceSpec | null
	) { super(); }

	toDOM(): HTMLElement {
		const btn = createEl("button");
		btn.className = "clickable-icon rnd-trigger";

		if (this.dice) {
			btn.setAttribute("aria-label", `Roll ${this.dice.notation}`);
			this.plugin.renderDiceButtonContent(btn, this.dice.notation);
		} else {
			btn.setAttribute("aria-label", "Pick a random list item");
			this.plugin.renderButtonContent(btn);
		}

		// mousedown only suppresses CodeMirror moving the caret into the widget;
		// the action itself hangs off click, which also covers touch taps and
		// Enter/Space once the button has keyboard focus
		btn.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
		});

		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (this.dice) {
				this.plugin.openDiceModal(this.dice);
			} else {
				void this.plugin.openModal(this.lineIndex, this.flagsRaw);
			}
		});

		return btn;
	}

	eq(other: RndWidget): boolean {
		return other.lineIndex === this.lineIndex &&
		       other.flagsRaw === this.flagsRaw &&
		       other.dice?.raw === this.dice?.raw &&
		       other.plugin.getButtonText() === this.plugin.getButtonText() &&
		       other.plugin.settingsVersion === this.plugin.settingsVersion;
	}

	ignoreEvent() { return false; }
}

// ─── CM6 ViewPlugin ───────────────────────────────────────────────────────────

interface FoundToken {
	line: number;   // 1-based
	from: number;
	to: number;
	flagsRaw: string | undefined;
	dice: DiceSpec | null;
}

function buildRndDecorations(
	view: EditorView,
	plugin: RandomListPlugin,
	skipMask: () => boolean[],
): DecorationSet {
	const builder   = new RangeSetBuilder<Decoration>();
	const { doc, selection } = view.state;
	const selRanges = Array.from({ length: selection.ranges.length }, (_, i) => selection.ranges[i]);

	// Visible lines are scanned first, and the frontmatter/fence mask is only
	// asked for once a token has actually turned up. update() runs on every
	// cursor move, so in a note with nothing on screen this now costs nothing.
	const found: FoundToken[] = [];

	for (const { from, to } of view.visibleRanges) {
		const startLine = doc.lineAt(from).number;
		const endLine   = doc.lineAt(to).number;

		for (let i = startLine; i <= endLine; i++) {
			const line = doc.line(i);
			RND_RE.lastIndex = 0;
			let match: RegExpExecArray | null;
			// Only worth computing for a line that turns out to hold a token
			let codeRanges: Array<[number, number]> | null = null;

			while ((match = RND_RE.exec(line.text)) !== null) {
				const tokenEnd  = match.index + match[0].length;
				const dice      = parseDiceSuffix(line.text.slice(tokenEnd));
				const sourceEnd = tokenEnd + (dice ? dice.raw.length : 0);

				// A dice suffix is part of the token's source text, so the widget
				// replaces both and the next iteration starts past it
				RND_RE.lastIndex = sourceEnd;

				// A token inside `backticks` is literal text, not a button
				codeRanges ??= inlineCodeRanges(line.text);
				if (isInsideRanges(match.index, codeRanges)) continue;

				const tokenFrom = line.from + match.index;
				const tokenTo   = line.from + sourceEnd;
				const cursorInside = selRanges.some(r => r.from <= tokenTo && r.to >= tokenFrom);
				if (cursorInside) continue;

				found.push({ line: i, from: tokenFrom, to: tokenTo, flagsRaw: match[1], dice });
			}
		}
	}

	if (found.length === 0) return builder.finish();

	const skip = skipMask();
	for (const m of found) {
		if (skip[m.line - 1]) continue;
		builder.add(m.from, m.to, Decoration.replace({
			widget: new RndWidget(plugin, m.line - 1, m.flagsRaw, m.dice),
		}));
	}
	return builder.finish();
}

class RndViewPlugin implements PluginValue {
	decorations: DecorationSet;
	// Frontmatter and fence state depend on the whole document, so the mask is
	// cached and rebuilt only when the text actually changes. Cursor moves and
	// scrolling fire update() far more often than edits do, and neither of them
	// can change which lines are code.
	private skipMask: boolean[] | null = null;

	constructor(view: EditorView, private plugin: RandomListPlugin) {
		this.decorations = buildRndDecorations(view, plugin, () => this.getSkipMask(view));
	}

	private getSkipMask(view: EditorView): boolean[] {
		this.skipMask ??= buildSkipMask(view.state.doc.toString().split("\n"));
		return this.skipMask;
	}

	update(update: ViewUpdate) {
		if (update.docChanged) this.skipMask = null;
		if (update.docChanged || update.selectionSet || update.viewportChanged) {
			this.decorations = buildRndDecorations(
				update.view, this.plugin, () => this.getSkipMask(update.view));
		}
	}

	destroy() {}
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class RndSettingTab extends PluginSettingTab {
	plugin: RandomListPlugin;
	private customLabelSetting: Setting | null = null;

	constructor(app: App, plugin: RandomListPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Custom button text")
			.setDesc(descFragment(SETTING_DESC.useCustomButtonText))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.useCustomButtonText)
				.onChange(async (val) => {
					this.plugin.settings.useCustomButtonText = val;
					await this.plugin.saveSettings();
					this.syncCustomLabelVisibility();
				})
			);

		// Built once and hidden, rather than re-rendering the whole tab on every
		// dropdown change — a re-render throws away focus and scroll position
		this.customLabelSetting = new Setting(containerEl)
			.setName("Custom button label")
			.setDesc(descFragment(SETTING_DESC.customButtonText))
			.addText(text => text
				.setPlaceholder("Pick, roll, ?")
				.setValue(this.plugin.settings.customButtonText)
				.onChange(async (val) => {
					this.plugin.settings.customButtonText = val;
					await this.plugin.saveSettings();
				})
			);
		this.syncCustomLabelVisibility();

		new Setting(containerEl)
			.setName("Include done items")
			.setDesc(descFragment(SETTING_DESC.includeDone))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.includeDone)
				.onChange(async (val) => {
					this.plugin.settings.includeDone = val;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Nested items")
			.setDesc(descFragment(SETTING_DESC.nestingMode))
			.addDropdown(drop => drop
				.addOption("leaves", "Innermost only")
				.addOption("top", "Top level only")
				.addOption("all", "Every item")
				.setValue(this.plugin.settings.nestingMode)
				.onChange(async (val) => {
					this.plugin.settings.nestingMode = val as NestingMode;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("No repeats until all shown")
			.setDesc(descFragment(SETTING_DESC.noRepeat))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.noRepeatUntilExhausted)
				.onChange(async (val) => {
					this.plugin.settings.noRepeatUntilExhausted = val;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Done timestamp")
			.setDesc(descFragment(SETTING_DESC.addDoneTimestamp))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.addDoneTimestamp)
				.onChange(async (val) => {
					this.plugin.settings.addDoneTimestamp = val;
					await this.plugin.saveSettings();
				})
			);
	}

	private syncCustomLabelVisibility() {
		this.customLabelSetting?.settingEl.toggleClass(
			"rnd-is-hidden", !this.plugin.settings.useCustomButtonText);
	}

	// Declarative mirror of display(), which is what puts these settings into
	// Obsidian 1.13+ global search. Every control binds straight to a key in
	// plugin.settings, so no getControlValue/setControlValue overrides are needed
	// and minAppVersion can stay well below 1.13. Obsidian bypasses display()
	// entirely once this returns definitions, so the two have to stay in step
	// until minAppVersion reaches 1.13 and display() can be deleted.
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Custom button text",
				desc: descText(SETTING_DESC.useCustomButtonText),
				control: { type: "toggle", key: "useCustomButtonText" },
			},
			{
				name: "Custom button label",
				desc: descText(SETTING_DESC.customButtonText),
				visible: () => this.plugin.settings.useCustomButtonText,
				control: { type: "text", key: "customButtonText" },
			},
			{
				name: "Include done items",
				desc: descText(SETTING_DESC.includeDone),
				control: { type: "toggle", key: "includeDone" },
			},
			{
				name: "Nested items",
				desc: descText(SETTING_DESC.nestingMode),
				control: {
					type: "dropdown",
					key: "nestingMode",
					options: { leaves: "Innermost only", top: "Top level only", all: "Every item" },
				},
			},
			{
				name: "No repeats until all shown",
				desc: descText(SETTING_DESC.noRepeat),
				control: { type: "toggle", key: "noRepeatUntilExhausted" },
			},
			{
				name: "Done timestamp",
				desc: descText(SETTING_DESC.addDoneTimestamp),
				control: { type: "toggle", key: "addDoneTimestamp" },
			},
		];
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

	// Reconfigures registered editor extensions across open editors, which
	// rebuilds the widgets against the new settings. Public API, so no reaching
	// into Obsidian's undocumented CM6 handle.
	private forceDecorationRebuild() {
		this.app.workspace.updateOptions();
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

	// Dice buttons always carry their notation, so a d6 and a d20 button stay
	// distinguishable once the widget has replaced the source token.
	renderDiceButtonContent(btn: HTMLElement, notation: string) {
		btn.empty();
		if (this.settings.useCustomButtonText && this.settings.customButtonText) {
			btn.createSpan({ text: this.settings.customButtonText });
			btn.removeClass("rnd-trigger--icon");
		} else {
			setIcon(btn, "dices");
			btn.addClass("rnd-trigger--icon");
		}
		btn.createSpan({ cls: "rnd-trigger__dice-label", text: notation });
	}

	openDiceModal(dice: DiceSpec) {
		new DiceRollModal(this.app, dice).open();
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
		const noRepeat         = overrides.noRepeat         ?? this.settings.noRepeatUntilExhausted;
		const nesting          = overrides.nesting          ?? this.settings.nestingMode;

		const { start, end } = getScopeLines(lines, triggerLineIndex);
		const items = extractListItems(lines, start, end, includeDone, nesting);

		if (items.length === 0) {
			new Notice("No list items found in scope.");
			return;
		}

		new RandomPickModal(this.app, {
			items,
			scopeHeading: findScopeHeading(lines, triggerLineIndex),
			includeDone,
			addDoneTimestamp,
			noRepeat,
			sourcePath: file.path,
			onToggleDone: (item, markDone) => this.toggleItemDone(file, item, markDone, addDoneTimestamp),
		}).open();
	}

	// ── Commands ──────────────────────────────────────────────────────────────

	private async runCommandWholeDoc() {
		const file = this.app.workspace.getActiveFile();
		if (!file) { new Notice("No active file."); return; }

		const content = await this.app.vault.read(file);
		const lines   = content.split("\n");
		const items   = extractListItems(lines, 0, lines.length, this.settings.includeDone, this.settings.nestingMode);

		if (items.length === 0) {
			new Notice("No list items found in document.");
			return;
		}

		new RandomPickModal(this.app, {
			items,
			scopeHeading: null,
			includeDone: this.settings.includeDone,
			addDoneTimestamp: this.settings.addDoneTimestamp,
			noRepeat: this.settings.noRepeatUntilExhausted,
			sourcePath: file.path,
			onToggleDone: (item, markDone) =>
				this.toggleItemDone(file, item, markDone, this.settings.addDoneTimestamp),
		}).open();
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

	// A {{rnd}} written inside `code` or a code block is documentation about the
	// plugin, not a button — this README renders in Obsidian too.
	private isInsideCode(node: Node, root: HTMLElement): boolean {
		for (let el = node.parentElement; el; el = el.parentElement) {
			if (el.tagName === "CODE" || el.tagName === "PRE") return true;
			if (el === root) break;
		}
		return false;
	}

	private processElement(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		const nodes: Text[] = [];
		let node: Text | null;
		while ((node = walker.nextNode() as Text | null)) {
			if (node.textContent
				&& /\{\{rnd(?::[^}]*)?\}\}/.test(node.textContent)
				&& !this.isInsideCode(node, el)) {
				nodes.push(node);
			}
		}

		// One counter for the whole element: the nth button has to line up with the
		// nth token in the source even when formatting splits the text nodes apart
		const counter = { value: 0 };
		for (const n of nodes) this.replaceTextNode(n, ctx, counter);
	}

	private replaceTextNode(textNode: Text, ctx: MarkdownPostProcessorContext, counter: { value: number }) {
		const parent = textNode.parentNode;
		if (!parent) return;
		const ownerDoc = textNode.ownerDocument;
		const text = textNode.textContent;

		const matchRe = /\{\{rnd(?::([^}]*))?\}\}/g;
		// Obsidian's global helper; nodes are adopted into ownerDoc when inserted
		const frag = createFragment();
		let lastIndex = 0;
		let match: RegExpExecArray | null;

		while ((match = matchRe.exec(text)) !== null) {
			const before = text.slice(lastIndex, match.index);
			if (before) frag.appendChild(ownerDoc.createTextNode(before));

			const tokenEnd = match.index + match[0].length;
			const dice     = parseDiceSuffix(text.slice(tokenEnd));

			frag.appendChild(this.createReadingBtn(ctx, counter.value, match[1], dice));

			lastIndex = tokenEnd + (dice ? dice.raw.length : 0);
			matchRe.lastIndex = lastIndex;
			counter.value++;
		}
		const rest = text.slice(lastIndex);
		if (rest) frag.appendChild(ownerDoc.createTextNode(rest));

		parent.replaceChild(frag, textNode);
	}

	private createReadingBtn(ctx: MarkdownPostProcessorContext, occurrenceIndex: number, flagsRaw: string | undefined, dice: DiceSpec | null): HTMLElement {
		const btn = createEl("button");
		btn.className = "clickable-icon rnd-trigger";

		// A dice roll needs no list and no scope, so it never reads the note back
		if (dice) {
			btn.setAttribute("aria-label", `Roll ${dice.notation}`);
			this.renderDiceButtonContent(btn, dice.notation);
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.openDiceModal(dice);
			});
			return btn;
		}

		btn.setAttribute("aria-label", "Pick a random list item");
		this.renderButtonContent(btn);

		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			void (async () => {
				const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
				if (!(file instanceof TFile)) { new Notice("Could not find the note file."); return; }

				const content = await this.app.vault.read(file);
				const lines   = content.split("\n");

				// Find the nth (occurrenceIndex) token within the rendered section
				const sectionInfo = ctx.getSectionInfo(btn);
				const lineStart   = sectionInfo?.lineStart ?? 0;
				const lineEnd     = sectionInfo?.lineEnd   ?? lines.length - 1;
				const triggerLine = findTokenLine(lines, lineStart, lineEnd, occurrenceIndex);

				this.showModal(lines, triggerLine, file, parseRndFlags(flagsRaw));
			})();
		});

		return btn;
	}

	// ── Toggle done ───────────────────────────────────────────────────────────

	// Resolves false when the note moved on since the modal opened, so the caller
	// can leave the item alone rather than checking off the wrong line. The read
	// and the write happen inside process() so nothing can slip in between them.
	async toggleItemDone(file: TFile, item: ListItem, markDone: boolean, addDoneTimestamp: boolean): Promise<boolean> {
		let applied = false;

		await this.app.vault.process(file, (data) => {
			const lines = data.split("\n");
			if (!lineMatchesItem(lines[item.lineIndex], item)) return data;

			lines[item.lineIndex] = rewriteDoneState(lines[item.lineIndex], markDone, addDoneTimestamp);
			applied = true;
			return lines.join("\n");
		});

		if (!applied) {
			new Notice("That line changed since this pick opened — nothing was marked.");
		}
		return applied;
	}
}
