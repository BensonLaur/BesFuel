"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { createSnapshot } = require("./helpers/snapshot.cjs");
const { checkMonitors } = require("../scripts/check-monitors.cjs");
const { importVerified } = require("../scripts/import-verified.cjs");
const { planAlerts, deliver } = require("../scripts/review-alerts.cjs");

const directory = path.join(__dirname, "fixtures/qinghai-20261029");
const manifest = require("./fixtures/qinghai-20261029/manifest.json");
const ids = ["qinghai-zone1", "qinghai-zone2"];
const monitors = ids.map(id => require(`../scripts/monitors/${id}.cjs`));
const supplements = ids.map(id => require(`../data/verified/${id}-20261029.json`));
const text = name => fs.readFileSync(path.join(directory, name), "utf8");
const bytes = name => fs.readFileSync(path.join(directory, name));
const current = manifest.files.find(file => file.name === "20261029.html").url;
const imageUrl = manifest.files.find(file => file.name === "20261029.png").url;
const today = "2026-10-31";
function reader(transform = value => value) {
  return {
    async getText(url) {
      const file = manifest.files.find(item => item.url === url);
      assert.ok(file, `Unexpected official URL: ${url}`);
      return transform(text(file.name), url);
    },
    async getBuffer(url) {
      const file = manifest.files.find(item => item.url === url);
      if (url === manifest.mirrorImage.url) return { buffer: bytes("20261029.png") };
      assert.ok(file, `Unexpected image URL: ${url}`);
      return { buffer: bytes(file.name) };
    }
  };
}
const collect = (monitor, input = reader(), day = today) => monitor.collect({ ...input, today: day });

test("Qinghai evidence preserves real response hashes and the two audited litre rows", () => {
  const hash = buffer => crypto.createHash("sha256").update(buffer).digest("hex");
  for (const file of manifest.files) assert.equal(hash(bytes(file.name)), file.fixtureSha256, file.name);
  assert.equal(hash(bytes("20261029.png")), manifest.mirrorImage.sha256);
  const expected = [{ "92": 8.85, "95": 9.48, diesel: 8.50 }, { "92": 8.94, "95": 9.58, diesel: 8.59 }];
  for (const [index, record] of supplements.entries()) {
    assert.equal(record.review.imageSha256, hash(bytes("20261029.png")));
    assert.equal(record.review.previousImageSha256, hash(bytes("20260924.JPG")));
    assert.deepEqual(record.notices.at(-1).prices, expected[index]);
    assert.equal(record.notices.at(-1).effectiveDate, "2026-10-30");
    assert.deepEqual(record.notices[0], require(`../data/verified/${record.id}.json`).notices.at(-1));
  }
});

test("real next-day CMS article and image stamps retain the October 29 business date", async () => {
  for (const monitor of monitors) {
    const result = await collect(monitor);
    assert.equal(result.url, current);
    assert.equal(result.imageUrl, imageUrl);
    assert.equal(result.publishedDate, "2026-10-29");
    assert.equal(result.effectiveDate, "2026-10-30");
    assert.equal(result.requiresManualPriceReview, true);
    assert.equal("prices" in result, false);
  }
});

test("an announcement is not applied before 24:00, and the price-column mirror remains discoverable", async () => {
  for (const monitor of monitors) {
    const result = await collect(monitor, reader(), "2026-10-29");
    assert.equal(result.publishedDate, "2026-09-24");
    assert.equal(result.effectiveDate, "2026-09-25");
  }
  const noticeList = manifest.files.find(file => file.name === "notice-list.html").url;
  const input = reader((html, url) => url === noticeList ? html.replace(/<li class="clearfix">\s*<a href="[^"]*t20261030_92962\.html"[\s\S]*?<\/li>/, "") : html);
  const result = await collect(monitors[1], input);
  assert.equal(result.url, manifest.files.find(file => file.name === "20261029-price.html").url);
  assert.equal(result.imageUrl, manifest.mirrorImage.url);
  assert.equal(result.effectiveDate, "2026-10-30");
});

test("relaxed CMS stamps still reject foreign hosts, malformed paths and unrelated image directories", async () => {
  for (const monitor of monitors) {
    for (const [from, to, pattern] of [
      [current, current.replace("fgw.qinghai.gov.cn/", "fgw.qinghai.gov.cn.evil.example/"), /不是预期/],
      [current, current.replace("fgw.qinghai.gov.cn/", "fgw.qinghai.gov.cn:8080/"), /不是预期/],
      [current, current + "?redirect=other", /不是预期/],
      ["t20261030_92962", "t20261032_92962", /文件日期无效/],
      ["t20261030_92962", "t20260930_92962", /目录与文件日期不符/],
      ["./W020261030518614379022.png", "http://evil.example/W020261030518614379022.png", /图片数量异常|不是预期/],
      ["./W020261030518614379022.png", "../202609/W020260930518614379022.png", /图片数量异常|公告目录/],
      ["W020261030518614379022.png", "W020261032518614379022.png", /图片文件日期无效/]
    ]) await assert.rejects(collect(monitor, reader(html => html.replaceAll(from, to))), pattern);
  }
  const input = reader();
  await assert.rejects(collect(monitors[1], { ...input, getBuffer: async () => ({ buffer: Buffer.alloc(6000) }) }), /图片内容异常/);
});

test("publication, source and execution dates remain independently checked against official text", async () => {
  for (const monitor of monitors) {
    for (const [from, to, pattern] of [
      ["发布时间：2026年10月29日", "发布时间：2026年10月30日", /发布日期与列表不符|标题、来源或日期异常/],
      ["价格处供稿", "匿名转载", /来源/],
      ["我省自2026年10月29日24时起", "我省自2026年10月30日24时起", /生效日|24 时执行时间/]
    ]) await assert.rejects(collect(monitor, reader((html, url) => url === current ? html.replaceAll(from, to) : html)), pattern, `${monitor.id}: ${from}`);
  }
});

test("new images remain gated until audited backfill, preserve history and cannot be rolled back", async () => {
  const initial = createSnapshot(...ids);
  const pending = await checkMonitors({ modules: monitors, data: initial, reader: () => reader(), today });
  assert.ok(pending.every(result => result.ok && result.needsReview));
  let data = structuredClone(initial);
  for (const record of supplements) {
    data = importVerified(data, record);
    for (const grade of ["92", "95", "diesel"]) {
      assert.deepEqual(data.regions[record.id].grades[grade].history.slice(0, -1), initial.regions[record.id].grades[grade].history);
      assert.equal(data.regions[record.id].grades[grade].price, record.notices.at(-1).prices[grade]);
    }
    const trusted = structuredClone(data);
    assert.throws(() => importVerified(data, require(`../data/verified/${record.id}.json`)), /可信价格旧/);
    assert.deepEqual(data, trusted);
  }
  const recovered = await checkMonitors({ modules: monitors, data, reader: () => reader(), today });
  assert.ok(recovered.every(result => result.ok && !result.needsReview));
  const previous = planAlerts({ version: 1, checkedAt: today, results: ids.map(id => ({ id, ok: false,
    error: "Original CMS date validation failure", failure: { category: "validation" } })) }, undefined, "failed").state;
  const report = { version: 1, checkedAt: today, results: recovered };
  const plan = planAlerts(report, previous, "recovered");
  assert.deepEqual(plan.summary.resolved.map(item => item.id).sort(), ids);
  assert.equal(plan.summary.active.length, 0);
  const repeated = planAlerts(report, plan.state, "next-run");
  assert.equal(repeated.summary.changed, false);
  let requests = 0;
  await deliver(repeated, { fetcher: async () => { requests++; throw new Error("Unexpected notification"); } });
  assert.equal(requests, 0);
});
