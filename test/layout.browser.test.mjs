import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const siteRoot = fileURLToPath(new URL("../site", import.meta.url));

function startSite() {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    const relative = normalize(path.endsWith("/") ? `${path}index.html` : path).replace(/^(\.\.[/\\])+/, "");
    const file = join(siteRoot, relative);
    if (!file.startsWith(siteRoot) || !existsSync(file)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    response.end(readFileSync(file));
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

function findChromium() {
  const fromEnv = [process.env.CHROME_PATH, process.env.CHROME_BIN, process.env.PUPPETEER_EXECUTABLE_PATH];
  const installed = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  const cached = [];
  for (const cache of [join(homedir(), ".cache/ms-playwright"), join(homedir(), ".cache/puppeteer")]) {
    if (!existsSync(cache)) continue;
    for (const entry of readdirSync(cache)) {
      cached.push(join(cache, entry, "chrome-linux64/chrome"), join(cache, entry, "chrome-linux/chrome"));
    }
  }
  return [...fromEnv, ...installed, ...cached].find((candidate) => candidate && existsSync(candidate)) ?? null;
}

class Connection {
  #socket;
  #nextId = 0;
  #pending = new Map();
  #waiting = [];
  #listeners = new Map();
  sessionId = null;

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => this.#receive(JSON.parse(event.data)));
  }

  static async open(url) {
    const socket = new WebSocket(url);
    await new Promise((ready, fail) => {
      socket.addEventListener("open", ready, { once: true });
      socket.addEventListener("error", () => fail(new Error(`cannot reach DevTools at ${url}`)), { once: true });
    });
    return new Connection(socket);
  }

  #receive(message) {
    if (message.id !== undefined) {
      const settle = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (!settle) return;
      if (message.error) settle.fail(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? null)})`));
      else settle.done(message.result);
      return;
    }
    for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params);
    for (const watcher of this.#waiting.splice(0)) {
      if (watcher.method === message.method) watcher.done(message.params);
      else this.#waiting.push(watcher);
    }
  }

  send(method, params = {}) {
    const id = ++this.#nextId;
    const payload = { id, method, params };
    if (this.sessionId) payload.sessionId = this.sessionId;
    this.#socket.send(JSON.stringify(payload));
    return new Promise((done, fail) => this.#pending.set(id, { done, fail }));
  }

  once(method) {
    return new Promise((done) => this.#waiting.push({ method, done }));
  }

  on(method, listener) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, []);
    this.#listeners.get(method).push(listener);
  }

  close() {
    this.#socket.close();
  }
}

async function launchChromium(binary) {
  const profile = mkdtempSync(join(tmpdir(), "site-layout-"));
  const child = spawn(binary, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-extensions",
    "--force-device-scale-factor=1",
    "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const endpoint = await new Promise((done, fail) => {
    let buffer = "";
    const timer = setTimeout(() => fail(new Error("Chromium did not report a DevTools endpoint")), 30_000);
    child.stderr.on("data", (chunk) => {
      buffer += chunk;
      const match = buffer.match(/(ws:\/\/\S+)/);
      if (!match) return;
      clearTimeout(timer);
      done(match[1]);
    });
    child.once("error", fail);
  });

  const browser = await Connection.open(endpoint);
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  browser.sessionId = sessionId;

  return {
    page: browser,
    async close() {
      browser.close();
      child.kill("SIGKILL");
      await new Promise((done) => child.once("exit", done));
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

const chromium = findChromium();
const reason = !chromium
  ? "no Chromium or Chrome binary found; set CHROME_PATH to run rendered-layout coverage"
  : typeof WebSocket !== "function"
    ? "this Node.js build has no global WebSocket; rendered-layout coverage needs Node.js 22 or newer"
    : false;

const limits = { timeout: 60_000 };

describe("rendered layout in a real browser", { skip: reason, timeout: 300_000 }, () => {
  let site;
  let browser;
  let page;
  let origin;
  const requested = [];

  const pause = (ms) => new Promise((done) => setTimeout(done, ms));

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await page.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };

  let scripting = true;
  const settle = () => (scripting
    ? evaluate("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))")
    : pause(100));

  const viewport = async (width, height, mobile = false) => {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    await page.send("Emulation.setTouchEmulationEnabled", mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    await settle();
  };

  const open = async (route) => {
    const loaded = page.once("Page.loadEventFired");
    await page.send("Page.navigate", { url: `${origin}${route}` });
    await loaded;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await evaluate('document.fonts.status === "loaded"')) break;
      await pause(50);
    }
    await settle();
  };

  const box = (selector) => evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
  })()`);

  const styleOf = (selector, property) => evaluate(
    `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).getPropertyValue(${JSON.stringify(property)})`,
  );

  before(async () => {
    site = await startSite();
    origin = `http://127.0.0.1:${site.address().port}`;
    browser = await launchChromium(chromium);
    page = browser.page;
    await page.send("Page.enable");
    await page.send("Network.enable");
    page.on("Network.requestWillBeSent", ({ request }) => requested.push(request.url));
  });

  after(async () => {
    if (browser) await browser.close();
    if (site) {
      site.closeAllConnections?.();
      await new Promise((done) => site.close(done));
    }
  });

  test("home centres the reading measure at the approved desktop geometry", limits, async () => {
    await viewport(1483, 885);
    await open("/");
    const shell = await box("main.page-shell");
    const available = await evaluate("document.documentElement.clientWidth");

    assert.ok(Math.abs(shell.width - 550.4) <= 0.5, `measure rendered ${shell.width}px, expected 550.4px`);
    assert.ok(
      Math.abs(shell.left - (available - shell.width) / 2) <= 1,
      `left gap ${shell.left}px is not centred in ${available}px`,
    );
    assert.ok(Math.abs(shell.left - (available - shell.right)) <= 1, "left and right gaps differ");
  });

  test("prose stays left aligned inside the centred measure", limits, async () => {
    await viewport(1483, 885);
    await open("/");
    const alignment = await styleOf(".intro-copy p", "text-align");
    assert.ok(["start", "left"].includes(alignment), `prose text-align resolved to ${alignment}`);
    const shell = await box("main.page-shell");
    const heading = await box("h1");
    const paragraph = await box(".intro-copy p");
    assert.ok(Math.abs(heading.left - shell.left) <= 1, "heading is not flush with the measure");
    assert.ok(Math.abs(paragraph.left - shell.left) <= 1, "prose is not flush with the measure");
  });

  test("home fits one screen at 1366x768 without scrolling or clipping", limits, async () => {
    await viewport(1366, 768);
    await open("/");
    const fit = await evaluate(`(() => {
      const root = document.documentElement;
      const home = document.querySelector(".home").getBoundingClientRect();
      const footer = document.querySelector(".local-time").getBoundingClientRect();
      return {
        scrollHeight: root.scrollHeight,
        clientHeight: root.clientHeight,
        homeHeight: home.height,
        footerBottom: footer.bottom,
      };
    })()`);
    assert.ok(fit.scrollHeight <= fit.clientHeight + 2, `page scrolls: ${fit.scrollHeight}px in ${fit.clientHeight}px`);
    assert.ok(fit.homeHeight >= fit.clientHeight - 2, "home does not fill the viewport height");
    assert.ok(fit.footerBottom <= fit.clientHeight + 2, "the Boston footer falls below the fold");
  });

  test("content reflows at 400% zoom without a horizontal scrollbar", limits, async () => {
    await viewport(320, 256);
    await open("/");
    const reflow = await evaluate(`(() => {
      const root = document.documentElement;
      const overflowing = [...document.querySelectorAll("main *")]
        .filter((node) => node.getBoundingClientRect().right > root.clientWidth + 1)
        .map((node) => node.className || node.tagName);
      return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, overflowing };
    })()`);
    assert.ok(reflow.scrollWidth <= reflow.clientWidth + 1, "the page scrolls horizontally at 400% zoom");
    assert.deepEqual(reflow.overflowing, [], "content overflows the viewport width at 400% zoom");
  });

  test("touch targets stay large enough on a narrow mobile viewport", limits, async () => {
    await viewport(390, 844, true);
    await open("/");
    const heights = await evaluate(
      '[...document.querySelectorAll(".work-link")].map((node) => node.getBoundingClientRect().height)',
    );
    assert.equal(heights.length, 3);
    for (const height of heights) assert.ok(height >= 44, `writing row rendered ${height}px tall`);
    const reflow = await evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1");
    assert.ok(reflow, "the mobile layout scrolls horizontally");
  });

  test("hovering a writing row fades the others and pointer exit restores them", limits, async () => {
    await viewport(1483, 885, false);
    await open("/");
    const target = await box(".work-link");
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(target.left + target.width / 2),
      y: Math.round(target.top + target.height / 2),
      buttons: 0,
    });
    await pause(400);
    const hovered = await evaluate(
      '[...document.querySelectorAll(".work-link")].map((node) => Number(getComputedStyle(node).opacity))',
    );
    assert.ok(Math.abs(hovered[0] - 1) <= 0.02, `hovered row rendered at opacity ${hovered[0]}`);
    for (const opacity of hovered.slice(1)) {
      assert.ok(Math.abs(opacity - 0.3) <= 0.02, `unhovered row rendered at opacity ${opacity}`);
    }

    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5, buttons: 0 });
    await pause(400);
    const restored = await evaluate(
      '[...document.querySelectorAll(".work-link")].map((node) => Number(getComputedStyle(node).opacity))',
    );
    for (const opacity of restored) assert.ok(Math.abs(opacity - 1) <= 0.02, `row stayed faded at opacity ${opacity}`);
  });

  test("keyboard focus fades the other rows and paints a visible focus ring", limits, async () => {
    for (let press = 0; press < 12; press += 1) {
      for (const type of ["rawKeyDown", "keyUp"]) {
        await page.send("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      }
      if (await evaluate('document.activeElement?.classList.contains("work-link") === true')) break;
    }
    assert.ok(
      await evaluate('document.activeElement?.classList.contains("work-link") === true'),
      "a writing row is not reachable by keyboard",
    );
    await pause(400);
    const focus = await evaluate(`(() => {
      const active = document.activeElement;
      const style = getComputedStyle(active);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        opacities: [...document.querySelectorAll(".work-link")].map((node) => ({
          focused: node === active,
          opacity: Number(getComputedStyle(node).opacity),
        })),
      };
    })()`);
    assert.equal(focus.outlineStyle, "solid");
    assert.equal(focus.outlineWidth, "2px");
    for (const row of focus.opacities) {
      const expected = row.focused ? 1 : 0.3;
      assert.ok(Math.abs(row.opacity - expected) <= 0.02, `focus fade rendered opacity ${row.opacity}`);
    }
  });

  test("the Dandho New marker renders in the hand-drawn yellow next to its title", limits, async () => {
    await viewport(1483, 885);
    await open("/");
    const layout = await evaluate(`(() => {
      const marker = document.querySelector(".new-marker");
      return { width: marker.offsetWidth, height: marker.offsetHeight, transform: getComputedStyle(marker).transform };
    })()`);
    const marker = await box(".new-marker");
    const overlay = await box(".new-marker svg");
    const label = await box(".new-marker > span");
    const stroke = await box(".new-marker path");
    const title = await box(".work-title");
    const row = await box(".work-link");

    assert.deepEqual(
      { width: layout.width, height: layout.height },
      { width: 40, height: 24 },
      "the marker is not laid out at its reference size",
    );
    assert.ok(
      Math.abs(overlay.width - marker.width) <= 0.5 && Math.abs(overlay.height - marker.height) <= 0.5,
      "the hand-drawn overlay does not cover the marker box",
    );
    assert.notEqual(layout.transform, "none", "the marker is not tilted");
    assert.ok(marker.height > layout.height, "the tilt does not reach the painted box");
    assert.ok(
      stroke.left <= label.left + 1 && stroke.right >= label.right - 1,
      "the hand-drawn loop does not enclose the New label",
    );
    assert.ok(marker.left >= title.left, "marker is not beside the Dandho title");
    assert.ok(marker.right <= row.right + 1, "marker escapes its writing row");
    assert.equal(await styleOf(".new-marker path", "stroke"), "rgb(227, 173, 0)");
    assert.equal(await styleOf(".new-marker path", "fill"), "none");
  });

  test("the Boston footer renders compact civil time and exactly one cat pose", limits, async () => {
    await viewport(1483, 885);
    await open("/");
    const footer = await evaluate(`(() => {
      const poses = [...document.querySelectorAll(".cat-pose")];
      return {
        time: document.querySelector("#boston-time").textContent,
        state: document.querySelector(".cat").dataset.state,
        visible: poses.filter((pose) => getComputedStyle(pose).display !== "none").length,
      };
    })()`);
    assert.match(footer.time, /^\d{1,2}:\d{2}(?:am|pm) in Boston, Massachusetts$/);
    assert.ok(["day", "evening", "night"].includes(footer.state), `cat state rendered as ${footer.state}`);
    assert.equal(footer.visible, 1);
    const cat = await box(".cat");
    assert.ok(Math.abs(cat.width - 38) <= 0.5 && Math.abs(cat.height - 32) <= 0.5, "cat rendered at the wrong size");
  });

  test("reduced motion and forced colours change the rendered result", limits, async () => {
    await viewport(1483, 885);
    await open("/");
    const animated = parseFloat(await styleOf(".cat-tail", "animation-duration"));
    assert.ok(animated > 1, `the cat tail should animate by default, got ${animated}s`);

    try {
      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await settle();
      const reduced = parseFloat(await styleOf(".cat-tail", "animation-duration"));
      assert.ok(reduced <= 0.001, `reduced motion left the tail animating for ${reduced}s`);
      assert.equal(await styleOf(".cat-tail", "animation-iteration-count"), "1");

      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
      await settle();
      assert.equal(await styleOf(".top-veil", "display"), "none");
      assert.equal(await styleOf(".work-link", "opacity"), "1");
    } finally {
      await page.send("Emulation.setEmulatedMedia", { features: [] });
      await settle();
    }
    assert.notEqual(await styleOf(".top-veil", "display"), "none");
  });

  test("the home page still reads and links without JavaScript", limits, async () => {
    await viewport(1483, 885);
    let fallback;
    try {
      scripting = false;
      await page.send("Emulation.setScriptExecutionDisabled", { value: true });
      await open("/");
      fallback = await evaluate(`(() => ({
      time: document.querySelector("#boston-time").textContent,
      state: document.querySelector(".cat").dataset.state,
      routes: [...document.querySelectorAll(".work-link")].map((node) => new URL(node.href).pathname),
      email: document.querySelector('a[href^="mailto:"]').getAttribute("href"),
      poses: [...document.querySelectorAll(".cat-pose")].filter((pose) => getComputedStyle(pose).display !== "none").length,
    }))()`);
    } finally {
      await page.send("Emulation.setScriptExecutionDisabled", { value: false });
      scripting = true;
    }
    assert.equal(fallback.time, "Boston, Massachusetts");
    assert.equal(fallback.state, "day");
    assert.equal(fallback.poses, 1);
    assert.deepEqual(fallback.routes, ["/dandho/", "/khata/", "/pulse/"]);
    assert.equal(fallback.email, "mailto:avitrvd98@gmail.com");
  });

  test("each essay loads directly, survives a refresh, and links back to the index", limits, async () => {
    await viewport(1483, 885);
    for (const [route, heading] of [["/dandho/", "Dandho"], ["/khata/", "Khata"], ["/pulse/", "Pulse"]]) {
      await open(route);
      const essay = await evaluate(`(() => ({
        heading: document.querySelector("h1").textContent,
        path: location.pathname,
        paragraphs: document.querySelectorAll(".article-body p").length,
        prose: document.querySelector(".article-body").innerText.trim().length,
        date: document.querySelector(".article-date time").textContent,
      }))()`);
      assert.equal(essay.path, route);
      assert.equal(essay.heading, heading);
      assert.ok(essay.paragraphs >= 6, `${route} rendered only ${essay.paragraphs} paragraphs`);
      assert.ok(essay.prose >= 2000, `${route} rendered only ${essay.prose} characters of prose`);
      assert.equal(essay.date, "8 September, 2026");

      const refreshed = page.once("Page.loadEventFired");
      await page.send("Page.reload", { ignoreCache: true });
      await refreshed;
      assert.equal(await evaluate("location.pathname"), route);
      assert.equal(await evaluate('document.querySelector("h1").textContent'), heading);

      const back = page.once("Page.loadEventFired");
      await evaluate('document.querySelector(".article-footer a").click()');
      await back;
      assert.equal(await evaluate("location.pathname"), "/");
      assert.equal(await evaluate('document.querySelector("h1").textContent'), "Avi Trivedi");
    }
  });

  test("a scrolling essay does not shift the centred measure", limits, async () => {
    await viewport(1483, 885);
    await open("/");
    const homeShell = await box("main.page-shell");
    assert.ok(
      !(await evaluate("document.documentElement.scrollHeight > document.documentElement.clientHeight")),
      "the home page was expected not to scroll at this viewport",
    );
    await open("/dandho/");
    const essayShell = await box("main.page-shell");
    assert.ok(
      await evaluate("document.documentElement.scrollHeight > document.documentElement.clientHeight"),
      "the essay was expected to scroll at this viewport",
    );
    assert.ok(
      Math.abs(essayShell.left - homeShell.left) <= 0.5,
      `the measure moved by ${Math.abs(essayShell.left - homeShell.left)}px when the scrollbar appeared`,
    );
  });

  test("the rendered site makes no off-origin requests", limits, () => {
    const offOrigin = requested.filter((url) => /^https?:\/\//.test(url) && !url.startsWith(origin));
    assert.deepEqual(offOrigin, []);
    assert.ok(
      requested.some((url) => url === `${origin}/fonts/inter-latin-wght-normal.woff2`),
      "the local Inter font was never requested",
    );
  });
});
