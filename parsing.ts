// Pure Markdown and list parsing for the plugin. Nothing here imports Obsidian,
// so it runs under `npm test` with node's built-in runner.

// ─── Timestamp ────────────────────────────────────────────────────────────────

// Tasks-compatible format: ✅ YYYY-MM-DD
export const TIMESTAMP_RE = /\s✅\s\d{4}-\d{2}-\d{2}$/;

export function buildTimestamp(now: Date = new Date()): string {
	const yyyy = now.getFullYear();
	const mm   = String(now.getMonth() + 1).padStart(2, "0");
	const dd   = String(now.getDate()).padStart(2, "0");
	return ` ✅ ${yyyy}-${mm}-${dd}`;
}

export function stripTimestamp(line: string): string {
	return line.replace(TIMESTAMP_RE, "");
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ListItem {
	text: string;             // item text without bullet/number/checkbox prefix
	lineIndex: number;
	isCheckbox: boolean;
	isDone: boolean;
	orderedNumber: number | null;
	depth: number;            // nesting level relative to the shallowest item in scope
	isLeaf: boolean;          // no more deeply nested item follows
	parents: string[];        // ancestor item texts, outermost first
}

// Which items in a nested list count as candidates. There is no default that
// suits every list: "- Italian / - Pizza" wants leaves, while "- Hyperion /
// - sci-fi, 1989" wants top level. Hence a setting rather than a guess.
export type NestingMode = "all" | "top" | "leaves";

export interface ParsedListLine {
	indent: string;
	text: string;
	isCheckbox: boolean;
	isDone: boolean;
	isOrdered: boolean;
}

// ─── Markdown parsing ─────────────────────────────────────────────────────────

export const HEADING_RE = /^(#{1,6})\s+(.*)$/;

// Bullet or number prefix. Markdown allows "-", "*" and "+" for unordered lists
// and both "1." and "1)" for ordered ones — Obsidian renders all of them.
const BULLET_SRC = "(?:[-*+]|(\\d+)[.)])";

// A checkbox holds any single character, not just " " and "x": Obsidian themes
// and the Tasks plugin use "/", "-", ">" and others for custom states.
const CHECKBOX_SRC = "(?:\\[([^\\]])\\]\\s)?";

// Groups: 1 indent, 2 ordered number (absent for bullets), 3 checkbox character
// (absent when unchecked-box syntax is missing), 4 item text.
export const LIST_ITEM_RE = new RegExp(`^(\\s*)${BULLET_SRC}\\s${CHECKBOX_SRC}(.+)`);

// The done-state rewriter has to accept the same prefixes the parser does, so
// both are built from BULLET_SRC rather than spelled out twice.
const DONE_STATE_RE = new RegExp(`^(\\s*${BULLET_SRC}\\s)\\[[^\\]]\\]`);

// Matches {{rnd}} or {{rnd:flags}} — group 1 captures the optional flags string
export const RND_RE = /\{\{rnd(?::([^}]*))?\}\}/g;
// The token together with any dice suffix, for stripping it back out of text
export const RND_TOKEN_STRIP_RE = /\{\{rnd(?::[^}]*)?\}\}(?:\d{0,2}d\d{1,4}(?:[+-]\d{1,4})?)?/g;

export interface RndOverrides {
	includeDone?: boolean;
	addDoneTimestamp?: boolean;
	noRepeat?: boolean;
	nesting?: NestingMode;
}

// Parses the comma-separated flags from a {{rnd:flags}} match.
// Unrecognized flags are ignored. Within a group the last flag encountered wins.
// Bare flags (done/nodone, ts/nots, norepeat/repeat) are on/off; a "depth-"
// prefix marks the one flag that chooses among several values rather than two.
export function parseRndFlags(raw: string | undefined): RndOverrides {
	const overrides: RndOverrides = {};
	if (!raw) return overrides;

	const flags = raw.split(",").map(f => f.trim().toLowerCase()).filter(f => f.length > 0);
	for (const flag of flags) {
		switch (flag) {
			case "done":     overrides.includeDone = true;  break;
			case "nodone":   overrides.includeDone = false; break;
			case "ts":       overrides.addDoneTimestamp = true;  break;
			case "nots":     overrides.addDoneTimestamp = false; break;
			case "norepeat": overrides.noRepeat = true;  break;
			case "repeat":   overrides.noRepeat = false; break;
			case "depth-all":    overrides.nesting = "all";    break;
			case "depth-top":    overrides.nesting = "top";    break;
			case "depth-leaves": overrides.nesting = "leaves"; break;
			// unrecognized flags are silently ignored
		}
	}
	return overrides;
}

export function stripMarkdown(text: string): string {
	return text
		.replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, (_match: string, link: string, alias?: string) => alias ? alias.slice(1) : link)
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/_([^_]+)_/g, "$1")
		.replace(/~~([^~]+)~~/g, "$1")
		.replace(RND_TOKEN_STRIP_RE, "")
		.trim();
}

const TAB_WIDTH = 4;

// Visual column width of an indent, so a tab-indented child and a space-indented
// one nest identically. Raw string comparison would treat them as different.
export function indentWidth(indent: string): number {
	let w = 0;
	for (const ch of indent) {
		if (ch === "\t") w += TAB_WIDTH - (w % TAB_WIDTH);
		else w += 1;
	}
	return w;
}

export function parseListLine(line: string): ParsedListLine | null {
	const m = LIST_ITEM_RE.exec(line);
	if (!m) return null;

	const checkboxChar = m[3];
	const isCheckbox   = checkboxChar !== undefined;

	return {
		indent:    m[1],
		isOrdered: m[2] !== undefined,
		isCheckbox,
		// Only x/X count as done — other custom states are still open items
		isDone:    isCheckbox && checkboxChar.toLowerCase() === "x",
		text:      m[4].trim(),
	};
}

// Lines that must never be read as list content: YAML frontmatter and fenced
// code blocks. Indented code is deliberately not detected — four spaces is
// ambiguous with a deeply nested list item.
export function buildSkipMask(lines: string[]): boolean[] {
	const skip = new Array<boolean>(lines.length).fill(false);
	let start = 0;

	// Frontmatter only counts when the very first line opens it and it closes
	if (lines[0]?.trim() === "---") {
		let close = -1;
		for (let i = 1; i < lines.length; i++) {
			if (lines[i].trim() === "---") { close = i; break; }
		}
		if (close !== -1) {
			for (let i = 0; i <= close; i++) skip[i] = true;
			start = close + 1;
		}
	}

	const FENCE_RE = /^\s*(`{3,}|~{3,})/;
	let fenceChar: string | null = null;
	for (let i = start; i < lines.length; i++) {
		const m = FENCE_RE.exec(lines[i]);
		if (fenceChar === null) {
			if (m) { fenceChar = m[1][0]; skip[i] = true; }
		} else {
			skip[i] = true;
			if (m && m[1][0] === fenceChar) fenceChar = null;
		}
	}
	return skip;
}

// Character ranges covered by inline code spans, so a {{rnd}} written inside
// backticks stays literal text instead of becoming a button. Backtick runs are
// paired left to right on equal length, the way Markdown resolves them.
export function inlineCodeRanges(line: string): Array<[number, number]> {
	const runs: Array<{ start: number; len: number }> = [];
	const runRe = /`+/g;
	let m: RegExpExecArray | null;
	while ((m = runRe.exec(line)) !== null) runs.push({ start: m.index, len: m[0].length });

	const ranges: Array<[number, number]> = [];
	let i = 0;
	while (i < runs.length) {
		const open = runs[i];
		let close = -1;
		for (let j = i + 1; j < runs.length; j++) {
			if (runs[j].len === open.len) { close = j; break; }
		}
		if (close === -1) { i++; continue; }
		ranges.push([open.start, runs[close].start + runs[close].len]);
		i = close + 1;
	}
	return ranges;
}

export function isInsideRanges(index: number, ranges: Array<[number, number]>): boolean {
	return ranges.some(([from, to]) => index >= from && index < to);
}

export function headingLevel(line: string): number {
	const m = HEADING_RE.exec(line);
	return m ? m[1].length : 0;
}

export function headingText(line: string): string | null {
	const m = HEADING_RE.exec(line);
	if (!m) return null;
	return stripMarkdown(m[2]);
}

export function findScopeHeading(lines: string[], triggerLineIndex: number): string | null {
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

export function getScopeLines(lines: string[], triggerLineIndex: number): { start: number; end: number } {
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

export function extractListItems(
	lines: string[],
	start: number,
	end: number,
	includeDone: boolean,
	mode: NestingMode = "all",
): ListItem[] {
	const skip = buildSkipMask(lines);

	// Every list line in scope is read first. Filtering done items or applying the
	// nesting mode up front would reparent the survivors — drop a done "Italian"
	// and its dishes would be promoted to top level.
	const all: ListItem[] = [];
	// Indent width and text of each open ancestor, innermost last
	const stack: { width: number; text: string }[] = [];
	// Running position of each ordered run, keyed by indent width. Counting
	// forward keeps this linear; walking back from every item to the head of its
	// list made a long numbered list quadratic.
	const orderedCounts = new Map<number, number>();

	for (let i = start; i < end; i++) {
		if (skip[i]) continue;
		// A blank line keeps a loose list going, so it settles nothing
		if (lines[i].trim() === "") continue;

		const parsed = parseListLine(lines[i]);
		if (!parsed) {
			// Prose ends any numbered run; the next "1." starts over
			orderedCounts.clear();
			continue;
		}

		const width = indentWidth(parsed.indent);
		while (stack.length > 0 && width <= stack[stack.length - 1].width) stack.pop();

		// Returning to this level ends deeper runs, and a bullet at this level
		// ends the run here. Nested content in between does not.
		for (const w of orderedCounts.keys()) {
			if (w > width || (w === width && !parsed.isOrdered)) orderedCounts.delete(w);
		}

		let orderedNumber: number | null = null;
		if (parsed.isOrdered) {
			orderedNumber = (orderedCounts.get(width) ?? 0) + 1;
			orderedCounts.set(width, orderedNumber);
		}

		all.push({
			text:       parsed.text,
			lineIndex:  i,
			isCheckbox: parsed.isCheckbox,
			isDone:     parsed.isDone,
			orderedNumber,
			depth:      stack.length,
			isLeaf:     true, // provisional; settled in the pass below
			parents:    stack.map(a => stripMarkdown(a.text)),
		});
		stack.push({ width, text: parsed.text });
	}

	// An item is a leaf when nothing more deeply nested follows it
	for (let i = 0; i < all.length; i++) {
		all[i].isLeaf = !(i + 1 < all.length && all[i + 1].depth > all[i].depth);
	}

	return all.filter(item => {
		if (item.isDone && !includeDone) return false;
		if (mode === "top")    return item.depth === 0;
		if (mode === "leaves") return item.isLeaf;
		return true;
	});
}

// The modal snapshots line numbers when it opens, so an edit elsewhere in the
// note can shift the item sitting at a given index. Verify before writing.
export function lineMatchesItem(line: string | undefined, item: ListItem): boolean {
	if (line === undefined) return false;
	const parsed = parseListLine(line);
	if (!parsed) return false;
	return stripTimestamp(parsed.text) === stripTimestamp(item.text);
}

export function rewriteDoneState(line: string, markDone: boolean, addTimestamp: boolean, now?: Date): string {
	let out = line.replace(DONE_STATE_RE, markDone ? "$1[x]" : "$1[ ]");
	// Strip first either way, so marking done twice can't stack timestamps
	out = stripTimestamp(out);
	if (markDone && addTimestamp) out += buildTimestamp(now);
	return out;
}

// ─── Dice ─────────────────────────────────────────────────────────────────────

// Standard dice notation written directly after a {{rnd}} token: {{rnd}}d6,
// {{rnd}}d20, {{rnd}}2d6, {{rnd}}3d8+2. The count defaults to 1 and the modifier
// is optional. The trailing lookahead keeps "{{rnd}}d6x" from half-matching —
// in that case the token falls back to its usual list-picking behaviour.
const DICE_SUFFIX_RE = /^(\d{0,2})d(\d{1,7})([+-]\d{1,4})?(?!\w)/;

export const MAX_DICE_COUNT = 50;
// Large enough to double as a draw — d4127 picks a ticket out of 4127 — while
// staying well inside the range where Math.random() is uniform.
export const MAX_DICE_SIDES = 1_000_000;

export interface DiceSpec {
	count: number;
	sides: number;
	modifier: number;
	raw: string;      // source text consumed after the token, e.g. "2d6+2"
	notation: string; // normalized label for the button and modal, e.g. "2d6+2"
}

export interface DiceRoll {
	rolls: number[];
	total: number;
}

// Parses a dice suffix anchored at the start of `rest` — the note text directly
// following a {{rnd}} token. Returns null when it isn't a roll this plugin
// handles, leaving the caller to pick from the list instead.
export function parseDiceSuffix(rest: string): DiceSpec | null {
	const m = DICE_SUFFIX_RE.exec(rest);
	if (!m) return null;

	const count    = m[1] === "" ? 1 : parseInt(m[1], 10);
	const sides    = parseInt(m[2], 10);
	const modifier = m[3] ? parseInt(m[3], 10) : 0;

	if (count < 1 || count > MAX_DICE_COUNT) return null;
	if (sides < 2 || sides > MAX_DICE_SIDES) return null;

	const countPart    = count > 1 ? String(count) : "";
	const modifierPart = modifier === 0 ? "" : (modifier > 0 ? `+${modifier}` : String(modifier));

	return { count, sides, modifier, raw: m[0], notation: `${countPart}d${sides}${modifierPart}` };
}

export function rollDice(spec: DiceSpec, random: () => number = Math.random): DiceRoll {
	const rolls: number[] = [];
	for (let i = 0; i < spec.count; i++) {
		rolls.push(Math.floor(random() * spec.sides) + 1);
	}
	return {
		rolls,
		total: rolls.reduce((sum, r) => sum + r, 0) + spec.modifier,
	};
}

// "4 + 3 + 2" for multiple dice, "4 + 3 - 2" once a modifier is involved.
// Null when there is nothing to break down: a single die and no modifier.
export function diceBreakdown(spec: DiceSpec, roll: DiceRoll): string | null {
	if (spec.count === 1 && spec.modifier === 0) return null;
	let out = roll.rolls.join(" + ");
	if (spec.modifier > 0)      out += ` + ${spec.modifier}`;
	else if (spec.modifier < 0) out += ` - ${Math.abs(spec.modifier)}`;
	return out;
}

// Locates the source line of the nth {{rnd}} token inside a rendered section.
// Tokens in inline code are skipped so the count stays aligned with the buttons
// the reading-mode post-processor actually created.
export function findTokenLine(lines: string[], lineStart: number, lineEnd: number, occurrenceIndex: number): number {
	const tokenRe = /\{\{rnd(?::[^}]*)?\}\}/g;
	let found = 0;

	for (let i = lineStart; i <= lineEnd; i++) {
		const text       = lines[i] ?? "";
		const codeRanges = inlineCodeRanges(text);
		tokenRe.lastIndex = 0;

		let m: RegExpExecArray | null;
		while ((m = tokenRe.exec(text)) !== null) {
			if (isInsideRanges(m.index, codeRanges)) continue;
			if (found === occurrenceIndex) return i;
			found++;
		}
	}
	return lineStart;
}
