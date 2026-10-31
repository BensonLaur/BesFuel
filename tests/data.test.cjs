const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { validateFiles, validateSnapshot } = require("../scripts/validate-data.cjs");

const root = path.resolve(__dirname, "..");
const jsonPath = path.join(root, "data/prices.json");
const jsPath = path.join(root, "data/prices.js");
const { createSnapshot } = require("./helpers/snapshot.cjs");
const clone = () => createSnapshot("hebei");

function snapshotWithForecast() {
  const snapshot = clone();
  const window = new Date(`${snapshot.checkedAt}T00:00:00Z`);
  window.setUTCDate(window.getUTCDate() + 14);
  const windowDate = window.toISOString().slice(0, 10);
  // Keep source/date validation independent of the published adjustment cycle.
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

function snapshotWithNotice(kind = "unchanged") {
  const snapshot = clone();
  const region = snapshot.regions.guangdong;
  const published = new Date(`${region.grades["92"].history.at(-1).date}T00:00:00Z`);
  published.setUTCDate(published.getUTCDate() - 1);
  region.latestNotice = {
    date: kind === "unchanged" ? region.checkedAt : published.toISOString().slice(0, 10),
    kind,
    title: kind === "unchanged" ? "成品油价格不作调整" : "成品油价格调整",
    sourceUrl: kind === "unchanged" ? "https://drc.gd.gov.cn/ywgg/content/post_9999999.html" : region.source.url
  };
  return snapshot;
}

test("latest official notice is optional and separate from the price's effective date", () => {
  const legacy = clone();
  delete legacy.regions.guangdong.latestNotice;
  assert.doesNotThrow(() => validateSnapshot(legacy));
  for (const kind of ["adjusted", "unchanged"]) {
    assert.doesNotThrow(() => validateSnapshot(snapshotWithNotice(kind)));
  }
});

test("rejects unverified notice sources, missing titles and invalid or future dates", () => {
  for (const patch of [
    { sourceUrl: "https://example.com/notice" }, { sourceUrl: "https://drc.gd.gov.cn/other" },
    { title: "" }, { kind: "unknown" }, { date: "invalid" }, { date: "9999-12-31" }
  ]) {
    const snapshot = snapshotWithNotice();
    Object.assign(snapshot.regions.guangdong.latestNotice, patch);
    assert.throws(() => validateSnapshot(snapshot), /latest official notice|latest notice source/);
  }
});

test("rejects notices that contradict the trusted price source or chronology", () => {
  const adjusted = snapshotWithNotice("adjusted");
  adjusted.regions.guangdong.latestNotice.sourceUrl = "https://drc.gd.gov.cn/ywgg/content/post_9999999.html";
  assert.throws(() => validateSnapshot(adjusted), /adjusted notice matches price source/);
  for (const kind of ["adjusted", "unchanged"]) {
    const snapshot = snapshotWithNotice(kind);
    snapshot.regions.guangdong.latestNotice.date = "2000-01-01";
    assert.throws(() => validateSnapshot(snapshot), /notice and price chronology/);
  }
});
