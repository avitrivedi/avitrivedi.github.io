import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { bostonHour, formatBostonTime, getBostonState } from "../site/interactions.js";

const read = (path) => readFileSync(new URL(`../site/${path}`, import.meta.url), "utf8");
const home = read("index.html");
const css = read("styles.css");
const articles = ["dandho", "khata", "pulse"].map((name) => [name, read(`${name}/index.html`)]);
const publicText = [home, css, ...articles.map(([, html]) => html)].join("\n");

function instant(value) { return new Date(value); }

test("home is the concise biography, writing index, and Boston footer", () => {
  assert.match(home, /<h1>Avi Trivedi<\/h1>/);
  assert.match(home, /I live in Boston/);
  assert.match(home, /currently work at <a href="https:\/\/www\.malbek\.io\/">Malbek<\/a>/);
  assert.match(home, /helping customers get\s+substantial value from its contract lifecycle management software/);
  assert.match(home, /founder of <a href="\.\/dandho\/">Dandho/);
  assert.equal((home.match(/class="work-link"/g) ?? []).length, 3);
  assert.match(home, /class="new-marker"><span>New<\/span><svg[^>]+aria-hidden="true"/);
  assert.match(home, /<footer class="site-footer">/);
  assert.doesNotMatch(home, /<article\b|Selected project|Archive/);
  assert.doesNotMatch(publicText, /tiny[ -]?coffee/i);
});

test("contact and article routes are real and static", () => {
  assert.match(home, /href="https:\/\/x\.com\/avifacts1"/);
  assert.match(home, /href="mailto:avitrvd98@gmail\.com"/);
  for (const [name, html] of articles) {
    assert.ok(existsSync(new URL(`../site/${name}/index.html`, import.meta.url)));
    assert.match(home, new RegExp(`href="\\./${name}/"`));
    assert.match(html, /<nav class="article-nav" aria-label="Writing"><a href="\.\.\/">Index<\/a><\/nav>/);
    assert.match(html, /<footer class="article-footer"><a href="\.\.\/">← Back to the index<\/a><\/footer>/);
    assert.match(html, /<time datetime="2026-09-08">8 September, 2026<\/time>/);
    assert.doesNotMatch(html, /github\.com|private|customer quote|revenue result/i);
  }
});

test("deployment URLs target the root origin", () => {
  const publicOrigin = "https://avitrivedi.github.io";
  const publicBase = "/";
  assert.match(home, new RegExp(`<link rel="canonical" href="${publicOrigin}${publicBase}">`));
  assert.match(home, new RegExp(`<meta property="og:image" content="${publicOrigin}${publicBase}social-card\\.png">`));
  assert.doesNotMatch(publicText, /(?:href|src)="\/(?!\/)/);
  for (const [name, html] of articles) {
    assert.match(html, new RegExp(`<link rel="canonical" href="${publicOrigin}${publicBase}${name}/">`));
    assert.match(html, /href="\.\.\/styles\.css"/);
    assert.match(html, /href="\.\.\/favicon\.svg"/);
  }
  assert.match(css, /url\("\.\/fonts\/inter-latin-wght-normal\.woff2"\)/);
});

test("Boston civil time handles DST and pose boundaries", () => {
  assert.equal(bostonHour(instant("2026-03-08T06:59:00Z")), 1);
  assert.equal(bostonHour(instant("2026-03-08T07:01:00Z")), 3);
  assert.equal(bostonHour(instant("2026-11-01T05:59:00Z")), 1);
  assert.equal(bostonHour(instant("2026-11-01T06:01:00Z")), 1);
  assert.equal(getBostonState(instant("2026-09-08T14:00:00Z")), "day");
  assert.equal(getBostonState(instant("2026-09-09T00:00:00Z")), "evening");
  assert.equal(getBostonState(instant("2026-09-09T04:00:00Z")), "night");
  assert.match(formatBostonTime(instant("2026-07-01T16:34:00Z")), /^12:34pm in Boston, Massachusetts$/);
  assert.match(formatBostonTime(instant("2026-01-01T17:34:00Z")), /^12:34pm in Boston, Massachusetts$/);
});

test("the shipped home markup carries the no-JS footer fallback", () => {
  assert.match(home, /<p id="boston-time">Boston, Massachusetts<\/p>/);
  assert.match(home, /<div class="cat" data-state="day" aria-hidden="true">/);
  assert.match(home, /viewBox="0 0 38 32" width="38" height="32"/);
  assert.equal((home.match(/class="cat-pose/g) ?? []).length, 3);
});

test("local licensed assets remain lightweight", () => {
  const font = new URL("../site/fonts/inter-latin-wght-normal.woff2", import.meta.url);
  const license = read("fonts/Inter-OFL-1.1.txt");
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/i);
  assert.ok(statSync(font).size <= 60_000);
  assert.ok(gzipSync(home).byteLength + gzipSync(css).byteLength + statSync(font).size <= 60_000);
  assert.doesNotMatch(publicText, /<img|src="https?:\/\//i);
});
