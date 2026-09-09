import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { createAuthorServer, listen } from "../tools/author-server.mjs";
import { createAnnotationManifest, generateAnnotatedPages } from "../scripts/annotation-build.mjs";
import { serializeAnnotationFile } from "../tools/annotation-core.js";

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
      'document.querySelector("#page-preview")?.contentDocument?.querySelector("[data-annotation-id=home-introduction]") && !document.querySelector("#status").textContent.includes("Loading")',
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
    await setFile(new URL("./fixtures/annotations/home.json", import.meta.url).pathname);
    await waitFor('document.querySelector("#status").textContent.includes("imported and validated")', "home fixture did not import");
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
    assert.equal(await evaluate('document.querySelector("#page-preview").contentDocument.querySelectorAll(".annotation-stroke--pen-graphite").length'), 1);
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
      const options = { bubbles: true, cancelable: true, pointerId: 72, pointerType: "pen", isPrimary: true, button: 0, clientX: rect.left + rect.width * 0.3, clientY: rect.top + rect.height * 0.4, pressure: 0.7 };
      layer.dispatchEvent(new win.PointerEvent("pointerdown", options));
      layer.dispatchEvent(new win.PointerEvent("pointercancel", options));
    })()`);
    assert.equal(await evaluate('document.querySelector("#page-preview").contentDocument.querySelectorAll("[data-annotation-id=home-introduction] > .annotation-layer--broad .annotation-stroke").length'), before + 1);
    assert.match(await evaluate('document.querySelector("#status").textContent'), /Interrupted stroke discarded/);

    await evaluate('document.querySelector("[data-tool=eraser]").click()');
    await evaluate(`(() => {
      const frame = document.querySelector("#page-preview");
      const win = frame.contentWindow;
      const layer = frame.contentDocument.querySelector(".annotation-author-canvas");
      const rect = layer.getBoundingClientRect();
      layer.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 73, pointerType: "mouse", isPrimary: true, button: 0, clientX: rect.left + rect.width * 0.3, clientY: rect.top + rect.height * 0.325, pressure: 0.5 }));
    })()`);
    assert.equal(await evaluate('document.querySelector("#page-preview").contentDocument.querySelectorAll("[data-annotation-id=home-introduction] > .annotation-layer--broad .annotation-stroke").length'), before);
    await evaluate('document.querySelector("#undo").click()');
    assert.equal(await evaluate('document.querySelector("#page-preview").contentDocument.querySelectorAll("[data-annotation-id=home-introduction] > .annotation-layer--broad .annotation-stroke").length'), before + 1);
    await evaluate('window.confirm = () => true; document.querySelector("#clear").click()');
    assert.equal(await evaluate('document.querySelector("#page-preview").contentDocument.querySelectorAll("[data-annotation-id=home-introduction] > .annotation-layer--broad .annotation-stroke").length'), 0);
    await evaluate('document.querySelector("#undo").click()');
    assert.equal(await evaluate('document.querySelector("#page-preview").contentDocument.querySelectorAll("[data-annotation-id=home-introduction] > .annotation-layer--broad .annotation-stroke").length'), before + 1);
  });

  test("coarse touch mode keeps 44px controls and safely commits touch drawing", async () => {
    await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await pause(100);
    const targetHeights = await evaluate('[...document.querySelectorAll("button, select, .file-control")].map((node) => node.getBoundingClientRect().height)');
    for (const height of targetHeights) assert.ok(height >= 44, `coarse target rendered at ${height}px`);
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
      const event = (type, x) => layer.dispatchEvent(new win.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 91, pointerType: "touch", isPrimary: true, button: 0, clientX: rect.left + rect.width * x, clientY: rect.top + rect.height * 0.5, pressure: 0.5 }));
      event("pointerdown", 0.2); event("pointermove", 0.5); event("pointerup", 0.5);
    })()`);
    assert.equal(await evaluate('document.querySelector("#page-preview").contentDocument.querySelectorAll(".annotation-author-canvas .annotation-stroke").length'), before + 1);
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#page-preview").contentDocument.querySelector(".annotation-author-canvas")).touchAction'), "none");
    const offOrigin = requests.filter((url) => /^https?:/.test(url) && !url.startsWith(origin));
    assert.deepEqual(offOrigin, []);
  });

  test("build-generated public SVG is inert, route-isolated, responsive, printable-safe, and works without JS", async () => {
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await page.send("Emulation.setDeviceMetricsOverride", { width: 767, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.send("Page.navigate", { url: `${fixtureOrigin}/` });
    await waitFor('location.origin === ' + JSON.stringify(fixtureOrigin) + ' && document.querySelectorAll(".annotation-layer").length === 2', "generated home fixture did not load");
    let layers = await evaluate(`[...document.querySelectorAll(".annotation-layer")].map((node) => ({
      className: node.getAttribute("class"), display: getComputedStyle(node).display,
      pointer: getComputedStyle(node).pointerEvents, aria: node.getAttribute("aria-hidden"), focusable: node.getAttribute("focusable")
    }))`);
    assert.equal(layers.find(({ className }) => className.includes("--narrow")).display, "block");
    assert.equal(layers.find(({ className }) => className.includes("--broad")).display, "none");
    assert.ok(layers.every((layer) => layer.pointer === "none" && layer.aria === "true" && layer.focusable === "false"));
    assert.equal(await evaluate('document.querySelectorAll(".annotation-layer a, .annotation-layer button, .annotation-layer [tabindex]").length'), 0);

    await page.send("Emulation.setDeviceMetricsOverride", { width: 768, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(100);
    layers = await evaluate('[...document.querySelectorAll(".annotation-layer")].map((node) => [node.getAttribute("class"), getComputedStyle(node).display])');
    assert.equal(layers.find(([name]) => name.includes("--broad"))[1], "block");
    assert.equal(layers.find(([name]) => name.includes("--narrow"))[1], "none");
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await pause(100);
    await captureEvidence("inert-preview.png");

    await page.send("Emulation.setEmulatedMedia", { media: "print" });
    assert.equal(await evaluate('[...document.querySelectorAll(".annotation-layer")].every((node) => getComputedStyle(node).display === "none")'), true);
    await page.send("Emulation.setEmulatedMedia", { media: "screen", features: [] });

    await page.send("Emulation.setScriptExecutionDisabled", { value: true });
    await page.send("Page.navigate", { url: `${fixtureOrigin}/dandho/` });
    await waitFor('document.querySelector("h1")?.textContent === "Dandho"', "no-JS generated Dandho fixture did not load");
    assert.equal(await evaluate('document.querySelectorAll(".annotation-stroke--pen-graphite").length'), 1);
    assert.equal(await evaluate('document.querySelectorAll(".annotation-stroke--pen-blue, .annotation-stroke--highlighter-yellow").length'), 0);
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
});
