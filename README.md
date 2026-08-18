# Random List Pick

An [Obsidian](https://obsidian.md) plugin that picks a random item from a list in your notes — for the lists you keep coming back to and don't want to scroll through: what to cook tonight, what to read next, which task to tackle. Drop `{{rnd}}` inline for a persistent button, or trigger a pick from the command palette without touching the note. Write `{{rnd}}d20` and the same button rolls dice instead.

## Contents

- [Usage](#usage)
- [What counts as a list item](#what-counts-as-a-list-item)
- [Nested lists](#nested-lists)
- [Dice rolls](#dice-rolls)
- [Scoping](#scoping)
- [Checkbox lists](#checkbox-lists)
- [Ordered lists](#ordered-lists)
- [Result rendering](#result-rendering)
- [Command palette](#command-palette)
- [Settings](#settings)
- [Installation](#installation)

## Usage

Write `{{rnd}}` anywhere in a note — it renders as a small clickable button that picks a random item from the list in scope.

```markdown
{{rnd}}

- Pizza
- Tacos
- Sushi
- Borsch
```

Click it → a modal shows the result. **Roll again** picks another one — by default it works through every item in scope before repeating any of them (see [Settings](#settings)). The modal opens with **Roll again** focused, so you can keep pressing Enter to reroll and Esc to close without touching the mouse.

Don't want a button in the note? See [Command palette](#command-palette).

## What counts as a list item

Every Markdown list style is recognized — `-`, `*` and `+` bullets, and both `1.` and `1)` numbering, at any indentation:

```markdown
{{rnd}}

- Pizza
* Tacos
+ Sushi
1) Borsch
```

Checkboxes may hold any single character, so custom states from themes or the [Tasks plugin](https://github.com/obsidian-tasks-group/obsidian-tasks) (`[/]`, `[-]`, `[>]`) are read as list items too. Only `[x]` and `[X]` count as done.

Two places are never treated as list content:

- **YAML frontmatter** — your `tags:` and `aliases:` values won't show up as picks
- **Fenced code blocks** — anything between ``` or ~~~ fences

A `{{rnd}}` written inside backticks or a code block stays literal text instead of becoming a button, so you can write about the plugin in your own notes.

## Nested lists

When a list is indented, the outer items are usually categories rather than candidates — you want a dish, not a cuisine:

```markdown
### Dinner {{rnd}}

- Italian
  - Pizza margherita
  - Carbonara
- Mexican
  - Tacos al pastor
```

By default only the **innermost** items are picked, so this list offers the three dishes and never "Italian". The pick shows what it was nested under, so the result still reads in context:

```
Italian
Pizza margherita
```

The opposite arrangement is just as common — an item with notes underneath it, where the outer item is the candidate:

```markdown
### Books {{rnd}}

- Hyperion
  - sci-fi, 1989
  - recommended by Anna
- Dune
```

Set **Nested items** to `Top level only` for those, either globally or per button with `{{rnd:depth-top}}`.

| Setting | Picks | Use for |
| --- | --- | --- |
| `Innermost only` (default) | items with nothing nested under them | category lists |
| `Top level only` | only the outermost items | items with notes underneath |
| `Every item` | everything, at any depth | flat lists, or when you genuinely want both |

Depth is measured relative to the shallowest item in scope, and tabs and spaces nest identically. An item at the top level with nothing under it still counts as innermost, so a partly-indented list keeps its unnested entries:

```markdown
- Pizza            ← picked in Innermost only
- Italian
  - Carbonara      ← picked in Innermost only
```

## Dice rolls

Write standard dice notation directly after the token and the button rolls dice instead of reading a list — no list needed, and heading scope is irrelevant.

```markdown
Initiative {{rnd}}d20

Fireball damage {{rnd}}8d6

Attack {{rnd}}d20+5
```

The count and the modifier are both optional, so `d6`, `2d6`, `3d8+2` and `d20-1` all work. The button shows the notation it rolls, so a `d6` and a `d20` in the same note stay distinguishable. The modal shows the total, with the individual dice broken out whenever there's more than one die or a modifier — **Roll again** rerolls, and the copy icon copies the total.

Supported range: 1–50 dice of 2–1000 sides, with a modifier up to ±9999. Anything outside that isn't treated as dice — `{{rnd}}d1`, `{{rnd}}d6x` and `{{rnd}}dinner` fall back to picking from the list, leaving the trailing text alone.

## Scoping

`{{rnd}}` draws only from the list below it, scoped by headings — never from above it.

- **In a heading** — scans from that heading down to the next heading of the same or higher level
- **In body text** — scans under the nearest ancestor heading, stopping at the next heading of equal or higher level
- **No heading context** — scans to the end of the note

```markdown
# Movies {{rnd}}

## Action {{rnd}}

- Mad Max
- John Wick

## Animated

- Spirited Away
- Lion King
```

The `{{rnd}}` under `# Movies` scans both `## Action` and `## Animated` — everything below it until the next `#` or higher — so it can pick from any movie in either subsection. The `{{rnd}}` under `## Action` only scans its own list.

## Checkbox lists

If the list has checkboxes, the modal shows a **Mark done** / **Mark undone** button. Marking an item done removes it from the pool until you undo it — handy for working through a reading queue, watchlist, or backlog without repeats. Items already checked when you open the modal are excluded by default.

```markdown
### Books to read {{rnd}}

- [x] The Hitchhiker's Guide to the Galaxy
- [x] Toreadors from Vasyukivka
- [ ] Hyperion
```

Enable **Include done items** in settings to keep checked items in the pool (shown with strikethrough in the modal).

If the note changes while the modal is open, marking an item done is skipped rather than applied to whatever now sits on that line — you'll get a notice saying so.

When everything's done and Include done is off, Roll again disables until something is marked undone.

### Done timestamps

Optionally append a Tasks-compatible timestamp when marking an item done (removed again if you undo it). Off by default. Compatible with the [Tasks plugin](https://github.com/obsidian-tasks-group/obsidian-tasks).

```markdown
- [x] Buy milk ✅ 2025-06-16
```

## Ordered lists

Works with numbered lists too — the modal shows the item's number alongside the result, and checkboxes are supported (`1. [ ] item`).

```markdown
### Priority queue {{rnd}}

1. Fix the login bug
2. Write release notes
3. Review open PRs
```

## Result rendering

List item text is rendered as markdown in the modal — links are clickable, bold and italic display correctly, inline code is styled.

A copy icon on the result copies it with formatting intact (rich paste into apps that accept HTML), falling back to plain text otherwise.

## Command palette

Both commands trigger a pick without a `{{rnd}}` button in the note — bind either to a hotkey for instant picks anywhere in the vault.

- **Random List Pick: Whole document** — picks from every list item in the note, ignoring heading scope (handy for a flat list with no headings, like a quick shopping list)
- **Random List Pick: From current position** — picks as if `{{rnd}}` were placed at the cursor's current line, respecting the usual heading-scope rules

Both use the global settings — there's no `{{rnd}}` token to read per-button flags from.

## Settings

- **Custom button text** — when on, the inline button shows your own label instead of the dice icon
- **Include done items** — when on, checked items stay in the pool and are shown with strikethrough in the modal
- **Nested items** — which items in an indented list can be picked: `Innermost only` (default), `Top level only`, or `Every item`. See [Nested lists](#nested-lists)
- **No repeats until all shown** — on by default. **Roll again** works through every item in scope before any of them can come up a second time; once they've all been shown the cycle starts over. Turn it off to pick independently each time (still never repeating the item currently on screen)
- **Done timestamp** — toggle to append a ✅ YYYY-MM-DD timestamp when marking items done (off by default)

### Per-button overrides

Override `Include done items`, `Nested items`, `No repeats until all shown` or `Done timestamp` for a single button without changing the global setting, using flags after a colon:

```
{{rnd}}              — uses the global settings
{{rnd:done}}         — include done items for this button, regardless of the global setting
{{rnd:nodone}}       — exclude done items for this button, regardless of the global setting
{{rnd:ts}}           — add a done timestamp for this button
{{rnd:nots}}         — don't add a timestamp for this button
{{rnd:norepeat}}     — work through every item before repeating, for this button
{{rnd:repeat}}       — pick independently each time, for this button
{{rnd:depth-leaves}} — pick only innermost items, for this button
{{rnd:depth-top}}    — pick only top-level items, for this button
{{rnd:depth-all}}    — pick every item at any depth, for this button
{{rnd:done,ts}}      — combine flags with a comma
```

Useful when one list in a note should behave differently from the rest of the vault:

```markdown
### Movies to watch {{rnd:done}}

- [x] Megamind
- [ ] Wolfwalkers
```

This button always shows `Megamind` as a possible pick (strikethrough, since it's done) even if **Include done items** is off globally.

Unrecognized flags are ignored. If a flag appears twice with conflicting values (`{{rnd:done,nodone}}`, `{{rnd:depth-top,depth-all}}`), the last one wins.

Flags without a prefix are on/off switches. The `depth-` prefix marks the one flag that chooses among several values rather than two.

## Installation

### From the community plugin list

Search for **Random List Pick** in Settings → Community plugins → Browse.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases/latest)
2. Create a folder named `random-list` inside your vault's `.obsidian/plugins/` directory
3. Place all three files in that folder
4. Enable the plugin in Settings → Community plugins

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # production build
npm test        # unit tests for the parsing logic
npx eslint .    # community-scanner ruleset
```

Markdown and dice parsing lives in `parsing.ts` with no Obsidian imports, so it runs directly under node's test runner.
