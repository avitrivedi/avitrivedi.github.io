import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  ANNOTATION_CSS,
  ANNOTATION_LIMITS,
  AnnotationValidationError,
  LAYOUTS,
  TOOL_PRESETS,
  canonicalizeAnnotationFile,
  closestStrokeIndex,
  reconcileAnnotationHashes,
  serializeAnnotationFile,
  strokeClassNames,
  strokePath,
  strokePathForStroke,
  validateAnnotationFile,
} from "../tools/annotation-core.js";
import {
  ANNOTATION_ROUTES,
  createAnnotationManifest,
  generateAnnotatedPages,
  inspectPageAnchors,
  renderRouteAnnotations,
} from "../scripts/annotation-build.mjs";

const siteRoot = resolve("site");
const fixtureRoot = resolve("test/fixtures/annotations");
const manifest = await createAnnotationManifest(siteRoot);
const hash = manifest["/"].anchors["home-introduction"].contentHash;

function validFile(overrides = {}) {
  return {
    schemaVersion: 2,
    route: "/",
    annotations: [{
      anchor: "home-introduction",
      contentHash: hash,
      layout: "broad",
      strokes: [{ tool: "pen", style: "graphite", width: 2.25, opacity: 1, points: [[0.1, 0.2, 0.5], [0.3, 0.4, 0.6]] }],
    }],
    ...overrides,
  };
}

function legacyFile(overrides = {}) {
  return {
    schemaVersion: 1,
    route: "/",
    annotations: [{
      anchor: "home-introduction",
      contentHash: hash,
      layout: "broad",
      strokes: [{ tool: "pen", style: "graphite", points: [[0.1, 0.2, 0], [0.3, 0.4, 0]] }],
    }],
    ...overrides,
  };
}

function changed(file, callback) {
  const copy = structuredClone(file);
  callback(copy);
  return copy;
}

function rejects(file, pattern, options) {
  assert.throws(() => validateAnnotationFile(file, manifest, options), (error) => {
    assert.ok(error instanceof AnnotationValidationError);
    assert.match(error.message, pattern);
    return true;
  });
}

test("the manifest covers four routes with durable unique source anchors", () => {
  assert.deepEqual(Object.keys(manifest), ["/", "/dandho/", "/khata/", "/pulse/"]);
  for (const definition of ANNOTATION_ROUTES) {
    const ids = definition.anchors.map(([id]) => id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(Object.keys(manifest[definition.route].anchors), ids);
    for (const details of Object.values(manifest[definition.route].anchors)) {
      assert.match(details.contentHash, /^sha256:[a-f0-9]{64}$/);
    }
  }
  assert.throws(
    () => inspectPageAnchors(
      '<section data-annotation-id="same"></section><section data-annotation-id="same"></section>',
      [["same", "Same"]],
      "duplicate.html",
    ),
    /duplicate annotation ID same/,
  );
});

test("strict validation accepts every preset and deterministic serialization is stable", () => {
  const file = validFile();
  assert.deepEqual(validateAnnotationFile(file, manifest), file);
  const presetStrokes = Object.entries(TOOL_PRESETS).map(([tool, preset], index) => ({
    tool,
    style: preset.styles[index % preset.styles.length],
    width: preset.widths[index % preset.widths.length],
    opacity: preset.opacities[index % preset.opacities.length],
    points: [[0.1 + index * 0.01, 0.2, 0.5]],
  }));
  assert.deepEqual(validateAnnotationFile(validFile({ annotations: [{ ...file.annotations[0], strokes: presetStrokes }] }), manifest).annotations[0].strokes, presetStrokes);
  const reversed = validFile({
    annotations: [
      { anchor: "home-writing", contentHash: manifest["/"].anchors["home-writing"].contentHash, layout: "narrow", strokes: [{ tool: "pen", style: "blue", width: 3.5, opacity: 0.82, points: [[0.1234567, -0, 0.5]] }] },
      ...file.annotations,
    ],
  });
  const once = serializeAnnotationFile(reversed, manifest);
  const twice = serializeAnnotationFile(JSON.parse(once), manifest);
  assert.equal(once, twice);
  assert.ok(once.endsWith("\n"));
  assert.ok(once.indexOf("home-introduction") < once.indexOf("home-writing"));
  assert.match(once, /0\.1235/);
  assert.doesNotMatch(once, /timestamp|private|device|\/home\//i);
  assert.equal(Object.is(canonicalizeAnnotationFile(reversed).annotations[1].strokes[0].points[0][1], -0), false);
});

test("legacy v1 files migrate deterministically without changing their rendering", () => {
  const legacy = legacyFile({
    annotations: [
      {
        ...legacyFile().annotations[0],
        strokes: [{ tool: "pen", style: "graphite", points: [[0.1, 0.2, 0], [0.3, 0.4, 1], [0.2, 0.5, 0.2]] }],
      },
      {
        anchor: "home-writing",
        contentHash: manifest["/"].anchors["home-writing"].contentHash,
        layout: "narrow",
        strokes: [{ tool: "highlighter", style: "yellow", points: [[0.2, 0.3, 0.7], [0.6, 0.3, 0.2]] }],
      },
    ],
  });
  const migrated = validateAnnotationFile(legacy, manifest);
  assert.equal(migrated.schemaVersion, 2);
  assert.deepEqual(migrated.annotations[0].strokes[0], {
    tool: "legacy-pen", style: "graphite", width: 2.25, opacity: 1,
    points: [[0.1, 0.2, 0.5], [0.3, 0.4, 0.5], [0.2, 0.5, 0.5]],
  });
  assert.deepEqual(migrated.annotations[1].strokes[0], {
    tool: "legacy-highlighter", style: "yellow", width: 12, opacity: 0.22,
    points: [[0.2, 0.3, 0.7], [0.6, 0.3, 0.2]],
  });
  const rendered = renderRouteAnnotations(readFileSync(resolve(siteRoot, "index.html"), "utf8"), migrated, ANNOTATION_ROUTES[0]);
  assert.equal(strokePathForStroke(migrated.annotations[0].strokes[0], 1000), "M 100 200 L 300 400 L 200 500");
  assert.equal(strokePathForStroke(migrated.annotations[1].strokes[0], 1000), "M 200 300 L 600 300");
  assert.match(strokeClassNames(migrated.annotations[0].strokes[0]), /annotation-tool--legacy-pen.*annotation-pressure--fixed/);
  assert.match(strokeClassNames(migrated.annotations[1].strokes[0]), /annotation-tool--legacy-highlighter.*annotation-pressure--fixed/);
  assert.match(ANNOTATION_CSS, /legacy-pen\.annotation-color--graphite\{stroke:#555\}/);
  assert.match(ANNOTATION_CSS, /legacy-pen\.annotation-color--blue\{stroke:#315f9d\}/);
  assert.match(rendered, /annotation-tool--legacy-pen[^>]*d="M 100 200 L 300 400 L 200 500"/);
  assert.match(rendered, /annotation-tool--legacy-highlighter[^>]*d="M 200 300 L 600 300"/);
  const once = serializeAnnotationFile(legacy, manifest);
  assert.equal(once, serializeAnnotationFile(JSON.parse(once), manifest));
  assert.deepEqual(JSON.parse(once), migrated);
});

test("serialization drops cleared targets so they cannot go stale in the repository", () => {
  const cleared = validFile({
    annotations: [
      { anchor: "home-introduction", contentHash: hash, layout: "broad", strokes: [] },
      ...validFile({ annotations: [{ ...validFile().annotations[0], layout: "narrow" }] }).annotations,
    ],
  });
  const output = JSON.parse(serializeAnnotationFile(cleared, manifest));
  assert.deepEqual(output.annotations.map((annotation) => annotation.layout), ["narrow"]);

  const staleAfterEdit = changed(cleared, (file) => {
    file.annotations[0].contentHash = `sha256:${"0".repeat(64)}`;
    file.annotations.pop();
  });
  rejects(staleAfterEdit, /is stale/);
  assert.deepEqual(JSON.parse(serializeAnnotationFile(staleAfterEdit, manifest)).annotations, []);
  assert.deepEqual(canonicalizeAnnotationFile(cleared).annotations.length, 1);
});

test("refreshed revisions restamp untouched targets and report drawn ones as stale", () => {
  const older = `sha256:${"0".repeat(64)}`;
  const file = validFile({
    annotations: [
      { anchor: "home-introduction", contentHash: older, layout: "broad", strokes: [] },
      { anchor: "home-writing", contentHash: older, layout: "narrow", strokes: [{ tool: "pen", style: "blue", width: 2.25, opacity: 1, points: [[0.1, 0.2, 0.5]] }] },
      { anchor: "home-boston", contentHash: manifest["/"].anchors["home-boston"].contentHash, layout: "broad", strokes: [] },
    ],
  });
  rejects(file, /is stale/);

  const report = reconcileAnnotationHashes(file, manifest["/"].anchors);
  assert.deepEqual(report.restamped, ["home-introduction"]);
  assert.deepEqual(report.stale, ["home-writing/narrow"]);
  assert.equal(file.annotations[0].contentHash, hash);
  assert.equal(file.annotations[1].contentHash, older);
  rejects(file, /is stale: content hash does not match home-writing/);

  file.annotations[1].strokes = [];
  assert.deepEqual(reconcileAnnotationHashes(file, manifest["/"].anchors).stale, []);
  assert.deepEqual(validateAnnotationFile(file, manifest).annotations.map((entry) => entry.anchor),
    ["home-introduction", "home-writing", "home-boston"]);
});

test("validation rejects unknown schema, routes, anchors, tools, styles, and fields", () => {
  rejects(validFile({ schemaVersion: 3 }), /unknown schema version/);
  rejects(validFile({ route: "/missing/" }), /unknown route/);
  rejects(changed(validFile(), (file) => { file.annotations[0].anchor = "not-an-anchor"; }), /unknown anchor/);
  rejects(changed(validFile(), (file) => { file.annotations[0].strokes[0].tool = "spray"; }), /tool is unknown/);
  rejects(changed(validFile(), (file) => { file.annotations[0].strokes[0].style = "#fff"; }), /style is not allowed/);
  rejects(changed(validFile(), (file) => { file.annotations[0].strokes[0].width = 2.3; }), /width is not allowed/);
  rejects(changed(validFile(), (file) => {
    Object.assign(file.annotations[0].strokes[0], { tool: "legacy-pen", width: 3.5 });
  }), /width is not allowed for legacy-pen/);
  rejects(changed(validFile(), (file) => { file.annotations[0].strokes[0].opacity = 0.81; }), /opacity is not allowed/);
  rejects(changed(validFile(), (file) => { file.annotations[0].strokes[0].width = "url(javascript:alert(1))"; }), /width is not allowed/);
  rejects({ ...validFile(), rawSvg: "<svg onload=alert(1)>" }, /must contain only/);
  rejects(changed(validFile(), (file) => { file.annotations[0].id = "file-supplied-dom-id"; }), /must contain only/);
  rejects(changed(validFile(), (file) => { file.annotations[0].strokes[0].url = "https://example.test"; }), /must contain only/);
});

test("validation rejects stale hashes, duplicate targets, and malformed scopes", () => {
  rejects(changed(validFile(), (file) => { file.annotations[0].contentHash = `sha256:${"0".repeat(64)}`; }), /is stale/);
  rejects(validFile({ annotations: [validFile().annotations[0], validFile().annotations[0]] }), /duplicates the/);
  rejects(changed(validFile(), (file) => { file.annotations[0].layout = "desktop<script>"; }), /layout must be one of/);
  rejects(changed(validFile(), (file) => { file.annotations[0].contentHash = "main"; }), /must be a SHA-256/);
});

test("validation rejects unsafe strings, malformed points, non-finite values, and invalid pressure", () => {
  rejects(changed(validFile(), (file) => { file.annotations[0].anchor = "<script>"; }), /short lowercase identifier/);
  rejects(changed(validFile(), (file) => { file.annotations[0].strokes[0].points[0] = [0.2, 0.3]; }), /must be \[x, y, pressure\]/);
  rejects(changed(validFile(), (file) => { file.annotations[0].strokes[0].points[0][0] = Number.NaN; }), /must be finite/);
  rejects(changed(validFile(), (file) => { file.annotations[0].strokes[0].points[0][1] = 1.01; }), /between 0 and 1/);
  rejects(changed(validFile(), (file) => { file.annotations[0].strokes[0].points[0][2] = -0.01; }), /between 0 and 1/);
});

test("validation enforces file, annotation, stroke, and point limits", () => {
  rejects(validFile(), /file exceeds/, { byteLength: ANNOTATION_LIMITS.maxFileBytes + 1 });
  rejects(validFile({ annotations: Array.from({ length: ANNOTATION_LIMITS.maxAnnotations + 1 }, () => ({})) }), /annotation count exceeds/);
  rejects(changed(validFile(), (file) => {
    file.annotations[0].strokes = Array.from({ length: ANNOTATION_LIMITS.maxStrokes + 1 }, () => ({ tool: "pen", style: "graphite", width: 2.25, opacity: 1, points: [[0, 0, 0.5]] }));
  }), /stroke count exceeds/);
  rejects(changed(validFile(), (file) => {
    file.annotations[0].strokes[0].points = Array.from({ length: ANNOTATION_LIMITS.maxPointsPerStroke + 1 }, () => [0, 0, 0.5]);
  }), /exceeds 2048 points/);
  rejects(changed(validFile(), (file) => {
    file.annotations[0].strokes = Array.from({ length: 6 }, () => ({
      tool: "pen",
      style: "graphite",
      width: 2.25,
      opacity: 1,
      points: Array.from({ length: 2_001 }, () => [0, 0, 0.5]),
    }));
  }), /point count exceeds/);
});

test("content revisions change when anchored source content changes", () => {
  const source = readFileSync(resolve(siteRoot, "index.html"), "utf8");
  const definition = ANNOTATION_ROUTES[0];
  const before = inspectPageAnchors(source, definition.anchors, definition.page);
  const after = inspectPageAnchors(source.replace("I live in Boston.", "I live near Boston."), definition.anchors, definition.page);
  assert.notEqual(before.get("home-introduction").contentHash, after.get("home-introduction").contentHash);
  assert.equal(before.get("home-writing").contentHash, after.get("home-writing").contentHash);
});

test("empty production data leaves page bytes unchanged", async () => {
  const generated = await generateAnnotatedPages({ sourceRoot: siteRoot, annotationRoot: resolve("annotations") });
  for (const definition of ANNOTATION_ROUTES) {
    assert.equal(generated.pages.get(definition.page), readFileSync(resolve(siteRoot, definition.page), "utf8"));
  }
});

test("fixture data generates inert, allowlisted SVG isolated to each route", async () => {
  const generated = await generateAnnotatedPages({ sourceRoot: siteRoot, annotationRoot: fixtureRoot });
  const home = generated.pages.get("index.html");
  const dandho = generated.pages.get("dandho/index.html");
  const khata = generated.pages.get("khata/index.html");
  assert.equal((home.match(/class="annotation-layer/g) ?? []).length, 2);
  assert.match(home, /annotation-layer--broad/);
  assert.match(home, /annotation-layer--narrow/);
  assert.match(home, /aria-hidden="true" focusable="false"/);
  assert.match(home, /<path class="annotation-stroke annotation-tool--legacy-pen annotation-color--blue annotation-width--225 annotation-opacity--100 annotation-pressure--fixed"/);
  assert.match(home, /<path class="annotation-stroke annotation-tool--legacy-highlighter annotation-color--yellow annotation-width--1200 annotation-opacity--22 annotation-pressure--fixed"/);
  assert.doesNotMatch(home, /annotation-tool--legacy-pen annotation-color--graphite/);
  assert.match(dandho, /annotation-tool--legacy-pen annotation-color--graphite/);
  assert.doesNotMatch(dandho, /<path[^>]+annotation-color--(?:blue|yellow)/);
  assert.doesNotMatch(khata, /annotation-layer/);
  for (const html of [home, dandho]) {
    assert.doesNotMatch(html, /<svg[^>]+(?:id=|tabindex=|onclick=|href=|style=)/);
    assert.doesNotMatch(html, /<script[^>]*annotation|innerHTML|javascript:/i);
  }
});

test("the generated SVG maps every reviewed preset value to fixed classes", () => {
  const definition = ANNOTATION_ROUTES[0];
  const source = readFileSync(resolve(siteRoot, definition.page), "utf8");
  const strokes = Object.entries(TOOL_PRESETS).flatMap(([tool, preset]) => preset.styles.map((style, index) => ({
    tool,
    style,
    width: preset.widths[index % preset.widths.length],
    opacity: preset.opacities[index % preset.opacities.length],
    points: [[0.1, 0.1 + index * 0.03, index / Math.max(1, preset.styles.length - 1)], [0.8, 0.2, 1]],
  })));
  const file = validFile({ annotations: [{ ...validFile().annotations[0], strokes }] });
  const validated = validateAnnotationFile(file, manifest);
  const html = renderRouteAnnotations(source, validated, definition);
  for (const [tool, preset] of Object.entries(TOOL_PRESETS)) {
    assert.match(html, new RegExp(`annotation-tool--${tool}`));
    for (const style of preset.styles) assert.match(html, new RegExp(`annotation-color--${style}`));
  }
  assert.doesNotMatch(html, /<path[^>]+(?:style=|onload=|href=)/);
  assert.match(html, /annotation-pressure--fixed/);
  assert.match(html, /annotation-pressure--[0-4]/);
});

test("the renderer uses deterministic finite paths and eraser hit testing prefers the top stroke", () => {
  assert.equal(strokePath([[0.1, 0.2, 0.5], [0.3, 0.4, 1]], 1000), "M 100 200 L 300 400");
  assert.match(strokePath([[0.1, 0.2, 0.5]], 1000), /^M 100 200 l/);
  const strokes = [
    { points: [[0, 0, 0.5], [1, 1, 0.5]] },
    { points: [[0, 1, 0.5], [1, 0, 0.5]] },
  ];
  assert.equal(closestStrokeIndex(strokes, [0.5, 0.5], 0.01), 1);
  assert.equal(closestStrokeIndex(strokes, [0.5, 0.8], 0.01), -1);
  const curved = [{ points: [[0, 0, 0.5], [1, 1, 0.5], [0, 1, 0.5]] }];
  assert.equal(strokePath(curved[0].points, 1000), "M 0 0 L 500 500 Q 1000 1000 0 1000");
  assert.equal(closestStrokeIndex(curved, [0.625, 0.875], 18, [1000, 1000]), 0);
  const legacyLinear = [{ tool: "legacy-pen", points: curved[0].points }];
  assert.equal(strokePathForStroke(legacyLinear[0], 1000), "M 0 0 L 1000 1000 L 0 1000");
  assert.equal(closestStrokeIndex(legacyLinear, [1, 1], 18, [1000, 1000]), 0);
});

test("eraser hit testing measures a pixel radius on both axes of a non-square section", () => {
  const wideSection = [550, 103];
  const tallSection = [103, 550];
  const horizontal = [{ points: [[0, 0.5, 0.5], [1, 0.5, 0.5]] }];
  const vertical = [{ points: [[0.5, 0, 0.5], [0.5, 1, 0.5]] }];
  assert.equal(closestStrokeIndex(horizontal, [0.5, 0.55], 16, wideSection), 0);
  assert.equal(closestStrokeIndex(vertical, [0.55, 0.5], 16, tallSection), 0);
  assert.equal(closestStrokeIndex(horizontal, [0.5, 0.55], 16 / 550), -1);
  assert.equal(closestStrokeIndex(vertical, [0.55, 0.5], 16 / 550), -1);
  assert.equal(closestStrokeIndex(horizontal, [0.5, 0.9], 16, wideSection), -1);
  assert.equal(closestStrokeIndex(vertical, [0.9, 0.5], 16, tallSection), -1);
});

test("every supported layout scope validates and generates its own scoped layer", () => {
  const definition = ANNOTATION_ROUTES[0];
  const source = readFileSync(resolve(siteRoot, definition.page), "utf8");
  const file = validFile({
    annotations: LAYOUTS.map((layout) => ({
      anchor: "home-introduction",
      contentHash: hash,
      layout,
      strokes: [{ tool: "pen", style: "graphite", width: 2.25, opacity: 1, points: [[0.1, 0.2, 0.5], [0.3, 0.4, 0.6]] }],
    })),
  });
  assert.deepEqual(LAYOUTS, ["narrow", "broad", "compact"]);
  assert.deepEqual(validateAnnotationFile(file, manifest).annotations.map((entry) => entry.layout), LAYOUTS);
  const html = renderRouteAnnotations(source, file, definition);
  for (const layout of LAYOUTS) {
    assert.equal((html.match(new RegExp(`annotation-layer annotation-layer--${layout}"`, "g")) ?? []).length, 1);
  }
  assert.deepEqual(
    JSON.parse(serializeAnnotationFile(file, manifest)).annotations.map((entry) => entry.layout),
    ["broad", "compact", "narrow"],
  );
});

test("hostile fixture input cannot be reflected by the build renderer", () => {
  const definition = ANNOTATION_ROUTES[0];
  const source = readFileSync(resolve(siteRoot, definition.page), "utf8");
  const hostile = changed(validFile(), (file) => {
    file.annotations[0].strokes[0].style = 'graphite" onload="alert(1)';
  });
  rejects(hostile, /style is not allowed/);
  assert.throws(() => renderRouteAnnotations(source, hostile, definition), /unsafe unvalidated stroke style/);
});

test("invalid JSON and oversized route files fail before publication", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "annotation-invalid-"));
  try {
    for (const definition of ANNOTATION_ROUTES) {
      const source = readFileSync(resolve("annotations", definition.data));
      writeFileSync(join(temporary, definition.data), source);
    }
    writeFileSync(join(temporary, "home.json"), "{ definitely not json");
    await assert.rejects(generateAnnotatedPages({ sourceRoot: siteRoot, annotationRoot: temporary }), /home\.json: invalid JSON/);
    writeFileSync(join(temporary, "home.json"), " ".repeat(ANNOTATION_LIMITS.maxFileBytes + 1));
    await assert.rejects(generateAnnotatedPages({ sourceRoot: siteRoot, annotationRoot: temporary }), /file exceeds/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
