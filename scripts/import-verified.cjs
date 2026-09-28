const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { mergeRegion, officialUrl, writeSnapshot } = require("./update-regions.cjs");
const { validateSnapshot } = require("./validate-data.cjs");

const root = path.resolve(__dirname, "..");

function importVerified(data, record) {
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(record.checkedAt), `${record.id}: checkedAt`);
  assert.ok(!record.unit || record.unit === "元/升", `${record.id}: 仅元/升核价记录可进入页面`);
  if (record.conversion) {
    const factor = record.conversion;
    assert.ok(officialUrl(factor.url, record.allowedHostnames) &&
      (!factor.ruleUrl || officialUrl(factor.ruleUrl, record.allowedHostnames)) &&
      /^\d{4}-\d{2}-\d{2}$/.test(factor.validFrom) &&
      /^\d{4}-\d{2}-\d{2}$/.test(factor.validThrough) &&
      factor.validFrom <= factor.validThrough, `${record.id}: official conversion rule`);
    for (const notice of record.notices || []) {
      assert.ok(notice.effectiveDate >= factor.validFrom && notice.effectiveDate <= factor.validThrough,
        `${record.id}: conversion season`);
      for (const grade of ["92", "95", "diesel"]) {
        const tonnes = notice.tonPrices?.[grade];
        const liters = factor.litersPerTon?.[grade];
        assert.ok(Number.isFinite(tonnes) && tonnes > 1000 &&
          Number.isFinite(liters) && liters > 1000 && liters < 1500 &&
          notice.prices?.[grade] === Math.round(tonnes * 100 / liters) / 100,
        `${record.id}/${grade}: official tonne-to-litre conversion`);
      }
    }
  }
  for (const notice of record.notices || []) {
    for (const field of ["imageUrl", "dieselImageUrl", "pdfUrl"]) {
      if (notice[field]) {
        assert.ok(officialUrl(notice[field], record.allowedHostnames), `${record.id}: official ${field}`);
      }
    }
  }
  const copy = structuredClone(data);
  mergeRegion(copy, record, record.notices, record.checkedAt);
  if (record.historyGaps) {
    assert.ok(Array.isArray(record.historyGaps), `${record.id}: historyGaps`);
    copy.regions[record.id].historyGaps = record.historyGaps.map(gap => {
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(gap.publishedDate) &&
        officialUrl(gap.url, record.allowedHostnames) &&
        typeof gap.reason === "string" && gap.reason.trim(),
      `${record.id}: audited history gap`);
      const day = new Date(`${gap.publishedDate}T00:00:00Z`);
      assert.ok(!Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === gap.publishedDate,
        `${record.id}: history gap date`);
      day.setUTCDate(day.getUTCDate() + 1);
      return { date: day.toISOString().slice(0, 10), sourceUrl: gap.url, reason: gap.reason };
    });
  }
  return validateSnapshot(copy);
}

if (require.main === module) {
  try {
    const names = process.argv.slice(2);
    if (!names.length) throw new Error("Usage: node scripts/import-verified.cjs <record.json> [...]");
    let data = JSON.parse(fs.readFileSync(path.join(root, "data", "prices.json"), "utf8"));
    for (const name of names) {
      const file = path.resolve(name);
      if (!file.startsWith(path.join(root, "data", "verified") + path.sep)) {
        throw new Error(`人工核验文件必须位于 data/verified：${name}`);
      }
      data = importVerified(data, JSON.parse(fs.readFileSync(file, "utf8")));
    }
    writeSnapshot(data);
    console.log(`已导入 ${names.length} 组人工核验官方价格。`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { importVerified };
