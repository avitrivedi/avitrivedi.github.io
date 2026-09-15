import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const pages = ["index.html", "dandho/index.html", "khata/index.html", "pulse/index.html"];
const publicOrigin = "https://avitrivedi.github.io";
const publicBase = "/";
const documents = pages.map((path) => [path, readFileSync(resolve("site", path), "utf8")]);
const css = readFileSync(resolve("site/styles.css"), "utf8");
const errors = [];
const expect = (condition, message) => { if (!condition) errors.push(message); };

for (const [path, html] of documents) {
  expect(/^<!doctype html>/i.test(html), `${path} must start with a doctype`);
  expect(/<html lang="en">/.test(html), `${path} must declare its language`);
  expect(/<meta name="viewport"/.test(html), `${path} needs a viewport meta tag`);
  expect((html.match(/<h1(?:\s|>)/g) ?? []).length === 1, `${path} needs exactly one h1`);
  expect(/class="skip-link" href="#main-content"/.test(html), `${path} needs a skip link`);
  expect(/<main class="page-shell[^>]+id="main-content" tabindex="-1">/.test(html), `${path} needs a focusable main`);
  expect(!/<(?:script|img)\b[^>]*\bsrc="https?:\/\//.test(html), `${path} contains a remote asset`);
  expect(!/<link\b(?=[^>]*\brel="(?:icon|preload|stylesheet)")(?=[^>]*\bhref="https?:\/\/)[^>]*>/.test(html), `${path} contains a remote linked asset`);
  expect(!/(?:href|src)="\/(?!\/)/.test(html), `${path} contains a root-relative URL`);
  expect(!/target="_blank"|href="#"|coming soon|placeholder|lorem ipsum/i.test(html), `${path} contains unfinished UI`);
  const route = path === "index.html" ? publicBase : `${publicBase}${path.replace(/index\.html$/, "")}`;
  expect(html.includes(`<link rel="canonical" href="${publicOrigin}${route}">`), `${path} has the wrong canonical URL`);
  expect(html.includes(`<meta property="og:url" content="${publicOrigin}${route}">`), `${path} has the wrong social URL`);
  expect(html.includes(`<meta property="og:image" content="${publicOrigin}${publicBase}social-card.png">`), `${path} has the wrong social image URL`);
  for (const link of html.matchAll(/<a\b([^>]*)>/g)) expect(/\bhref="[^"]+"/.test(link[1]), `${path} has an anchor without href`);
}

const home = documents[0][1];
expect(/<nav class="work-index" aria-labelledby="work-index-title"(?:\s[^>]*)?>/.test(home), "home writing index must be labeled");
expect(/https:\/\/www\.malbek\.io\//.test(home), "Malbek destination is missing");
expect(/https:\/\/x\.com\/avifacts1/.test(home), "X destination is missing");
expect(/mailto:avitrvd98@gmail\.com/.test(home), "email destination is missing");
for (const route of ["dandho", "khata", "pulse"]) {
  expect(home.includes(`href="./${route}/"`), `${route} root-site route is missing`);
}
for (const [, article] of documents.slice(1)) {
  expect(article.includes('<a class="article-index-link" href="../"><span aria-hidden="true">↩ </span>Index</a>'), "article index route must be relative");
  expect(article.includes('<a class="article-index-link" href="../">← Back to the index</a>'), "article back route must be relative");
}
expect(!/tiny[ -]?coffee/i.test(documents.map(([, html]) => html).join("\n")), "removed project appears in public pages");
expect(/prefers-reduced-motion:\s*reduce/.test(css), "CSS must respect reduced motion");
expect(/forced-colors:\s*active/.test(css), "CSS needs forced-colors treatment");
expect(/@media \(hover: none\), \(pointer: coarse\)/.test(css), "CSS needs coarse-pointer treatment");
expect(/:focus-visible/.test(css), "CSS needs visible focus styles");
expect(!/@import\b/.test(css), "CSS may not import remote styles");

for (const asset of ["styles.css", "interactions.js", "favicon.svg", "social-card.svg", "social-card.png", "fonts/inter-latin-wght-normal.woff2", "fonts/Inter-OFL-1.1.txt", ...pages]) {
  expect(existsSync(resolve("site", asset)), `site/${asset} is required`);
}

if (errors.length) {
  console.error(`Site lint failed with ${errors.length} issue${errors.length === 1 ? "" : "s"}:`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else console.log("Site lint passed.");
