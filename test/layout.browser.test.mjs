import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { generateAnnotatedPages } from "../scripts/annotation-build.mjs";

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

async function startSite() {
  const { pages } = await generateAnnotatedPages();
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    const relative = normalize(path.endsWith("/") ? `${path}index.html` : path)
      .replace(/^(\.\.[/\\])+/, "")
      .replace(/^[/\\]+/, "");
    const file = join(siteRoot, relative);
    if (!file.startsWith(siteRoot) || (!pages.has(relative) && !existsSync(file))) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    response.end(pages.get(relative) ?? readFileSync(file));
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

const CDP_TIMEOUT = 20_000;

class Connection {
  #socket;
  #nextId = 0;
  #pending = new Map();
  #waiting = [];
  #listeners = new Map();
  #dead = null;
  sessionId = null;

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => this.#receive(JSON.parse(event.data)));
    socket.addEventListener("close", () => this.#abort(new Error("the DevTools connection closed")));
    socket.addEventListener("error", () => this.#abort(new Error("the DevTools connection failed")));
  }

  static async open(url, timeout = CDP_TIMEOUT) {
    const socket = new WebSocket(url);
    try {
      await new Promise((ready, fail) => {
        const timer = setTimeout(() => fail(new Error(`DevTools at ${url} did not complete a handshake within ${timeout}ms`)), timeout);
        const settle = (finish, value) => {
          clearTimeout(timer);
          finish(value);
        };
        socket.addEventListener("open", () => settle(ready), { once: true });
        socket.addEventListener("error", () => settle(fail, new Error(`cannot reach DevTools at ${url}`)), { once: true });
        socket.addEventListener("close", () => settle(fail, new Error(`DevTools at ${url} closed the connection`)), { once: true });
      });
    } catch (error) {
      socket.close();
      throw error;
    }
    return new Connection(socket);
  }

  #abort(reason) {
    if (this.#dead) return;
    this.#dead = reason;
    for (const settle of this.#pending.values()) settle.fail(reason);
    this.#pending.clear();
    for (const watcher of this.#waiting.splice(0)) watcher.fail(reason);
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

  send(method, params = {}, timeout = CDP_TIMEOUT) {
    if (this.#dead) return Promise.reject(this.#dead);
    const id = ++this.#nextId;
    const payload = { id, method, params };
    if (this.sessionId) payload.sessionId = this.sessionId;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        fail(new Error(`${method} did not answer within ${timeout}ms`));
      }, timeout);
      this.#pending.set(id, {
        done: (result) => { clearTimeout(timer); done(result); },
        fail: (error) => { clearTimeout(timer); fail(error); },
      });
      try {
        this.#socket.send(JSON.stringify(payload));
      } catch (error) {
        this.#pending.get(id)?.fail(error);
        this.#pending.delete(id);
      }
    });
  }

  once(method, timeout = CDP_TIMEOUT) {
    if (this.#dead) return Promise.reject(this.#dead);
    return new Promise((done, fail) => {
      const watcher = { method };
      const timer = setTimeout(() => {
        this.#waiting = this.#waiting.filter((entry) => entry !== watcher);
        fail(new Error(`${method} did not arrive within ${timeout}ms`));
      }, timeout);
      watcher.done = (params) => { clearTimeout(timer); done(params); };
      watcher.fail = (error) => { clearTimeout(timer); fail(error); };
      this.#waiting.push(watcher);
    });
  }

  on(method, listener) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, []);
    this.#listeners.get(method).push(listener);
  }

  close() {
    this.#abort(new Error("the DevTools connection was closed by the harness"));
    this.#socket.close();
  }
}

const running = new Set();

async function stopEveryChromium() {
  for (const stop of [...running]) await stop();
}

async function launchChromium(binary) {
  const profile = mkdtempSync(join(tmpdir(), "site-layout-"));
  let gone = false;
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
  child.once("close", () => { gone = true; });
  child.once("error", () => { gone = true; });

  const stop = async () => {
    running.delete(stop);
    child.kill("SIGKILL");
    await new Promise((done) => {
      if (gone) return done();
      child.once("close", done);
      child.once("error", done);
      setTimeout(done, 2_000).unref();
    });
    child.stderr?.destroy();
    rmSync(profile, { recursive: true, force: true });
  };
  running.add(stop);

  let timer;
  try {
    const endpoint = await new Promise((done, fail) => {
      let buffer = "";
      timer = setTimeout(() => fail(new Error("Chromium did not report a DevTools endpoint within 30s")), 30_000);
      const read = (chunk) => {
        buffer += chunk;
        const match = buffer.match(/(ws:\/\/\S+)\r?\n/);
        if (!match) return;
        child.stderr.off("data", read);
        done(match[1]);
      };
      child.stderr.on("data", read);
      child.once("error", fail);
      child.once("close", (code) => fail(new Error(`Chromium exited with code ${code} before reporting a DevTools endpoint`)));
    });

    const browser = await Connection.open(endpoint);
    const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
    browser.sessionId = sessionId;

    return {
      page: browser,
      async close() {
        browser.close();
        await stop();
      },
    };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const chromium = findChromium();
const unavailable = !chromium
  ? "no Chromium or Chrome binary found; set CHROME_PATH to point at one"
  : typeof WebSocket !== "function"
    ? "this Node.js build has no global WebSocket; rendered-layout coverage needs Node.js 22 or newer"
    : null;

const demanded = process.env.REQUIRE_BROWSER ?? process.env.CI ?? "";
const required = demanded !== "" && demanded !== "0" && demanded !== "false";

if (unavailable && required) {
  test("a browser is available for the required rendered-layout coverage", () => {
    assert.fail(
      `Rendered-layout coverage is required here because ${process.env.REQUIRE_BROWSER ? "REQUIRE_BROWSER" : "CI"} is set, but ${unavailable}.`,
    );
  });
}

const limits = { timeout: 60_000 };

describe("rendered layout in a real browser", { skip: unavailable ?? false, timeout: 300_000 }, () => {
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
    await stopEveryChromium();
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

  test("the Dandho row exposes one semantic circled New label without unsafe geometry", limits, async () => {
    for (const [label, width, height, mobile] of [
      ["narrow", 390, 844, true],
      ["compact", 1366, 768, false],
      ["broad", 1483, 885, false],
      ["400% reflow", 320, 256, true],
    ]) {
      await viewport(width, height, mobile);
      await open("/");
      await evaluate("document.querySelector('.work-link').scrollIntoView({ block: 'center' })");
      await settle();
      const state = await evaluate(`(() => {
        const link = document.querySelector('.work-link');
        const title = link.querySelector('.work-title');
        const badge = link.querySelector('.new-label');
        const oval = badge.querySelector('svg');
        const date = link.querySelector('time');
        const row = link.getBoundingClientRect();
        const badgeBox = badge.getBoundingClientRect();
        const ovalBox = oval.getBoundingClientRect();
        const dateBox = date.getBoundingClientRect();
        const hit = document.elementFromPoint(badgeBox.left + badgeBox.width / 2, badgeBox.top + badgeBox.height / 2);
        return {
          visibleText: badge.childNodes[0].textContent,
          titleLabel: title.getAttribute('aria-label'),
          badgeCount: document.querySelectorAll('.new-label').length,
          svgHidden: oval.getAttribute('aria-hidden'),
          svgFocusable: oval.getAttribute('focusable'),
          svgPointerEvents: getComputedStyle(oval).pointerEvents,
          pathCount: oval.querySelectorAll('path').length,
          withinRow: ovalBox.top >= row.top - 1 && ovalBox.bottom <= row.bottom + 1,
          clearsDate: ovalBox.right < dateBox.left,
          hitIsLink: hit?.closest('.work-link') === link,
          horizontal: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        };
      })()`);
      assert.equal(state.visibleText, "New", `${label} lost the visible label text`);
      assert.equal(state.titleLabel, "Dandho, New", `${label} lost the semantic title`);
      assert.equal(state.badgeCount, 1, `${label} duplicated the label`);
      assert.equal(state.svgHidden, "true", `${label} exposed the oval to assistive technology`);
      assert.equal(state.svgFocusable, "false", `${label} made the oval focusable`);
      assert.equal(state.svgPointerEvents, "none", `${label} let the oval intercept pointers`);
      assert.equal(state.pathCount, 2, `${label} lost the two-line hand-drawn oval`);
      assert.ok(state.withinRow, `${label} oval crossed the Dandho row boundary`);
      assert.ok(state.clearsDate, `${label} oval overlapped the date`);
      assert.ok(state.hitIsLink, `${label} badge area escaped the Dandho link target`);
      assert.ok(state.horizontal, `${label} label caused horizontal scrolling`);
    }

    await viewport(1483, 885, false);
    await open("/");
    const { root: { nodeId } } = await page.send("DOM.getDocument");
    const { nodeId: linkNodeId } = await page.send("DOM.querySelector", { nodeId, selector: ".work-link" });
    const { node: { backendNodeId } } = await page.send("DOM.describeNode", { nodeId: linkNodeId });
    const tree = await page.send("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false });
    const link = tree.nodes.find((node) => node.role?.value === "link");
    assert.ok(link, "the Dandho row is missing from the accessibility tree");
    assert.match(link.name.value, /^Dandho, New\b/, `accessible link name was ${link.name.value}`);
    assert.equal((link.name.value.match(/\bNew\b/g) ?? []).length, 1, "New is announced more than once");
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
    await viewport(1483, 885, false);
    await open("/");
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
    assert.equal(await styleOf(".new-label", "animation-name"), "none", "the circled label should remain static");
    assert.equal(await styleOf(".new-label", "transition-duration"), "0s", "the circled label should not add motion");

    try {
      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await settle();
      const reduced = parseFloat(await styleOf(".cat-tail", "animation-duration"));
      assert.ok(reduced <= 0.001, `reduced motion left the tail animating for ${reduced}s`);
      assert.equal(await styleOf(".cat-tail", "animation-iteration-count"), "1");

      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
      await settle();
      assert.equal(await styleOf(".top-veil", "display"), "none");
      assert.ok(await evaluate('[...document.querySelectorAll(".annotation-layer")].every((node) => getComputedStyle(node).display === "none")'));
      assert.notEqual(await styleOf(".new-label", "display"), "none");
      assert.equal(await styleOf(".new-label", "color"), "rgb(0, 0, 0)");

      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-contrast", value: "more" }] });
      await settle();
      assert.ok(await evaluate('[...document.querySelectorAll(".annotation-layer")].every((node) => getComputedStyle(node).display === "none")'));
      assert.equal(await styleOf(".new-label", "color"), "rgb(69, 69, 69)");

      await page.send("Emulation.setEmulatedMedia", { media: "print" });
      await settle();
      assert.ok(await evaluate('[...document.querySelectorAll(".annotation-layer")].every((node) => getComputedStyle(node).display === "none")'));
      assert.notEqual(await styleOf(".new-label", "display"), "none");

      await page.send("Emulation.setEmulatedMedia", { media: "screen", features: [{ name: "forced-colors", value: "active" }] });
      await settle();
      const row = await box(".work-link");
      await page.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.round(row.left + row.width / 2),
        y: Math.round(row.top + row.height / 2),
        buttons: 0,
      });
      await pause(400);
      const forced = await evaluate(
        '[...document.querySelectorAll(".work-link")].map((node) => Number(getComputedStyle(node).opacity))',
      );
      assert.equal(forced.length, 3);
      assert.ok(
        await evaluate('document.querySelector(".work-link").matches(":hover")'),
        "the first writing row is not hovered, so the forced-colours override is not exercised",
      );
      for (const opacity of forced) {
        assert.equal(opacity, 1, `forced colours left a writing row faded at opacity ${opacity}`);
      }
    } finally {
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5, buttons: 0 });
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
      newLabel: document.querySelector(".new-label").childNodes[0].textContent,
      dandhoName: document.querySelector(".work-title").getAttribute("aria-label"),
    }))()`);
    } finally {
      await page.send("Emulation.setScriptExecutionDisabled", { value: false });
      scripting = true;
    }
    assert.equal(fallback.time, "Boston, Massachusetts");
    assert.equal(fallback.state, "day");
    assert.equal(fallback.poses, 1);
    assert.equal(fallback.newLabel, "New");
    assert.equal(fallback.dandhoName, "Dandho, New");
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

  test("stable annotation anchors preserve reflow at supported widths and zoom equivalents", limits, async () => {
    await open("/");
    for (const [label, width, height] of [
      ["320px", 320, 568],
      ["390px portrait", 390, 844],
      ["844px landscape", 844, 390],
      ["768px", 768, 1024],
      ["1366px", 1366, 768],
      ["1483px", 1483, 885],
      ["80% zoom equivalent", 1708, 960],
      ["125% zoom equivalent", 1093, 614],
      ["200% zoom equivalent", 683, 384],
      ["400% zoom equivalent", 342, 192],
    ]) {
      await viewport(width, height, width < 600);
      const state = await evaluate(`(() => ({
        horizontal: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        anchors: [...document.querySelectorAll("[data-annotation-id]")].map((node) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }),
        layers: [...document.querySelectorAll(".annotation-layer")].map((node) => ({
          display: getComputedStyle(node).display,
          scope: node.classList.contains("annotation-layer--broad") ? "broad" : "unexpected",
          pointerEvents: getComputedStyle(node).pointerEvents,
          ariaHidden: node.getAttribute("aria-hidden"),
          focusable: node.getAttribute("focusable"),
        })),
      }))()`);
      assert.ok(state.horizontal, `${label} produced horizontal scrolling`);
      assert.ok(state.anchors.length >= 3 && state.anchors.every(Boolean), `${label} collapsed an annotation anchor`);
      assert.equal(state.layers.length, 1, `${label} lost the published homepage annotation`);
      assert.ok(state.layers.every((layer) => layer.scope === "broad" && layer.pointerEvents === "none"
        && layer.ariaHidden === "true" && layer.focusable === "false"), `${label} exposed an interactive or unauthored annotation`);
      const broad = width > 600 && !(height <= 768 && width >= 737);
      assert.equal(state.layers.filter((layer) => layer.display !== "none").length, broad ? 1 : 0,
        `${label} rendered annotations outside their authored broad scope`);
    }
  });

  test("the rendered site makes no off-origin or annotation-data requests", limits, () => {
    const offOrigin = requested.filter((url) => /^https?:\/\//.test(url) && !url.startsWith(origin));
    assert.deepEqual(offOrigin, []);
    assert.deepEqual(requested.filter((url) => /(?:annotations\/|authoring-manifest|editor\.js)/.test(url)), []);
    assert.ok(
      requested.some((url) => url === `${origin}/fonts/inter-latin-wght-normal.woff2`),
      "the local Inter font was never requested",
    );
  });
});
