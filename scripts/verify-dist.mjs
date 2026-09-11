import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { ANNOTATION_ROUTES, generateAnnotatedPages } from "./annotation-build.mjs";

const root = resolve("dist");
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else files.push(path);
  }
}
await walk(root);

const names = files.map((path) => relative(root, path).replaceAll("\\", "/")).sort();
const forbiddenNames = names.filter((name) => (
  name.startsWith("tools/")
  || name.startsWith("annotations/")
  || /(?:editor|author-server|annotation-core|fixture|service-worker)/i.test(name)
  || name.endsWith(".json")
));
if (forbiddenNames.length) throw new Error(`Production contains private annotation files: ${forbiddenNames.join(", ")}`);

const textFiles = files.filter((path) => [".html", ".css", ".js", ".svg", ".txt"].some((extension) => path.endsWith(extension)));
const text = (await Promise.all(textFiles.map((path) => readFile(path, "utf8")))).join("\n");
const forbiddenContent = [
  [/(?:127\.0\.0\.1|localhost)/i, "loopback URL"],
  [/(?:\/home\/avifacts|firstmate)/i, "private path"],
  [/(?:Annotation author|Enable drawing|authoring-manifest|Import route JSON)/i, "editor text"],
  [/(?:localStorage|sessionStorage|indexedDB|serviceWorker)/, "draft storage or service worker"],
  [/(?:XMLHttpRequest|sendBeacon|new WebSocket|method\s*:\s*["']POST)/, "network write code"],
];
for (const [pattern, label] of forbiddenContent) if (pattern.test(text)) throw new Error(`Production contains ${label}`);

const expected = await generateAnnotatedPages();
let layerCount = 0;
for (const definition of ANNOTATION_ROUTES) {
  const page = await readFile(resolve(root, definition.page), "utf8");
  if (page !== expected.pages.get(definition.page)) {
    throw new Error(`${definition.page} does not match validated build-time annotation generation`);
  }
  if (!definition.anchors.every(([id]) => page.includes(`data-annotation-id=\"${id}\"`))) {
    throw new Error(`${definition.page} is missing a stable annotation anchor`);
  }
  layerCount += (page.match(/class=\"annotation-layer/g) ?? []).length;
}

console.log(`Verified ${names.length} production files: no editor, draft JSON, private paths, or write code; ${layerCount} validated annotation layer${layerCount === 1 ? "" : "s"}.`);
