const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { validateFiles, validateSnapshot } = require("../scripts/validate-data.cjs");

const root = path.resolve(__dirname, "..");
const jsonPath = path.join(root, "data/prices.json");
const jsPath = path.join(root, "data/prices.js");
const clone = () => JSON.parse(fs.readFileSync(jsonPath, "utf8"));

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

test("forecast and adjustment need their own dated sources", () => {
  const snapshot = clone();
  snapshot.regions.guangdong.forecast.sourceUrl = "https://example.com/forecast";
  assert.throws(() => validateSnapshot(snapshot), /market source/);
  snapshot.regions.guangdong.forecast.sourceUrl = "https://www.tuanyou.net/yuanyou/bianhualv/814.html";
  snapshot.regions.guangdong.forecast.windowDate = "2026-10-29";
  assert.throws(() => validateSnapshot(snapshot), /forecast source and date/);
  snapshot.regions.guangdong.forecast.windowDate = "2026-10-15";
  snapshot.regions.guangdong.nextAdjustment.holidaySourceUrl = null;
  assert.throws(() => validateSnapshot(snapshot), /adjustment source/);
});
