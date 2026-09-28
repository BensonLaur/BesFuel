const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const officialNotice = /^https:\/\/drc\.gd\.gov\.cn\/ywgg\/content\/post_\d+\.html$/;

function officialHosts(key) {
  if (key === "guangdong") return ["drc.gd.gov.cn"];
  const sourceFile = path.join(__dirname, "sources", `${key}.cjs`);
  if (fs.existsSync(sourceFile)) {
    const source = require(sourceFile);
    return source.id === key ? source.allowedHostnames : [];
  }
  const verifiedFile = path.join(root, "data", "verified", `${key}.json`);
  if (fs.existsSync(verifiedFile)) {
    const verified = JSON.parse(fs.readFileSync(verifiedFile, "utf8"));
    return verified.id === key ? verified.allowedHostnames : [];
  }
  return [];
}

function isOfficialUrl(value, hosts) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && hosts.includes(url.hostname) &&
      !url.username && !url.password;
  } catch (_) {
    return false;
  }
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateSnapshot(data, hostOverrides = {}) {
  assert.equal(data.version, 2, "snapshot version");
  assert.ok(validDate(data.checkedAt), "snapshot checkedAt");
  const national = data.nationalAdjustment;
  assert.ok(national && typeof national === "object", "national adjustment");
  if (national.nextAdjustment?.date || national.nextAdjustment?.dateLabel) {
    const next = national.nextAdjustment;
    assert.ok(validDate(next.date) && next.dateLabel === `预计 ${next.date} 24:00`, "national adjustment date");
    assert.ok(next.sourceName &&
      next.sourceUrl === "https://www.ndrc.gov.cn/xxgk/zcfb/tz/201601/W020190905506573420251.pdf" &&
      next.holidaySourceUrl === "https://www.beijing.gov.cn/cs/gncs/zcwj/202603/t20260327_4568275.html",
    "national adjustment sources");
  }
  if (national.forecast?.description) {
    const forecast = national.forecast;
    assert.ok(forecast.sourceName && validDate(forecast.updatedAt) &&
      forecast.updatedAt <= data.checkedAt && forecast.windowDate === national.nextAdjustment?.date &&
      /^https:\/\/www\.tuanyou\.net\/yuanyou\/bianhualv\/\d+\.html$/.test(forecast.sourceUrl),
    "national forecast source and date");
    assert.ok(["up", "down"].includes(forecast.direction) && Number.isFinite(forecast.amountPerLiter) &&
      forecast.amountPerLiter > 0 && forecast.amountPerLiter <= 5 && Number.isInteger(forecast.workday) &&
      forecast.workday >= 1 && forecast.workday <= 10 &&
      forecast.description === `预计${forecast.direction === "up" ? "上调" : "下调"}约 ${forecast.amountPerLiter.toFixed(2)} 元/升`,
    "national forecast values");
  }
  assert.ok(data.regions && typeof data.regions === "object" && Object.keys(data.regions).length, "regions");
  for (const [key, region] of Object.entries(data.regions)) {
    const hosts = hostOverrides[key] || officialHosts(key);
    assert.ok(Array.isArray(hosts) && hosts.length, `${key}: official host list`);
    assert.ok(!Object.hasOwn(region, "nextAdjustment") && !Object.hasOwn(region, "forecast"), `${key}: shared adjustment must not be duplicated`);
    assert.ok(region.name && region.priceScope && region.effectiveLabel, `${key}: label and scope`);
    assert.ok(validDate(region.checkedAt), `${key}: checkedAt`);
    assert.ok(region.checkedAt <= data.checkedAt, `${key}: region checkedAt cannot exceed snapshot date`);
    if (region.priceValidThrough) assert.ok(validDate(region.priceValidThrough), `${key}: price validity`);
    if (region.conversionSource) {
      assert.ok(region.priceValidThrough === region.conversionSource.validThrough &&
        isOfficialUrl(region.conversionSource.url, hosts) &&
        (!region.conversionSource.ruleUrl || isOfficialUrl(region.conversionSource.ruleUrl, hosts)),
      `${key}: official conversion source`);
    }
    assert.ok(region.source?.name && isOfficialUrl(region.source.url, hosts), `${key}: current official source`);
    assert.ok(region.grades && typeof region.grades === "object", `${key}: grades`);
    for (const grade of ["92", "95", "98", "diesel"]) {
      const entry = region.grades[grade];
      assert.ok(entry && Array.isArray(entry.history), `${key}/${grade}: entry and history`);
      assert.ok(entry.price === null || (Number.isFinite(entry.price) && entry.price >= 1 && entry.price <= 30), `${key}/${grade}: price range`);
      let previous = "";
      for (const point of entry.history) {
        assert.ok(validDate(point.date) && point.date > previous, `${key}/${grade}: ordered unique dates`);
        assert.ok(Number.isFinite(point.price) && point.price >= 1 && point.price <= 30, `${key}/${grade}: historical price`);
        assert.ok(isOfficialUrl(point.sourceUrl, hosts), `${key}/${grade}: official historical source`);
        if (key === "guangdong") assert.match(point.sourceUrl, officialNotice, `${key}/${grade}: official history`);
        previous = point.date;
      }
      if (entry.price !== null) {
        assert.ok(entry.history.length, `${key}/${grade}: priced grade needs history`);
        assert.equal(entry.price, entry.history.at(-1).price, `${key}/${grade}: latest history price`);
        if (region.priceValidThrough) {
          assert.ok(entry.history.at(-1).date <= region.priceValidThrough, `${key}/${grade}: price validity`);
        }
      }
    }
    if (region.historyGaps !== undefined) {
      assert.ok(Array.isArray(region.historyGaps), `${key}: history gaps`);
      const first = region.grades["92"].history[0]?.date;
      const last = region.grades["92"].history.at(-1)?.date;
      let previous = "";
      for (const gap of region.historyGaps) {
        assert.ok(validDate(gap.date) && gap.date > previous &&
          gap.date > first && gap.date < last &&
          isOfficialUrl(gap.sourceUrl, hosts) &&
          typeof gap.reason === "string" && gap.reason.trim(),
        `${key}: audited history gap`);
        for (const grade of ["92", "95", "diesel"]) {
          assert.ok(!region.grades[grade].history.some(point => point.date === gap.date),
            `${key}/${grade}: gap cannot also be a price point`);
        }
        previous = gap.date;
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
