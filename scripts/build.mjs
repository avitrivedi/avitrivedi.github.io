import { cp, mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve("site");
const destination = resolve("dist");

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });

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
