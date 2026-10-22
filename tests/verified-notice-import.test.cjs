"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const snapshot = require("../data/prices.json");
const zhejiang = require("../data/verified/zhejiang.json");
const hunan = require("../data/verified/hunan.json");
const { importVerified } = require("../scripts/import-verified.cjs");
const { classifyMonitor } = require("../scripts/check-monitors.cjs");

test("a reviewed no-change notice advances evidence without adding a price date", () => {
  const base = structuredClone(snapshot);
  delete base.regions.zhejiang.latestNotice;
  base.regions.zhejiang.source.url = zhejiang.notices.at(-1).url;
  base.regions.zhejiang.checkedAt = "2026-09-29";
  const before = structuredClone(base);
  const next = importVerified(base, zhejiang);
  const region = next.regions.zhejiang;
  assert.deepEqual(base, before);
  assert.deepEqual(region.grades, before.regions.zhejiang.grades);
  assert.equal(region.effectiveLabel, "2026-09-24 24:00 起");
  assert.equal(region.source.url, zhejiang.latestNotice.sourceUrl);
  assert.equal(region.latestNotice.date, "2026-10-15");
  assert.equal(region.checkedAt, zhejiang.checkedAt);
  assert.equal(region.grades["92"].history.at(-1).sourceUrl, zhejiang.notices.at(-1).url);
  assert.deepEqual(importVerified(next, zhejiang), next);
  const monitor = require("../scripts/monitors/zhejiang.cjs");
  const latest = { url: region.source.url, kind: "unchanged", requiresManualLiterReview: true };
  assert.equal(classifyMonitor(monitor, latest, next).needsReview, false);
  assert.equal(classifyMonitor(monitor, { ...latest, url: latest.url.replace(/art_[a-f0-9]+/, "art_" + "f".repeat(32)) }, next).needsReview, true);
});

test("manual no-change imports reject a wrong base table, foreign URL and invalid chronology", () => {
  for (const patch of [
    { priceSourceUrl: zhejiang.notices[0].url },
    { sourceUrl: "https://example.com/unchanged" },
    { kind: "adjusted" },
    { title: "" },
    { date: "2026-02-30" },
    { date: "2026-10-24" },
    { date: "2026-09-20" },
  ]) {
    const record = structuredClone(zhejiang);
    Object.assign(record.latestNotice, patch);
    assert.throws(() => importVerified(snapshot, record), /unchanged notice|拒绝不调整公告回退/);
  }
});

test("official XLS evidence adds Hunan while unverified attachments cannot enter the snapshot", () => {
  const base = structuredClone(snapshot);
  delete base.regions.hunan;
  const next = importVerified(base, hunan);
  assert.equal(next.regions.hunan.grades["98"].price, null);
  assert.equal(next.regions.hunan.grades["92"].history.length, 4);
  assert.equal(next.regions.hunan.grades["92"].history.at(-1).date, "2026-09-25");
  assert.equal(classifyMonitor(require("../scripts/monitors/hunan.cjs"), {
    url: hunan.notices.at(-1).url, requiresManualLiterReview: true,
  }, next).needsReview, false);
  const invalid = structuredClone(hunan);
  invalid.notices.at(-1).attachmentUrl = "https://example.com/prices.xls";
  assert.throws(() => importVerified(base, invalid), /official attachmentUrl/);
  assert.equal(base.regions.hunan, undefined);
});
