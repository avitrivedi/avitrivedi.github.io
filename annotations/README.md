# Static annotation data

These four reviewed files are the only annotation publication inputs:

| Route | File | Stable section anchors |
|---|---|---|
| `/` | `home.json` | `home-introduction`, `home-writing`, `home-boston` |
| `/dandho/` | `dandho.json` | `dandho-header`, `dandho-overview`, `dandho-operating-model`, `dandho-boundaries`, `dandho-conversation` |
| `/khata/` | `khata.json` | `khata-header`, `khata-overview`, `khata-barcode`, `khata-stock`, `khata-report` |
| `/pulse/` | `pulse.json` | `pulse-header`, `pulse-overview`, `pulse-grain`, `pulse-handoffs`, `pulse-scorecard` |

IDs are unique within a route and belong to page source, not imported data. Keep them durable when editing prose. Duplicate, missing, or unknown IDs fail the build.

## Authoring tools

The local studio offers five deliberate presets:

- **Pencil** — a lighter, pressure-aware graphite or blue line for loose notes.
- **Ink pen** — a crisp pressure-aware line in graphite, ocean blue, coral, moss, or plum.
- **Marker** — a broader pressure-aware square-ended mark in graphite, blue, coral, or moss.
- **Highlighter** — a translucent, pressure-independent band in yellow, mint, sky, or pink.
- **Whole-stroke eraser** — removes the topmost complete stroke under the pointer; it never edits points or exports an eraser record.

Each drawing preset exposes only its reviewed widths and opacities. Color swatches, width options, opacity options, pressure bands, and their generated CSS classes are fixed allowlists in `tools/annotation-core.js`; imported text can never become CSS or SVG markup. Pen pressure affects pencil, ink, and marker weight. Mouse and non-pressure touch input receive a stable midpoint pressure. Highlighter remains even so highlighted text does not pulse in width.

Read and scroll is always the default. Choose **Start drawing** to opt in; **Stop drawing** or <kbd>Escape</kbd> restores normal scrolling, touch gestures, text selection, links, context menus, and keyboard focus. Single-key tool/history shortcuts are active only in drawing mode: <kbd>P</kbd> pencil, <kbd>I</kbd> ink, <kbd>M</kbd> marker, <kbd>H</kbd> highlighter, <kbd>E</kbd> eraser, <kbd>U</kbd> undo, and <kbd>R</kbd> redo. A canceled pointer/pen/touch stroke is discarded in full.

## Schema version 2

A newly exported route file has exactly these fields:

```json
{
  "schemaVersion": 2,
  "route": "/",
  "annotations": []
}
```

Each `annotations` item has exactly:

- `anchor`: one allowlisted anchor for that route;
- `contentHash`: the editor-supplied `sha256:` revision of the current anchored HTML;
- `layout`: `narrow`, `broad`, or `compact` (see [Layout scopes](#layout-scopes));
- `strokes`: an ordered array of strokes.

A v2 stroke has exactly `tool`, `style`, `width`, `opacity`, and `points`. Newly authored `tool` values are `pencil`, `pen`, `marker`, or `highlighter`; `legacy-pen` and `legacy-highlighter` are reserved migration identities accepted for v1 compatibility but are not drawing presets. `style`, `width`, and `opacity` must be one of that tool’s fixed choices shown by the editor or, for a legacy identity, its fixed migrated value. Every point is `[x, y, pressure]`; all three values are finite numbers from 0 through 1 relative to the section box. Export rounds point values to four decimal places and sorts section/layout records for reviewable diffs.

No other keys or values are accepted. In particular, route files cannot carry HTML, SVG, XML, CSS, URLs, event attributes, scripts, DOM IDs, arbitrary colors, arbitrary dimensions, timestamps, or non-finite numbers.

### Version 1 compatibility

The original editor exported schema v1 strokes with `tool`, `style`, and `points`. Those files remain valid publication inputs and import without manual edits. The validator deterministically migrates `pen` + `graphite`/`blue` to `legacy-pen` with width `2.25` and opacity `1`, and `highlighter` + `yellow` to `legacy-highlighter` with width `12` and opacity `0.22`. These reserved identities preserve the original point-to-point path, round caps, graphite `#555`, blue `#315f9d`, and pressure-independent weight after v2 export; newly drawn strokes continue to use the modern rendering. Because v1 rendering ignored recorded pen pressure, migration normalizes legacy pen pressure to `0.5`. The studio reports the in-memory migration, and the next export writes canonical schema v2 without losing that rendering identity. Unknown versions, non-original v1 tool/style pairs, and nonfixed settings on v2 legacy identities fail with an explicit validation error. Existing empty v1 route files therefore continue to build byte-for-byte unchanged.

## Layout scopes

`site/styles.css` has two rules that change the size of an anchored section’s own box. `@media (max-width: 37.5rem)` reflows the page, and `@media (max-height: 48rem) and (min-width: 46.01rem)` compresses the homepage into one desktop screen. The three scopes are that set of size layouts:

| Scope | Visible when | Preview viewports in the editor |
|---|---|---|
| `narrow` | width `37.5rem` and below | 320 × 568, 390 × 844 |
| `compact` | width `46.01rem` and above **and** height `48rem` and below | 768 × 720, 1366 × 768, 1483 × 768 |
| `broad` | every other viewport wider than `37.5rem` | 768 × 1024, 1366 × 900, 1483 × 885 |

The two rules cannot apply together, so exactly one scope renders at any viewport and the other two stay `display: none`. Both boundaries are in `rem`, so they follow the visitor’s root font size. Draw a section at every scope that matters; an unauthored scope stays empty instead of stretching a mark from a different layout.

Scopes describe viewport size only. A coarse pointer raises `.work-link` row height, so a `home-writing` mark stretches by a few percent on a touch device at `broad` or `compact` size. Keep marks section-level for that reason.

## Limits and validation

- 65,536 UTF-8 bytes per route file
- 24 section/layout records per route
- 128 strokes per route
- 2,048 points per stroke
- 12,000 points per route

The validator also rejects malformed JSON, unknown schema/route/anchor/layout/tool/style, unapproved width or opacity, duplicate section/layout targets, stale content hashes, malformed points, non-finite or out-of-range coordinates, and invalid pressure. Any failure stops `npm run build` with the file and reason; stale or hostile input is never silently rendered.

## Review and publication workflow

1. Run `npm run annotations:author` and open the printed loopback URL.
2. Choose the route, stable section, layout scope, and one of that scope’s preview viewports.
3. Import the matching file here or begin empty. Import is size-capped, strictly validated, and migrated from v1 when needed.
4. Stay in read/scroll mode while navigating or selecting text. Explicitly start drawing, choose a preset/color/width/opacity, and draw with mouse, touch, or pen. Undo/redo, erasing, and confirmed clear remain available.
5. Enter **Public preview** to see the exact build renderer without author outlines or input handling. Review each relevant scope, including 1366 × 768 for the one-screen desktop layout. Avoid marking links or controls unless deliberate and tested.
6. Export and replace the matching file in this directory. The browser revokes its temporary download URL; it sends nothing over the network and stores no draft.
7. Run `npm run check`, inspect the JSON and generated preview, commit, and open a normal PR. Git review and deployment—not the local tool—are the publication authority.

A build turns validated numeric/enum data into inline SVG using only fixed classes. The layer is `pointer-events: none`, nonfocusable, decorative (`aria-hidden`), outside the reading order, and hidden for print, forced colors, and increased contrast. If a drawing communicates meaning rather than decoration, add the same meaning as ordinary adjacent page text before publication.

Section-relative geometry does not promise exact-word survival across arbitrary wrapping, font, zoom, or content changes. Use a separate mark per scope, keep marks section-level, and re-author anything that no longer lines up. A viewport outside a mark’s scope hides that mark rather than displaying it in the wrong place.
