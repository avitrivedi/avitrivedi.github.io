# Avi Trivedi — personal site

Source for Avi Trivedi’s static personal site: <https://avitrivedi.github.io/>.

The site is dependency-free HTML, CSS, and JavaScript. JavaScript updates Boston civil time and the time-based cat pose; pages and links remain usable without it. There is no backend, analytics, tracker, or visitor-side API request.

Inter is distributed locally under the SIL Open Font License 1.1. The required notice is at `site/fonts/Inter-OFL-1.1.txt`. No license is granted for the rest of the repository.

## Build and verify

Node.js 20 or newer is required.

```sh
npm ci
npm run check
```

`npm run check` runs the source linter, Node tests, and production build. Generated output is written to `dist/` and is not committed.

## Author annotations locally

Annotations are repository-authored and become public only after export, review, commit, PR, and deployment. Start the local-only editor with:

```sh
npm run annotations:author
```

Open the printed `http://127.0.0.1:4174/` URL. The server binds only to loopback and has no write endpoint. In the studio, choose a route, stable section, `narrow`, `broad`, or `compact` layout scope, and a matching preview viewport. Import that route’s existing JSON from `annotations/` or begin empty; schema v1 files migrate deterministically in memory. Read/scroll remains the default until you explicitly start drawing. Pencil, ink, marker, highlighter, curated colors, safe width/opacity choices, pressure input, whole-stroke erasing, undo/redo, confirmed clear, deterministic export, light/dark themes, and an exact inert public-preview mode are available. Replace only the matching file in `annotations/`, run `npm run check`, inspect the diff and target widths, and publish through the normal PR workflow. The editor never commits, pushes, uploads, sends telemetry, or stores a draft.

A scope covers one viewport-size layout of `site/styles.css`, so a mark is never shown at a size layout it was not authored against:

| Scope | Visible when | Site rule |
|---|---|---|
| `narrow` | width `37.5rem` and below | the width reflow at `max-width: 37.5rem` |
| `compact` | width `46.01rem` and above **and** height `48rem` and below | the one-screen desktop rule at `(max-height: 48rem) and (min-width: 46.01rem)` |
| `broad` | every other viewport wider than `37.5rem` | the base layout |

Both boundaries are in `rem`, so they move with the visitor's root font size (600px, 736px, and 768px at the 16px default). The two rules never apply together, so exactly one scope is visible at any viewport. Scopes describe viewport size only: a coarse pointer also raises the writing-index row height, which stretches a `home-writing` mark by a few percent on a touch device at `broad` or `compact` size. Keep marks section-level rather than word-level for that reason. Marks use normalized section-relative points and are intentionally hidden outside their authored scope, in print, in forced-colors mode, and when increased contrast is requested. They are suitable for reviewed section drawings and highlighting—not exact-word anchoring across arbitrary reflow. Re-author a mark if its target text or layout changes; a SHA-256 content mismatch fails the build.

The strict schema and complete anchor/limit reference are in [`annotations/README.md`](annotations/README.md). Public pages receive only validated, generated, decorative SVG: no editor, raw JSON, account, storage, cookies, service worker, API, or visitor controls.

## Structure

- `site/` — visitor-facing source and local font assets
- `annotations/` — reviewed route data and schema/workflow reference
- `scripts/` — dependency-free lint, validation, and build-time SVG generation
- `tools/` — loopback-only annotation editor; never copied into production
- `test/` — content, routing, time-zone, payload, annotation-security, editor, and rendered-layout checks. The rendered-layout tests drive an installed Chromium or Chrome over the DevTools protocol with no extra packages. Set `CHROME_PATH` to point at a browser when discovery fails. They need Node.js 22 or newer for its global `WebSocket`. They skip with a reason on a developer machine that has no browser or an older Node.js, but they fail when `CI` or `REQUIRE_BROWSER` is set, so a deployment can never go green without them.
- `.github/workflows/` — CI and GitHub Pages deployment

Changes are reviewed through pull requests. A green deployment from public `master` publishes the generated `dist/` artifact to GitHub Pages.
