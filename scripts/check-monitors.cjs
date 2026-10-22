const fs = require("node:fs");
const path = require("node:path");
const { chinaDate, makeReaderFactory, officialUrl, writeSnapshot } = require("./update-regions.cjs");
const { failureResult } = require("./source-errors.cjs");
const { reportHealth } = require("./source-health.cjs");

const root = path.resolve(__dirname, "..");
const monitorDirectory = path.join(__dirname, "monitors");

async function checkMonitors({ modules, data, reader = makeReaderFactory() } = {}) {
  const monitors = modules || (fs.existsSync(monitorDirectory) ?
    fs.readdirSync(monitorDirectory).filter(name => name.endsWith(".cjs")).sort()
      .map(name => require(path.join(monitorDirectory, name))) : []);
  const snapshot = data || JSON.parse(fs.readFileSync(path.join(root, "data", "prices.json"), "utf8"));
  const results = [];
  for (const monitor of monitors) {
    try {
      const latest = await monitor.collect({ ...reader(monitor.allowedHostnames), today: chinaDate() });
      if (!officialUrl(latest?.url, monitor.allowedHostnames)) {
        throw new Error("监测器返回了非官方公告地址");
      }
      const stored = snapshot.regions[monitor.id];
      // A government page can be corrected in place without changing its URL.
      const priceChanged = Boolean(stored && latest.prices &&
        ["92", "95", "diesel"].some(grade =>
          latest.prices[grade] !== stored.grades?.[grade]?.price));
      const needsReview = !stored || stored.source.url !== latest.url ||
        latest.requiresManualCoefficientReview === true || priceChanged;
      results.push({ id: monitor.id, ok: true, latest, stored: Boolean(stored), needsReview });
    } catch (error) {
      results.push(failureResult(monitor.id, error));
    }
  }
  return results;
}

function refreshMonitorDates(data, results, today) {
  const updated = structuredClone(data);
  let count = 0;
  for (const result of results) {
    const region = updated.regions[result.id];
    if (!result.ok || result.needsReview || !region || region.checkedAt >= today) continue;
    // Same official notice plus a valid conversion season is enough to recheck the current snapshot.
    region.checkedAt = today;
    count += 1;
  }
  if (count && updated.checkedAt < today) updated.checkedAt = today;
  return { data: updated, count };
}

if (require.main === module) {
  const data = JSON.parse(fs.readFileSync(path.join(root, "data", "prices.json"), "utf8"));
  checkMonitors({ data }).then(results => {
    const refreshed = refreshMonitorDates(data, results, chinaDate());
    if (refreshed.count) writeSnapshot(refreshed.data);
    for (const result of results) {
      if (!result.ok) console.warn(`${result.id}: 公告监测失败；${result.error}`);
      else if (result.needsReview) console.warn(result.latest.requiresManualCoefficientReview ?
        `${result.id}: 折算系数适用期已结束，需人工复核：${result.latest.coefficientNoticeUrl}` :
        result.latest.requiresManualLiterReview && !result.stored ?
          `${result.id}: 官方每升价仍待人工核实：${result.latest.url}` :
          `${result.id}: 新公告需人工核价：${result.latest.url}`);
      else console.log(`${result.id}: 最新公告与人工核价快照一致`);
    }
    reportHealth("人工核价地区公告监测", results);
  }).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { checkMonitors, refreshMonitorDates };
