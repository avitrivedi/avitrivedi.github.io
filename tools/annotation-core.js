export const ANNOTATION_SCHEMA_VERSION = 1;
export const ANNOTATION_LIMITS = Object.freeze({
  maxFileBytes: 65_536,
  maxAnnotations: 24,
  maxStrokes: 128,
  maxPointsPerStroke: 2_048,
  maxPoints: 12_000,
});

export const LAYOUTS = Object.freeze(["narrow", "broad"]);
export const STYLES = Object.freeze({
  pen: Object.freeze(["graphite", "blue"]),
  highlighter: Object.freeze(["yellow"]),
});

export const ANNOTATION_CSS = `[data-annotation-active]{position:relative}.annotation-layer{position:absolute;z-index:2;inset:0;display:block;width:100%;height:100%;overflow:visible;pointer-events:none;user-select:none}.annotation-layer--narrow{display:none}.annotation-stroke{fill:none;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}.annotation-stroke--pen-graphite{stroke:#555;stroke-width:2.25}.annotation-stroke--pen-blue{stroke:#315f9d;stroke-width:2.25}.annotation-stroke--highlighter-yellow{stroke:#d6a900;stroke-width:12;opacity:.22}@media(max-width:47.999rem){.annotation-layer--broad{display:none}.annotation-layer--narrow{display:block}}@media print{.annotation-layer{display:none!important}}@media(prefers-contrast:more){.annotation-layer{display:none}}@media(forced-colors:active){.annotation-layer{display:none!important}}`;

const FILE_KEYS = ["schemaVersion", "route", "annotations"];
const ANNOTATION_KEYS = ["anchor", "contentHash", "layout", "strokes"];
const STROKE_KEYS = ["tool", "style", "points"];
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class AnnotationValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AnnotationValidationError";
  }
}

function fail(message) {
  throw new AnnotationValidationError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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

export function validateManifest(manifest) {
  if (!isRecord(manifest)) fail("route manifest must be an object");
  for (const [route, definition] of Object.entries(manifest)) {
    if (typeof route !== "string" || !route.startsWith("/") || !route.endsWith("/")) {
      fail(`manifest route ${JSON.stringify(route)} is malformed`);
    }
    if (!isRecord(definition) || !isRecord(definition.anchors)) {
      fail(`manifest route ${route} must define anchors`);
    }
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
    if (options.byteLength > ANNOTATION_LIMITS.maxFileBytes) {
      fail(`file exceeds the ${ANNOTATION_LIMITS.maxFileBytes}-byte limit`);
    }
  }

  requireExactKeys(value, FILE_KEYS, "annotation file");
  if (value.schemaVersion !== ANNOTATION_SCHEMA_VERSION) {
    fail(`unknown schema version ${JSON.stringify(value.schemaVersion)}`);
  }
  if (typeof value.route !== "string" || !Object.hasOwn(manifest, value.route)) {
    fail(`unknown route ${JSON.stringify(value.route)}`);
  }
  if (!Array.isArray(value.annotations)) fail("annotations must be an array");
  if (value.annotations.length > ANNOTATION_LIMITS.maxAnnotations) {
    fail(`annotation count exceeds ${ANNOTATION_LIMITS.maxAnnotations}`);
  }

  const routeDefinition = manifest[value.route];
  const targets = new Set();
  let strokeCount = 0;
  let pointCount = 0;

  const annotations = value.annotations.map((annotation, annotationIndex) => {
    const location = `annotations[${annotationIndex}]`;
    requireExactKeys(annotation, ANNOTATION_KEYS, location);
    safeKey(annotation.anchor, `${location}.anchor`);
    const anchorDefinition = Object.hasOwn(routeDefinition.anchors, annotation.anchor)
      ? routeDefinition.anchors[annotation.anchor]
      : null;
    if (!anchorDefinition) fail(`${location} uses unknown anchor ${JSON.stringify(annotation.anchor)}`);
    if (typeof annotation.contentHash !== "string" || !HASH_PATTERN.test(annotation.contentHash)) {
      fail(`${location}.contentHash must be a SHA-256 revision`);
    }
    if (annotation.contentHash !== anchorDefinition.contentHash) {
      fail(`${location} is stale: content hash does not match ${annotation.anchor}`);
    }
    if (typeof annotation.layout !== "string" || !LAYOUTS.includes(annotation.layout)) {
      fail(`${location}.layout must be one of: ${LAYOUTS.join(", ")}`);
    }
    const target = `${annotation.anchor}\u0000${annotation.layout}`;
    if (targets.has(target)) fail(`${location} duplicates the ${annotation.anchor}/${annotation.layout} target`);
    targets.add(target);
    if (!Array.isArray(annotation.strokes)) fail(`${location}.strokes must be an array`);

    const strokes = annotation.strokes.map((stroke, strokeIndex) => {
      const strokeLocation = `${location}.strokes[${strokeIndex}]`;
      requireExactKeys(stroke, STROKE_KEYS, strokeLocation);
      if (typeof stroke.tool !== "string" || !Object.hasOwn(STYLES, stroke.tool)) {
        fail(`${strokeLocation}.tool is unknown`);
      }
      if (typeof stroke.style !== "string" || !STYLES[stroke.tool].includes(stroke.style)) {
        fail(`${strokeLocation}.style is not allowed for ${stroke.tool}`);
      }
      if (!Array.isArray(stroke.points) || stroke.points.length === 0) {
        fail(`${strokeLocation}.points must be a non-empty array`);
      }
      if (stroke.points.length > ANNOTATION_LIMITS.maxPointsPerStroke) {
        fail(`${strokeLocation} exceeds ${ANNOTATION_LIMITS.maxPointsPerStroke} points`);
      }
      strokeCount += 1;
      if (strokeCount > ANNOTATION_LIMITS.maxStrokes) {
        fail(`stroke count exceeds ${ANNOTATION_LIMITS.maxStrokes}`);
      }
      const points = stroke.points.map((point, pointIndex) => {
        const pointLocation = `${strokeLocation}.points[${pointIndex}]`;
        if (!Array.isArray(point) || point.length !== 3) fail(`${pointLocation} must be [x, y, pressure]`);
        for (const [valueIndex, coordinate] of point.entries()) {
          if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
            fail(`${pointLocation}[${valueIndex}] must be finite`);
          }
          if (coordinate < 0 || coordinate > 1) {
            fail(`${pointLocation}[${valueIndex}] must be between 0 and 1`);
          }
        }
        pointCount += 1;
        if (pointCount > ANNOTATION_LIMITS.maxPoints) {
          fail(`point count exceeds ${ANNOTATION_LIMITS.maxPoints}`);
        }
        return point;
      });
      return { tool: stroke.tool, style: stroke.style, points };
    });
    return {
      anchor: annotation.anchor,
      contentHash: annotation.contentHash,
      layout: annotation.layout,
      strokes,
    };
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
          points: stroke.points.map((point) => point.map(rounded)),
        })),
      })),
  };
}

export function serializeAnnotationFile(value, manifest) {
  const canonical = canonicalizeAnnotationFile(value);
  validateAnnotationFile(canonical, manifest);
  const output = `${JSON.stringify(canonical, null, 2)}\n`;
  validateAnnotationFile(canonical, manifest, { byteLength: new TextEncoder().encode(output).byteLength });
  return output;
}

export function createEmptyAnnotationFile(route) {
  return { schemaVersion: ANNOTATION_SCHEMA_VERSION, route, annotations: [] };
}

export function strokePath(points, scale = 1) {
  const coordinates = points.map(([x, y]) => [rounded(x * scale), rounded(y * scale)]);
  const [first, ...rest] = coordinates;
  if (!first) return "";
  if (rest.length === 0) {
    return `M ${first[0]} ${first[1]} l 0.01 0`;
  }
  return `M ${first[0]} ${first[1]}${rest.map(([x, y]) => ` L ${x} ${y}`).join("")}`;
}

function segmentDistanceSquared(point, start, end) {
  const deltaX = end[0] - start[0];
  const deltaY = end[1] - start[1];
  if (deltaX === 0 && deltaY === 0) {
    return (point[0] - start[0]) ** 2 + (point[1] - start[1]) ** 2;
  }
  const projection = Math.max(0, Math.min(1,
    ((point[0] - start[0]) * deltaX + (point[1] - start[1]) * deltaY) / (deltaX ** 2 + deltaY ** 2),
  ));
  const closest = [start[0] + projection * deltaX, start[1] + projection * deltaY];
  return (point[0] - closest[0]) ** 2 + (point[1] - closest[1]) ** 2;
}

export function closestStrokeIndex(strokes, point, radius) {
  const radiusSquared = radius ** 2;
  for (let strokeIndex = strokes.length - 1; strokeIndex >= 0; strokeIndex -= 1) {
    const points = strokes[strokeIndex].points;
    if (points.length === 1 && segmentDistanceSquared(point, points[0], points[0]) <= radiusSquared) return strokeIndex;
    for (let index = 1; index < points.length; index += 1) {
      if (segmentDistanceSquared(point, points[index - 1], points[index]) <= radiusSquared) return strokeIndex;
    }
  }
  return -1;
}
