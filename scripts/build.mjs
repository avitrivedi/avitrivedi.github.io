import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateAnnotatedPages } from "./annotation-build.mjs";

const source = resolve("site");
const destination = resolve("dist");
const { pages } = await generateAnnotatedPages({ sourceRoot: source });

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
for (const [page, html] of pages) await writeFile(resolve(destination, page), html);

const requiredFiles = [
  "index.html",
  "styles.css",
  "interactions.js",
  "dandho/index.html",
  "khata/index.html",
  "pulse/index.html",
  "favicon.svg",
  "social-card.svg",
  "social-card.png",
  "fonts/inter-latin-wght-normal.woff2",
  "fonts/Inter-OFL-1.1.txt",
];
for (const file of requiredFiles) {
  const details = await stat(resolve(destination, file));
  if (!details.isFile() || details.size === 0) {
    throw new Error(`Build output is missing ${file}`);
  }
}

console.log(`Built ${requiredFiles.length} required static assets in dist/.`);
