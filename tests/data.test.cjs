const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { validateFiles, validateSnapshot } = require("../scripts/validate-data.cjs");

const root = path.resolve(__dirname, "..");
const jsonPath = path.join(root, "data/prices.json");
const jsPath = path.join(root, "data/prices.js");
const clone = () => JSON.parse(fs.readFileSync(jsonPath, "utf8"));

function snapshotWithForecast() {
  const snapshot = clone();
  const window = new Date(`${snapshot.checkedAt}T00:00:00Z`);
  window.setUTCDate(window.getUTCDate() + 14);
  const windowDate = window.toISOString().slice(0, 10);
  // Build a complete national fixture: the live snapshot may have no forecast after a cycle change.
  snapshot.nationalAdjustment = {
    nextAdjustment: {
      date: windowDate,
      dateLabel: `预计 ${windowDate} 24:00`,
      sourceName: "国家发展改革委调价规则与国务院放假安排",
      sourceUrl: "https://www.ndrc.gov.cn/xxgk/zcfb/tz/201601/W020190905506573420251.pdf",
      holidaySourceUrl: "https://www.beijing.gov.cn/cs/gncs/zcwj/202603/t20260327_4568275.html"
    },
    forecast: {
      direction: "down",
      amountPerLiter: 0.18,
      description: "预计下调约 0.18 元/升",
      sourceName: "团友网",
      sourceUrl: "https://www.tuanyou.net/yuanyou/bianhualv/814.html",
      updatedAt: snapshot.checkedAt,
      windowDate,
      workday: 1
    }
  };
  return snapshot;
}

test("published JSON and offline fallback agree on the official snapshot", () => {
  const snapshot = validateFiles(jsonPath, jsPath);
  assert.equal(snapshot.regions.guangdong.grades["98"].price, null);
});

test("rejects a price that disagrees with its latest official history", () => {
  const snapshot = clone();
  snapshot.regions.guangdong.grades["92"].price += 1;
  assert.throws(() => validateSnapshot(snapshot), /latest history price/);
});

test("rejects missing official provenance and duplicate historical dates", () => {
  const missingSource = clone();
  missingSource.regions.guangdong.source.url = "https://example.com/notice";
  assert.throws(() => validateSnapshot(missingSource), /current official source/);
  const duplicate = clone();
  const history = duplicate.regions.guangdong.grades["95"].history;
  history.splice(1, 0, { ...history[0] });
  assert.throws(() => validateSnapshot(duplicate), /ordered unique dates/);
});

test("other regions also require their own official host for current and historical prices", () => {
  const current = clone();
  current.regions.hebei.source.url = "https://example.com/notice";
  assert.throws(() => validateSnapshot(current), /hebei: current official source/);
  const history = clone();
  history.regions.hebei.grades["92"].history[0].sourceUrl = "https://example.com/notice";
  assert.throws(() => validateSnapshot(history), /hebei\/92: official historical source/);
});

test("accepts a sourced forecast for the current adjustment window", () => {
  assert.doesNotThrow(() => validateSnapshot(snapshotWithForecast()));
});

test("accepts an empty forecast after a cycle change or unavailable market estimate", () => {
  for (const forecast of [
    {},
    {
      direction: null, amountPerLiter: null, description: null, sourceName: null,
      sourceUrl: null, updatedAt: null, windowDate: null, workday: null
    }
  ]) {
    const snapshot = snapshotWithForecast();
    snapshot.nationalAdjustment.forecast = forecast;
    assert.doesNotThrow(() => validateSnapshot(snapshot));
  }
});

test("rejects a forecast with an invalid source, date or adjustment window", () => {
  const mutations = [
    forecast => { forecast.sourceUrl = "https://example.com/forecast"; },
    forecast => { forecast.sourceName = null; },
    forecast => { forecast.updatedAt = null; },
    forecast => { forecast.updatedAt = "invalid"; },
    (forecast, snapshot) => { forecast.updatedAt = snapshot.nationalAdjustment.nextAdjustment.date; },
    forecast => { forecast.windowDate = forecast.updatedAt; }
  ];
  for (const mutate of mutations) {
    const snapshot = snapshotWithForecast();
    mutate(snapshot.nationalAdjustment.forecast, snapshot);
    assert.throws(() => validateSnapshot(snapshot), /national forecast source and date/);
  }
});

test("adjustment rules need their own sources even without a forecast", () => {
  for (const hasForecast of [true, false]) {
    const snapshot = snapshotWithForecast();
    if (!hasForecast) snapshot.nationalAdjustment.forecast = {};
    snapshot.nationalAdjustment.nextAdjustment.holidaySourceUrl = null;
    assert.throws(() => validateSnapshot(snapshot), /national adjustment sources/);
  }
});

test("rejects national adjustment data duplicated in a region", () => {
  const snapshot = snapshotWithForecast();
  snapshot.regions.guangdong.forecast = snapshot.nationalAdjustment.forecast;
  assert.throws(() => validateSnapshot(snapshot), /shared adjustment must not be duplicated/);
});
