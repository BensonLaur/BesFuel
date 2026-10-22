"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { applyBundle, MAX_BYTES } = require("./cloud-bundle.cjs");
const { mergeRegion, chinaDate, writeSnapshot } = require("./update-regions.cjs");
const { validateSnapshot } = require("./validate-data.cjs");
const { failureResult } = require("./source-errors.cjs");
const { reportHealth } = require("./source-health.cjs");
const { collectTable } = require("./automatic-tables.cjs");
const { publishingReader } = require("./publish-reader.cjs");
const { readHunan } = require("./automatic-hunan.cjs");
const { validateExtras } = require("./cloud-extra.cjs");
const root = path.resolve(__dirname, "..");

// Only these audited adapters already enforce the retail/litre column and all
// three grades. Presence of arbitrary prices in a monitor is not authorization.
const AUTOMATIC_MONITORS = Object.freeze(["anhui", "chongqing", "henan", "ningxia",
  "shandong", "xinjiang-dushanzi", "xinjiang-karamay-main"]);
function recordFor(id) {
  return JSON.parse(fs.readFileSync(path.join(root, "data/verified", `${id}.json`), "utf8"));
}
function acceptMonitor(data, result, today) {
  assert.ok(result.ok && AUTOMATIC_MONITORS.includes(result.id), "公告未通过自动核价适配器");
  const latest = result.latest, record = recordFor(result.id), old = data.regions[result.id];
  assert.ok(old && latest.prices && latest.effectiveDate && !latest.kind &&
    !latest.requiresManualCoefficientReview && !latest.requiresManualLiterReview, "缺少可自动核验的完整升价");
  assert.ok(old.checkedAt <= today, "拒绝核对日期回退");
  // A long outage can conceal intervening adjustments. Keep history honest
  // until the missing notices are backfilled instead of drawing a false step.
  assert.ok(Date.parse(latest.publishedDate) - Date.parse(old.checkedAt) <= 3 * 86400000, "公告检查中断，需补齐期间历史");
  const next = structuredClone(data);
  mergeRegion(next, record, [latest], today);
  return next;
}
function acceptParsedMonitors(bundle, initial, options = {}) {
  const replay = applyBundle(bundle, initial, options);
  const today = chinaDate(new Date(bundle.startedAt));
  let data = replay.data;
  const results = replay.monitors.map(result => {
    if (!result.ok || !AUTOMATIC_MONITORS.includes(result.id)) return result;
    try {
      data = acceptMonitor(data, result, today);
      return { ...result, needsReview: false, automatic: true };
    } catch (error) { return failureResult(result.id, error); }
  });
  return { data, sources: replay.sources, monitors: results };
}
async function runAutomatic({ bundle, initial, today = chinaDate(), reader = publishingReader } = {}) {
  const replay = bundle ? acceptParsedMonitors(bundle, initial) : { data: structuredClone(initial), sources: [], monitors: [] };
  const extra = bundle ? validateExtras(bundle) : null;
  let data = replay.data;
  const direct = [];
  const hunan = replay.monitors.find(item => item.id === "hunan");
  if (hunan?.ok) {
    try {
      const record = recordFor("hunan"), relay = extra?.get("hunan");
      if (relay && !relay.ok) throw Object.assign(new Error(relay.error), { details: relay.failure });
      const attachmentReader = relay ? { getBuffer: async url => {
        assert.equal(url, relay.url, "湖南附件请求与证据不符");
        return { buffer: Buffer.from(relay.base64, "base64") };
      } } : reader(record.allowedHostnames);
      const latest = await readHunan(hunan.latest, attachmentReader);
      assert.ok(initial.regions.hunan.checkedAt <= chinaDate(new Date(bundle.startedAt)), "湖南核对日期回退");
      assert.ok(Date.parse(latest.publishedDate) - Date.parse(data.regions.hunan.checkedAt) <= 3 * 86400000, "湖南公告检查中断，需补齐历史");
      const next = structuredClone(data);
      mergeRegion(next, record, [latest], chinaDate(new Date(bundle.startedAt)));
      data = next;
      Object.assign(hunan, { latest, needsReview: false, automatic: true });
    } catch (error) {
      data.regions.hunan = structuredClone(initial.regions.hunan);
      Object.assign(hunan, failureResult("hunan", error));
    }
  }
  for (const id of ["hainan", "jiangxi"]) {
    try {
      const record = recordFor(id), relay = extra?.get(id);
      if (relay && !relay.ok) throw Object.assign(new Error(relay.error), { details: relay.failure });
      const notices = relay ? relay.notices : await collectTable(record, reader(record.allowedHostnames), today);
      const checkedAt = relay ? chinaDate(new Date(bundle.startedAt)) : today;
      assert.ok(data.regions[id]?.checkedAt <= checkedAt, "拒绝核对日期回退");
      const history = data.regions[id].grades["92"].history;
      assert.ok(notices.some(notice => history.some(point => point.date === notice.effectiveDate)), "官网近期列表与已核历史无交集，需补齐历史");
      const next = structuredClone(data);
      mergeRegion(next, record, notices, checkedAt);
      data = next;
      direct.push({ id, ok: true, automatic: true, transport: relay ? "FC" : "GitHub", count: notices.length, latest: notices.at(-1) });
    } catch (error) { direct.push(failureResult(id, error)); }
  }
  validateSnapshot(data);
  return { ...replay, data, direct };
}
async function main() {
  const file = process.argv[2];
  let bundle;
  if (file) {
    assert.ok(fs.statSync(file).size <= MAX_BYTES, "FC 快照超出大小上限");
    bundle = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  const initial = JSON.parse(fs.readFileSync(path.join(root, "data/prices.json"), "utf8"));
  const result = await runAutomatic({ bundle, initial });
  writeSnapshot(result.data);
  if (bundle) console.log(`采用 FC 地区快照：${bundle.generatedAt}；采集代码：${bundle.revision}`);
  reportHealth("FC 地区自动采集", result.sources);
  reportHealth("自动核价后的 FC 公告检查", result.monitors);
  reportHealth("海南、江西官方价表自动采集", result.direct);
  const reportFile = process.env.BESFUEL_REVIEW_REPORT || path.join(root, ".automatic-review.json");
  fs.writeFileSync(reportFile, JSON.stringify({ version: 1, checkedAt: chinaDate(),
    results: [...result.sources, ...result.monitors, ...result.direct] }, null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { AUTOMATIC_MONITORS, acceptMonitor, acceptParsedMonitors, runAutomatic };
