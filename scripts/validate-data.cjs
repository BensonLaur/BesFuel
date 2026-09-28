const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const officialNotice = /^https:\/\/drc\.gd\.gov\.cn\/ywgg\/content\/post_\d+\.html$/;

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateSnapshot(data) {
  assert.equal(data.version, 1, "snapshot version");
  assert.ok(validDate(data.checkedAt), "snapshot checkedAt");
  assert.ok(data.regions && typeof data.regions === "object" && Object.keys(data.regions).length, "regions");
  for (const [key, region] of Object.entries(data.regions)) {
    assert.ok(region.name && region.priceScope && region.effectiveLabel, `${key}: label and scope`);
    assert.ok(validDate(region.checkedAt), `${key}: checkedAt`);
    assert.ok(region.checkedAt <= data.checkedAt, `${key}: region checkedAt cannot exceed snapshot date`);
    assert.ok(region.source?.name && /^https:\/\//.test(region.source.url), `${key}: source`);
    assert.ok(region.grades && typeof region.grades === "object", `${key}: grades`);
    for (const grade of ["92", "95", "98", "diesel"]) {
      const entry = region.grades[grade];
      assert.ok(entry && Array.isArray(entry.history), `${key}/${grade}: entry and history`);
      assert.ok(entry.price === null || (Number.isFinite(entry.price) && entry.price >= 1 && entry.price <= 30), `${key}/${grade}: price range`);
      let previous = "";
      for (const point of entry.history) {
        assert.ok(validDate(point.date) && point.date > previous, `${key}/${grade}: ordered unique dates`);
        assert.ok(Number.isFinite(point.price) && point.price >= 1 && point.price <= 30, `${key}/${grade}: historical price`);
        assert.ok(/^https:\/\//.test(point.sourceUrl), `${key}/${grade}: historical source`);
        if (key === "guangdong") assert.match(point.sourceUrl, officialNotice, `${key}/${grade}: official history`);
        previous = point.date;
      }
      if (entry.price !== null) {
        assert.ok(entry.history.length, `${key}/${grade}: priced grade needs history`);
        assert.equal(entry.price, entry.history.at(-1).price, `${key}/${grade}: latest history price`);
      }
    }
    if (region.nextAdjustment?.date || region.nextAdjustment?.dateLabel) {
      const next = region.nextAdjustment;
      assert.ok(validDate(next.date) && next.dateLabel === `预计 ${next.date} 24:00`, `${key}: adjustment date`);
      assert.ok(next.sourceName && /^https:\/\//.test(next.sourceUrl) && /^https:\/\//.test(next.holidaySourceUrl), `${key}: adjustment source`);
      if (key === "guangdong") {
        assert.equal(next.sourceUrl, "https://www.ndrc.gov.cn/xxgk/zcfb/tz/201601/W020190905506573420251.pdf", "Guangdong adjustment rule source");
        assert.equal(next.holidaySourceUrl, "https://www.beijing.gov.cn/cs/gncs/zcwj/202603/t20260327_4568275.html", "Guangdong holiday source");
      }
    }
    if (region.forecast?.description) {
      const forecast = region.forecast;
      assert.ok(forecast.sourceName && /^https:\/\//.test(forecast.sourceUrl) && validDate(forecast.updatedAt) &&
        forecast.updatedAt <= data.checkedAt && forecast.windowDate === region.nextAdjustment?.date,
      `${key}: forecast source and date`);
      assert.ok(["up", "down"].includes(forecast.direction) && Number.isFinite(forecast.amountPerLiter) &&
        forecast.amountPerLiter > 0 && forecast.amountPerLiter <= 5 && Number.isInteger(forecast.workday) &&
        forecast.workday >= 1 && forecast.workday <= 10 &&
        forecast.description === `预计${forecast.direction === "up" ? "上调" : "下调"}约 ${forecast.amountPerLiter.toFixed(2)} 元/升`,
      `${key}: forecast values`);
      if (key === "guangdong") {
        assert.match(forecast.sourceUrl, /^https:\/\/www\.tuanyou\.net\/yuanyou\/bianhualv\/\d+\.html$/, "Guangdong market source");
      }
    }
    if (key === "guangdong") {
      assert.equal(region.name, "广东", "Guangdong display name");
      assert.match(region.source.url, officialNotice, "Guangdong current official source");
      const latest = region.grades["92"].history.at(-1);
      for (const grade of ["92", "95", "diesel"]) {
        const point = region.grades[grade].history.at(-1);
        assert.equal(point.date, latest.date, `Guangdong ${grade}: effective date`);
        assert.equal(point.sourceUrl, region.source.url, `Guangdong ${grade}: current source`);
      }
      assert.equal(region.grades["98"].price, null, "Guangdong 98 stays unverified");
    }
  }
  return data;
}

function validateFiles(jsonPath, scriptPath) {
  const data = validateSnapshot(JSON.parse(fs.readFileSync(jsonPath, "utf8")));
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(scriptPath, "utf8"), sandbox, { timeout: 1000 });
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.window.BESFUEL_DATA)), data, "browser fallback matches JSON");
  return data;
}

if (require.main === module) {
  try {
    validateFiles(process.argv[2] || path.join(root, "data/prices.json"), process.argv[3] || path.join(root, "data/prices.js"));
    console.log("Price snapshot and browser fallback validated.");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { validateSnapshot, validateFiles };
