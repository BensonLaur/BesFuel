"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fixture = require("./helpers/recovery.cjs");
const { createSnapshot } = require("./helpers/snapshot.cjs");
const { importVerified } = require("../scripts/import-verified.cjs");
const { acceptMonitor, runAutomatic } = require("../scripts/automatic-review.cjs");
const { readHunan } = require("../scripts/automatic-hunan.cjs");
const { acceptDocument, parseZhejiang } = require("../scripts/automatic-documents.cjs");
const { collectEvidence, GROUPS } = require("../scripts/cloud-evidence.cjs");
const { loadModules, adapterDigest } = require("../scripts/cloud-bundle.cjs");
const { counts } = require("../scripts/source-health.cjs");
const { planAlerts } = require("../scripts/review-alerts.cjs");
const yunnan = ["yunnan-kunming", "yunnan-zone2", "yunnan-zone3", "yunnan-zone4", "yunnan-zone5"];
const ids = ["henan", "hunan", "zhejiang", ...yunnan];
const monitor = id => require(`../scripts/monitors/${id}.cjs`);
const collect = (id, reader = fixture.reader(), today = "2026-10-31") => monitor(id).collect({ ...reader, today });
const supplements = () => yunnan.map(id => require(`../data/verified/${id}-20261029.json`));
const expected = {
  henan: { "92": 8.90, "95": 9.50, diesel: 8.58 },
  hunan: { "92": 8.83, "95": 9.38, diesel: 8.66 },
  zhejiang: { "92": 8.85, "95": 9.42, diesel: 8.57 },
  "yunnan-kunming": { "92": 9.04, "95": 9.70, diesel: 8.65 },
  "yunnan-zone2": { "92": 9.11, "95": 9.77, diesel: 8.74 },
  "yunnan-zone3": { "92": 9.19, "95": 9.85, diesel: 8.82 },
  "yunnan-zone4": { "92": 9.26, "95": 9.93, diesel: 8.91 },
  "yunnan-zone5": { "92": 9.32, "95": 9.99, diesel: 8.98 }
};

test("official recovery fixtures retain their recorded hashes", () => {
  for (const file of fixture.manifest.files) assert.equal(
    crypto.createHash("sha256").update(fixture.bytes(file.name)).digest("hex"), file.fixtureSha256, file.name);
});

test("Henan's official enumeration punctuation preserves oil scope and retail prices", async () => {
  assert.deepEqual((await collect("henan")).prices, expected.henan);
  const mutateBody = transform => fixture.reader(text => text.replace(/(<div class="conBox">)([\s\S]*?)(<\/div>)/,
    (_, start, body, end) => start + transform(body.replace(/<[^>]+>/g, '')) + end));
  await assert.rejects(collect("henan", mutateBody(text => text.replace("汽油、国VI车用柴油", "汽油、航空煤油"))), /适用油品/);
  await assert.rejects(collect("henan", mutateBody(text => text.replace("自2026年10月29日24时起", "自2026年10月30日24时起"))), /生效日/);
});

test("Hunan's full-width title leads to the same announcement-bound XLS and real retail cells", async () => {
  const latest = await collect("hunan");
  assert.equal(latest.effectiveDate, "2026-10-30");
  assert.deepEqual((await readHunan(latest, fixture.reader())).prices, expected.hunan);
  await assert.rejects(collect("hunan", fixture.reader(text => text.replaceAll("5f49acd264d543ab8e876a64f31c0d93.xls", "../../other.xls"))), /XLS 附件/);
});

test("Zhejiang's office-published bulletin passes both independent price checks", async () => {
  const latest = await collect("zhejiang");
  assert.deepEqual(latest.prices, expected.zhejiang);
  assert.deepEqual(parseZhejiang(fixture.text("zhejiang.html"), latest).prices, expected.zhejiang);
  const wrong = fixture.text("zhejiang.html").replace('name="ContentSource" content="办公室"', 'name="ContentSource" content="未知来源"');
  await assert.rejects(collect("zhejiang", fixture.reader((text, url) => url.includes("/art/") ? wrong : text)), /来源/);
  assert.throws(() => parseZhejiang(wrong + '<meta name="other" content="价格处">', latest), /来源/);
});

test("all Yunnan zones discover the migrated column, dated article and its own PDF", async () => {
  for (const id of yunnan) {
    const current = await collect(id);
    assert.equal(current.effectiveDate, "2026-10-30");
    assert.match(current.url, /\/jgysf\/202610\/t20261029_4376532\.html$/);
    assert.match(current.pdfUrl, /\/jgysf\/202610\/P020261029587511868286\.pdf$/);
    const before = await collect(id, fixture.reader(), "2026-10-29");
    assert.equal(before.effectiveDate, "2026-09-25");
    assert.match(before.pdfUrl, /\/202609\/P020261022613826315296\.pdf$/);
  }
});

test("migrated Yunnan rejects foreign addresses, mismatched paths, sources, attachments and malformed PDFs", async () => {
  for (const [transform, pattern] of [
    [(text, url) => url.endsWith("/cpyjg/") ? text.replace('../../../zwgk/fdzdgknr/jgysf/202610/t20261029_4376532.html', 'https://evil.example/price.html') : text, /官网地址/],
    [(text, url) => url.endsWith("/cpyjg/") ? text.replace('t20261029_4376532', 't20261028_4376532') : text, /路径与列表日期/],
    [text => text.replace('name="ContentSource" content="云南省发展和改革委员会"', 'name="ContentSource" content="未知来源"'), /发布单位/],
    [text => text.replace('./P020261029587511868286.pdf', '../202609/P020261029587511868286.pdf'), /该公告的官网附件/],
    [text => text.replace('来源：价格监测与成本调查处', '来源：匿名转载'), /发布单位/]
  ]) await assert.rejects(collect("yunnan-kunming", fixture.reader(transform)), pattern);
  const reader = fixture.reader();
  await assert.rejects(collect("yunnan-kunming", { ...reader, getBuffer: async () => ({ buffer: Buffer.from('%PDF-incomplete') }) }), /PDF 内容异常/);
  const html = fixture.text("yunnan-oil-list.html"), first = html.slice(html.indexOf('<div class="list-content">')).match(/<li>[\s\S]*?<\/li>/)[0];
  await assert.rejects(collect("yunnan-kunming", fixture.reader((text, url) => url.endsWith('/cpyjg/') ? text.replace(first, first + first) : text)), /最新公告日期不唯一/);
});

test("audited Yunnan recovery fills the outage without weakening the automatic continuity or rollback guards", () => {
  let base = createSnapshot(...yunnan);
  for (const id of yunnan) base.regions[id].checkedAt = "2026-10-23";
  base.checkedAt = "2026-10-31";
  for (const record of supplements()) {
    const latest = record.notices.at(-1), id = record.id;
    assert.throws(() => acceptDocument(base, id, latest, { prices: latest.prices }, "2026-10-31"), /检查中断/);
    const before = structuredClone(base);
    base = importVerified(base, record);
    assert.deepEqual(base.regions[id].grades["92"].history.slice(0, -1), before.regions[id].grades["92"].history);
    assert.deepEqual(Object.fromEntries(["92", "95", "diesel"].map(grade => [grade, base.regions[id].grades[grade].price])), expected[id]);
    const trusted = structuredClone(base);
    assert.throws(() => importVerified(base, require(`../data/verified/${id}.json`)), /可信价格旧/);
    assert.deepEqual(base, trusted);
  }
});

test("FC evidence replay automatically verifies all eight repairs and marks the summary items recovered", async () => {
  let initial = createSnapshot(...ids, ...Object.values(GROUPS).flat());
  initial.checkedAt = "2026-10-31";
  for (const id of ids) initial.regions[id].checkedAt = "2026-10-29";
  for (const record of supplements()) initial = importVerified(initial, record);
  const sources = loadModules("sources").map(source => ({ id: source.id, ok: false, error: "unrelated test source offline", failure: { category: "timeout" } }));
  const monitors = await Promise.all(loadModules("monitors").map(async source => ids.includes(source.id) ?
    { id: source.id, ok: true, latest: await collect(source.id) } : { id: source.id, ok: false, error: "unrelated test monitor offline", failure: { category: "timeout" } }));
  const now = new Date("2026-10-31T08:00:00.000Z");
  const bundle = { format: "besfuel-regions-v1", revision: "a".repeat(40), adapterDigest: adapterDigest(),
    startedAt: now.toISOString(), generatedAt: now.toISOString(), sources, monitors,
    counts: { sources: counts(sources), monitors: counts(monitors) } };
  bundle.evidence = await collectEvidence(bundle, () => fixture.reader());
  const result = await runAutomatic({ bundle, initial, now, reader: () => fixture.reader() });
  const repaired = result.monitors.filter(item => ids.includes(item.id));
  assert.equal(repaired.length, 8);
  for (const item of repaired) {
    assert.equal(item.ok, true, item.error);
    assert.equal(item.automatic, true, item.id);
    assert.equal(item.needsReview, false);
    assert.deepEqual(Object.fromEntries(["92", "95", "diesel"].map(grade => [grade, result.data.regions[item.id].grades[grade].price])), expected[item.id]);
  }
  const previous = planAlerts({ version: 1, results: ids.map(id => ({ id, ok: false, error: "original collector failure" })) }, undefined, "before").state;
  const plan = planAlerts({ version: 1, checkedAt: "2026-10-31", results: repaired }, previous, "after");
  assert.equal(plan.summary.active.length, 0);
  assert.deepEqual(plan.summary.resolved.map(item => item.id).sort(), [...ids].sort());
});
