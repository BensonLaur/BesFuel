"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { discover, parseArticle } = require("../scripts/automatic-tables.cjs");
const { acceptMonitor, runAutomatic } = require("../scripts/automatic-review.cjs");
const { planAlerts, deliver } = require("../scripts/review-alerts.cjs");
const { loadModules, adapterDigest } = require("../scripts/cloud-bundle.cjs");
const { counts } = require("../scripts/source-health.cjs");
const { publicHttpFallback } = require("../scripts/publish-reader.cjs");
const snapshot = require("../data/prices.json");
const fixture = id => fs.readFileSync(path.join(__dirname, "fixtures/automatic", id + ".html"), "utf8");
const record = id => require(`../data/verified/${id}.json`);

test("public HTTP fallback is host-scoped and never bypasses a certificate failure", async () => {
  let reason = { category: "timeout", causes: [] }, called = [];
  const reader = publicHttpFallback({ getText: async () => { throw Object.assign(Error("failed"), { details: reason }); } },
    { getText: async url => { called.push(url); return "official page"; } });
  assert.equal(await reader.getText("https://plan.hainan.gov.cn/"), "official page");
  assert.deepEqual(called, ["http://plan.hainan.gov.cn/"]);
  await assert.rejects(reader.getText("https://example.com/"));
  reason = { category: "network", causes: [{ message: "schannel certificate validation failed" }] };
  await assert.rejects(reader.getText("https://drc.jiangxi.gov.cn/"));
  reason = { category: "tls", causes: [] };
  await assert.rejects(reader.getText("https://drc.jiangxi.gov.cn/"));
  assert.equal(called.length, 1);
});

test("official HTML fixtures retain retail columns, dates and Hainan surcharge", () => {
  for (const id of ["hainan", "jiangxi"]) {
    const last = record(id).notices.at(-1);
    const parsed = parseArticle(id, fixture(id), { url: last.url, date: last.publishedDate });
    assert.deepEqual(parsed.prices, last.prices);
    assert.equal(parsed.effectiveDate, last.effectiveDate);
    assert.match(parsed.sourceSha256, /^[a-f0-9]{64}$/);
    assert.throws(() => parseArticle(id, fixture(id).replaceAll("/升", "/吨"), last));
    assert.throws(() => parseArticle(id, fixture(id), { url: "https://example.com/fake" }));
    assert.throws(() => parseArticle(id, fixture(id), { url: last.url, date: "2026-09-23" }));
    assert.throws(() => parseArticle(id, fixture(id).replace(/95(?:#|号车用)汽油/g, "98号汽油"), last));
  }
  assert.throws(() => parseArticle("hainan", fixture("hainan").replace("1.05", "1.10"), record("hainan").notices.at(-1)));
});

test("discovery reads inert official JSON and fails closed on unknown notice types", () => {
  const r = record("jiangxi"), notice = r.notices.at(-1);
  const row = { title: "江西省发展改革委关于成品油价格调整的通告", pubDate: "2026-09-24 15:57",
    urls: JSON.stringify({ pc: new URL(notice.url).pathname }) };
  const html = `var col14590 = ${JSON.stringify([row])}`;
  assert.deepEqual(discover("jiangxi", html), [{ url: notice.url, date: "2026-09-24" }]);
  assert.throws(() => discover("jiangxi", html.replace("价格调整", "价格不作调整")));
  assert.throws(() => discover("jiangxi", "var col14590 = [process.exit()]"));
  assert.throws(() => discover("hainan", '<a href="https://example.com/oil">海南省成品油价格按机制调整</a>'));
});

function nextHenan() {
  const data = structuredClone(snapshot);
  data.regions.henan.checkedAt = "2026-10-29";
  const latest = { ...record("henan").notices.at(-1), publishedDate: "2026-10-29", effectiveDate: "2026-10-30",
    url: "https://fgw.henan.gov.cn/2026/10-29/3439999.html", prices: { "92": 8.5, "95": 9.09, diesel: 8.17 } };
  return { data, result: { id: "henan", ok: true, latest, needsReview: true } };
}
test("a validated new monitor notice updates atomically and preserves audited history", () => {
  const { data, result } = nextHenan(), before = structuredClone(data);
  const after = acceptMonitor(data, result, "2026-10-30");
  assert.deepEqual(data, before);
  assert.equal(after.regions.henan.grades["92"].price, 8.5);
  assert.deepEqual(after.regions.henan.grades["92"].history.slice(0, -1), before.regions.henan.grades["92"].history);
  assert.deepEqual(after.regions.hainan, before.regions.hainan);
  assert.deepEqual(acceptMonitor(after, result, "2026-10-30"), after);
});
test("automatic monitor imports reject unit gaps, future prices, conflicts and missed history", () => {
  const { data, result } = nextHenan();
  for (const latest of [{ ...result.latest, prices: { ...result.latest.prices, diesel: undefined } },
    { ...result.latest, prices: { ...result.latest.prices, "92": 11000 } },
    { ...result.latest, requiresManualCoefficientReview: true },
    { ...result.latest, url: "https://example.com/fake" }]) {
    assert.throws(() => acceptMonitor(data, { ...result, latest }, "2026-10-30"));
  }
  assert.throws(() => acceptMonitor(data, result, "2026-10-29"));
  assert.throws(() => acceptMonitor(data, { ...result, id: "guizhou-zone1" }, "2026-10-30"));
  data.regions.henan.checkedAt = "2026-10-23";
  assert.throws(() => acceptMonitor(data, result, "2026-10-30"), /中断/);
  const conflict = { ...result, latest: { ...record("henan").notices.at(-1), prices: result.latest.prices } };
  assert.throws(() => acceptMonitor(data, conflict, "2026-10-30"), /冲突/);
});
test("a failed direct source retains its price and check date", async () => {
  const before = structuredClone(snapshot);
  const result = await runAutomatic({ initial: before, reader: () => ({ getText: async () => { throw Error("offline"); } }) });
  assert.deepEqual(result.data, before);
  assert.equal(result.direct.filter(item => !item.ok).length, 2);
});
test("a matching Hunan announcement cannot refresh its date if XLS verification fails", async () => {
  const initial = structuredClone(snapshot);
  initial.regions.hunan.checkedAt = "2026-09-25";
  const sources = loadModules("sources").map(m => ({ id: m.id, ok: false, error: "offline" }));
  const monitors = loadModules("monitors").map(m => m.id === "hunan" ?
    { id: m.id, ok: true, needsReview: false, latest: record("hunan").notices.at(-1) } :
    { id: m.id, ok: false, error: "offline" });
  const now = new Date().toISOString();
  const bundle = { format: "besfuel-regions-v1", adapterDigest: adapterDigest(), revision: "a".repeat(40),
    startedAt: now, generatedAt: now, sources, monitors, counts: { sources: counts(sources), monitors: counts(monitors) } };
  const reader = () => ({ getBuffer: async () => { throw Error("attachment unavailable"); },
    getText: async () => { throw Error("offline"); } });
  const result = await runAutomatic({ bundle, initial, reader });
  assert.deepEqual(result.data.regions.hunan, initial.regions.hunan);
  assert.equal(result.monitors.find(m => m.id === "hunan").ok, false);
});
const failure = { id: "hainan", ok: false, error: "timeout", failure: { category: "timeout", url: "https://plan.hainan.gov.cn/" } };
const report = results => ({ version: 1, results });
test("transient failures wait three runs, deduplicate, recover and can alert on recurrence", () => {
  let p = planAlerts(report([failure]), undefined, "1");
  assert.equal(p.actions.length, 0);
  p = planAlerts(report([failure]), p.state, "1");
  assert.equal(p.state.entries.hainan.consecutive, 1);
  p = planAlerts(report([failure]), p.state, "2");
  assert.equal(p.actions.length, 0);
  p = planAlerts(report([failure]), p.state, "3");
  assert.equal(p.actions[0].kind, "alert");
  p = planAlerts(report([failure]), p.state, "4");
  assert.equal(p.actions.length, 0);
  p = planAlerts(report([{ id: "hainan", ok: true }]), p.state, "5");
  assert.equal(p.actions[0].kind, "resolve");
  p = planAlerts(report([failure]), p.state, "6");
  assert.equal(p.actions.length, 0);
});
test("new unresolved evidence alerts once and retry delivery does not repeat writes", async () => {
  const r = { id: "liaoning", ok: true, needsReview: true, latest: { url: "https://fgw.ln.gov.cn/new.pdf" } };
  const p = planAlerts(report([r]), undefined, "1");
  assert.equal(p.actions.length, 1);
  assert.equal(planAlerts(report([r]), p.state, "2").actions.length, 0);
  assert.equal(planAlerts(report([{ ...r, latest: { url: "https://fgw.ln.gov.cn/newer.pdf" } }]), p.state, "2").actions.length, 1);
  const calls = [], issue = { number: 3, user: { login: "github-actions[bot]" }, body: `<!-- besfuel-data-alert:liaoning -->\n<!-- evidence:${p.actions[0].signature} -->` };
  await deliver(p.actions, { token: "test", repository: "owner/repo", fetcher: async (url, args) => {
    calls.push(args.method); return { ok: true, json: async () => [issue] };
  } });
  assert.deepEqual(calls, ["GET"]);
});
