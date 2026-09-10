import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createAnnotationManifest } from "../scripts/annotation-build.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const AUTHOR_ROOT = resolve(ROOT, "tools/author");
const SITE_ROOT = resolve(ROOT, "site");
const CORE_FILE = resolve(ROOT, "tools/annotation-core.js");
const HOST = "127.0.0.1";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function securityHeaders(preview = false) {
  const style = preview ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'";
  return {
    "cache-control": "no-store",
    "content-security-policy": `default-src 'self'; script-src 'self'; ${style}; style-src-attr 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
  };
}

function inside(root, path) {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function siteFile(pathname, siteRoot) {
  let relative = pathname.slice("/preview".length);
  if (!relative || relative.endsWith("/")) relative += "index.html";
  relative = relative.replace(/^\/+/, "");
  const path = resolve(siteRoot, relative);
  if (!inside(siteRoot, path)) return null;
  try {
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}

async function authorFile(pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const path = resolve(AUTHOR_ROOT, relative);
  if (!inside(AUTHOR_ROOT, path)) return null;
  try {
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}

export function createAuthorServer({ siteRoot = SITE_ROOT } = {}) {
  return createServer(async (request, response) => {
    try {
      const host = request.headers.host?.split(":")[0];
      if (host !== HOST && host !== "localhost") {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8", ...securityHeaders() });
        response.end("Loopback host required.\n");
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8", ...securityHeaders() });
        response.end("Read-only local authoring server.\n");
        return;
      }
      const pathname = decodeURIComponent(new URL(request.url, `http://${HOST}`).pathname);
      if (pathname === "/authoring-manifest.json") {
        const body = `${JSON.stringify(await createAnnotationManifest(siteRoot))}\n`;
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", ...securityHeaders() });
        if (request.method === "GET") response.end(body); else response.end();
        return;
      }
      if (pathname === "/annotation-core.js") {
        const body = await readFile(CORE_FILE);
        response.writeHead(200, { "content-type": MIME[".js"], ...securityHeaders() });
        if (request.method === "GET") response.end(body); else response.end();
        return;
      }
      const preview = pathname === "/preview" || pathname.startsWith("/preview/");
      const file = preview ? await siteFile(pathname, siteRoot) : await authorFile(pathname);
      if (!file) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...securityHeaders(preview) });
        response.end("Not found.\n");
        return;
      }
      const body = await readFile(file);
      response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", ...securityHeaders(preview) });
      if (request.method === "GET") response.end(body); else response.end();
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8", ...securityHeaders() });
      response.end(`Local authoring error: ${error.message}\n`);
    }
  });
}

export function listen(server, port = 4174) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolveListen(server.address());
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portFlag = process.argv.indexOf("--port");
  const port = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 4174;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    console.error("Usage: node tools/author-server.mjs [--port 0-65535]");
    process.exit(1);
  }
  const server = createAuthorServer();
  const address = await listen(server, port);
  console.log(`Local annotation author: http://${HOST}:${address.port}/`);
  console.log("Loopback only. Stop with Ctrl+C; exports are downloaded by the browser and never uploaded.");
}
