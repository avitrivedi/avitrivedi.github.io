# Static annotation data

These four reviewed files are the only annotation publication inputs:

| Route | File | Stable section anchors |
|---|---|---|
| `/` | `home.json` | `home-introduction`, `home-writing`, `home-boston` |
| `/dandho/` | `dandho.json` | `dandho-header`, `dandho-overview`, `dandho-operating-model`, `dandho-boundaries`, `dandho-conversation` |
| `/khata/` | `khata.json` | `khata-header`, `khata-overview`, `khata-barcode`, `khata-stock`, `khata-report` |
| `/pulse/` | `pulse.json` | `pulse-header`, `pulse-overview`, `pulse-grain`, `pulse-handoffs`, `pulse-scorecard` |

IDs are unique within a route and belong to the page source, not to imported data. Keep them durable when editing prose. Duplicate, missing, or unknown IDs fail the build.

## Schema version 1

A route file has exactly these fields:

```json
{
  "schemaVersion": 1,
  "route": "/",
  "annotations": []
}
```

Each `annotations` item has exactly:

- `anchor`: one allowlisted anchor for that route;
- `contentHash`: the editor-supplied `sha256:` revision of the current anchored HTML;
- `layout`: `narrow`, `broad`, or `compact` (see [Layout scopes](#layout-scopes));
- `strokes`: an ordered array of strokes.

A stroke has exactly `tool`, `style`, and `points`. Allowed pairs are `pen` + `graphite`, `pen` + `blue`, and `highlighter` + `yellow`. Erasing removes a complete stroke before export, so `eraser` is not stored. Every point is `[x, y, pressure]`; all three values are finite numbers from 0 through 1 relative to the section box. Export rounds numbers to four decimal places and sorts section/layout records for reviewable diffs.

No other keys or values are accepted. In particular, route files cannot carry HTML, SVG, XML, CSS, URLs, event attributes, scripts, DOM IDs, arbitrary colors, or timestamps.

## Layout scopes

`site/styles.css` has two rules that change the size of an anchored section's own box. `@media (max-width: 37.5rem)` reflows the page, and `@media (max-height: 48rem) and (min-width: 46.01rem)` compresses the homepage into one desktop screen. The three scopes are that set of size layouts:

| Scope | Visible when | Preview viewports in the editor |
|---|---|---|
| `narrow` | width `37.5rem` and below | 320 × 568, 390 × 844 |
| `compact` | width `46.01rem` and above **and** height `48rem` and below | 768 × 720, 1366 × 768, 1483 × 768 |
| `broad` | every other viewport wider than `37.5rem` | 768 × 1024, 1366 × 900, 1483 × 885 |

The two rules cannot apply together, so exactly one scope renders at any viewport and the other two stay `display: none`. Both boundaries are in `rem`, so they follow the visitor's root font size. Draw a section at every scope that matters; an unauthored scope stays empty instead of stretching a mark from a different layout.

Scopes describe viewport size only. A coarse pointer raises `.work-link` row height, so a `home-writing` mark stretches by a few percent on a touch device at `broad` or `compact` size. Keep marks section-level for that reason.

## Limits

- 65,536 UTF-8 bytes per route file
- 24 section/layout records per route
- 128 strokes per route
- 2,048 points per stroke
- 12,000 points per route

The validator also rejects malformed JSON, unknown schema/route/anchor/layout/tool/style, duplicate section/layout targets, stale content hashes, malformed points, non-finite or out-of-range coordinates, and invalid pressure. Any failure stops `npm run build` with the file and reason; stale marks are never silently moved.

## Review workflow

1. Run `npm run annotations:author` and open the printed loopback URL.
2. Choose the route, anchor, layout scope, and one of that scope's preview viewports.
3. Import the matching file here or begin empty. Import is capped and validated before rendering.
4. Stay in read/scroll mode while navigating or selecting text. Explicitly enable drawing, then use pen/highlighter, stroke eraser, undo, or confirmed clear. Freehand creation requires pointer, pen, or touch; every other operation is keyboard operable.
5. Check **Public preview**, then review each scope's viewports as relevant, including 1366 × 768 for the one-screen desktop layout. Avoid marking links or controls unless that effect is deliberate and tested.
6. Export and replace the matching file in this directory. The browser revokes its temporary download URL; it sends nothing over the network.
7. Run `npm run check`, inspect the JSON and generated preview, commit, and open a normal PR. Git review and deployment—not the local tool—are the publication authority.

A build turns validated numeric/enum data into inline SVG using fixed classes. The layer is `pointer-events: none`, nonfocusable, decorative (`aria-hidden`), outside the reading order, and hidden for print, forced colors, and increased contrast. If a drawing communicates meaning rather than decoration, add the same meaning as ordinary adjacent page text before publication.

Section-relative geometry does not promise exact-word survival across arbitrary wrapping, font, zoom, or content changes. Use a separate mark per scope, keep marks section-level, and re-author anything that no longer lines up. A viewport outside a mark's scope hides that mark rather than displaying it in the wrong place.
