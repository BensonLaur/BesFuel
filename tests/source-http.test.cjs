const assert = require("node:assert/strict");
const test = require("node:test");
const { makeReader } = require("../scripts/update-regions.cjs");
const { auditSources } = require("../scripts/audit-sources.cjs");
const host = "official.example.gov.cn", url = `https://${host}/notices/`;

test("request failures retain URL and nested DNS, timeout and TLS causes", async () => {
  for (const [code, category] of [["ENOTFOUND", "dns"], ["UND_ERR_CONNECT_TIMEOUT", "timeout"], ["ERR_SSL_BAD_ECPOINT", "tls"]]) {
    const cause = Object.assign(new Error("underlying failure"), { code });
    const reader = makeReader([host], { fetcher: async () => { throw new TypeError("fetch failed", { cause }); } });
    await assert.rejects(reader.getText(url), error => {
      assert.match(error.message, new RegExp(code));
      assert.ok(error.message.includes(url));
      assert.equal(error.details.category, category);
      assert.equal(error.details.causes[1].code, code);
      return true;
    });
  }
});

test("HTTP refusal includes status and target without retrying or reading the denied body", async () => {
  let calls = 0, cancelled = false;
  const reader = makeReader([host], { fetcher: async () => {
    calls++;
    return { status: 403, ok: false, body: { cancel: async () => { cancelled = true; } } };
  } });
  await assert.rejects(reader.getBuffer(url), error => error.details.status === 403 && error.details.url === url);
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});

test("redirects cannot leave official hosts or deadlock through a cached cycle", async () => {
  for (const destination of ["https://evil.example/", url]) {
    let calls = 0;
    const reader = makeReader([host], { fetcher: async () => {
      calls++;
      return { status: 302, headers: new Headers({ location: destination }), body: { cancel: async () => {} } };
    } });
    await assert.rejects(reader.getText(url), /非允许的官方地址|重定向循环/);
    assert.equal(calls, 1);
  }
});

test("shared request cache deduplicates zones but never grants another region's host access", async () => {
  const cache = new Map(); let calls = 0;
  const options = { cache, fetcher: async () => { calls++; return new Response("official notice"); } };
  const first = makeReader([host], options), second = makeReader([host], options), foreign = makeReader(["other.example"], options);
  assert.deepEqual(await Promise.all([first.getText(url), second.getText(url)]), ["official notice", "official notice"]);
  assert.equal(calls, 1);
  await assert.rejects(foreign.getText(url), /非允许的官方地址/);
});

test("read-only audit separates failures from manual review without changing the supplied snapshot", async () => {
  const initial = { checkedAt: "2026-09-29", regions: {} }, before = structuredClone(initial);
  const report = await auditSources({ sources: [], initial, summaryFile: "", monitors: [
    { id: "unavailable", allowedHostnames: [host], collect: async ({ getText }) => getText(url) },
    { id: "new", allowedHostnames: [host], collect: async () => ({ url, requiresManualPriceReview: true }) }
  ], readerOptions: { fetcher: async () => { throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" }); } } });
  assert.equal(report.counts.monitors.failed, 1);
  assert.equal(report.counts.monitors.review, 1);
  assert.equal(report.monitors[0].failure.causes[0].code, "ECONNRESET");
  assert.deepEqual(initial, before);
});
