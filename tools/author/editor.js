import {
  ANNOTATION_CSS,
  ANNOTATION_LIMITS,
  closestStrokeIndex,
  createEmptyAnnotationFile,
  serializeAnnotationFile,
  strokePath,
  validateAnnotationFile,
} from "/annotation-core.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const VIEWPORTS = {
  narrow: [
    { width: 320, height: 568, label: "320 × 568" },
    { width: 390, height: 844, label: "390 × 844" },
  ],
  broad: [
    { width: 768, height: 1024, label: "768 × 1024" },
    { width: 1366, height: 768, label: "1366 × 768" },
    { width: 1483, height: 885, label: "1483 × 885" },
  ],
};

const elements = Object.fromEntries([
  "status", "route", "anchor", "layout", "viewport", "draw-toggle", "public-preview", "style",
  "undo", "clear", "empty", "export", "import-file", "page-preview", "preview-size",
].map((id) => [id, document.getElementById(id)]));
const toolButtons = [...document.querySelectorAll(".tool")];

let manifest;
let currentFile;
let drawing = false;
let publicPreview = false;
let selectedTool = "pen";
let activePointer = null;
const routeFiles = new Map();
const histories = new Map();

function setStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.dataset.error = error ? "true" : "false";
}

function clone(value) {
  return structuredClone(value);
}

function history() {
  if (!histories.has(currentFile.route)) histories.set(currentFile.route, []);
  return histories.get(currentFile.route);
}

function remember(snapshot = clone(currentFile)) {
  const entries = history();
  entries.push(snapshot);
  if (entries.length > 50) entries.shift();
  elements.undo.disabled = false;
}

function replaceCurrent(next) {
  currentFile = next;
  routeFiles.set(next.route, next);
}

function routeDefinition() {
  return manifest[elements.route.value];
}

function selectedAnchorDefinition() {
  return routeDefinition().anchors[elements.anchor.value];
}

function selectedAnnotation(create = false) {
  let annotation = currentFile.annotations.find((entry) => (
    entry.anchor === elements.anchor.value && entry.layout === elements.layout.value
  ));
  if (!annotation && create) {
    annotation = {
      anchor: elements.anchor.value,
      contentHash: selectedAnchorDefinition().contentHash,
      layout: elements.layout.value,
      strokes: [],
    };
    currentFile.annotations.push(annotation);
  }
  return annotation;
}

function fileStrokeCount() {
  return currentFile.annotations.reduce((total, annotation) => total + annotation.strokes.length, 0);
}

function setTool(tool) {
  selectedTool = tool;
  for (const button of toolButtons) button.setAttribute("aria-checked", String(button.dataset.tool === tool));
  elements.style.replaceChildren();
  const options = tool === "pen"
    ? [["graphite", "Graphite"], ["blue", "Blue"]]
    : tool === "highlighter"
      ? [["yellow", "Yellow"]]
      : [["unused", "Not used by eraser"]];
  for (const [value, label] of options) elements.style.add(new Option(label, value));
  elements.style.disabled = tool === "eraser";
  elements.style.previousElementSibling.textContent = tool === "pen" ? "Pen style" : tool === "highlighter" ? "Highlighter style" : "Eraser";
  setStatus(`${tool[0].toUpperCase()}${tool.slice(1)} selected${drawing ? ". Drawing is active." : ". Read/scroll mode remains active."}`);
}

function configureAnchors() {
  elements.anchor.replaceChildren();
  for (const [id, details] of Object.entries(routeDefinition().anchors)) {
    elements.anchor.add(new Option(details.name, id));
  }
}

function configureViewports(preferredWidth) {
  const choices = VIEWPORTS[elements.layout.value];
  elements.viewport.replaceChildren();
  for (const choice of choices) elements.viewport.add(new Option(choice.label, String(choice.width)));
  const preferred = choices.find((choice) => choice.width === preferredWidth);
  elements.viewport.value = String(preferred?.width ?? (elements.layout.value === "broad" ? 1366 : 390));
  resizePreview();
}

function resizePreview() {
  const choice = VIEWPORTS[elements.layout.value].find(({ width }) => width === Number(elements.viewport.value));
  if (!choice) return;
  elements["page-preview"].style.width = `${choice.width}px`;
  elements["page-preview"].style.height = `${choice.height}px`;
  elements["preview-size"].textContent = `${choice.label} · ${elements.layout.value}`;
}

function previewRoute() {
  return `/preview${currentFile.route}`;
}

function loadRoute() {
  const next = previewRoute();
  if (new URL(elements["page-preview"].src || "about:blank", location.href).pathname !== next) {
    elements["page-preview"].src = next;
  } else {
    renderPreview();
  }
}

function addPreviewStyle(doc, includeAuthorStyles) {
  const style = doc.createElement("style");
  style.dataset.annotationAuthorStyle = "true";
  style.textContent = includeAuthorStyles
    ? `${ANNOTATION_CSS}\n.annotation-author-selected{outline:2px dashed #6d6d6d;outline-offset:6px}.annotation-author-canvas{pointer-events:auto!important;touch-action:none}`
    : ANNOTATION_CSS;
  doc.head.append(style);
}

function createLayer(doc, annotation, editable = false) {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", `annotation-layer annotation-layer--${annotation.layout}${editable ? " annotation-author-canvas" : ""}`);
  svg.setAttribute("viewBox", "0 0 1000 1000");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const stroke of annotation.strokes) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("class", `annotation-stroke annotation-stroke--${stroke.tool}-${stroke.style}`);
    path.setAttribute("d", strokePath(stroke.points, 1000));
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

function renderPreview() {
  const frame = elements["page-preview"];
  const doc = frame.contentDocument;
  if (!doc?.documentElement || !manifest) return;
  cleanPreview(doc);
  addPreviewStyle(doc, !publicPreview);

  for (const annotation of currentFile.annotations) {
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
  const current = selectedAnnotation(false) ?? {
    anchor: elements.anchor.value,
    contentHash: selectedAnchorDefinition().contentHash,
    layout: elements.layout.value,
    strokes: [],
  };
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
  const before = activePointer.before;
  try {
    if (layer?.hasPointerCapture(activePointer.id)) layer.releasePointerCapture(activePointer.id);
  } catch {
    // Capture may already be gone after a platform cancellation.
  }
  activePointer = null;
  replaceCurrent(before);
  renderPreview();
  setStatus("Interrupted stroke discarded. Drawing remains active.");
}

function installPointerHandlers(layer) {
  layer.addEventListener("pointerdown", (event) => {
    if (!drawing || publicPreview || !event.isPrimary || event.button !== 0 || activePointer) return;
    const point = pointFromEvent(layer, event);
    if (selectedTool === "eraser") {
      const target = selectedAnnotation(false);
      if (!target) return;
      const rect = layer.getBoundingClientRect();
      const index = closestStrokeIndex(target.strokes, point, 16 / Math.max(rect.width, rect.height));
      if (index < 0) {
        setStatus("No stroke is close enough to erase.");
        return;
      }
      const before = clone(currentFile);
      target.strokes.splice(index, 1);
      remember(before);
      renderPreview();
      setStatus("Stroke erased. Drawing remains active.");
      return;
    }

    const before = clone(currentFile);
    const target = selectedAnnotation(true);
    if (fileStrokeCount() >= ANNOTATION_LIMITS.maxStrokes) {
      replaceCurrent(before);
      setStatus(`This file has reached the ${ANNOTATION_LIMITS.maxStrokes}-stroke limit.`, true);
      return;
    }
    const stroke = { tool: selectedTool, style: elements.style.value, points: [point] };
    target.strokes.push(stroke);
    const path = layer.ownerDocument.createElementNS(SVG_NS, "path");
    path.setAttribute("class", `annotation-stroke annotation-stroke--${stroke.tool}-${stroke.style}`);
    path.setAttribute("d", strokePath(stroke.points, 1000));
    layer.append(path);
    activePointer = { id: event.pointerId, before, stroke, path };
    try { layer.setPointerCapture(event.pointerId); } catch { /* Pointer capture is best effort. */ }
    event.preventDefault();
  });

  layer.addEventListener("pointermove", (event) => {
    if (!activePointer || event.pointerId !== activePointer.id) return;
    const point = pointFromEvent(layer, event);
    const last = activePointer.stroke.points.at(-1);
    if (Math.hypot(point[0] - last[0], point[1] - last[1]) < 0.0008) return;
    if (activePointer.stroke.points.length >= ANNOTATION_LIMITS.maxPointsPerStroke) return;
    activePointer.stroke.points.push(point);
    activePointer.path.setAttribute("d", strokePath(activePointer.stroke.points, 1000));
    event.preventDefault();
  });

  layer.addEventListener("pointerup", (event) => {
    if (!activePointer || event.pointerId !== activePointer.id) return;
    const before = activePointer.before;
    activePointer = null;
    try { if (layer.hasPointerCapture(event.pointerId)) layer.releasePointerCapture(event.pointerId); } catch { /* Already released. */ }
    try {
      validateAnnotationFile(currentFile, manifest);
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
  layer.addEventListener("pointercancel", () => cancelPointer(layer));
  layer.addEventListener("lostpointercapture", () => cancelPointer(layer));
}

function discardActiveStroke() {
  if (!activePointer) return;
  cancelPointer(elements["page-preview"].contentDocument?.querySelector(".annotation-author-canvas"));
}

function setDrawing(next) {
  drawing = Boolean(next) && !publicPreview;
  if (!drawing) discardActiveStroke();
  elements["draw-toggle"].setAttribute("aria-pressed", String(drawing));
  elements["draw-toggle"].textContent = drawing ? "Disable drawing" : "Enable drawing";
  renderPreview();
  setStatus(drawing
    ? `${selectedTool[0].toUpperCase()}${selectedTool.slice(1)} active. Escape returns to read/scroll mode.`
    : "Read/scroll mode. Page links, selection, context menus, and scrolling are available.");
}

function setPublicPreview(next) {
  publicPreview = Boolean(next);
  if (publicPreview) setDrawing(false);
  document.body.dataset.publicPreview = String(publicPreview);
  elements["public-preview"].setAttribute("aria-pressed", String(publicPreview));
  elements["public-preview"].textContent = publicPreview ? "Exit public preview" : "Public preview";
  elements["draw-toggle"].disabled = publicPreview;
  renderPreview();
  setStatus(publicPreview
    ? "Exact inert public rendering preview: author outlines and input handling are off."
    : "Author preview restored in read/scroll mode.");
}

function resetModes() {
  discardActiveStroke();
  publicPreview = false;
  drawing = false;
  document.body.dataset.publicPreview = "false";
  elements["public-preview"].setAttribute("aria-pressed", "false");
  elements["public-preview"].textContent = "Public preview";
  elements["draw-toggle"].disabled = false;
  elements["draw-toggle"].setAttribute("aria-pressed", "false");
  elements["draw-toggle"].textContent = "Enable drawing";
}

async function importFile(file) {
  if (!file) return;
  try {
    if (file.size > ANNOTATION_LIMITS.maxFileBytes) throw new Error(`File exceeds the ${ANNOTATION_LIMITS.maxFileBytes}-byte limit.`);
    const text = await file.text();
    let value;
    try { value = JSON.parse(text); } catch { throw new Error("Import is not valid JSON."); }
    const validated = validateAnnotationFile(value, manifest, { byteLength: new TextEncoder().encode(text).byteLength });
    if (validated.route !== elements.route.value) {
      throw new Error(`Import is for ${validated.route}; choose that page before importing.`);
    }
    remember(clone(currentFile));
    replaceCurrent(validated);
    renderPreview();
    setStatus(`${file.name} imported and validated. Nothing has been uploaded or saved.`);
  } catch (error) {
    setStatus(`Import failed: ${error.message}`, true);
  } finally {
    elements["import-file"].value = "";
  }
}

function undo() {
  const previous = history().pop();
  if (!previous) return;
  replaceCurrent(previous);
  elements.undo.disabled = history().length === 0;
  renderPreview();
  setStatus("Last drawing change undone.");
}

function clearTarget() {
  const target = selectedAnnotation(false);
  if (!target?.strokes.length) {
    setStatus("The selected section and layout are already empty.");
    return;
  }
  if (!window.confirm(`Clear ${target.strokes.length} stroke${target.strokes.length === 1 ? "" : "s"} from this section and layout?`)) return;
  const before = clone(currentFile);
  target.strokes = [];
  remember(before);
  renderPreview();
  setStatus("Selected section and layout cleared. Undo is available.");
}

function beginEmpty() {
  if (currentFile.annotations.some((annotation) => annotation.strokes.length)
      && !window.confirm("Discard every in-memory annotation for this route and begin empty?")) return;
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
  } catch (error) {
    setStatus(`Export failed: ${error.message}`, true);
  }
}

async function frameLoaded() {
  try {
    const path = elements["page-preview"].contentWindow.location.pathname.replace(/^\/preview/, "") || "/";
    if (manifest[path] && path !== elements.route.value) {
      elements.route.value = path;
      currentFile = routeFiles.get(path);
      configureAnchors();
      elements.undo.disabled = history().length === 0;
    }
    await elements["page-preview"].contentDocument.fonts?.ready;
    renderPreview();
    setStatus("Local page ready in read/scroll mode. Choose a section, then enable drawing.");
  } catch (error) {
    setStatus(`Preview failed: ${error.message}`, true);
  }
}

function wireEvents() {
  elements.route.addEventListener("change", () => {
    resetModes();
    currentFile = routeFiles.get(elements.route.value);
    configureAnchors();
    elements.undo.disabled = history().length === 0;
    loadRoute();
  });
  elements.anchor.addEventListener("change", () => { setDrawing(false); setPublicPreview(false); });
  elements.layout.addEventListener("change", () => {
    setDrawing(false);
    setPublicPreview(false);
    configureViewports();
  });
  elements.viewport.addEventListener("change", () => { resizePreview(); requestAnimationFrame(renderPreview); });
  elements["draw-toggle"].addEventListener("click", () => setDrawing(!drawing));
  elements["public-preview"].addEventListener("click", () => setPublicPreview(!publicPreview));
  for (const button of toolButtons) button.addEventListener("click", () => setTool(button.dataset.tool));
  elements.undo.addEventListener("click", undo);
  elements.clear.addEventListener("click", clearTarget);
  elements.empty.addEventListener("click", beginEmpty);
  elements.export.addEventListener("click", exportFile);
  elements["import-file"].addEventListener("change", () => importFile(elements["import-file"].files[0]));
  elements["page-preview"].addEventListener("load", frameLoaded);
  document.addEventListener("keydown", (event) => {
    if (!drawing || event.altKey || event.ctrlKey || event.metaKey || event.target.matches("input, select, textarea, button")) return;
    const key = event.key.toLowerCase();
    if (key === "escape") setDrawing(false);
    else if (key === "p") setTool("pen");
    else if (key === "h") setTool("highlighter");
    else if (key === "e") setTool("eraser");
    else if (key === "u") undo();
    else return;
    event.preventDefault();
  });
}

async function start() {
  try {
    const response = await fetch("/authoring-manifest.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`manifest returned HTTP ${response.status}`);
    manifest = await response.json();
    for (const route of Object.keys(manifest)) {
      routeFiles.set(route, createEmptyAnnotationFile(route));
      histories.set(route, []);
      elements.route.add(new Option(manifest[route].name, route));
    }
    currentFile = routeFiles.get(elements.route.value);
    configureAnchors();
    configureViewports(1366);
    setTool("pen");
    wireEvents();
    loadRoute();
  } catch (error) {
    setStatus(`Authoring tool could not start: ${error.message}`, true);
  }
}

start();
