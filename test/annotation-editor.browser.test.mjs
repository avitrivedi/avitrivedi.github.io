import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { createAuthorServer, listen } from "../tools/author-server.mjs";
import {
  ANNOTATION_ROUTES,
  createAnnotationManifest,
  generateAnnotatedPages,
  renderRouteAnnotations,
} from "../scripts/annotation-build.mjs";
import { TOOL_PRESETS, serializeAnnotationFile } from "../tools/annotation-core.js";

function findChromium() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const cache of [join(homedir(), ".cache/ms-playwright"), join(homedir(), ".cache/puppeteer")]) {
    if (!existsSync(cache)) continue;
    for (const entry of readdirSync(cache)) {
      candidates.push(join(cache, entry, "chrome-linux64/chrome"), join(cache, entry, "chrome-linux/chrome"));
    }
  }
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

class Connection {
  #socket;
  #id = 0;
  #pending = new Map();
  #events = [];
  sessionId;

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (!pending) return;
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else {
        for (const listener of this.#events.filter((entry) => entry.method === message.method)) listener.callback(message.params);
      }
    });
  }

  static async open(url) {
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error("DevTools handshake timed out")), 20_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolveOpen(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("DevTools handshake failed")); }, { once: true });
    });
    return new Connection(socket);
  }

  send(method, params = {}) {
    const id = ++this.#id;
    const payload = { id, method, params };
    if (this.sessionId) payload.sessionId = this.sessionId;
    return new Promise((resolveSend, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 20_000);
      this.#pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolveSend(result); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.#socket.send(JSON.stringify(payload));
    });
  }

  on(method, callback) { this.#events.push({ method, callback }); }
  close() { this.#socket.close(); }
}

async function launchChromium(binary, downloadPath) {
  const profile = mkdtempSync(join(tmpdir(), "annotation-editor-chrome-"));
  const child = spawn(binary, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--disable-background-networking", "--disable-extensions", "--no-first-run",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Chromium endpoint timed out")), 30_000);
    child.stderr.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/(ws:\/\/\S+)\r?\n/);
      if (!match) return;
      clearTimeout(timer);
      resolveEndpoint(match[1]);
    });
    child.once("error", reject);
    child.once("close", (code) => reject(new Error(`Chromium exited early with ${code}`)));
  });
  const connection = await Connection.open(endpoint);
  const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
  connection.sessionId = sessionId;
  await connection.send("Page.enable");
  await connection.send("Network.enable");
  await connection.send("DOM.enable");
  await connection.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath });
  return {
    page: connection,
    close: async () => {
      connection.close();
      child.kill("SIGKILL");
      await new Promise((done) => { child.once("close", done); setTimeout(done, 2_000).unref(); });
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

const chromium = findChromium();
const unavailable = !chromium
  ? "no Chromium or Chrome binary found"
  : typeof WebSocket !== "function"
    ? "Node.js has no global WebSocket"
    : false;
const required = Boolean(process.env.CI || process.env.REQUIRE_BROWSER);
if (unavailable && required) test("annotation editor browser is available", () => assert.fail(unavailable));

const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

describe("local annotation editor in a real browser", { skip: unavailable, timeout: 240_000 }, () => {
  let authorServer;
  let fixtureServer;
  let browser;
  let page;
  let origin;
  let fixtureOrigin;
  let downloadPath;
  const requests = [];

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };

  const waitFor = async (expression, message) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await evaluate(expression)) return;
      await pause(50);
    }
    assert.fail(message);
  };

  const captureEvidence = async (name) => {
    if (!process.env.ANNOTATION_SCREENSHOT_DIR) return;
    const { data } = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(process.env.ANNOTATION_SCREENSHOT_DIR, name), Buffer.from(data, "base64"));
  };

  const setFile = async (path) => {
    const { root } = await page.send("DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId } = await page.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#import-file" });
    await page.send("DOM.setFileInputFiles", { nodeId, files: [path] });
    await evaluate('document.querySelector("#import-file").dispatchEvent(new Event("change", { bubbles: true }))');
  };

  before(async () => {
    authorServer = createAuthorServer();
    const address = await listen(authorServer, 0);
    origin = `http://127.0.0.1:${address.port}`;

    const generated = await generateAnnotatedPages({ annotationRoot: resolve("test/fixtures/annotations") });
    const generatedRoutes = new Map([
      ["/", generated.pages.get("index.html")],
      ["/dandho/", generated.pages.get("dandho/index.html")],
      ["/khata/", generated.pages.get("khata/index.html")],
      ["/pulse/", generated.pages.get("pulse/index.html")],
    ]);
    fixtureServer = createServer((request, response) => {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      if (generatedRoutes.has(pathname)) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(generatedRoutes.get(pathname));
        return;
      }
      const file = resolve("site", pathname.replace(/^\//, ""));
      if (!file.startsWith(`${resolve("site")}/`) || !existsSync(file)) {
        response.writeHead(404).end();
        return;
      }
      const type = { ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" }[extname(file)] ?? "application/octet-stream";
      response.writeHead(200, { "content-type": type });
      response.end(readFileSync(file));
    });
    await new Promise((done) => fixtureServer.listen(0, "127.0.0.1", done));
    fixtureOrigin = `http://127.0.0.1:${fixtureServer.address().port}`;

    downloadPath = mkdtempSync(join(tmpdir(), "annotation-downloads-"));
    browser = await launchChromium(chromium, downloadPath);
    page = browser.page;
    page.on("Network.requestWillBeSent", ({ request }) => requests.push(request.url));
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1483, height: 885, deviceScaleFactor: 1, mobile: false });
    await page.send("Page.navigate", { url: `${origin}/` });
    await waitFor(
      'document.querySelector("#page-preview")?.contentDocument?.querySelector("[data-annotation-id=home-introduction]") && document.querySelector("#status").textContent.includes("Local page ready")',
      "the local authoring preview did not become ready",
    );
  });

  after(async () => {
    if (browser) await browser.close();
    if (authorServer) await new Promise((done) => authorServer.close(done));
    if (fixtureServer) await new Promise((done) => fixtureServer.close(done));
    if (downloadPath) rmSync(downloadPath, { recursive: true, force: true });
  });

  test("imports home and essay fixtures, scopes responsive layers, and exports deterministic JSON", async () => {
    const ready = await evaluate('document.querySelector("#status").textContent');
    assert.match(ready, /Local page ready in read and scroll mode/);
    assert.doesNotMatch(ready, /could not be refreshed|Page content changed/);
    assert.equal(await evaluate('document.querySelector("#status").dataset.error'), "false");

    await setFile(new URL("./fixtures/annotations/home.json", import.meta.url).pathname);
    await waitFor('document.querySelector("#status").textContent.includes("imported and validated")', "home fixture did not import");
    assert.match(await evaluate('document.querySelector("#status").textContent'), /Legacy v1 strokes were deterministically migrated/);
    const legacyHighlighter = await evaluate(`(() => {
      const stroke = document.querySelector("#page-preview").contentDocument.querySelector(".annotation-tool--legacy-highlighter");
      const style = getComputedStyle(stroke);
      return { path: stroke.getAttribute("d"), cap: style.strokeLinecap, width: style.strokeWidth, opacity: style.opacity };
    })()`);
    assert.deepEqual(legacyHighlighter, { path: "M 100 200 L 650 200", cap: "round", width: "12px", opacity: "0.22" });
    let visibility = await evaluate(`(() => {
      const doc = document.querySelector("#page-preview").contentDocument;
      return [...doc.querySelectorAll(".annotation-layer")].map((node) => [node.className.baseVal, getComputedStyle(node).display]);
    })()`);
    assert.deepEqual(visibility.map((entry) => entry[1]).sort(), ["block", "none"]);
    assert.ok(visibility.find(([name]) => name.includes("--broad"))[1] === "block");
    await captureEvidence("local-editor.png");

    await evaluate(`(() => {
      const layout = document.querySelector("#layout");
      layout.value = "narrow";
      layout.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await pause(100);
    visibility = await evaluate(`(() => {
      const doc = document.querySelector("#page-preview").contentDocument;
      return [...doc.querySelectorAll(".annotation-layer")].map((node) => [node.className.baseVal, getComputedStyle(node).display]);
    })()`);
    assert.ok(visibility.find(([name]) => name.includes("--narrow"))[1] === "block");
    assert.ok(visibility.find(([name]) => name.includes("--broad"))[1] === "none");

    await evaluate('document.querySelector("#public-preview").click()');
    assert.equal(await evaluate(`(() => {
      const dock = document.querySelector("#tool-dock");
      dock.querySelector(".color-swatch").focus();
      return dock.inert && !dock.contains(document.activeElement);
    })()`), true);
    assert.equal(await evaluate(`(() => {
      const doc = document.querySelector("#page-preview").contentDocument;
      const layers = [...doc.querySelectorAll(".annotation-layer")];
      return layers.length === 2 && layers.every((node) => getComputedStyle(node).pointerEvents === "none" && node.getAttribute("aria-hidden") === "true" && node.getAttribute("focusable") === "false") && !doc.querySelector(".annotation-author-selected, .annotation-author-canvas");
    })()`), true);
    await page.send("Emulation.setEmulatedMedia", { media: "print" });
    assert.equal(await evaluate('[...document.querySelector("#page-preview").contentDocument.querySelectorAll(".annotation-layer")].every((node) => getComputedStyle(node).display === "none")'), true);
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-contrast", value: "more" }] });
    assert.equal(await evaluate('[...document.querySelector("#page-preview").contentDocument.querySelectorAll(".annotation-layer")].every((node) => getComputedStyle(node).display === "none")'), true);
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
    assert.equal(await evaluate('[...document.querySelector("#page-preview").contentDocument.querySelectorAll(".annotation-layer")].every((node) => getComputedStyle(node).display === "none")'), true);
    await page.send("Emulation.setEmulatedMedia", { features: [] });
    await evaluate('document.querySelector("#public-preview").click(); document.querySelector("#export").click()');
    for (let attempt = 0; attempt < 100 && !existsSync(join(downloadPath, "home.json")); attempt += 1) await pause(50);
    assert.ok(existsSync(join(downloadPath, "home.json")), "home export was not downloaded");
    const expected = serializeAnnotationFile(
      JSON.parse(readFileSync(new URL("./fixtures/annotations/home.json", import.meta.url), "utf8")),
      await createAnnotationManifest(),
    );
    assert.equal(readFileSync(join(downloadPath, "home.json"), "utf8"), expected);

    await evaluate(`(() => {
      const route = document.querySelector("#route");
      route.value = "/dandho/";
      route.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await waitFor('document.querySelector("#page-preview").contentDocument?.querySelector("[data-annotation-id=dandho-overview]")', "Dandho preview did not load");
    await setFile(new URL("./fixtures/annotations/dandho.json", import.meta.url).pathname);
    await waitFor('document.querySelector("#status").textContent.includes("dandho.json imported")', "Dandho fixture did not import");
    const legacyVisual = await evaluate(`(() => {
      const stroke = document.querySelector("#page-preview").contentDocument.querySelector(".annotation-tool--legacy-pen.annotation-color--graphite");
      const style = getComputedStyle(stroke);
      return { count: stroke ? 1 : 0, path: stroke?.getAttribute("d"), color: style.stroke, width: style.strokeWidth, cap: style.strokeLinecap };
    })()`);
    assert.deepEqual(legacyVisual, { count: 1, path: "M 40 50 L 60 450 L 40 900", color: "rgb(85, 85, 85)", width: "2.25px", cap: "round" });
  });

  test("public preview matches canonical exported production geometry", async () => {
    const currentManifest = await createAnnotationManifest();
    const inputPath = join(downloadPath, "precision-input.json");
    writeFileSync(inputPath, JSON.stringify({
      schemaVersion: 2,
      route: "/",
      annotations: [{
        anchor: "home-introduction",
        contentHash: currentManifest["/"].anchors["home-introduction"].contentHash,
        layout: "broad",
        strokes: [{
          tool: "pen",
          style: "graphite",
          width: 2.25,
          opacity: 1,
          points: [[0.123456, 0.2, 0.37496], [0.8, 0.4, 0.37496]],
        }],
      }],
    }));
    await evaluate(`(() => {
      const route = document.querySelector("#route");
      route.value = "/";
      route.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await waitFor('document.querySelector("#page-preview").contentDocument?.querySelector("[data-annotation-id=home-introduction]")', "home preview did not load");
    await setFile(inputPath);
    await waitFor('document.querySelector("#status").textContent.includes("precision-input.json imported")', "precision fixture did not import");
    await evaluate('document.querySelector("#public-preview").click()');
    const previewPath = await evaluate('document.querySelector("#page-preview").contentDocument.querySelector(".annotation-layer--broad path").outerHTML');
    assert.match(previewPath, /annotation-pressure--2/);

    const exportPath = join(downloadPath, "home.json");
    rmSync(exportPath, { force: true });
    await evaluate('document.querySelector("#export").click()');
    for (let attempt = 0; attempt < 100 && !existsSync(exportPath); attempt += 1) await pause(50);
    assert.ok(existsSync(exportPath), "canonical export was not downloaded");
    const exported = JSON.parse(readFileSync(exportPath, "utf8"));
    const production = renderRouteAnnotations(
      readFileSync(resolve("site/index.html"), "utf8"),
      exported,
      ANNOTATION_ROUTES[0],
    );
    assert.ok(production.includes(previewPath));
  });

  test("draw, pointer cancellation, erase, undo, and confirmed clear preserve editor state", async () => {
    await evaluate(`(() => {
      const route = document.querySelector("#route");
      route.value = "/";
      route.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await waitFor('document.querySelector("#page-preview").contentDocument?.querySelector("[data-annotation-id=home-introduction]")', "home preview did not return");
    await evaluate(`(() => {
      const layout = document.querySelector("#layout");
      layout.value = "broad";
      layout.dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector("#draw-toggle").click();
    })()`);
    await pause(100);
    const before = await evaluate('document.querySelector("#page-preview").contentDocument.querySelectorAll("[data-annotation-id=home-introduction] > .annotation-layer--broad .annotation-stroke").length');
    await evaluate(`(() => {
      const frame = document.querySelector("#page-preview");
      const win = frame.contentWindow;
      const layer = frame.contentDocument.querySelector(".annotation-author-canvas");
      const rect = layer.getBoundingClientRect();
      const event = (type, x, y) => layer.dispatchEvent(new win.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 71, pointerType: "mouse", isPrimary: true, button: 0, clientX: rect.left + rect.width * x, clientY: rect.top + rect.height * y, pressure: 0.5 }));
      event("pointerdown", 0.2, 0.3); event("pointermove", 0.4, 0.35); event("pointerup", 0.4, 0.35);
    })()`);
    assert.equal(await evaluate('document.querySelector("#page-preview").contentDocument.querySelectorAll("[data-annotation-id=home-introduction] > .annotation-layer--broad .annotation-stroke").length'), before + 1);

    await evaluate(`(() => {
      const frame = document.querySelector("#page-preview");
      const win = frame.contentWindow;
      const layer = frame.contentDocument.querySelector(".annotation-author-canvas");
      const rect = layer.getBoundingClientRect();
      const primary = { bubbles: true, cancelable: true, pointerId: 76, pointerType: "pen", isPrimary: true, button: 0, clientX: rect.left + rect.width * 0.45, clientY: rect.top + rect.height * 0.45, pressure: 0.7 };
      const secondary = { ...primary, pointerId: 77, isPrimary: false };
      layer.dispatchEvent(new win.PointerEvent("pointerdown", primary));
      layer.dispatchEvent(new win.PointerEvent("pointercancel", secondary));
      layer.dispatchEvent(new win.PointerEvent("lostpointercapture", secondary));
      layer.dispatchEvent(new win.PointerEvent("pointermove", { ...primary, clientX: rect.left + rect.width * 0.55 }));
      layer.dispatchEvent(new win.PointerEvent("pointerup", { ...primary, clientX: rect.left + rect.width * 0.55 }));
    })()`);
    assert.equal(await evaluate('document.querySelector("#page-preview").contentDocument.querySelectorAll("[data-annotation-id=home-introduction] > .annotation-layer--broad .annotation-stroke").length'), before + 2);
    assert.doesNotMatch(await evaluate('document.querySelector("#status").textContent'), /Interrupted stroke discarded/);
    await evaluate('document.querySelector("#undo").click()');
    assert.equal(await evaluate('document.querySelector("#page-preview").contentDocument.querySelectorAll("[data-annotation-id=home-introduction] > .annotation-layer--broad .annotation-stroke").length'), before + 1);

    await evaluate(`(() => {
      const frame = document.querySelector("#page-preview");
      const win = frame.contentWindow;
      const layer = frame.contentDocument.querySelector(".annotation-author-canvas");
      const rect = layer.getBoundingClientRect();
      const options = { bubbles: true, cancelable: true, pointerId: 72, pointerType: "pen", isPrimary: true, button: 0, clientX: rect.left + rect.width * 0.3, clientY: rect.top + rect.height * 0.4, pressure: 0.7 };
      layer.dispatchEvent(new win.PointerEvent("pointerdown", options));
      layer.dispatchEvent(new win.PointerEvent("pointercancel", options));
    })()`);
    assert.equal(await evaluate('document.querySelector("#page-preview").contentDocument.querySelectorAll("[data-annotation-id=home-introduction] > .annotation-layer--broad .annotation-stroke").length'), before + 1);
    assert.match(await evaluate('document.querySelector("#status").textContent'), /Interrupted stroke discarded/);

    await evaluate('document.querySelector("[data-tool=eraser]").click()');
    const canvas = await evaluate('(() => { const rect = document.querySelector("#page-preview").contentDocument.querySelector(".annotation-author-canvas").getBoundingClientRect(); return [rect.width, rect.height]; })()');
    assert.ok(
      canvas[1] < canvas[0] * 0.625,
      `the introduction section is ${canvas[0]}x${canvas[1]}, too square to prove the eraser measures pixels on both axes`,
    );
    await evaluate(`(() => {
      const frame = document.querySelector("#page-preview");
      const win = frame.contentWindow;
      const layer = frame.contentDocument.querySelector(".annotation-author-canvas");
      const rect = layer.getBoundingClientRect();
      const options = { bubbles: true, cancelable: true, pointerId: 73, pointerType: "mouse", isPrimary: true, button: 0, clientX: rect.left + rect.width * 0.3, clientY: rect.top + rect.height * 0.325 + 10, pressure: 0.5 };
      layer.dispatchEvent(new win.PointerEvent("pointerdown", options));
      layer.dispatchEvent(new win.PointerEvent("pointercancel", options));
    })()`);
    assert.equal(await evaluate('document.querySelector("#page-preview").contentDocument.querySelectorAll("[data-annotation-id=home-introduction] > .annotation-layer--broad .annotation-stroke").length'), before + 1);
    assert.match(await evaluate('document.querySelector("#status").textContent'), /Interrupted stroke discarded/);
    await evaluate(`(() => {
      const frame = document.querySelector("#page-preview");
      const win = frame.contentWindow;
      const layer = frame.contentDocument.querySelector(".annotation-author-canvas");
      const rect = layer.getBoundingClientRect();
      const options = { bubbles: true, cancelable: true, pointerId: 74, pointerType: "mouse", isPrimary: true, button: 0, clientX: rect.left + rect.width * 0.3, clientY: rect.top + rect.height * 0.325 + 10, pressure: 0.5 };
      layer.dispatchEvent(new win.PointerEvent("pointerdown", options));
      layer.dispatchEvent(new win.PointerEvent("pointerup", options));
    })()`);
    assert.equal(await evaluate('document.querySelector("#page-preview").contentDocument.querySelectorAll("[data-annotation-id=home-introduction] > .annotation-layer--broad .annotation-stroke").length'), before);
    await evaluate('document.querySelector("#undo").click()');
    assert.equal(await evaluate('document.querySelector("#page-preview").contentDocument.querySelectorAll("[data-annotation-id=home-introduction] > .annotation-layer--broad .annotation-stroke").length'), before + 1);
    await evaluate('window.confirm = () => true; document.querySelector("#clear").click()');
    assert.equal(await evaluate('document.querySelector("#page-preview").contentDocument.querySelectorAll("[data-annotation-id=home-introduction] > .annotation-layer--broad .annotation-stroke").length'), 0);
    await evaluate('document.querySelector("#undo").click()');
    assert.equal(await evaluate('document.querySelector("#page-preview").contentDocument.querySelectorAll("[data-annotation-id=home-introduction] > .annotation-layer--broad .annotation-stroke").length'), before + 1);
    await evaluate('document.querySelector("#redo").click()');
    assert.equal(await evaluate('document.querySelector("#page-preview").contentDocument.querySelectorAll("[data-annotation-id=home-introduction] > .annotation-layer--broad .annotation-stroke").length'), 0);
    await evaluate('document.querySelector("#undo").click()');
    assert.equal(await evaluate('document.querySelector("#page-preview").contentDocument.querySelectorAll("[data-annotation-id=home-introduction] > .annotation-layer--broad .annotation-stroke").length'), before + 1);
  });

  test("every safe preset exposes curated colors, widths, opacity, and a matching preview", async () => {
    for (const [tool, preset] of Object.entries(TOOL_PRESETS)) {
      await evaluate(`document.querySelector(${JSON.stringify(`[data-tool=${tool}]`)}).click()`);
      const controls = await evaluate(`(() => ({
        colors: [...document.querySelectorAll("#color-palette .color-swatch")].map((node) => node.dataset.style),
        widths: [...document.querySelector("#width").options].map((option) => Number(option.value)),
        opacities: [...document.querySelector("#opacity").options].map((option) => Number(option.value)),
        previewPressure: document.querySelector("#brush-preview").dataset.pressureAware,
        hidden: document.querySelector("#brush-settings").hidden,
      }))()`);
      assert.deepEqual(controls.colors, [...preset.styles]);
      assert.deepEqual(controls.widths, [...preset.widths]);
      assert.deepEqual(controls.opacities, [...preset.opacities]);
      assert.equal(controls.previewPressure, String(preset.pressure));
      assert.equal(controls.hidden, false);
      for (const style of preset.styles) {
        await evaluate(`document.querySelector(${JSON.stringify(`#color-palette [data-style=${style}]`)}).click()`);
        assert.equal(await evaluate('document.querySelector("#color-palette [aria-checked=true]").dataset.style'), style);
      }
      for (const width of preset.widths) {
        await evaluate(`(() => { const select = document.querySelector("#width"); select.value = ${JSON.stringify(String(width))}; select.dispatchEvent(new Event("change", { bubbles: true })); })()`);
        assert.equal(Number(await evaluate('document.querySelector("#brush-preview").style.strokeWidth')), width);
      }
      for (const opacity of preset.opacities) {
        await evaluate(`(() => { const select = document.querySelector("#opacity"); select.value = ${JSON.stringify(String(opacity))}; select.dispatchEvent(new Event("change", { bubbles: true })); })()`);
        assert.equal(Number(await evaluate('document.querySelector("#brush-preview").style.opacity')), opacity);
      }
    }
    await evaluate('document.querySelector("[data-tool=eraser]").click()');
    assert.equal(await evaluate('document.querySelector("#brush-settings").hidden'), true);
  });

  test("drawing shortcuts preserve controls while Escape always exits from buttons", async () => {
    const pressInPreview = (key) => evaluate(`(() => {
      const doc = document.querySelector("#page-preview").contentDocument;
      doc.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
    })()`);
    const buttonEscape = await evaluate(`(() => {
      const toggle = document.querySelector("#draw-toggle");
      if (toggle.getAttribute("aria-pressed") === "true") toggle.click();
      toggle.focus();
      toggle.click();
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      toggle.dispatchEvent(event);
      return { drawing: toggle.getAttribute("aria-pressed"), prevented: event.defaultPrevented };
    })()`);
    assert.deepEqual(buttonEscape, { drawing: "false", prevented: true });
    const selectEscape = await evaluate(`(() => {
      document.querySelector("#draw-toggle").click();
      const select = document.querySelector("#width");
      select.focus();
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      select.dispatchEvent(event);
      return { drawing: document.querySelector("#draw-toggle").getAttribute("aria-pressed"), prevented: event.defaultPrevented };
    })()`);
    assert.deepEqual(selectEscape, { drawing: "true", prevented: false });
    await pressInPreview("h");
    assert.equal(await evaluate('document.querySelector("[data-tool=highlighter]").getAttribute("aria-checked")'), "true");
    await pressInPreview("p");
    assert.equal(await evaluate('document.querySelector("[data-tool=pencil]").getAttribute("aria-checked")'), "true");
    await pressInPreview("Escape");
    await pause(100);
    assert.equal(await evaluate('document.querySelector("#draw-toggle").getAttribute("aria-pressed")'), "false");
    const beforeTool = await evaluate('document.querySelector(".tool[aria-checked=true]").dataset.tool');
    const allowed = await evaluate(`(() => {
      const event = new KeyboardEvent("keydown", { key: "m", bubbles: true, cancelable: true });
      document.dispatchEvent(event);
      return !event.defaultPrevented;
    })()`);
    assert.equal(allowed, true, "single-key shortcuts must not claim keys outside drawing mode");
    assert.equal(await evaluate('document.querySelector(".tool[aria-checked=true]").dataset.tool'), beforeTool);
  });

  test("the editor adapts its tool surface and honors theme, reduced motion, and forced colors", async () => {
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1483, height: 885, deviceScaleFactor: 1, mobile: false });
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".tool-dock")).position'), "absolute");
    const explicitLight = await evaluate(`(() => {
      document.querySelector("#theme-toggle").click();
      const root = document.documentElement;
      return {
        rootTheme: root.dataset.theme,
        bodyTheme: document.body.dataset.theme,
        rootScheme: getComputedStyle(root).colorScheme,
        controlScheme: getComputedStyle(document.querySelector("#width")).colorScheme,
        rootPaper: getComputedStyle(root).backgroundColor,
        bodyPaper: getComputedStyle(document.body).backgroundColor,
      };
    })()`);
    assert.equal(explicitLight.rootTheme, "light");
    assert.equal(explicitLight.bodyTheme, "light");
    assert.equal(explicitLight.rootScheme, "light");
    assert.equal(explicitLight.controlScheme, "light");
    assert.equal(explicitLight.rootPaper, explicitLight.bodyPaper);
    await evaluate('document.querySelector("#theme-toggle").click()');
    await pause(200);
    const explicitDark = await evaluate(`(() => ({
      rootTheme: document.documentElement.dataset.theme,
      bodyTheme: document.body.dataset.theme,
      rootScheme: getComputedStyle(document.documentElement).colorScheme,
      controlScheme: getComputedStyle(document.querySelector("#width")).colorScheme,
      rootPaper: getComputedStyle(document.documentElement).backgroundColor,
    }))()`);
    assert.equal(explicitDark.rootTheme, "dark");
    assert.equal(explicitDark.bodyTheme, "dark");
    assert.equal(explicitDark.rootScheme, "dark");
    assert.equal(explicitDark.controlScheme, "dark");
    assert.notEqual(explicitDark.rootPaper, explicitLight.rootPaper);
    const actionContrasts = await evaluate(`(() => {
      const contrast = (node) => {
        const channels = (value) => value.match(/[\\d.]+/g).slice(0, 3).map((channel) => Number(channel) / 255);
        const luminance = (value) => channels(value)
          .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
          .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
        const style = getComputedStyle(node);
        const values = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a);
        return (values[0] + 0.05) / (values[1] + 0.05);
      };
      const draw = document.querySelector("#draw-toggle");
      const exportButton = document.querySelector("#export");
      const inactive = contrast(draw);
      draw.click();
      const active = contrast(draw);
      draw.click();
      return [inactive, active, contrast(exportButton)];
    })()`);
    for (const contrast of actionContrasts) assert.ok(contrast >= 4.5, `dark filled action contrast was ${contrast}`);
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    assert.ok(Number.parseFloat(await evaluate('getComputedStyle(document.querySelector("#draw-toggle")).transitionDuration')) <= 0.001);
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".preview-scroll")).backgroundImage'), "none");
    await page.send("Emulation.setEmulatedMedia", { features: [] });
    await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await pause(100);
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".tool-dock")).position'), "static");
    await evaluate('document.querySelector("#theme-toggle").click()');
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1483, height: 885, deviceScaleFactor: 1, mobile: false });
  });

  test("the undo shortcut during a held stroke undoes once and commits nothing", async () => {
    if (!(await evaluate('document.querySelector("#draw-toggle").getAttribute("aria-pressed") === "true"'))) {
      await evaluate('document.querySelector("[data-tool=pen]").click(); document.querySelector("#draw-toggle").click()');
      await pause(100);
    }
    const strokes = 'document.querySelector("#page-preview").contentDocument.querySelectorAll(".annotation-author-canvas .annotation-stroke").length';
    const before = await evaluate(strokes);
    await evaluate(`(() => {
      const frame = document.querySelector("#page-preview");
      const win = frame.contentWindow;
      const layer = frame.contentDocument.querySelector(".annotation-author-canvas");
      const rect = layer.getBoundingClientRect();
      const event = (type, x, y) => layer.dispatchEvent(new win.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 74, pointerType: "mouse", isPrimary: true, button: 0, clientX: rect.left + rect.width * x, clientY: rect.top + rect.height * y, pressure: 0.5 }));
      event("pointerdown", 0.25, 0.6); event("pointermove", 0.45, 0.65); event("pointerup", 0.45, 0.65);
    })()`);
    assert.equal(await evaluate(strokes), before + 1);

    await evaluate(`(() => {
      const frame = document.querySelector("#page-preview");
      const win = frame.contentWindow;
      const doc = frame.contentDocument;
      const layer = doc.querySelector(".annotation-author-canvas");
      const rect = layer.getBoundingClientRect();
      const options = { bubbles: true, cancelable: true, pointerId: 75, pointerType: "mouse", isPrimary: true, button: 0, clientX: rect.left + rect.width * 0.6, clientY: rect.top + rect.height * 0.7, pressure: 0.5 };
      layer.dispatchEvent(new win.PointerEvent("pointerdown", options));
      doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "u", bubbles: true, cancelable: true }));
      layer.dispatchEvent(new win.PointerEvent("pointerup", options));
    })()`);
    assert.match(await evaluate('document.querySelector("#status").textContent'), /Last drawing change undone/);
    assert.equal(await evaluate('document.querySelector("#status").dataset.error'), "false");
    assert.equal(await evaluate(strokes), before);
    assert.equal(await evaluate(`(() => {
      const doc = document.querySelector("#page-preview").contentDocument;
      return doc.querySelectorAll(".annotation-author-canvas").length;
    })()`), 1);
  });

  test("keyboard focus stays visible on every named control, including Import", async () => {
    const tab = async () => {
      for (const type of ["rawKeyDown", "keyUp"]) {
        await page.send("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      }
      await pause(30);
    };
    await evaluate('document.querySelector("#clear").focus()');
    assert.equal(await evaluate('document.activeElement.id'), "clear");
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#clear")).outlineStyle'), "solid");

    await tab();
    assert.equal(await evaluate('document.activeElement.id'), "import-file");
    assert.equal(await evaluate(`(() => {
      const outline = getComputedStyle(document.querySelector(".file-control"));
      return [outline.outlineStyle, Math.round(Number.parseFloat(outline.outlineWidth))].join(" ");
    })()`), "solid 3");

    await tab();
    assert.equal(await evaluate('document.activeElement.id'), "empty");
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#empty")).outlineStyle'), "solid");
    await evaluate('document.activeElement.blur()');
  });

  test("coarse touch mode keeps 44px controls and safely commits touch drawing", async () => {
    await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await pause(100);
    const targetHeights = await evaluate('[...document.querySelectorAll("button, select, .file-control")].map((node) => ({ name: node.id || node.className || node.tagName, height: node.getBoundingClientRect().height }))');
    for (const target of targetHeights) assert.ok(target.height >= 44, `${target.name} coarse target rendered at ${target.height}px`);
    if (!(await evaluate('document.querySelector("#draw-toggle").getAttribute("aria-pressed") === "true"'))) {
      await evaluate('document.querySelector("#draw-toggle").click()');
    }
    await evaluate('document.querySelector("[data-tool=highlighter]").click()');
    const before = await evaluate('document.querySelector("#page-preview").contentDocument.querySelectorAll(".annotation-author-canvas .annotation-stroke").length');
    await evaluate(`(() => {
      const frame = document.querySelector("#page-preview");
      const win = frame.contentWindow;
      const layer = frame.contentDocument.querySelector(".annotation-author-canvas");
      const rect = layer.getBoundingClientRect();
      const event = (type) => layer.dispatchEvent(new win.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 91, pointerType: "touch", isPrimary: true, button: 0, clientX: rect.left + rect.width * 0.2, clientY: rect.top + rect.height * 0.5, pressure: 0.5 }));
      event("pointerdown"); event("pointerup");
    })()`);
    assert.equal(await evaluate('document.querySelector("#page-preview").contentDocument.querySelectorAll(".annotation-author-canvas .annotation-stroke").length'), before + 1);
    assert.equal(await evaluate(`(() => {
      const stroke = document.querySelector("#page-preview").contentDocument.querySelector(".annotation-author-canvas .annotation-stroke:last-child");
      return stroke.classList.contains("annotation-stroke--singleton") && getComputedStyle(stroke).strokeLinecap === "round";
    })()`), true);
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#page-preview").contentDocument.querySelector(".annotation-author-canvas")).touchAction'), "none");
    await evaluate(`(() => {
      const frame = document.querySelector("#page-preview");
      const win = frame.contentWindow;
      const layer = frame.contentDocument.querySelector(".annotation-author-canvas");
      const rect = layer.getBoundingClientRect();
      const options = { bubbles: true, cancelable: true, pointerId: 92, pointerType: "touch", isPrimary: true, button: 0, clientX: rect.left + rect.width * 0.3, clientY: rect.top + rect.height * 0.6, pressure: 0.8 };
      layer.dispatchEvent(new win.PointerEvent("pointerdown", options));
      layer.dispatchEvent(new win.PointerEvent("pointercancel", options));
    })()`);
    assert.equal(await evaluate('document.querySelector("#page-preview").contentDocument.querySelectorAll(".annotation-author-canvas .annotation-stroke").length'), before + 1);
    assert.match(await evaluate('document.querySelector("#status").textContent'), /Interrupted stroke discarded/);
    await evaluate('document.querySelector("#draw-toggle").click()');
    assert.equal(await evaluate('document.querySelector("#page-preview").contentDocument.querySelector(".annotation-layer").classList.contains("annotation-author-canvas")'), false);
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#page-preview").contentDocument.querySelector(".annotation-layer")).pointerEvents'), "none");
    const offOrigin = requests.filter((url) => /^https?:/.test(url) && !url.startsWith(origin));
    assert.deepEqual(offOrigin, []);
  });

  test("build-generated public SVG is inert, route-isolated, responsive, printable-safe, and works without JS", async () => {
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await page.send("Emulation.setDeviceMetricsOverride", { width: 600, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.send("Page.navigate", { url: `${fixtureOrigin}/` });
    await waitFor('location.origin === ' + JSON.stringify(fixtureOrigin) + ' && document.querySelectorAll(".annotation-layer").length === 2', "generated home fixture did not load");
    const layers = await evaluate(`[...document.querySelectorAll(".annotation-layer")].map((node) => ({
      className: node.getAttribute("class"), display: getComputedStyle(node).display,
      pointer: getComputedStyle(node).pointerEvents, aria: node.getAttribute("aria-hidden"), focusable: node.getAttribute("focusable")
    }))`);
    assert.equal(layers.find(({ className }) => className.includes("--narrow")).display, "block");
    assert.equal(layers.find(({ className }) => className.includes("--broad")).display, "none");
    assert.ok(layers.every((layer) => layer.pointer === "none" && layer.aria === "true" && layer.focusable === "false"));
    assert.equal(await evaluate('document.querySelectorAll(".annotation-layer a, .annotation-layer button, .annotation-layer [tabindex]").length'), 0);

    const scopeAt = async (width, height) => {
      await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await pause(100);
      return evaluate(`(() => {
        const probe = document.querySelector(".annotation-layer").cloneNode(false);
        probe.setAttribute("class", "annotation-layer annotation-layer--compact");
        document.querySelector("[data-annotation-id=home-introduction]").append(probe);
        const shown = [...document.querySelectorAll(".annotation-layer")]
          .filter((node) => getComputedStyle(node).display !== "none")
          .map((node) => node.getAttribute("class").replace("annotation-layer annotation-layer--", ""));
        probe.remove();
        return {
          shown,
          reflow: [
            getComputedStyle(document.querySelector(".page-shell")).paddingTop,
            getComputedStyle(document.querySelector(".intro-copy")).marginTop,
            getComputedStyle(document.querySelector(".work-index")).marginTop,
            getComputedStyle(document.querySelector(".work-list")).getPropertyValue("--year-column").trim(),
            getComputedStyle(document.querySelector(".site-footer")).paddingTop,
            getComputedStyle(document.querySelector(".local-time")).minHeight,
          ].join(" "),
        };
      })()`);
    };
    const boundary = await scopeAt(600, 900);
    const past = await scopeAt(601, 900);
    const wide = await scopeAt(1366, 900);
    const shortAndNarrower = await scopeAt(601, 768);
    const shortAndWide = await scopeAt(1366, 768);
    const shortAndWider = await scopeAt(1483, 768);
    assert.deepEqual(boundary.shown, ["narrow"]);
    assert.deepEqual(past.shown, ["broad"]);
    assert.deepEqual(wide.shown, ["broad"]);
    assert.deepEqual(shortAndNarrower.shown, ["broad"], "the one-screen rule needs 46.01rem of width");
    assert.deepEqual(shortAndWide.shown, ["compact"], "only the compact scope may render in the one-screen layout");
    assert.deepEqual(shortAndWider.shown, ["compact"]);
    assert.notEqual(boundary.reflow, past.reflow, "the scope boundary must sit on the site's own reflow breakpoint");
    assert.equal(past.reflow, wide.reflow, "the broad scope must cover one unchanged site layout");
    assert.equal(past.reflow, shortAndNarrower.reflow, "the broad scope must cover one unchanged site layout");
    assert.notEqual(wide.reflow, shortAndWide.reflow, "the compact scope must be a distinct site layout");
    assert.equal(shortAndWide.reflow, shortAndWider.reflow, "the compact scope must cover one unchanged site layout");
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(100);
    await captureEvidence("inert-preview.png");

    assert.equal(await evaluate('[...document.querySelectorAll(".annotation-layer")].some((node) => getComputedStyle(node).display !== "none")'), true);
    await page.send("Emulation.setEmulatedMedia", { media: "print" });
    assert.equal(await evaluate('[...document.querySelectorAll(".annotation-layer")].every((node) => getComputedStyle(node).display === "none")'), true);
    await page.send("Emulation.setEmulatedMedia", { media: "screen", features: [] });

    await page.send("Emulation.setScriptExecutionDisabled", { value: true });
    await page.send("Page.navigate", { url: `${fixtureOrigin}/dandho/` });
    await waitFor('document.querySelector("h1")?.textContent === "Dandho"', "no-JS generated Dandho fixture did not load");
    assert.equal(await evaluate('document.querySelectorAll(".annotation-tool--legacy-pen.annotation-color--graphite").length'), 1);
    assert.equal(await evaluate('document.querySelectorAll(".annotation-color--blue, .annotation-color--yellow").length'), 0);
    assert.ok(await evaluate('document.querySelector(".article-body").innerText.length > 2000'));
    await evaluate('document.body.style.setProperty("font-family", "serif", "important")');
    await pause(100);
    const reflowAttachment = await evaluate(`(() => {
      const host = document.querySelector("[data-annotation-id=dandho-overview]").getBoundingClientRect();
      const layer = document.querySelector(".annotation-layer").getBoundingClientRect();
      return { host: [host.left, host.top, host.width, host.height], layer: [layer.left, layer.top, layer.width, layer.height] };
    })()`);
    reflowAttachment.host.forEach((value, index) => assert.ok(Math.abs(value - reflowAttachment.layer[index]) <= 0.5));
    await page.send("Emulation.setScriptExecutionDisabled", { value: false });

    const fixtureRequests = requests.filter((url) => url.startsWith(fixtureOrigin));
    assert.deepEqual(fixtureRequests.filter((url) => /annotations\/|\.json(?:$|\?)/.test(url)), []);
  });

  test("a stale mark reports itself without blocking drawing on an unchanged anchor", async () => {
    const temporarySite = mkdtempSync(join(tmpdir(), "annotation-site-"));
    cpSync(resolve("site"), temporarySite, { recursive: true });
    const staleServer = createAuthorServer({ siteRoot: temporarySite });
    const address = await listen(staleServer, 0);
    try {
      await page.send("Emulation.setDeviceMetricsOverride", { width: 1483, height: 885, deviceScaleFactor: 1, mobile: false });
      await page.send("Page.navigate", { url: `http://127.0.0.1:${address.port}/` });
      await waitFor(
        'document.querySelector("#page-preview")?.contentDocument?.querySelector("[data-annotation-id=home-introduction]") && document.querySelector("#status").textContent.includes("Local page ready")',
        "the temporary-site editor did not become ready",
      );
      await setFile(new URL("./fixtures/annotations/home.json", import.meta.url).pathname);
      await waitFor('document.querySelector("#status").textContent.includes("imported and validated")', "home fixture did not import");

      const index = join(temporarySite, "index.html");
      const source = readFileSync(index, "utf8");
      assert.ok(source.includes("I live in Boston."), "the introduction sentence used by this test moved");
      writeFileSync(index, source.replace("I live in Boston.", "I live close to Boston."));

      for (const route of ["/dandho/", "/"]) {
        await evaluate(`(() => {
          const select = document.querySelector("#route");
          select.value = ${JSON.stringify(route)};
          select.dispatchEvent(new Event("change", { bubbles: true }));
        })()`);
        await pause(200);
      }
      await waitFor(
        'document.querySelector("#status").textContent.includes("Page content changed under")',
        "the editor did not report the edited anchor as stale",
      );

      await evaluate('document.querySelector("#public-preview").click()');
      assert.equal(await evaluate('document.querySelector("#public-preview").getAttribute("aria-pressed")'), "false");
      assert.equal(await evaluate('document.body.dataset.publicPreview'), "false");
      assert.equal(await evaluate('document.querySelector("#status").dataset.error'), "true");
      assert.match(await evaluate('document.querySelector("#status").textContent'), /Public preview unavailable:.*stale/);
      assert.ok(await evaluate('document.querySelector("#page-preview").contentDocument.querySelector(".annotation-author-selected") !== null'));

      await evaluate(`(() => {
        const anchor = document.querySelector("#anchor");
        anchor.value = "home-boston";
        anchor.dispatchEvent(new Event("change", { bubbles: true }));
        document.querySelector("[data-tool=pen]").click();
        document.querySelector("#draw-toggle").click();
      })()`);
      await pause(100);
      await evaluate(`(() => {
        const frame = document.querySelector("#page-preview");
        const win = frame.contentWindow;
        const layer = frame.contentDocument.querySelector(".annotation-author-canvas");
        const rect = layer.getBoundingClientRect();
        const event = (type, x, y) => layer.dispatchEvent(new win.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 81, pointerType: "mouse", isPrimary: true, button: 0, clientX: rect.left + rect.width * x, clientY: rect.top + rect.height * y, pressure: 0.5 }));
        event("pointerdown", 0.2, 0.3); event("pointermove", 0.5, 0.4); event("pointerup", 0.5, 0.4);
      })()`);
      assert.match(await evaluate('document.querySelector("#status").textContent'), /Stroke added/);
      assert.equal(await evaluate('document.querySelector("#status").dataset.error'), "false");
      assert.equal(await evaluate('document.querySelector("#page-preview").contentDocument.querySelectorAll("[data-annotation-id=home-boston] .annotation-stroke").length'), 1);

      await evaluate('document.querySelector("#export").click()');
      await waitFor('document.querySelector("#status").dataset.error === "true"', "export accepted a stale mark");
      assert.match(await evaluate('document.querySelector("#status").textContent'), /Export failed:.*stale/);
    } finally {
      await new Promise((done) => staleServer.close(done));
      rmSync(temporarySite, { recursive: true, force: true });
    }
  });
});
