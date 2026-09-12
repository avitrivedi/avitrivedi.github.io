export const ANNOTATION_SCHEMA_VERSION = 2;
export const LEGACY_ANNOTATION_SCHEMA_VERSION = 1;
export const ANNOTATION_LIMITS = Object.freeze({
  maxFileBytes: 65_536,
  maxAnnotations: 24,
  maxStrokes: 128,
  maxPointsPerStroke: 2_048,
  maxPoints: 12_000,
});

export const LAYOUTS = Object.freeze(["narrow", "broad", "compact"]);
export const TOOL_PRESETS = Object.freeze({
  pencil: Object.freeze({
    label: "Pencil",
    styles: Object.freeze(["graphite", "blue"]),
    widths: Object.freeze([1.5, 2.25, 3]),
    opacities: Object.freeze([0.55, 0.72, 0.9]),
    defaults: Object.freeze({ style: "graphite", width: 2.25, opacity: 0.72 }),
    pressure: true,
  }),
  pen: Object.freeze({
    label: "Ink pen",
    styles: Object.freeze(["graphite", "blue", "coral", "moss", "plum"]),
    widths: Object.freeze([2.25, 3.5, 5]),
    opacities: Object.freeze([0.65, 0.82, 1]),
    defaults: Object.freeze({ style: "blue", width: 3.5, opacity: 1 }),
    pressure: true,
  }),
  marker: Object.freeze({
    label: "Marker",
    styles: Object.freeze(["graphite", "blue", "coral", "moss"]),
    widths: Object.freeze([7, 10, 14]),
    opacities: Object.freeze([0.55, 0.72, 0.9]),
    defaults: Object.freeze({ style: "coral", width: 10, opacity: 0.72 }),
    pressure: true,
  }),
  highlighter: Object.freeze({
    label: "Highlighter",
    styles: Object.freeze(["yellow", "mint", "sky", "pink"]),
    widths: Object.freeze([12, 18, 24]),
    opacities: Object.freeze([0.16, 0.22, 0.3]),
    defaults: Object.freeze({ style: "yellow", width: 18, opacity: 0.22 }),
    pressure: false,
  }),
});

// Kept as a compatibility export for code that only needs the tool/style allowlist.
export const STYLES = Object.freeze(Object.fromEntries(
  Object.entries(TOOL_PRESETS).map(([tool, preset]) => [tool, preset.styles]),
));

export const STYLE_COLORS = Object.freeze({
  graphite: "#34343a",
  blue: "#2864b7",
  coral: "#c65348",
  moss: "#44735a",
  plum: "#80567f",
  yellow: "#d6a900",
  mint: "#4b9973",
  sky: "#3f82aa",
  pink: "#bd6685",
});

const WIDTH_CLASS = new Map([
  [1.5, "annotation-width--150"], [2.25, "annotation-width--225"], [3, "annotation-width--300"],
  [3.5, "annotation-width--350"], [5, "annotation-width--500"], [7, "annotation-width--700"],
  [10, "annotation-width--1000"], [12, "annotation-width--1200"], [14, "annotation-width--1400"],
  [18, "annotation-width--1800"], [24, "annotation-width--2400"],
]);
const OPACITY_CLASS = new Map([
  [0.16, "annotation-opacity--16"], [0.22, "annotation-opacity--22"], [0.3, "annotation-opacity--30"],
  [0.55, "annotation-opacity--55"], [0.65, "annotation-opacity--65"], [0.72, "annotation-opacity--72"],
  [0.82, "annotation-opacity--82"], [0.9, "annotation-opacity--90"], [1, "annotation-opacity--100"],
]);

const colorRules = Object.entries(STYLE_COLORS)
  .map(([style, color]) => `.annotation-color--${style}{stroke:${color}}`)
  .join("");
const widthRules = [...WIDTH_CLASS.entries()]
  .map(([width, className]) => `.${className}{--annotation-width:${width}px}`)
  .join("");
const opacityRules = [...OPACITY_CLASS.entries()]
  .map(([opacity, className]) => `.${className}{opacity:${opacity}}`)
  .join("");

export const ANNOTATION_CSS = `[data-annotation-active]{position:relative}.annotation-layer{position:absolute;z-index:2;inset:0;display:block;width:100%;height:100%;overflow:visible;pointer-events:none;user-select:none}.annotation-layer--narrow,.annotation-layer--compact{display:none}.annotation-stroke{fill:none;stroke-width:calc(var(--annotation-width)*var(--annotation-pressure,1));stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}.annotation-tool--pencil{stroke-linecap:round}.annotation-tool--marker{stroke-linecap:square}.annotation-tool--highlighter{stroke-linecap:butt}${colorRules}${widthRules}${opacityRules}.annotation-pressure--0{--annotation-pressure:.72}.annotation-pressure--1{--annotation-pressure:.86}.annotation-pressure--2{--annotation-pressure:1}.annotation-pressure--3{--annotation-pressure:1.13}.annotation-pressure--4{--annotation-pressure:1.26}.annotation-pressure--fixed{--annotation-pressure:1}@media(max-width:37.5rem){.annotation-layer--broad{display:none}.annotation-layer--narrow{display:block}}@media (max-height:48rem) and (min-width:46.01rem){.annotation-layer--broad{display:none}.annotation-layer--compact{display:block}}@media print{.annotation-layer{display:none!important}}@media(prefers-contrast:more){.annotation-layer{display:none}}@media(forced-colors:active){.annotation-layer{display:none!important}}`;

const FILE_KEYS = ["schemaVersion", "route", "annotations"];
const ANNOTATION_KEYS = ["anchor", "contentHash", "layout", "strokes"];
const LEGACY_STROKE_KEYS = ["tool", "style", "points"];
const STROKE_KEYS = ["tool", "style", "width", "opacity", "points"];
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LEGACY_STYLES = Object.freeze({ pen: Object.freeze(["graphite", "blue"]), highlighter: Object.freeze(["yellow"]) });
const LEGACY_DEFAULTS = Object.freeze({
  pen: Object.freeze({ width: 2.25, opacity: 1 }),
  highlighter: Object.freeze({ width: 12, opacity: 0.22 }),
});

export class AnnotationValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AnnotationValidationError";
  }
}

function fail(message) { throw new AnnotationValidationError(message); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

function requireExactKeys(value, expected, location) {
  if (!isRecord(value)) fail(`${location} must be an object`);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    fail(`${location} must contain only: ${expected.join(", ")}`);
  }
}

function safeKey(value, location) {
  if (typeof value !== "string" || value.length > 64 || !SAFE_KEY_PATTERN.test(value)) {
    fail(`${location} must be a short lowercase identifier`);
  }
}

function includesExact(values, value) {
  return typeof value === "number" && Number.isFinite(value) && values.includes(value);
}

export function validateManifest(manifest) {
  if (!isRecord(manifest)) fail("route manifest must be an object");
  for (const [route, definition] of Object.entries(manifest)) {
    if (typeof route !== "string" || !route.startsWith("/") || !route.endsWith("/")) {
      fail(`manifest route ${JSON.stringify(route)} is malformed`);
    }
    if (!isRecord(definition) || !isRecord(definition.anchors)) fail(`manifest route ${route} must define anchors`);
    const seen = new Set();
    for (const [anchor, details] of Object.entries(definition.anchors)) {
      safeKey(anchor, `manifest anchor for ${route}`);
      if (seen.has(anchor)) fail(`manifest route ${route} has duplicate anchor ID ${anchor}`);
      seen.add(anchor);
      if (!isRecord(details) || typeof details.contentHash !== "string" || !HASH_PATTERN.test(details.contentHash)) {
        fail(`manifest anchor ${anchor} has an invalid content hash`);
      }
    }
  }
  return manifest;
}

export function validateAnnotationFile(value, manifest, options = {}) {
  validateManifest(manifest);
  if (options.byteLength !== undefined) {
    if (!Number.isSafeInteger(options.byteLength) || options.byteLength < 0) fail("file size is invalid");
    if (options.byteLength > ANNOTATION_LIMITS.maxFileBytes) fail(`file exceeds the ${ANNOTATION_LIMITS.maxFileBytes}-byte limit`);
  }

  requireExactKeys(value, FILE_KEYS, "annotation file");
  if (![LEGACY_ANNOTATION_SCHEMA_VERSION, ANNOTATION_SCHEMA_VERSION].includes(value.schemaVersion)) {
    fail(`unknown schema version ${JSON.stringify(value.schemaVersion)}`);
  }
  const legacy = value.schemaVersion === LEGACY_ANNOTATION_SCHEMA_VERSION;
  if (typeof value.route !== "string" || !Object.hasOwn(manifest, value.route)) fail(`unknown route ${JSON.stringify(value.route)}`);
  if (!Array.isArray(value.annotations)) fail("annotations must be an array");
  if (value.annotations.length > ANNOTATION_LIMITS.maxAnnotations) fail(`annotation count exceeds ${ANNOTATION_LIMITS.maxAnnotations}`);

  const routeDefinition = manifest[value.route];
  const targets = new Set();
  let strokeCount = 0;
  let pointCount = 0;
  const annotations = value.annotations.map((annotation, annotationIndex) => {
    const location = `annotations[${annotationIndex}]`;
    requireExactKeys(annotation, ANNOTATION_KEYS, location);
    safeKey(annotation.anchor, `${location}.anchor`);
    const anchorDefinition = Object.hasOwn(routeDefinition.anchors, annotation.anchor) ? routeDefinition.anchors[annotation.anchor] : null;
    if (!anchorDefinition) fail(`${location} uses unknown anchor ${JSON.stringify(annotation.anchor)}`);
    if (typeof annotation.contentHash !== "string" || !HASH_PATTERN.test(annotation.contentHash)) fail(`${location}.contentHash must be a SHA-256 revision`);
    if (annotation.contentHash !== anchorDefinition.contentHash) fail(`${location} is stale: content hash does not match ${annotation.anchor}`);
    if (typeof annotation.layout !== "string" || !LAYOUTS.includes(annotation.layout)) fail(`${location}.layout must be one of: ${LAYOUTS.join(", ")}`);
    const target = `${annotation.anchor}\u0000${annotation.layout}`;
    if (targets.has(target)) fail(`${location} duplicates the ${annotation.anchor}/${annotation.layout} target`);
    targets.add(target);
    if (!Array.isArray(annotation.strokes)) fail(`${location}.strokes must be an array`);

    const strokes = annotation.strokes.map((stroke, strokeIndex) => {
      const strokeLocation = `${location}.strokes[${strokeIndex}]`;
      requireExactKeys(stroke, legacy ? LEGACY_STROKE_KEYS : STROKE_KEYS, strokeLocation);
      if (typeof stroke.tool !== "string") fail(`${strokeLocation}.tool is unknown`);
      if (legacy) {
        if (!Object.hasOwn(LEGACY_STYLES, stroke.tool)) fail(`${strokeLocation}.tool is unknown`);
        if (typeof stroke.style !== "string" || !LEGACY_STYLES[stroke.tool].includes(stroke.style)) fail(`${strokeLocation}.style is not allowed for ${stroke.tool}`);
      } else {
        if (!Object.hasOwn(TOOL_PRESETS, stroke.tool)) fail(`${strokeLocation}.tool is unknown`);
        const preset = TOOL_PRESETS[stroke.tool];
        if (typeof stroke.style !== "string" || !preset.styles.includes(stroke.style)) fail(`${strokeLocation}.style is not allowed for ${stroke.tool}`);
        if (!includesExact(preset.widths, stroke.width)) fail(`${strokeLocation}.width is not allowed for ${stroke.tool}`);
        if (!includesExact(preset.opacities, stroke.opacity)) fail(`${strokeLocation}.opacity is not allowed for ${stroke.tool}`);
      }
      if (!Array.isArray(stroke.points) || stroke.points.length === 0) fail(`${strokeLocation}.points must be a non-empty array`);
      if (stroke.points.length > ANNOTATION_LIMITS.maxPointsPerStroke) fail(`${strokeLocation} exceeds ${ANNOTATION_LIMITS.maxPointsPerStroke} points`);
      strokeCount += 1;
      if (strokeCount > ANNOTATION_LIMITS.maxStrokes) fail(`stroke count exceeds ${ANNOTATION_LIMITS.maxStrokes}`);
      const points = stroke.points.map((point, pointIndex) => {
        const pointLocation = `${strokeLocation}.points[${pointIndex}]`;
        if (!Array.isArray(point) || point.length !== 3) fail(`${pointLocation} must be [x, y, pressure]`);
        for (const [valueIndex, coordinate] of point.entries()) {
          if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) fail(`${pointLocation}[${valueIndex}] must be finite`);
          if (coordinate < 0 || coordinate > 1) fail(`${pointLocation}[${valueIndex}] must be between 0 and 1`);
        }
        pointCount += 1;
        if (pointCount > ANNOTATION_LIMITS.maxPoints) fail(`point count exceeds ${ANNOTATION_LIMITS.maxPoints}`);
        return point;
      });
      const migrated = legacy ? LEGACY_DEFAULTS[stroke.tool] : stroke;
      return { tool: stroke.tool, style: stroke.style, width: migrated.width, opacity: migrated.opacity, points };
    });
    return { anchor: annotation.anchor, contentHash: annotation.contentHash, layout: annotation.layout, strokes };
  });
  return { schemaVersion: ANNOTATION_SCHEMA_VERSION, route: value.route, annotations };
}

function rounded(value) {
  const number = Math.round(value * 10_000) / 10_000;
  return Object.is(number, -0) ? 0 : number;
}

export function canonicalizeAnnotationFile(value) {
  return {
    schemaVersion: ANNOTATION_SCHEMA_VERSION,
    route: value.route,
    annotations: [...value.annotations]
      .filter((annotation) => !Array.isArray(annotation?.strokes) || annotation.strokes.length > 0)
      .sort((left, right) => {
        const leftKey = `${left.anchor}\u0000${left.layout}`;
        const rightKey = `${right.anchor}\u0000${right.layout}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      })
      .map((annotation) => ({
        anchor: annotation.anchor,
        contentHash: annotation.contentHash,
        layout: annotation.layout,
        strokes: annotation.strokes.map((stroke) => ({
          tool: stroke.tool,
          style: stroke.style,
          width: stroke.width,
          opacity: stroke.opacity,
          points: stroke.points.map((point) => point.map(rounded)),
        })),
      })),
  };
}

export function serializeAnnotationFile(value, manifest) {
  const withoutClearedTargets = {
    ...value,
    annotations: Array.isArray(value?.annotations)
      ? value.annotations.filter((annotation) => !Array.isArray(annotation?.strokes) || annotation.strokes.length > 0)
      : value?.annotations,
  };
  const validated = validateAnnotationFile(withoutClearedTargets, manifest);
  const canonical = canonicalizeAnnotationFile(validated);
  validateAnnotationFile(canonical, manifest);
  const output = `${JSON.stringify(canonical, null, 2)}\n`;
  validateAnnotationFile(canonical, manifest, { byteLength: new TextEncoder().encode(output).byteLength });
  return output;
}

export function createEmptyAnnotationFile(route) {
  return { schemaVersion: ANNOTATION_SCHEMA_VERSION, route, annotations: [] };
}

export function reconcileAnnotationHashes(file, anchors) {
  const restamped = [];
  const stale = [];
  for (const annotation of file.annotations) {
    if (!Object.hasOwn(anchors, annotation.anchor)) continue;
    const current = anchors[annotation.anchor].contentHash;
    if (current === annotation.contentHash) continue;
    if (annotation.strokes.length === 0) {
      annotation.contentHash = current;
      restamped.push(annotation.anchor);
    } else stale.push(`${annotation.anchor}/${annotation.layout}`);
  }
  return { restamped, stale };
}

export function strokePath(points, scale = 1) {
  const coordinates = points.map(([x, y]) => [rounded(x * scale), rounded(y * scale)]);
  const [first, ...rest] = coordinates;
  if (!first) return "";
  if (rest.length === 0) return `M ${first[0]} ${first[1]} l 0.01 0`;
  if (rest.length === 1) return `M ${first[0]} ${first[1]} L ${rest[0][0]} ${rest[0][1]}`;
  const midpoint = (left, right) => [rounded((left[0] + right[0]) / 2), rounded((left[1] + right[1]) / 2)];
  let output = `M ${first[0]} ${first[1]}`;
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const current = coordinates[index];
    const next = coordinates[index + 1];
    if (index === 0) {
      const middle = midpoint(current, next);
      output += ` L ${middle[0]} ${middle[1]}`;
    } else if (index < coordinates.length - 2) {
      const middle = midpoint(current, next);
      output += ` Q ${current[0]} ${current[1]} ${middle[0]} ${middle[1]}`;
    } else output += ` Q ${current[0]} ${current[1]} ${next[0]} ${next[1]}`;
  }
  return output;
}

export function strokePressureClass(stroke) {
  if (!TOOL_PRESETS[stroke.tool]?.pressure) return "annotation-pressure--fixed";
  const average = stroke.points.reduce((sum, point) => sum + point[2], 0) / stroke.points.length;
  const band = Math.max(0, Math.min(4, Math.round(average * 4)));
  return `annotation-pressure--${band}`;
}

export function strokeClassNames(stroke) {
  const preset = TOOL_PRESETS[stroke.tool];
  if (!preset || !preset.styles.includes(stroke.style)) fail("unsafe unvalidated stroke style reached the renderer");
  const width = WIDTH_CLASS.get(stroke.width);
  const opacity = OPACITY_CLASS.get(stroke.opacity);
  if (!width || !preset.widths.includes(stroke.width)) fail("unsafe unvalidated stroke width reached the renderer");
  if (!opacity || !preset.opacities.includes(stroke.opacity)) fail("unsafe unvalidated stroke opacity reached the renderer");
  return [
    "annotation-stroke",
    `annotation-tool--${stroke.tool}`,
    `annotation-color--${stroke.style}`,
    width,
    opacity,
    strokePressureClass(stroke),
  ].join(" ");
}

function segmentDistanceSquared(point, start, end) {
  const deltaX = end[0] - start[0];
  const deltaY = end[1] - start[1];
  if (deltaX === 0 && deltaY === 0) return (point[0] - start[0]) ** 2 + (point[1] - start[1]) ** 2;
  const projection = Math.max(0, Math.min(1, ((point[0] - start[0]) * deltaX + (point[1] - start[1]) * deltaY) / (deltaX ** 2 + deltaY ** 2)));
  const closest = [start[0] + projection * deltaX, start[1] + projection * deltaY];
  return (point[0] - closest[0]) ** 2 + (point[1] - closest[1]) ** 2;
}

export function closestStrokeIndex(strokes, point, radius, scale = [1, 1]) {
  const project = ([x, y]) => [x * scale[0], y * scale[1]];
  const radiusSquared = radius ** 2;
  const target = project(point);
  for (let strokeIndex = strokes.length - 1; strokeIndex >= 0; strokeIndex -= 1) {
    const points = strokes[strokeIndex].points.map(project);
    if (points.length === 1 && segmentDistanceSquared(target, points[0], points[0]) <= radiusSquared) return strokeIndex;
    for (let index = 1; index < points.length; index += 1) {
      if (segmentDistanceSquared(target, points[index - 1], points[index]) <= radiusSquared) return strokeIndex;
    }
  }
  return -1;
}
