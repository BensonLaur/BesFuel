"use strict";
const { createSnapshot } = require("./helpers/snapshot.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { GROUPS, plan, collectEvidence, validateEvidence } = require("../scripts/cloud-evidence.cjs");
const { parseXizang, parseZhejiang, parseBinary, acceptDocument, applyDocuments } = require("../scripts/automatic-documents.cjs");
const { planAlerts } = require("../scripts/review-alerts.cjs");
const snapshot = createSnapshot(...Object.values(GROUPS).flat());
const fixture = name => fs.readFileSync(path.join(__dirname, "fixtures/automatic/documents", name));
const record = id => require(`../data/verified/${id}.json`);
const latest = id => structuredClone(record(id).notices.find(n => n.publishedDate === "2026-09-24"));
const unchanged = () => ({ url: record("zhejiang").latestNotice.sourceUrl, title: "浙江省成品油价格不作调整",
  publishedDate: "2026-10-15", effectiveDate: "2026-10-16", kind: "unchanged" });
function bundle() {
  const monitors = Object.values(GROUPS).flat().map(id => ({ id, ok: true, latest: id === "zhejiang" ? unchanged() : latest(id) }));
  return { startedAt: "2026-10-22T18:43:00.000Z", monitors };
}
async function evidenceBundle() {
  const b = bundle(), files = new Map();
  for (const group of Object.keys(GROUPS)) {
    const { urls } = plan(b, group);
    const names = { xizang: ["xizang.html"], zhejiang: ["zhejiang-unchanged.html"],
      sichuan: [null, "sichuan.docx"], jilin: [null, "jilin.pdf"], yunnan: [null, "yunnan.pdf"] }[group];
    urls.forEach((url, i) => files.set(url, names[i] ? fixture(names[i]) : Buffer.from("official announcement")));
  }
  b.evidence = await collectEvidence(b, () => ({ getBuffer: async url => ({ buffer: files.get(url) }) }));
  return b;
}
function initial() {
  const data = structuredClone(snapshot);
  for (const id of Object.values(GROUPS).flat()) {
    const region = data.regions[id], notice = latest(id);
    for (const grade of ["92", "95", "diesel"]) {
      region.grades[grade] = { price: notice.prices[grade], history: [{ date: notice.effectiveDate, price: notice.prices[grade], sourceUrl: notice.url }] };
    }
    region.source.url = notice.url;
    region.checkedAt = "2026-10-22";
    delete region.latestNotice;
  }
  return data;
}
test("new evidence is optional for old FC and binds bytes to the current official attachment", async () => {
  assert.equal(validateEvidence({}), null);
  const b = await evidenceBundle();
  assert.equal(validateEvidence(b).size, 5);
  for (const mutate of [x => x.evidence.results.pop(), x => { x.evidence.results[0].documents[0].url = "https://example.com/"; },
    x => { x.evidence.results[2].documents[1].base64 = Buffer.from("changed").toString("base64"); },
    x => { x.monitors.find(m => m.id === "yunnan-zone5").latest.publishedDate = "2026-09-11"; }]) {
    const bad = structuredClone(b); mutate(bad); assert.throws(() => validateEvidence(bad));
  }
});
test("one attachment group failing does not prevent other official evidence from being captured", async () => {
  const b = bundle();
  const result = await collectEvidence(b, () => ({ getBuffer: async url => {
    if (url.includes("jl.gov.cn")) throw Error("network unavailable");
    return { buffer: Buffer.from("official") };
  } }));
  assert.deepEqual(result.results.filter(x => !x.ok).map(x => x.id), ["jilin"]);
  assert.equal(result.results.filter(x => x.ok).length, 4);
});
test("Tibet prices require matching zones, explicit litre units and consistent old/new/delta values", () => {
  const html = fixture("xizang.html").toString().replace(/<[^>]*>/g, "").replace(/\s|&nbsp;/g, ""),
    parsed = parseXizang(html, latest("xizang-lhasa"));
  for (const id of GROUPS.xizang) assert.deepEqual(parsed[id].prices, latest(id).prices);
  for (const changed of [html.replaceAll("每升", "每吨"), html.replace("每升涨0.34元", "每升涨0.35元"),
    html.replace("（二）昌都价区", "（二）拉萨价区"), html.replaceAll("95号汽油", "98号汽油")]) {
    assert.throws(() => parseXizang(changed, latest("xizang-lhasa")));
  }
});
test("Zhejiang unchanged announcements keep the original price source, effective date and history", () => {
  const before = initial(), parsed = parseZhejiang(fixture("zhejiang-unchanged.html").toString(), unchanged());
  const after = acceptDocument(before, "zhejiang", unchanged(), parsed, "2026-10-23");
  assert.deepEqual(after.regions.zhejiang.grades, before.regions.zhejiang.grades);
  assert.deepEqual(after.regions.zhejiang.source, before.regions.zhejiang.source);
  assert.equal(after.regions.zhejiang.effectiveLabel, before.regions.zhejiang.effectiveLabel);
  assert.equal(after.regions.zhejiang.latestNotice.date, "2026-10-15");
  assert.equal(after.regions.zhejiang.checkedAt, "2026-10-23");
  assert.throws(() => acceptDocument(before, "zhejiang", unchanged(), { unchanged: "2026-09-11" }, "2026-10-23"));
  const adjusted = { ...latest("zhejiang"), title: "浙江省成品油价格调整" };
  assert.deepEqual(parseZhejiang(fixture("zhejiang-adjusted.html").toString(), adjusted).prices, adjusted.prices);
});
test("new confirmed document prices append history; conflicts, gaps and future dates are blocked atomically", () => {
  const before = initial(), id = "jilin", n = { ...latest(id), publishedDate: "2026-10-22", effectiveDate: "2026-10-23" };
  const parsed = { prices: { "92": 8.5, "95": 9.1, diesel: 8 } }, copy = structuredClone(before);
  const after = acceptDocument(before, id, n, parsed, "2026-10-23");
  assert.deepEqual(before, copy);
  assert.equal(after.regions[id].grades["92"].history.length, 2);
  assert.throws(() => acceptDocument(before, id, latest(id), parsed, "2026-10-23"), /冲突/);
  assert.throws(() => acceptDocument(before, id, n, parsed, "2026-10-22"));
  before.regions[id].checkedAt = "2026-10-01";
  assert.throws(() => acceptDocument(before, id, n, parsed, "2026-10-23"), /中断/);
});
test("attachment failure rolls back any earlier announcement date refresh; unaffected regions still update", async () => {
  const b = await evidenceBundle(), before = initial(), refreshed = structuredClone(before);
  refreshed.regions.jilin.checkedAt = "2026-10-23";
  const result = await applyDocuments(b, before, refreshed, b.monitors, { parse: async group => {
    if (group === "jilin") throw Error("PDF columns changed");
    return Object.fromEntries(GROUPS[group].map(id => [id, latest(id).prices]));
  } });
  assert.deepEqual(result.data.regions.jilin, before.regions.jilin);
  assert.equal(result.data.regions["yunnan-zone5"].checkedAt, "2026-10-23");
  assert.equal(result.monitors.filter(x => x.automatic).length, 10);
  const failed = result.monitors.find(x => x.id === "jilin");
  assert.equal(failed.failure.url, latest("jilin").url);
  assert.match(failed.evidenceFingerprint, /^[a-f0-9]{64}$/);
});
test("parser subprocess failures do not include changing temporary directories in alert messages", async () => {
  const buffer = fixture("jilin.pdf"), doc = { base64: buffer.toString("base64"), sha256: crypto.createHash("sha256").update(buffer).digest("hex") };
  await assert.rejects(parseBinary("jilin", doc, latest("jilin"), async () => { throw { stderr: "PDF 缺少唯一的可读文字价表" }; }),
    error => error.message === "jilin: 附件解析未通过：PDF 缺少唯一的可读文字价表");
});
test("the same document problem stays quiet; new evidence alerts, and recovery closes an older issue", () => {
  const failed = { id: "jilin", ok: false, error: "表头变化", failure: { category: "validation", url: latest("jilin").url }, evidenceFingerprint: "a".repeat(64) };
  const report = result => ({ version: 1, results: [result] });
  const first = planAlerts(report(failed), undefined, "1");
  assert.equal(first.actions.length, 1);
  assert.equal(planAlerts(report(failed), first.state, "2").actions.length, 0);
  assert.equal(planAlerts(report({ ...failed, evidenceFingerprint: "b".repeat(64) }), first.state, "2").actions.length, 1);
  const transient = planAlerts(report({ ...failed, failure: { category: "timeout" } }), first.state, "2");
  assert.equal(transient.actions.length, 0);
  assert.equal(planAlerts(report({ id: "jilin", ok: true }), transient.state, "3").actions[0].kind, "resolve");
});
