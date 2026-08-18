import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildSkipMask,
	diceBreakdown,
	extractListItems,
	findScopeHeading,
	findTokenLine,
	getScopeLines,
	indentWidth,
	inlineCodeRanges,
	lineMatchesItem,
	parseDiceSuffix,
	parseListLine,
	parseRndFlags,
	rewriteDoneState,
	rollDice,
	stripMarkdown,
} from "./parsing.ts";

const lines = (s: string) => s.split("\n");
const texts = (items: { text: string }[]) => items.map(i => i.text);

describe("parseListLine", () => {
	it("accepts every unordered bullet Markdown allows", () => {
		for (const bullet of ["-", "*", "+"]) {
			const parsed = parseListLine(`${bullet} Pizza`);
			assert.equal(parsed?.text, "Pizza", `bullet "${bullet}"`);
			assert.equal(parsed?.isOrdered, false);
		}
	});

	it("accepts both ordered delimiters", () => {
		for (const delim of [".", ")"]) {
			const parsed = parseListLine(`1${delim} Borsch`);
			assert.equal(parsed?.text, "Borsch", `delimiter "${delim}"`);
			assert.equal(parsed?.isOrdered, true);
		}
	});

	it("reads checkboxes, counting only x/X as done", () => {
		assert.equal(parseListLine("- [ ] Open")?.isDone, false);
		assert.equal(parseListLine("- [x] Done")?.isDone, true);
		assert.equal(parseListLine("- [X] Done")?.isDone, true);
	});

	it("treats custom checkbox states as open items without leaking the marker", () => {
		for (const state of ["/", "-", ">", "?"]) {
			const parsed = parseListLine(`- [${state}] In progress`);
			assert.equal(parsed?.isCheckbox, true, `state "${state}"`);
			assert.equal(parsed?.isDone, false);
			assert.equal(parsed?.text, "In progress");
		}
	});

	it("does not mistake a bracketed word for a checkbox", () => {
		assert.equal(parseListLine("- [ohno] text")?.isCheckbox, false);
		assert.equal(parseListLine("- [ohno] text")?.text, "[ohno] text");
	});

	it("returns null for non-list lines", () => {
		assert.equal(parseListLine("Just a paragraph"), null);
		assert.equal(parseListLine("---"), null);
		assert.equal(parseListLine("# Heading"), null);
	});
});

describe("buildSkipMask", () => {
	it("masks YAML frontmatter", () => {
		const mask = buildSkipMask(lines("---\ntags:\n  - project\n---\n- Real"));
		assert.deepEqual(mask, [true, true, true, true, false]);
	});

	it("ignores a --- that is not frontmatter", () => {
		const mask = buildSkipMask(lines("# Title\n---\n- Real"));
		assert.deepEqual(mask, [false, false, false]);
	});

	it("leaves the document alone when frontmatter never closes", () => {
		const mask = buildSkipMask(lines("---\ntags:\n- Real"));
		assert.deepEqual(mask, [false, false, false]);
	});

	it("masks fenced code blocks, backticks and tildes alike", () => {
		assert.deepEqual(buildSkipMask(lines("- A\n```js\n- fake\n```\n- B")),
			[false, true, true, true, false]);
		assert.deepEqual(buildSkipMask(lines("- A\n~~~\n- fake\n~~~\n- B")),
			[false, true, true, true, false]);
	});

	it("does not let a tilde close a backtick fence", () => {
		const mask = buildSkipMask(lines("```\n~~~\n- still code\n```\n- B"));
		assert.deepEqual(mask, [true, true, true, true, false]);
	});
});

describe("extractListItems", () => {
	const note = lines(`---
tags:
  - project
aliases:
  - Dinner ideas
---

# Dinner

- Pizza
* Tacos
+ Sushi
1) Borsch

\`\`\`js
- not a list item
\`\`\`

- [x] Eaten already
- [/] Cooking now`);

	it("finds every bullet style and skips frontmatter and code blocks", () => {
		assert.deepEqual(
			texts(extractListItems(note, 0, note.length, false)),
			["Pizza", "Tacos", "Sushi", "Borsch", "Cooking now"]);
	});

	it("includes done items only when asked", () => {
		assert.ok(texts(extractListItems(note, 0, note.length, true)).includes("Eaten already"));
	});

	it("numbers ordered items by position, not by the digits written", () => {
		const src = lines("1. a\n1. b\n1. c");
		assert.deepEqual(
			extractListItems(src, 0, src.length, false).map(i => i.orderedNumber),
			[1, 2, 3]);
	});

	it("leaves unordered items unnumbered", () => {
		const src = lines("- a\n- b");
		assert.deepEqual(
			extractListItems(src, 0, src.length, false).map(i => i.orderedNumber),
			[null, null]);
	});
});

describe("getScopeLines / findScopeHeading", () => {
	const note = lines(`# Movies {{rnd}}

## Action {{rnd}}

- Mad Max
- John Wick

## Animated

- Spirited Away`);

	it("scans a whole section from a token in its heading", () => {
		const { start, end } = getScopeLines(note, 0);
		assert.deepEqual(texts(extractListItems(note, start, end, false)),
			["Mad Max", "John Wick", "Spirited Away"]);
	});

	it("stops at the next heading of equal or higher level", () => {
		const { start, end } = getScopeLines(note, 2);
		assert.deepEqual(texts(extractListItems(note, start, end, false)),
			["Mad Max", "John Wick"]);
	});

	it("names the scope after the heading it belongs to", () => {
		assert.equal(findScopeHeading(note, 0), "Movies");
		assert.equal(findScopeHeading(note, 2), "Action");
		assert.equal(findScopeHeading(note, 4), "Action");
	});

	it("runs to the end of the note when there is no heading above", () => {
		const flat = lines("{{rnd}}\n- a\n- b");
		assert.deepEqual(getScopeLines(flat, 0), { start: 1, end: 3 });
		assert.equal(findScopeHeading(flat, 0), null);
	});
});

describe("inlineCodeRanges / findTokenLine", () => {
	it("covers a backtick span", () => {
		assert.deepEqual(inlineCodeRanges("a `{{rnd}}` b"), [[2, 11]]);
	});

	it("pairs runs of equal length only", () => {
		assert.deepEqual(inlineCodeRanges("``a`b``"), [[0, 7]]);
	});

	it("ignores an unclosed backtick", () => {
		assert.deepEqual(inlineCodeRanges("a ` b"), []);
	});

	it("counts tokens rather than lines, skipping those in inline code", () => {
		const src = lines("`{{rnd}}` and {{rnd}}\n{{rnd}}");
		assert.equal(findTokenLine(src, 0, 1, 0), 0); // the real one on line 0
		assert.equal(findTokenLine(src, 0, 1, 1), 1); // the one on line 1
	});

	it("handles two tokens on the same line", () => {
		const src = lines("{{rnd}} x {{rnd}}\n{{rnd}}");
		assert.equal(findTokenLine(src, 0, 1, 1), 0);
		assert.equal(findTokenLine(src, 0, 1, 2), 1);
	});
});

describe("rewriteDoneState", () => {
	const jan = new Date(2026, 0, 5);

	it("checks and unchecks across bullet styles", () => {
		for (const prefix of ["- ", "* ", "+ ", "1. ", "1) "]) {
			assert.equal(rewriteDoneState(`${prefix}[ ] Task`, true, false), `${prefix}[x] Task`);
			assert.equal(rewriteDoneState(`${prefix}[x] Task`, false, false), `${prefix}[ ] Task`);
		}
	});

	it("checks off a custom state without leaving it behind", () => {
		assert.equal(rewriteDoneState("- [/] Task", true, false), "- [x] Task");
	});

	it("adds and removes the Tasks timestamp", () => {
		assert.equal(rewriteDoneState("- [ ] Task", true, true, jan), "- [x] Task ✅ 2026-01-05");
		assert.equal(rewriteDoneState("- [x] Task ✅ 2026-01-05", false, false), "- [ ] Task");
	});

	it("never stacks timestamps", () => {
		assert.equal(rewriteDoneState("- [x] Task ✅ 2026-01-01", true, true, jan),
			"- [x] Task ✅ 2026-01-05");
	});

	it("preserves indentation", () => {
		assert.equal(rewriteDoneState("  - [ ] Task", true, false), "  - [x] Task");
	});
});

describe("lineMatchesItem", () => {
	const item = {
		text: "Pizza", lineIndex: 3, isCheckbox: false, isDone: false,
		orderedNumber: null, depth: 0, isLeaf: true, parents: [],
	};

	it("matches the same item written any way", () => {
		assert.ok(lineMatchesItem("- Pizza", item));
		assert.ok(lineMatchesItem("* Pizza", item));
		assert.ok(lineMatchesItem("- [ ] Pizza", item));
	});

	it("rejects a line the note has moved out from under", () => {
		assert.equal(lineMatchesItem("- Tacos", item), false);
		assert.equal(lineMatchesItem("Some paragraph", item), false);
		assert.equal(lineMatchesItem(undefined, item), false);
	});

	it("looks past a done timestamp on either side", () => {
		assert.ok(lineMatchesItem("- [x] Pizza ✅ 2026-01-05", item));
	});
});

describe("parseRndFlags", () => {
	it("reads each flag", () => {
		assert.deepEqual(parseRndFlags("done"), { includeDone: true });
		assert.deepEqual(parseRndFlags("nots"), { addDoneTimestamp: false });
		assert.deepEqual(parseRndFlags("norepeat"), { noRepeat: true });
		assert.deepEqual(parseRndFlags("repeat"), { noRepeat: false });
	});

	it("combines flags and lets the last of a pair win", () => {
		assert.deepEqual(parseRndFlags("done,ts"), { includeDone: true, addDoneTimestamp: true });
		assert.deepEqual(parseRndFlags("done,nodone"), { includeDone: false });
	});

	it("ignores whitespace, case and unknown flags", () => {
		assert.deepEqual(parseRndFlags(" DONE , wat "), { includeDone: true });
		assert.deepEqual(parseRndFlags(undefined), {});
	});
});

describe("parseDiceSuffix", () => {
	it("reads count, sides and modifier", () => {
		assert.deepEqual(parseDiceSuffix("d6"),
			{ count: 1, sides: 6, modifier: 0, raw: "d6", notation: "d6" });
		assert.deepEqual(parseDiceSuffix("3d8+2"),
			{ count: 3, sides: 8, modifier: 2, raw: "3d8+2", notation: "3d8+2" });
		assert.deepEqual(parseDiceSuffix("d20-1"),
			{ count: 1, sides: 20, modifier: -1, raw: "d20-1", notation: "d20-1" });
	});

	it("stops at a sentence-ending period but not at a letter", () => {
		assert.equal(parseDiceSuffix("d6.")?.raw, "d6");
		assert.equal(parseDiceSuffix("d6x"), null);
		assert.equal(parseDiceSuffix("dinner"), null);
	});

	it("takes sides large enough to draw a number", () => {
		assert.equal(parseDiceSuffix("d4127")?.sides, 4127);
		assert.equal(parseDiceSuffix("d1000000")?.sides, 1000000);
	});

	it("rejects values outside the supported range", () => {
		assert.equal(parseDiceSuffix("d1"), null);
		assert.equal(parseDiceSuffix("99d6"), null);
		assert.equal(parseDiceSuffix("d1000001"), null);
		// More digits than the pattern takes must not match a prefix of them
		assert.equal(parseDiceSuffix("d10000000"), null);
	});
});

describe("rollDice / diceBreakdown", () => {
	it("stays within range across many rolls", () => {
		const spec = parseDiceSuffix("3d6+2")!;
		for (let i = 0; i < 500; i++) {
			const { rolls, total } = rollDice(spec);
			assert.equal(rolls.length, 3);
			assert.ok(rolls.every(r => r >= 1 && r <= 6));
			assert.equal(total, rolls.reduce((a, b) => a + b, 0) + 2);
		}
	});

	it("reaches both extremes", () => {
		const spec = parseDiceSuffix("2d6")!;
		assert.deepEqual(rollDice(spec, () => 0), { rolls: [1, 1], total: 2 });
		assert.deepEqual(rollDice(spec, () => 0.999), { rolls: [6, 6], total: 12 });
	});

	it("breaks down only when there is something to show", () => {
		assert.equal(diceBreakdown(parseDiceSuffix("d6")!, { rolls: [4], total: 4 }), null);
		assert.equal(diceBreakdown(parseDiceSuffix("2d6")!, { rolls: [4, 3], total: 7 }), "4 + 3");
		assert.equal(diceBreakdown(parseDiceSuffix("2d6+2")!, { rolls: [4, 3], total: 9 }), "4 + 3 + 2");
		assert.equal(diceBreakdown(parseDiceSuffix("d20-1")!, { rolls: [9], total: 8 }), "9 - 1");
	});
});

describe("stripMarkdown", () => {
	it("unwraps links, emphasis and code", () => {
		assert.equal(stripMarkdown("**Bold** and `code`"), "Bold and code");
		assert.equal(stripMarkdown("[[Note|Alias]]"), "Alias");
		assert.equal(stripMarkdown("[text](http://x)"), "text");
	});

	it("removes the token and any dice suffix", () => {
		assert.equal(stripMarkdown("Movies {{rnd}}"), "Movies");
		assert.equal(stripMarkdown("Combat {{rnd}}2d6+1"), "Combat");
		assert.equal(stripMarkdown("Books {{rnd:done,ts}}"), "Books");
	});
});

describe("indentWidth", () => {
	it("expands tabs to the next tab stop rather than counting characters", () => {
		assert.equal(indentWidth(""), 0);
		assert.equal(indentWidth("    "), 4);
		assert.equal(indentWidth("\t"), 4);
		assert.equal(indentWidth("  \t"), 4);   // 2 spaces then a tab lands on 4
		assert.equal(indentWidth("\t\t"), 8);
	});
});

describe("nesting", () => {
	const dinner = lines(`- Italian
  - Pizza margherita
  - Carbonara
- Mexican
  - Tacos al pastor`);

	it("assigns depth relative to the shallowest item in scope", () => {
		assert.deepEqual(
			extractListItems(dinner, 0, dinner.length, false, "all").map(i => i.depth),
			[0, 1, 1, 0, 1]);
	});

	it("marks an item a leaf when nothing deeper follows", () => {
		assert.deepEqual(
			extractListItems(dinner, 0, dinner.length, false, "all").map(i => i.isLeaf),
			[false, true, true, false, true]);
	});

	it("picks only the dishes in leaves mode", () => {
		assert.deepEqual(
			texts(extractListItems(dinner, 0, dinner.length, false, "leaves")),
			["Pizza margherita", "Carbonara", "Tacos al pastor"]);
	});

	it("picks only the cuisines in top mode", () => {
		assert.deepEqual(
			texts(extractListItems(dinner, 0, dinner.length, false, "top")),
			["Italian", "Mexican"]);
	});

	it("records the ancestor chain, outermost first", () => {
		const items = extractListItems(dinner, 0, dinner.length, false, "leaves");
		assert.deepEqual(items[0].parents, ["Italian"]);
		assert.deepEqual(items[2].parents, ["Mexican"]);
	});

	it("handles three levels", () => {
		const src = lines(`- Europe
  - Italy
    - Rome
    - Milan
  - France
    - Paris`);
		assert.deepEqual(texts(extractListItems(src, 0, src.length, false, "leaves")),
			["Rome", "Milan", "Paris"]);
		assert.deepEqual(texts(extractListItems(src, 0, src.length, false, "top")), ["Europe"]);
		assert.deepEqual(
			extractListItems(src, 0, src.length, false, "leaves")[0].parents,
			["Europe", "Italy"]);
	});

	it("keeps mixed-depth candidates that happen to be top level", () => {
		// "Pizza" is a leaf at depth 0; leaves mode must not drop it
		const src = lines(`- Pizza
- Italian
  - Carbonara`);
		assert.deepEqual(texts(extractListItems(src, 0, src.length, false, "leaves")),
			["Pizza", "Carbonara"]);
	});

	it("treats a flat list as all leaves", () => {
		const flat = lines("- a\n- b\n- c");
		assert.deepEqual(texts(extractListItems(flat, 0, flat.length, false, "leaves")),
			["a", "b", "c"]);
	});

	it("nests tab-indented children the same as space-indented ones", () => {
		const tabbed = lines("- Italian\n\t- Pizza");
		assert.deepEqual(extractListItems(tabbed, 0, tabbed.length, false, "all").map(i => i.depth),
			[0, 1]);
		assert.deepEqual(texts(extractListItems(tabbed, 0, tabbed.length, false, "leaves")), ["Pizza"]);
	});

	it("nests an ordered child under an unordered parent", () => {
		const src = lines("- Italian\n  1. Pizza\n  2. Carbonara");
		const items = extractListItems(src, 0, src.length, false, "leaves");
		assert.deepEqual(texts(items), ["Pizza", "Carbonara"]);
		assert.deepEqual(items.map(i => i.orderedNumber), [1, 2]);
	});

	it("does not reparent children when their parent is a filtered-out done item", () => {
		// Dropping "Italian" before computing depth would promote its dishes
		const src = lines("- [x] Italian\n  - Pizza\n  - Carbonara");
		const items = extractListItems(src, 0, src.length, false, "all");
		assert.deepEqual(texts(items), ["Pizza", "Carbonara"]);
		assert.deepEqual(items.map(i => i.depth), [1, 1]);
		assert.deepEqual(items[0].parents, ["Italian"]);
	});

	it("strips markdown from the ancestor chain", () => {
		const src = lines("- **Italian** food\n  - Pizza");
		assert.deepEqual(
			extractListItems(src, 0, src.length, false, "leaves")[0].parents,
			["Italian food"]);
	});

	it("reads the depth flags", () => {
		assert.deepEqual(parseRndFlags("depth-leaves"), { nesting: "leaves" });
		assert.deepEqual(parseRndFlags("depth-top"), { nesting: "top" });
		assert.deepEqual(parseRndFlags("depth-all"), { nesting: "all" });
		assert.deepEqual(parseRndFlags("depth-top,depth-leaves"), { nesting: "leaves" });
		assert.deepEqual(parseRndFlags("done,depth-top"), { includeDone: true, nesting: "top" });
	});
});

describe("ordered numbering", () => {
	const numbers = (src: string) =>
		extractListItems(lines(src), 0, lines(src).length, true, "all").map(i => i.orderedNumber);

	it("keeps counting across a blank line, which only makes the list loose", () => {
		assert.deepEqual(numbers("1. a\n\n2. b"), [1, 2]);
	});

	it("keeps counting past nested content, the way Obsidian renders it", () => {
		// Walking backwards used to stop at the sub-item and restart at 1
		assert.deepEqual(numbers("1. a\n  - note\n2. b"), [1, null, 2]);
	});

	it("restarts after prose ends the list", () => {
		assert.deepEqual(numbers("1. a\n2. b\n\nSome text\n\n1. x"), [1, 2, 1]);
	});

	it("restarts when a bullet interrupts at the same level", () => {
		assert.deepEqual(numbers("1. a\n- b\n2. c"), [1, null, 1]);
	});

	it("numbers a nested ordered list independently of its parent", () => {
		assert.deepEqual(numbers("1. a\n  1. x\n  2. y\n2. b"), [1, 1, 2, 2]);
	});

	it("restarts a nested run each time its parent comes round again", () => {
		assert.deepEqual(numbers("1. a\n  1. x\n2. b\n  1. y"), [1, 1, 2, 1]);
	});

	it("stays linear on a long list", () => {
		const src = Array.from({ length: 400 }, (_, i) => `${i + 1}. item`).join("\n");
		const nums = numbers(src);
		assert.equal(nums.length, 400);
		assert.equal(nums[0], 1);
		assert.equal(nums[399], 400);
	});
});
