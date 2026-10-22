"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { chinaDate, makeReader, updateAll, mergeRegion, officialUrl, validateNotices } = require("./update-regions.cjs");
const { checkMonitors, classifyMonitor, refreshMonitorDates } = require("./check-monitors.cjs");
const { validateSnapshot } = require("./validate-data.cjs");
const { counts } = require("./source-health.cjs");
const root = path.resolve(__dirname, "..");
const MAX_BYTES = 5_000_000;
const MAX_AGE_MS = 18 * 60 * 60 * 1000;

function loadModules(directory) {
  return fs.readdirSync(path.join(__dirname, directory)).filter(name => name.endsWith(".cjs")).sort()
    .map(name => require(path.join(__dirname, directory, name)));
}
function adapterDigest() {
  const files = ["update-regions.cjs", "check-monitors.cjs", "validate-data.cjs", "nmg-unchanged.cjs", "source-transport.cjs",
    ...["sources", "monitors"].flatMap(dir => fs.readdirSync(path.join(__dirname, dir)).filter(name => name.endsWith(".cjs")).map(name => `${dir}/${name}`))].sort();
  const hash = crypto.createHash("sha256");
  for (const file of files) hash.update(file + "\n" + fs.readFileSync(path.join(__dirname, file), "utf8").replace(/\r\n/g, "\n") + "\n");
  return hash.digest("hex");
}
function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function timestamp(value) {
  assert.ok(typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, "FC 时间戳无效");
  return Date.parse(value);
}
function validateResults(results, modules) {
  assert.ok(Array.isArray(results), "FC 结果必须是数组");
  assert.deepEqual(results.map(item => item.id).sort(), modules.map(item => item.id).sort(), "FC 来源清单缺失、重复或与当前代码不符");
  for (const result of results) {
    assert.equal(typeof result.ok, "boolean", `${result.id}: FC 状态无效`);
    if (!result.ok) assert.ok(typeof result.error === "string" && result.error.length > 0 && result.error.length <= 10000, `${result.id}: 缺少错误说明`);
  }
}
function validateLatest(latest, module, today) {
  assert.ok(latest && officialUrl(latest.url, module.allowedHostnames), `${module.id}: FC 非官方公告`);
  assert.ok(validDate(latest.publishedDate) && latest.publishedDate <= today, `${module.id}: FC 公告日期无效`);
  if (latest.effectiveDate) assert.ok(validDate(latest.effectiveDate) && latest.effectiveDate <= today, `${module.id}: FC 生效日期无效`);
  if (latest.prices) for (const grade of ["92", "95", "diesel"]) {
    const price = latest.prices[grade];
    assert.ok(Number.isFinite(price) && price >= 1 && price <= 30 && Math.abs(price * 100 - Math.round(price * 100)) < 1e-8,
      `${module.id}: FC 每升价无效`);
  }
  for (const name of ["requiresManualCoefficientReview", "requiresManualLiterReview", "requiresManualPriceReview"]) {
    if (latest[name] !== undefined) assert.equal(typeof latest[name], "boolean", `${module.id}: FC 复核状态无效`);
  }
}
function validateBundle(bundle, { now = new Date(), maxAgeMs = MAX_AGE_MS, sources = loadModules("sources"), monitors = loadModules("monitors") } = {}) {
  assert.equal(bundle?.format, "besfuel-regions-v1", "FC 快照格式不符");
  assert.equal(bundle.adapterDigest, adapterDigest(), "FC 采集代码与仓库校验规则不一致，请重新部署 FC 包");
  assert.match(bundle.revision, /^[0-9a-f]{40}$/, "FC 代码版本无效");
  const started = timestamp(bundle.startedAt), generated = timestamp(bundle.generatedAt);
  assert.ok(generated >= started && generated - started <= 16 * 60 * 1000, "FC 运行时间无效");
  assert.ok(generated <= now.getTime() + 5 * 60 * 1000 && now.getTime() - started <= maxAgeMs, "FC 快照已过期或时间超前");
  const today = chinaDate(new Date(started));
  validateResults(bundle.sources, sources);
  validateResults(bundle.monitors, monitors);
  for (const result of bundle.sources.filter(item => item.ok)) {
    const source = sources.find(item => item.id === result.id);
    validateNotices(source, result.notices, today);
    assert.equal(result.count, result.notices.length, `${result.id}: FC 公告数量不符`);
    if (result.latestNotice !== null && result.latestNotice !== undefined) {
      const notice = result.latestNotice;
      assert.ok(notice.kind === "unchanged" && validDate(notice.date) && notice.date <= today &&
        notice.date >= result.notices.at(-1).effectiveDate && typeof notice.title === "string" && notice.title.trim() &&
        officialUrl(notice.sourceUrl, source.allowedHostnames), `${result.id}: FC 不调整公告无效`);
    }
  }
  for (const result of bundle.monitors.filter(item => item.ok)) validateLatest(result.latest, monitors.find(item => item.id === result.id), today);
  assert.deepEqual(bundle.counts, { sources: counts(bundle.sources), monitors: counts(bundle.monitors) }, "FC 汇总与逐项结果不一致");
  return bundle;
}
function applyBundle(bundle, initial, options = {}) {
  const sources = options.sources || loadModules("sources"), monitors = options.monitors || loadModules("monitors");
  validateBundle(bundle, { ...options, sources, monitors });
  validateSnapshot(initial);
  let data = structuredClone(initial);
  const today = chinaDate(new Date(bundle.startedAt));
  const sourceResults = [];
  for (const result of bundle.sources) {
    if (result.ok) {
      const stored = data.regions[result.id];
      assert.ok(!stored || stored.checkedAt <= today, `${result.id}: FC 核对日期回退`);
      const notices = structuredClone(result.notices);
      if (result.latestNotice) notices.latestNotice = structuredClone(result.latestNotice);
      mergeRegion(data, sources.find(source => source.id === result.id), notices, today);
    }
    const { notices, latestNotice, ...summary } = result;
    sourceResults.push(summary);
  }
  const monitorResults = bundle.monitors.map(result => result.ok ?
    classifyMonitor(monitors.find(monitor => monitor.id === result.id), structuredClone(result.latest), data) : structuredClone(result));
  // Apply only evidence-backed changes to the current checkout. Never replace
  // the whole snapshot with the older baseline shipped inside the FC package.
  data = refreshMonitorDates(data, monitorResults, today).data;
  validateSnapshot(data);
  return { data, sources: sourceResults, monitors: monitorResults };
}
async function collectBundle({ initial, sources = loadModules("sources"), monitors = loadModules("monitors"), reader,
  revision, now = () => new Date() } = {}) {
  const startedAt = now().toISOString(), today = chinaDate(new Date(startedAt));
  const requests = [], cache = new Map();
  const sharedReader = reader || (hosts => makeReader(hosts, { cache, onRequest: item => requests.push(item) }));
  const seed = initial || JSON.parse(fs.readFileSync(path.join(root, "data/prices.json"), "utf8"));
  const updated = await updateAll({ initial: seed, sources, reader: sharedReader, today, includeNotices: true });
  const monitorResults = await checkMonitors({ data: updated.data, modules: monitors, reader: sharedReader, today });
  const bundle = { format: "besfuel-regions-v1", revision, adapterDigest: adapterDigest(), startedAt, generatedAt: now().toISOString(),
    runtime: { node: process.version, platform: process.platform }, sources: updated.results, monitors: monitorResults,
    counts: { sources: counts(updated.results), monitors: counts(monitorResults) }, requests };
  validateBundle(bundle, { sources, monitors, now: now() });
  return bundle;
}
module.exports = { MAX_BYTES, MAX_AGE_MS, loadModules, adapterDigest, validateBundle, applyBundle, collectBundle };
