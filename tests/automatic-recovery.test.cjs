"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const fixture = require("./helpers/recovery.cjs");
const { createSnapshot } = require("./helpers/snapshot.cjs");
const { importVerified } = require("../scripts/import-verified.cjs");
const { acceptMonitor, runAutomatic } = require("../scripts/automatic-review.cjs");
const { readHunan } = require("../scripts/automatic-hunan.cjs");
const { acceptDocument, parseZhejiang } = require("../scripts/automatic-documents.cjs");
const { collectEvidence, GROUPS } = require("../scripts/cloud-evidence.cjs");
const { loadModules, adapterDigest } = require("../scripts/cloud-bundle.cjs");
const { counts } = require("../scripts/source-health.cjs");
const { extraDigest } = require("../scripts/cloud-extra.cjs");
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

async function failedHunanRelay(failure, announcement = false) {
  const initial = createSnapshot("hunan");
  initial.checkedAt = initial.regions.hunan.checkedAt = "2026-11-04";
  const latest = await collect("hunan");
  const sources = loadModules("sources").map(m => ({ id: m.id, ok: false, error: "unrelated offline source" }));
  const monitors = loadModules("monitors").map(m => m.id === "hunan" ?
    (announcement ? { id: m.id, ok: false, error: "FC announcement unavailable", failure } : { id: m.id, ok: true, latest }) :
    { id: m.id, ok: false, error: "unrelated offline monitor" });
  const now = new Date("2026-11-05T09:00:00.000Z");
  const bundle = { format: "besfuel-regions-v1", revision: "a".repeat(40), adapterDigest: adapterDigest(),
    startedAt: now.toISOString(), generatedAt: now.toISOString(), sources, monitors,
    counts: { sources: counts(sources), monitors: counts(monitors) },
    extra: { version: 1, digest: extraDigest(), results: [
      ...["hainan", "jiangxi"].map(id => ({ id, ok: false, error: "unrelated offline table" })),
      { id: "hunan", ok: false, error: "FC attachment unavailable", failure: announcement ? { category: "validation" } : failure }
    ] } };
  return { initial, bundle, now };
}

test("Hunan recovers the real failed FC header download from the same XLS on the publisher", async t => {
  const options = await failedHunanRelay({ category: "network", causes: [{ code: "HPE_INVALID_HEADER_TOKEN" }] });
  const before = structuredClone(options.initial), requested = [];
  const reader = () => ({ getBuffer: async url => { requested.push(url); return fixture.reader().getBuffer(url); } });
  const recoveryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "besfuel-hunan-recovery-"));
  t.after(() => fs.rmSync(recoveryDirectory, { recursive: true, force: true }));
  const result = await runAutomatic({ ...options, reader, recoveryDirectory });
  const hunan = result.monitors.find(m => m.id === "hunan");
  assert.equal(hunan.ok, true, hunan.error);
  assert.equal(hunan.transport, "GitHub");
  assert.equal(hunan.recovery.failure.causes[0].code, "HPE_INVALID_HEADER_TOKEN");
  assert.deepEqual(requested, [options.bundle.monitors.find(m => m.id === "hunan").latest.attachmentUrl]);
  assert.deepEqual(hunan.latest.prices, expected.hunan);
  assert.match(hunan.latest.attachmentSha256, /^[a-f0-9]{64}$/);
  assert.equal(hunan.recovery.evidenceFile, "hunan-recovery.xls");
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(recoveryDirectory, "hunan-recovery.xls"))).digest("hex"),
    hunan.latest.attachmentSha256);
  assert.equal(result.data.regions.hunan.checkedAt, "2026-11-05");
  assert.deepEqual(options.initial, before);
});

test("failed Hunan recovery retains trusted prices and original check date", async () => {
  const options = await failedHunanRelay({ category: "timeout" });
  let calls = 0;
  const result = await runAutomatic({ ...options, reader: () => ({ getBuffer: async () => {
    calls++; return { buffer: Buffer.from("not a workbook") };
  } }) });
  assert.equal(calls, 1);
  assert.deepEqual(result.data.regions.hunan, options.initial.regions.hunan);
  const hunan = result.monitors.find(m => m.id === "hunan");
  assert.equal(hunan.ok, false);
  assert.equal(hunan.recovery.attempted, true);
  assert.match(hunan.error, /不是 XLS/);
});

test("Hunan rediscovers and verifies the official announcement when FC cannot read the list", async t => {
  const options = await failedHunanRelay({ category: "network", causes: [{ code: "HPE_INVALID_HEADER_TOKEN" }] }, true);
  const recoveryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "besfuel-hunan-announcement-"));
  t.after(() => fs.rmSync(recoveryDirectory, { recursive: true, force: true }));
  const result = await runAutomatic({ ...options, reader: () => fixture.reader(), recoveryDirectory });
  const hunan = result.monitors.find(m => m.id === "hunan");
  assert.equal(hunan.ok, true, hunan.error);
  assert.equal(hunan.recovery.stage, "announcement");
  assert.equal(hunan.transport, "GitHub");
  assert.equal(hunan.error, undefined);
  assert.equal(hunan.failure, undefined);
  assert.deepEqual(hunan.latest.prices, expected.hunan);
  assert.equal(result.data.regions.hunan.checkedAt, "2026-11-05");
  assert.deepEqual(fs.readdirSync(recoveryDirectory).sort(), ["hunan-recovery-1.html", "hunan-recovery-2.html", "hunan-recovery.xls"]);
});

test("failed Hunan announcement recovery preserves the old check date and rejects foreign XLS", async () => {
  for (const reader of [() => ({ getText: async () => { throw Error("publisher offline"); } }),
    () => fixture.reader(text => text.replaceAll('5f49acd264d543ab8e876a64f31c0d93.xls', '../../other.xls'))]) {
    const options = await failedHunanRelay({ category: "timeout" }, true);
    const result = await runAutomatic({ ...options, reader });
    assert.equal(result.monitors.find(m => m.id === "hunan").ok, false);
    assert.deepEqual(result.data.regions.hunan, options.initial.regions.hunan);
  }
});

test("Hunan does not retry failed validation, TLS, access denial or rate limiting", async () => {
  for (const failure of [{ category: "validation" }, { category: "tls" }, { category: "http", status: 403 },
    { category: "http", status: 429 }, undefined]) {
    for (const announcement of [false, true]) {
      const options = await failedHunanRelay(failure, announcement);
      const forbidden = async () => assert.fail("must not retry");
      const result = await runAutomatic({ ...options, reader: () => ({ getBuffer: forbidden, getText: forbidden }) });
      assert.deepEqual(result.data.regions.hunan, options.initial.regions.hunan);
      assert.equal(result.monitors.find(m => m.id === "hunan").recovery, undefined);
    }
  }
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
