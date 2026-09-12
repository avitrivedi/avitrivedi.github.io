import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { createAuthorServer, listen } from "../tools/author-server.mjs";

async function withServer(callback) {
  const server = createAuthorServer();
  const address = await listen(server, 0);
  try {
    assert.equal(address.address, "127.0.0.1");
    await callback(`http://127.0.0.1:${address.port}`, address.port);
  } finally {
    await new Promise((done) => server.close(done));
  }
}

test("the author server is loopback-only, read-only, and does not expose route data", async () => {
  await withServer(async (origin) => {
    const page = await fetch(`${origin}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /object-src 'none'/);
    assert.equal(page.headers.get("set-cookie"), null);
    assert.match(await page.text(), /Annotation studio/);

    const manifestResponse = await fetch(`${origin}/authoring-manifest.json`);
    const manifest = await manifestResponse.json();
    assert.deepEqual(Object.keys(manifest), ["/", "/dandho/", "/khata/", "/pulse/"]);
    assert.match(manifest["/"].anchors["home-introduction"].contentHash, /^sha256:[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(manifest), /\/home\/|avifacts|localhost|127\.0\.0\.1/);

    const preview = await fetch(`${origin}/preview/dandho/`);
    assert.equal(preview.status, 200);
    assert.match(await preview.text(), /data-annotation-id="dandho-overview"/);
    assert.equal((await fetch(`${origin}/annotations/home.json`)).status, 404);
    assert.equal((await fetch(`${origin}/test/fixtures/annotations/home.json`)).status, 404);

    const post = await fetch(`${origin}/authoring-manifest.json`, { method: "POST", body: "draft" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
    assert.match(await post.text(), /Read-only/);
  });
});

test("the author server rejects non-loopback Host headers", async () => {
  await withServer(async (_origin, port) => {
    const result = await new Promise((resolveResult, reject) => {
      const outgoing = request({ hostname: "127.0.0.1", port, path: "/", headers: { host: "attacker.example" } }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolveResult({ status: response.statusCode, body }));
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
    assert.equal(result.status, 403);
    assert.match(result.body, /Loopback host required/);
  });
});
