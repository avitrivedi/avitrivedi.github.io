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

## Structure

- `site/` — visitor-facing source and local font assets
- `scripts/` — dependency-free lint and build scripts
- `test/` — content, routing, time-zone, payload, and rendered-layout checks. The rendered-layout tests drive an installed Chromium or Chrome over the DevTools protocol with no extra packages. They skip with a reason when no browser is found; set `CHROME_PATH` to point at one.
- `.github/workflows/` — CI and GitHub Pages deployment

Changes are reviewed through pull requests. A green deployment from public `master` publishes the generated `dist/` artifact to GitHub Pages.
