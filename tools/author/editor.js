import {
  ANNOTATION_CSS,
  ANNOTATION_LIMITS,
  LEGACY_ANNOTATION_SCHEMA_VERSION,
  STYLE_COLORS,
  TOOL_PRESETS,
  closestStrokeIndex,
  createEmptyAnnotationFile,
  reconcileAnnotationHashes,
  serializeAnnotationFile,
  strokeClassNames,
  strokePathForStroke,
  validateAnnotationFile,
  validateManifest,
} from "/annotation-core.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const VIEWPORTS = {
  narrow: [
    { width: 320, height: 568, label: "320 × 568" },
    { width: 390, height: 844, label: "390 × 844" },
  ],
  broad: [
    { width: 768, height: 1024, label: "768 × 1024" },
    { width: 1366, height: 900, label: "1366 × 900" },
    { width: 1483, height: 885, label: "1483 × 885" },
  ],
  compact: [
    { width: 768, height: 720, label: "768 × 720" },
    { width: 1366, height: 768, label: "1366 × 768" },
    { width: 1483, height: 768, label: "1483 × 768" },
  ],
};
const COLOR_LABELS = {
  graphite: "Graphite",
  blue: "Ocean blue",
  coral: "Coral",
  moss: "Moss",
  plum: "Plum",
  yellow: "Sun yellow",
  mint: "Mint",
  sky: "Sky blue",
  pink: "Petal pink",
};
const THEME_ORDER = ["system", "light", "dark"];

const elements = Object.fromEntries([
  "status", "route", "anchor", "layout", "viewport", "draw-toggle", "public-preview",
  "width", "opacity", "color-palette", "brush-settings", "brush-preview", "tool-dock", "undo", "redo",
  "clear", "empty", "export", "import-file", "page-preview", "preview-size", "theme-toggle",
].map((id) => [id, document.getElementById(id)]));
const toolButtons = [...document.querySelectorAll(".tool")];
const drawingControls = [...document.querySelectorAll(".tool, #width, #opacity, #undo, #redo, #clear")];
const toolSettings = Object.fromEntries(Object.entries(TOOL_PRESETS).map(([tool, preset]) => [tool, { ...preset.defaults }]));

let manifest;
let currentFile;
let drawing = false;
let publicPreview = false;
let selectedTool = "pencil";
let activePointer = null;
const routeFiles = new Map();
const histories = new Map();

function setStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.dataset.error = error ? "true" : "false";
  elements.status.title = message;
}

function clone(value) { return structuredClone(value); }
function history() { return histories.get(currentFile.route); }

function updateHistoryControls() {
  const entries = history();
  elements.undo.disabled = publicPreview || entries.past.length === 0;
  elements.redo.disabled = publicPreview || entries.future.length === 0;
}

function remember(snapshot = clone(currentFile)) {
  const entries = history();
  entries.past.push(snapshot);
  if (entries.past.length > 50) entries.past.shift();
  entries.future.length = 0;
  updateHistoryControls();
}

function replaceCurrent(next) {
  currentFile = next;
  routeFiles.set(next.route, next);
}

function routeDefinition() { return manifest[elements.route.value]; }
function selectedAnchorDefinition() { return routeDefinition().anchors[elements.anchor.value]; }

function emptyAnnotation() {
  return {
    anchor: elements.anchor.value,
    contentHash: selectedAnchorDefinition().contentHash,
    layout: elements.layout.value,
    strokes: [],
  };
}

function selectedAnnotation(create = false) {
  let annotation = currentFile.annotations.find((entry) => entry.anchor === elements.anchor.value && entry.layout === elements.layout.value);
  if (!annotation && create) {
    annotation = emptyAnnotation();
    currentFile.annotations.push(annotation);
  }
  return annotation;
}

function fileWithFreshSiblings(target) {
  const anchors = manifest[currentFile.route].anchors;
  return {
    schemaVersion: currentFile.schemaVersion,
    route: currentFile.route,
    annotations: currentFile.annotations.map((annotation) => (
      annotation === target || !Object.hasOwn(anchors, annotation.anchor)
        ? annotation
        : { ...annotation, contentHash: anchors[annotation.anchor].contentHash }
    )),
  };
}

function fileStrokeCount() {
  return currentFile.annotations.reduce((total, annotation) => total + annotation.strokes.length, 0);
}

function addOptions(select, values, formatter) {
  select.replaceChildren();
  for (const value of values) select.add(new Option(formatter(value), String(value)));
}

function updateBrushPreview() {
  const preset = TOOL_PRESETS[selectedTool];
  const settings = toolSettings[selectedTool];
  const unavailable = selectedTool === "eraser";
  elements["brush-settings"].hidden = unavailable;
  if (unavailable) return;
  elements["brush-preview"].style.stroke = STYLE_COLORS[settings.style];
  elements["brush-preview"].style.strokeWidth = String(settings.width);
  elements["brush-preview"].style.opacity = String(settings.opacity);
  elements["brush-preview"].style.strokeLinecap = selectedTool === "marker" ? "square" : selectedTool === "highlighter" ? "butt" : "round";
  elements["brush-preview"].dataset.pressureAware = String(preset.pressure);
}

function configurePalette() {
  const settings = toolSettings[selectedTool];
  const palette = elements["color-palette"];
  palette.replaceChildren();
  for (const style of TOOL_PRESETS[selectedTool].styles) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "color-swatch";
    button.dataset.style = style;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(style === settings.style));
    button.setAttribute("aria-label", COLOR_LABELS[style]);
    button.title = COLOR_LABELS[style];
    button.style.setProperty("--swatch", STYLE_COLORS[style]);
    button.addEventListener("click", () => {
      settings.style = style;
      for (const swatch of palette.children) swatch.setAttribute("aria-checked", String(swatch === button));
      updateBrushPreview();
      setStatus(`${COLOR_LABELS[style]} selected for ${TOOL_PRESETS[selectedTool].label.toLowerCase()}.`);
    });
    palette.append(button);
  }
}

function configureBrushControls() {
  if (selectedTool === "eraser") {
    elements["brush-settings"].hidden = true;
    return;
  }
  const preset = TOOL_PRESETS[selectedTool];
  const settings = toolSettings[selectedTool];
  addOptions(elements.width, preset.widths, (value) => `${value} px`);
  addOptions(elements.opacity, preset.opacities, (value) => `${Math.round(value * 100)}%`);
  elements.width.value = String(settings.width);
  elements.opacity.value = String(settings.opacity);
  configurePalette();
  updateBrushPreview();
}

function setTool(tool) {
  if (tool !== "eraser" && !Object.hasOwn(TOOL_PRESETS, tool)) return;
  selectedTool = tool;
  for (const button of toolButtons) button.setAttribute("aria-checked", String(button.dataset.tool === tool));
  configureBrushControls();
  const name = tool === "eraser" ? "Whole-stroke eraser" : TOOL_PRESETS[tool].label;
  setStatus(`${name} selected. ${drawing ? "Drawing is active." : "Read and scroll mode remains active."}`);
}

function configureAnchors() {
  elements.anchor.replaceChildren();
  for (const [id, details] of Object.entries(routeDefinition().anchors)) elements.anchor.add(new Option(details.name, id));
}

function configureViewports(preferredWidth) {
  const choices = VIEWPORTS[elements.layout.value];
  elements.viewport.replaceChildren();
  for (const choice of choices) elements.viewport.add(new Option(choice.label, String(choice.width)));
  const preferred = choices.find((choice) => choice.width === preferredWidth);
  elements.viewport.value = String(preferred?.width ?? (elements.layout.value === "narrow" ? 390 : 1366));
  resizePreview();
}

function resizePreview() {
  const choice = VIEWPORTS[elements.layout.value].find(({ width }) => width === Number(elements.viewport.value));
  if (!choice) return;
  elements["page-preview"].style.width = `${choice.width}px`;
  elements["page-preview"].style.height = `${choice.height}px`;
  elements["preview-size"].textContent = `${choice.label} · ${elements.layout.value}`;
}

function previewRoute() { return `/preview${currentFile.route}`; }

function loadRoute() {
  const next = previewRoute();
  if (new URL(elements["page-preview"].src || "about:blank", location.href).pathname !== next) elements["page-preview"].src = next;
  else renderPreview();
}

function addPreviewStyle(doc, includeAuthorStyles) {
  const style = doc.createElement("style");
  style.dataset.annotationAuthorStyle = "true";
  style.textContent = includeAuthorStyles
    ? `${ANNOTATION_CSS}\n.annotation-author-selected{outline:2px dashed #587367;outline-offset:6px}.annotation-author-canvas{pointer-events:auto!important;touch-action:none;cursor:crosshair}`
    : ANNOTATION_CSS;
  doc.head.append(style);
}

function createLayer(doc, annotation) {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", `annotation-layer annotation-layer--${annotation.layout}`);
  svg.setAttribute("viewBox", "0 0 1000 1000");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const stroke of annotation.strokes) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("class", strokeClassNames(stroke));
    path.setAttribute("d", strokePathForStroke(stroke, 1000));
    svg.append(path);
  }
  return svg;
}

function cleanPreview(doc) {
  for (const node of doc.querySelectorAll(".annotation-layer")) node.remove();
  for (const node of doc.querySelectorAll("[data-annotation-active]")) node.removeAttribute("data-annotation-active");
  for (const node of doc.querySelectorAll(".annotation-author-selected")) node.classList.remove("annotation-author-selected");
  for (const node of doc.querySelectorAll("style[data-annotation-author-style]")) node.remove();
}

function publicPreviewFile() {
  return JSON.parse(serializeAnnotationFile(currentFile, manifest));
}

function renderPreview() {
  const frame = elements["page-preview"];
  const doc = frame.contentDocument;
  if (!doc?.documentElement || !manifest) return;
  const previewFile = publicPreview ? publicPreviewFile() : currentFile;
  cleanPreview(doc);
  addPreviewStyle(doc, !publicPreview);
  for (const annotation of previewFile.annotations) {
    if (annotation.strokes.length === 0) continue;
    const host = doc.querySelector(`[data-annotation-id="${annotation.anchor}"]`);
    if (!host) continue;
    host.setAttribute("data-annotation-active", "");
    host.append(createLayer(doc, annotation));
  }
  if (publicPreview) return;
  const host = doc.querySelector(`[data-annotation-id="${elements.anchor.value}"]`);
  if (!host) {
    setStatus("The selected section is not present on this preview page.", true);
    return;
  }
  host.classList.add("annotation-author-selected");
  host.setAttribute("data-annotation-active", "");
  const current = selectedAnnotation(false) ?? emptyAnnotation();
  let layer = [...host.querySelectorAll(":scope > .annotation-layer")]
    .find((candidate) => candidate.classList.contains(`annotation-layer--${elements.layout.value}`));
  if (!layer) {
    layer = createLayer(doc, current);
    host.append(layer);
  }
  if (drawing) {
    layer.classList.add("annotation-author-canvas");
    installPointerHandlers(layer);
  }
}

function pointFromEvent(layer, event) {
  const rect = layer.getBoundingClientRect();
  const clamp = (number) => Math.max(0, Math.min(1, number));
  const pressure = event.pressure > 0 ? event.pressure : 0.5;
  return [clamp((event.clientX - rect.left) / rect.width), clamp((event.clientY - rect.top) / rect.height), clamp(pressure)];
}

function cancelPointer(layer) {
  if (!activePointer) return;
  const { before, id } = activePointer;
  activePointer = null;
  try { if (layer?.hasPointerCapture(id)) layer.releasePointerCapture(id); } catch { /* Capture may already be gone. */ }
  replaceCurrent(before);
  renderPreview();
  setStatus("Interrupted stroke discarded. Drawing remains active.");
}

function appendPointerPoints(layer, event) {
  const samples = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [event];
  for (const sample of samples.length ? samples : [event]) {
    const point = pointFromEvent(layer, sample);
    const last = activePointer.stroke.points.at(-1);
    if (Math.hypot(point[0] - last[0], point[1] - last[1]) < 0.0008) continue;
    if (activePointer.stroke.points.length >= ANNOTATION_LIMITS.maxPointsPerStroke) break;
    activePointer.stroke.points.push(point);
  }
  activePointer.path.setAttribute("d", strokePathForStroke(activePointer.stroke, 1000));
  activePointer.path.setAttribute("class", strokeClassNames(activePointer.stroke));
}

function installPointerHandlers(layer) {
  layer.addEventListener("pointerdown", (event) => {
    if (!drawing || publicPreview || !event.isPrimary || event.button !== 0 || activePointer) return;
    const point = pointFromEvent(layer, event);
    if (selectedTool === "eraser") {
      const target = selectedAnnotation(false);
      if (!target) { event.preventDefault(); return; }
      const rect = layer.getBoundingClientRect();
      const index = closestStrokeIndex(target.strokes, point, 18, [rect.width, rect.height]);
      if (index < 0) {
        setStatus("No stroke is close enough to erase.");
        event.preventDefault();
        return;
      }
      activePointer = { id: event.pointerId, before: clone(currentFile), eraseIndex: index, target };
      try { layer.setPointerCapture(event.pointerId); } catch { /* Capture is best effort. */ }
      event.preventDefault();
      return;
    }

    const before = clone(currentFile);
    const target = selectedAnnotation(true);
    if (fileStrokeCount() >= ANNOTATION_LIMITS.maxStrokes) {
      replaceCurrent(before);
      setStatus(`This file has reached the ${ANNOTATION_LIMITS.maxStrokes}-stroke limit.`, true);
      event.preventDefault();
      return;
    }
    if (target.strokes.length === 0) target.contentHash = selectedAnchorDefinition().contentHash;
    const settings = toolSettings[selectedTool];
    const stroke = { tool: selectedTool, style: settings.style, width: settings.width, opacity: settings.opacity, points: [point] };
    target.strokes.push(stroke);
    const path = layer.ownerDocument.createElementNS(SVG_NS, "path");
    path.setAttribute("class", strokeClassNames(stroke));
    path.setAttribute("d", strokePathForStroke(stroke, 1000));
    layer.append(path);
    activePointer = { id: event.pointerId, before, stroke, path, target };
    try { layer.setPointerCapture(event.pointerId); } catch { /* Capture is best effort. */ }
    event.preventDefault();
  });

  layer.addEventListener("pointermove", (event) => {
    if (!activePointer || event.pointerId !== activePointer.id) return;
    if (activePointer.stroke) appendPointerPoints(layer, event);
    event.preventDefault();
  });

  layer.addEventListener("pointerup", (event) => {
    if (!activePointer || event.pointerId !== activePointer.id) return;
    if (activePointer.stroke) appendPointerPoints(layer, event);
    const { before, eraseIndex, target } = activePointer;
    activePointer = null;
    try { if (layer.hasPointerCapture(event.pointerId)) layer.releasePointerCapture(event.pointerId); } catch { /* Already released. */ }
    if (eraseIndex !== undefined) {
      target.strokes.splice(eraseIndex, 1);
      remember(before);
      renderPreview();
      setStatus("Whole stroke erased. Undo is available.");
      event.preventDefault();
      return;
    }
    try {
      validateAnnotationFile(fileWithFreshSiblings(target), manifest);
      remember(before);
      renderPreview();
      setStatus("Stroke added. Drawing remains active.");
    } catch (error) {
      replaceCurrent(before);
      renderPreview();
      setStatus(error.message, true);
    }
    event.preventDefault();
  });
  const cancelMatchingPointer = (event) => {
    if (!activePointer || event.pointerId !== activePointer.id) return;
    cancelPointer(layer);
  };
  layer.addEventListener("pointercancel", cancelMatchingPointer);
  layer.addEventListener("lostpointercapture", cancelMatchingPointer);
}

function discardActiveStroke() {
  if (!activePointer) return;
  cancelPointer(elements["page-preview"].contentDocument?.querySelector(".annotation-author-canvas"));
}

function setDrawing(next) {
  drawing = Boolean(next) && !publicPreview;
  if (!drawing) discardActiveStroke();
  document.body.dataset.drawing = String(drawing);
  elements["draw-toggle"].setAttribute("aria-pressed", String(drawing));
  elements["draw-toggle"].querySelector("span").textContent = drawing ? "Stop drawing" : "Start drawing";
  elements["draw-toggle"].title = drawing ? "Return to read and scroll mode (Escape)" : "Enter drawing mode";
  renderPreview();
  const toolName = selectedTool === "eraser" ? "Whole-stroke eraser" : TOOL_PRESETS[selectedTool].label;
  setStatus(drawing
    ? `${toolName} active. Escape returns to read and scroll mode.`
    : "Read and scroll mode. Links, selection, context menus, focus, and touch gestures are available.");
}

function setPublicPreview(next) {
  const enable = Boolean(next);
  if (enable) {
    setDrawing(false);
    try {
      publicPreviewFile();
    } catch (error) {
      setStatus(`Public preview unavailable: ${error.message}`, true);
      return;
    }
  }
  publicPreview = enable;
  document.body.dataset.publicPreview = String(publicPreview);
  elements["public-preview"].setAttribute("aria-pressed", String(publicPreview));
  elements["public-preview"].querySelector("span").textContent = publicPreview ? "Exit public preview" : "Public preview";
  elements["draw-toggle"].disabled = publicPreview;
  elements["tool-dock"].inert = publicPreview;
  for (const control of drawingControls) control.disabled = publicPreview || ((control === elements.undo || control === elements.redo) && control.disabled);
  if (!publicPreview) {
    for (const control of drawingControls) if (control !== elements.undo && control !== elements.redo) control.disabled = false;
  }
  updateHistoryControls();
  renderPreview();
  setStatus(publicPreview
    ? "Exact public preview. The layer is inert, decorative, nonfocusable, and uses production rendering."
    : "Author preview restored in read and scroll mode.");
}

function resetModes() {
  discardActiveStroke();
  publicPreview = false;
  drawing = false;
  document.body.dataset.publicPreview = "false";
  document.body.dataset.drawing = "false";
  elements["public-preview"].setAttribute("aria-pressed", "false");
  elements["public-preview"].querySelector("span").textContent = "Public preview";
  elements["draw-toggle"].disabled = false;
  elements["tool-dock"].inert = false;
  elements["draw-toggle"].setAttribute("aria-pressed", "false");
  elements["draw-toggle"].querySelector("span").textContent = "Start drawing";
  for (const control of drawingControls) if (control !== elements.undo && control !== elements.redo) control.disabled = false;
  updateHistoryControls();
}

async function importFile(file) {
  if (!file) return;
  discardActiveStroke();
  try {
    if (file.size > ANNOTATION_LIMITS.maxFileBytes) throw new Error(`File exceeds the ${ANNOTATION_LIMITS.maxFileBytes}-byte limit.`);
    const text = await file.text();
    let value;
    try { value = JSON.parse(text); } catch { throw new Error("Import is not valid JSON."); }
    const sourceVersion = value?.schemaVersion;
    const validated = validateAnnotationFile(value, manifest, { byteLength: new TextEncoder().encode(text).byteLength });
    if (validated.route !== elements.route.value) throw new Error(`Import is for ${validated.route}; choose that page before importing.`);
    remember(clone(currentFile));
    replaceCurrent(validated);
    renderPreview();
    const migration = sourceVersion === LEGACY_ANNOTATION_SCHEMA_VERSION ? " Legacy v1 strokes were deterministically migrated in memory." : "";
    setStatus(`${file.name} imported and validated.${migration} Nothing was uploaded or saved.`);
  } catch (error) {
    setStatus(`Import failed: ${error.message}`, true);
  } finally { elements["import-file"].value = ""; }
}

function undo() {
  discardActiveStroke();
  const entries = history();
  const previous = entries.past.pop();
  if (!previous) return;
  entries.future.push(clone(currentFile));
  replaceCurrent(previous);
  updateHistoryControls();
  renderPreview();
  setStatus("Last drawing change undone. Redo is available.");
}

function redo() {
  discardActiveStroke();
  const entries = history();
  const next = entries.future.pop();
  if (!next) return;
  entries.past.push(clone(currentFile));
  replaceCurrent(next);
  updateHistoryControls();
  renderPreview();
  setStatus("Drawing change restored.");
}

function clearTarget() {
  discardActiveStroke();
  const target = selectedAnnotation(false);
  if (!target?.strokes.length) {
    setStatus("The selected section and scope are already empty.");
    return;
  }
  if (!window.confirm(`Clear ${target.strokes.length} stroke${target.strokes.length === 1 ? "" : "s"} from this section and scope? You can undo this.`)) return;
  const before = clone(currentFile);
  target.strokes = [];
  remember(before);
  renderPreview();
  setStatus("Selected section and scope cleared. Undo is available.");
}

function beginEmpty() {
  discardActiveStroke();
  if (currentFile.annotations.some((annotation) => annotation.strokes.length)
      && !window.confirm("Discard every in-memory annotation for this route and begin empty? You can undo this.")) return;
  remember(clone(currentFile));
  replaceCurrent(createEmptyAnnotationFile(currentFile.route));
  renderPreview();
  setStatus("Started an empty in-memory route file. The repository was not changed.");
}

function exportFile() {
  try {
    const output = serializeAnnotationFile(currentFile, manifest);
    const blob = new Blob([output], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = routeDefinition().data;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus(`${routeDefinition().data} exported deterministically. Review it before replacing annotations/${routeDefinition().data}.`);
  } catch (error) { setStatus(`Export failed: ${error.message}`, true); }
}

async function fetchManifest() {
  const response = await fetch("/authoring-manifest.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`manifest returned HTTP ${response.status}`);
  return validateManifest(await response.json());
}

async function refreshManifest() {
  const next = await fetchManifest();
  const stale = [];
  for (const [route, definition] of Object.entries(next)) {
    const file = routeFiles.get(route);
    if (!file) continue;
    for (const target of reconcileAnnotationHashes(file, definition.anchors).stale) stale.push(`${route} ${target}`);
  }
  manifest = next;
  return stale;
}

async function frameLoaded() {
  try {
    elements["page-preview"].contentDocument.addEventListener("keydown", handleShortcut);
    const path = elements["page-preview"].contentWindow.location.pathname.replace(/^\/preview/, "") || "/";
    if (manifest[path] && path !== elements.route.value) {
      elements.route.value = path;
      currentFile = routeFiles.get(path);
      configureAnchors();
      updateHistoryControls();
    }
    await elements["page-preview"].contentDocument.fonts?.ready;
    let notice = "";
    try {
      const stale = await refreshManifest();
      if (stale.length > 0) notice = ` Page content changed under ${stale.join(", ")}: redraw or clear ${stale.length === 1 ? "that mark" : "those marks"} before export.`;
    } catch (error) { notice = ` Page revisions could not be refreshed: ${error.message}`; }
    renderPreview();
    setStatus(`Local page ready in read and scroll mode. Choose a section, then start drawing.${notice}`, notice !== "");
  } catch (error) { setStatus(`Preview failed: ${error.message}`, true); }
}

function handleShortcut(event) {
  if (!drawing || event.altKey || event.ctrlKey || event.metaKey) return;
  const { target } = event;
  const key = event.key.toLowerCase();
  const editable = Boolean(target?.isContentEditable)
    || (typeof target?.matches === "function" && target.matches("input, select, textarea"));
  if (key === "escape" && !editable) {
    setDrawing(false);
    event.preventDefault();
    return;
  }
  if (editable || (typeof target?.matches === "function" && target.matches("button, summary"))) return;
  const action = {
    p: () => setTool("pencil"),
    i: () => setTool("pen"),
    m: () => setTool("marker"),
    h: () => setTool("highlighter"),
    e: () => setTool("eraser"),
    u: undo,
    r: redo,
  }[key];
  if (!action) return;
  action();
  event.preventDefault();
}

function cycleTheme() {
  const current = document.documentElement.dataset.theme;
  const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
  document.documentElement.dataset.theme = next;
  document.body.dataset.theme = next;
  elements["theme-toggle"].setAttribute("aria-label", `Theme: ${next === "system" ? "follow system" : next}`);
  setStatus(`Editor theme set to ${next === "system" ? "follow your system" : next}. The public page preview is unchanged.`);
}

function wireEvents() {
  elements.route.addEventListener("change", () => {
    resetModes();
    currentFile = routeFiles.get(elements.route.value);
    configureAnchors();
    updateHistoryControls();
    loadRoute();
  });
  elements.anchor.addEventListener("change", () => { setDrawing(false); setPublicPreview(false); });
  elements.layout.addEventListener("change", () => { setDrawing(false); setPublicPreview(false); configureViewports(); });
  elements.viewport.addEventListener("change", () => { resizePreview(); requestAnimationFrame(renderPreview); });
  elements["draw-toggle"].addEventListener("click", () => setDrawing(!drawing));
  elements["public-preview"].addEventListener("click", () => setPublicPreview(!publicPreview));
  for (const button of toolButtons) button.addEventListener("click", () => setTool(button.dataset.tool));
  elements.width.addEventListener("change", () => { toolSettings[selectedTool].width = Number(elements.width.value); updateBrushPreview(); });
  elements.opacity.addEventListener("change", () => { toolSettings[selectedTool].opacity = Number(elements.opacity.value); updateBrushPreview(); });
  elements.undo.addEventListener("click", undo);
  elements.redo.addEventListener("click", redo);
  elements.clear.addEventListener("click", clearTarget);
  elements.empty.addEventListener("click", beginEmpty);
  elements.export.addEventListener("click", exportFile);
  elements["import-file"].addEventListener("change", () => importFile(elements["import-file"].files[0]));
  elements["page-preview"].addEventListener("load", frameLoaded);
  elements["theme-toggle"].addEventListener("click", cycleTheme);
  document.addEventListener("keydown", handleShortcut);
}

async function start() {
  try {
    manifest = await fetchManifest();
    for (const route of Object.keys(manifest)) {
      routeFiles.set(route, createEmptyAnnotationFile(route));
      histories.set(route, { past: [], future: [] });
      elements.route.add(new Option(manifest[route].name, route));
    }
    currentFile = routeFiles.get(elements.route.value);
    configureAnchors();
    configureViewports(1366);
    setTool("pencil");
    updateHistoryControls();
    wireEvents();
    loadRoute();
  } catch (error) { setStatus(`Authoring tool could not start: ${error.message}`, true); }
}

start();
