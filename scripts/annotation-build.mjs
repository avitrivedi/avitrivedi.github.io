import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ANNOTATION_CSS,
  ANNOTATION_LIMITS,
  LAYOUTS,
  strokeClassNames,
  strokePathForStroke,
  validateAnnotationFile,
  validateManifest,
} from "../tools/annotation-core.js";

export const ANNOTATION_ROUTES = Object.freeze([
  {
    route: "/",
    name: "Home",
    page: "index.html",
    data: "home.json",
    anchors: [
      ["home-introduction", "Introduction"],
      ["home-writing", "Writing index"],
      ["home-boston", "Boston time and cat"],
    ],
  },
  {
    route: "/dandho/",
    name: "Dandho",
    page: "dandho/index.html",
    data: "dandho.json",
    anchors: [
      ["dandho-header", "Article heading"],
      ["dandho-overview", "Overview"],
      ["dandho-operating-model", "Start with the operating model"],
      ["dandho-boundaries", "Make boundaries do useful work"],
      ["dandho-conversation", "Software should fit the conversation"],
    ],
  },
  {
    route: "/khata/",
    name: "Khata",
    page: "khata/index.html",
    data: "khata.json",
    anchors: [
      ["khata-header", "Article heading"],
      ["khata-overview", "Overview"],
      ["khata-barcode", "The barcode is the starting point"],
      ["khata-stock", "Keep stock connected to the sale"],
      ["khata-report", "A report should answer the next question"],
    ],
  },
  {
    route: "/pulse/",
    name: "Pulse",
    page: "pulse/index.html",
    data: "pulse.json",
    anchors: [
      ["pulse-header", "Article heading"],
      ["pulse-overview", "Overview"],
      ["pulse-grain", "Define the grain before the metric"],
      ["pulse-handoffs", "Prefer inspectable handoffs"],
      ["pulse-scorecard", "A scorecard is an interface"],
    ],
  },
]);

const ANCHOR_PATTERN = /<([a-z][a-z0-9-]*)\b[^>]*\bdata-annotation-id="([^"]+)"[^>]*>/gi;

function findClosingTag(html, tag, start) {
  const pattern = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
  pattern.lastIndex = start;
  let depth = 1;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    if (match[0][1] === "/") depth -= 1;
    else depth += 1;
    if (depth === 0) return { start: match.index, end: pattern.lastIndex };
  }
  throw new Error(`Annotation anchor <${tag}> has no closing tag`);
}

export function inspectPageAnchors(html, expectedAnchors, page) {
  const anchors = new Map();
  for (const match of html.matchAll(ANCHOR_PATTERN)) {
    const [, tag, id] = match;
    if (anchors.has(id)) throw new Error(`${page} has duplicate annotation ID ${id}`);
    const close = findClosingTag(html, tag, match.index + match[0].length);
    const inner = html.slice(match.index + match[0].length, close.start);
    const canonical = inner.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
    anchors.set(id, {
      id,
      tag,
      openStart: match.index,
      openEnd: match.index + match[0].length,
      closeStart: close.start,
      contentHash: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
    });
  }
  const expected = new Set(expectedAnchors.map(([id]) => id));
  for (const id of expected) if (!anchors.has(id)) throw new Error(`${page} is missing annotation ID ${id}`);
  for (const id of anchors.keys()) if (!expected.has(id)) throw new Error(`${page} has unknown annotation ID ${id}`);
  if (anchors.size !== expected.size) throw new Error(`${page} annotation IDs do not match the route manifest`);
  return anchors;
}

export async function createAnnotationManifest(sourceRoot = resolve("site")) {
  const manifest = {};
  for (const definition of ANNOTATION_ROUTES) {
    const configuredIds = definition.anchors.map(([id]) => id);
    if (new Set(configuredIds).size !== configuredIds.length) {
      throw new Error(`${definition.page} route configuration has duplicate annotation IDs`);
    }
    const html = await readFile(resolve(sourceRoot, definition.page), "utf8");
    const inspected = inspectPageAnchors(html, definition.anchors, definition.page);
    manifest[definition.route] = {
      name: definition.name,
      page: definition.page,
      data: definition.data,
      anchors: Object.fromEntries(definition.anchors.map(([id, name]) => [id, {
        name,
        contentHash: inspected.get(id).contentHash,
      }])),
    };
  }
  validateManifest(manifest);
  return manifest;
}

function svgFor(annotation) {
  if (!LAYOUTS.includes(annotation.layout)) throw new Error("unsafe unvalidated layout reached the renderer");
  const paths = annotation.strokes.map((stroke) => {
    const classes = strokeClassNames(stroke);
    const path = strokePathForStroke(stroke, 1000);
    return `<path class="${classes}" d="${path}"></path>`;
  }).join("");
  return `<svg class="annotation-layer annotation-layer--${annotation.layout}" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true" focusable="false">${paths}</svg>`;
}

export function renderRouteAnnotations(html, annotationFile, definition) {
  const inspected = inspectPageAnchors(html, definition.anchors, definition.page);
  const byAnchor = new Map();
  for (const annotation of annotationFile.annotations) {
    if (annotation.strokes.length === 0) continue;
    if (!byAnchor.has(annotation.anchor)) byAnchor.set(annotation.anchor, []);
    byAnchor.get(annotation.anchor).push(annotation);
  }
  if (byAnchor.size === 0) return html;

  const headEnd = html.indexOf("</head>");
  if (headEnd < 0) throw new Error(`${definition.page} has no closing head element`);
  const edits = [{ position: headEnd, text: `<style>${ANNOTATION_CSS}</style>\n  ` }];
  for (const [anchor, annotations] of byAnchor) {
    const position = inspected.get(anchor);
    edits.push({ position: position.openEnd - 1, text: " data-annotation-active" });
    const layers = [...annotations]
      .sort((left, right) => left.layout.localeCompare(right.layout))
      .map(svgFor)
      .join("");
    edits.push({ position: position.closeStart, text: layers });
  }
  edits.sort((left, right) => right.position - left.position);
  let output = html;
  for (const edit of edits) output = `${output.slice(0, edit.position)}${edit.text}${output.slice(edit.position)}`;
  return output;
}

export async function loadAndValidateRouteAnnotations(definition, manifest, annotationRoot = resolve("annotations")) {
  const filePath = resolve(annotationRoot, definition.data);
  const raw = await readFile(filePath);
  if (raw.byteLength > ANNOTATION_LIMITS.maxFileBytes) {
    throw new Error(`${definition.data}: file exceeds the ${ANNOTATION_LIMITS.maxFileBytes}-byte limit`);
  }
  let value;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new Error(`${definition.data}: invalid JSON (${error.message})`);
  }
  try {
    return validateAnnotationFile(value, manifest, { byteLength: raw.byteLength });
  } catch (error) {
    throw new Error(`${definition.data}: ${error.message}`);
  }
}

export async function generateAnnotatedPages({
  sourceRoot = resolve("site"),
  annotationRoot = resolve("annotations"),
} = {}) {
  const manifest = await createAnnotationManifest(sourceRoot);
  const pages = new Map();
  for (const definition of ANNOTATION_ROUTES) {
    const [html, annotationFile] = await Promise.all([
      readFile(resolve(sourceRoot, definition.page), "utf8"),
      loadAndValidateRouteAnnotations(definition, manifest, annotationRoot),
    ]);
    pages.set(definition.page, renderRouteAnnotations(html, annotationFile, definition));
  }
  return { manifest, pages };
}
