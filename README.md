# Random List Pick

An [Obsidian](https://obsidian.md) plugin that adds an inline button to your notes for picking a random item from a list.

## Usage

Write `{{rnd}}` anywhere in a note — it renders as a small clickable button. Click it to get a random item picked from the list in scope.

The intended use is decision-making and selection from a curated list you maintain in your notes: what to cook tonight, what book to read next, which task to tackle, where to go — anything you'd otherwise scroll through and deliberate over.

```markdown
{{rnd}}

- Pizza
- Tacos
- Sushi
- Borsch
```

Click the button → a modal shows a random pick. **Roll again** to get a different result (never repeats the current item). Accept and close with Escape, ×, or clicking outside.

## Scoping

`{{rnd}}` only draws from the list that belongs to it — not the entire note.

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

`{{rnd}}` under `# Movies` scans both `## Action` and `## Animated` — everything below it until the next `#` or higher — so it can pick from any movie in either subsection. The `{{rnd}}` under `## Action` only scans its own list.

## Checkbox lists

If the list has checkboxes, the modal shows a **Mark done** / **Mark undone** button. Marking an item done removes it from the pool — Roll again won't land on it until you mark it undone. Items already checked when you open the modal are excluded by default.

```markdown
### Books to read {{rnd}}

- [x] The Hitchhiker's Guide to the Galaxy
- [x] Toreadors from Vasyukivka
- [ ] Hyperion
```

Enable **Include done items** in settings to keep checked items in the pool (shown with strikethrough in the modal).

When all items are marked done and Include done is off, Roll again is disabled until something is marked undone.

## Done timestamps

Optionally append a Tasks-compatible timestamp when marking an item done. Marking it undone removes it.

```markdown
- [x] Buy milk ✅ 2025-06-16
```

Compatible with the [Tasks plugin](https://github.com/obsidian-tasks-group/obsidian-tasks) if you use both. Off by default.

## Ordered lists

Works with numbered lists too. The rendered number is shown in the modal alongside the result.

```markdown
### Priority queue {{rnd}}

1. Fix the login bug
2. Write release notes
3. Review open PRs
```

Ordered lists support checkboxes as well: `1. [ ] item`.

## Result rendering

List item text is rendered as markdown in the modal — links are clickable, bold and italic display correctly, inline code is styled.

A copy icon sits at the right edge of the result. Click it to copy the result with formatting intact (rich paste into other notes or apps that accept HTML), with a plain-text fallback.

## Settings

**Button text** — use the default dice icon or set a custom text label.

**Include done items** — when on, checked items stay in the pool and are shown with strikethrough in the modal.

**Done timestamp** — toggle to append a ✅ YYYY-MM-DD timestamp when marking items done (off by default).

## Per-button overrides

Override `Include done items` or `Done timestamp` for a single button without changing the global setting, using flags after a colon:

```markdown
- `{{rnd}}` — uses the global settings
- `{{rnd:done}}` — include done items for this button, regardless of the global setting
- `{{rnd:nodone}}` — exclude done items for this button, regardless of the global setting
- `{{rnd:ts}}` — add a done timestamp for this button
- `{{rnd:nots}}` — don't add a timestamp for this button
- `{{rnd:done,ts}}` — combine flags with a comma
```

```markdown
### Movies to watch {{rnd:done}}

- [x] Megamind
- [ ] Wolfwalkers
```

This button always shows `Megamind` as a possible pick (strikethrough, since it's done) even if `Include done items` is off globally — useful when one list in a note should behave differently from the rest of the vault.

Unrecognized flags are ignored. If a flag pair appears twice (`{{rnd:done,nodone}}`), the last one wins.

## Installation

### From the community plugin list

Search for **Random List Pick** in Settings → Community plugins → Browse.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases/latest)
2. Create a folder named `random-list` inside your vault's `.obsidian/plugins/` directory
3. Place both files in that folder
4. Enable the plugin in Settings → Community plugins
