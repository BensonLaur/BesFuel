const assert = require("node:assert/strict");
const test = require("node:test");
const { buildHistory } = require("../lib/history.js");

function regionFixture() {
  return {
    checkedAt: "2026-10-16",
    latestNotice: {
      date: "2026-10-15", kind: "unchanged",
      sourceUrl: "https://drc.gd.gov.cn/ywgg/content/post_4967003.html"
    },
    grades: {
      "92": { price: 8.63, history: [
        { date: "2026-09-12", price: 8.31, sourceUrl: "older-price" },
        { date: "2026-09-25", price: 8.63, sourceUrl: "current-price" }
      ] },
      "98": { price: null, history: [] }
    }
  };
}

test("extends the chart to a verified unchanged announcement without modifying price history", () => {
  const region = regionFixture();
  const before = JSON.stringify(region);
  const result = buildHistory(region, "92", "2026-10-16");
  assert.deepEqual(result.points.at(-1), {
    date: "2026-10-15", price: 8.63, kind: "unchanged", sourceUrl: region.latestNotice.sourceUrl
  });
  assert.equal(result.priceCount, 2);
  assert.equal(result.noticeCount, 1);
  assert.equal(JSON.stringify(region), before);
  assert.deepEqual(buildHistory(region, "92", "2026-10-16"), result);
});

test("never turns a later check date into an official event", () => {
  const region = regionFixture();
  region.checkedAt = "2026-10-20";
  assert.equal(buildHistory(region, "92", "2026-10-20").points.at(-1).date, "2026-10-15");
  delete region.latestNotice;
  assert.equal(buildHistory(region, "92", "2026-10-20").points.at(-1).date, "2026-09-25");
});

test("rejects future, unverified, duplicate and out-of-order announcement dates", () => {
  for (const patch of [
    { date: "2026-10-17" }, { date: "2026-09-25" }, { date: "2026-09-24" },
    { date: "2026-02-30" }, { date: "invalid" }, { kind: "unknown" }, { sourceUrl: null }
  ]) {
    const region = regionFixture();
    Object.assign(region.latestNotice, patch);
    assert.equal(buildHistory(region, "92", "2026-10-16").noticeCount, 0);
  }
  const region = regionFixture();
  region.checkedAt = "2026-10-14";
  assert.equal(buildHistory(region, "92", "2026-10-16").noticeCount, 0);
  assert.equal(buildHistory(regionFixture(), "92", "2026-10-14").noticeCount, 0);
});

test("does not infer unknown grades, mismatched prices or expired conversion prices", () => {
  const region = regionFixture();
  assert.deepEqual(buildHistory(region, "98", "2026-10-16"), { points: [], priceCount: 0, noticeCount: 0 });
  assert.equal(buildHistory(region, "95", "2026-10-16").noticeCount, 0);
  region.grades["92"].price = 9;
  assert.equal(buildHistory(region, "92", "2026-10-16").noticeCount, 0);
  region.grades["92"].price = 8.63;
  region.priceValidThrough = "2026-10-14";
  assert.equal(buildHistory(region, "92", "2026-10-16").noticeCount, 0);
});

test("does not bridge a missing price period with an unchanged observation", () => {
  const region = regionFixture();
  region.historyGaps = [{ date: "2026-10-01" }];
  assert.equal(buildHistory(region, "92", "2026-10-16").noticeCount, 0);
});

test("follows subsequent unchanged announcements and returns to price nodes after an adjustment", () => {
  const region = regionFixture();
  region.checkedAt = "2026-11-01";
  region.latestNotice.date = "2026-10-29";
  assert.equal(buildHistory(region, "92", "2026-11-01").points.at(-1).date, "2026-10-29");
  region.latestNotice.kind = "adjusted";
  region.grades["92"].price = 8.73;
  region.grades["92"].history.push({ date: "2026-10-30", price: 8.73, sourceUrl: "new-price" });
  const result = buildHistory(region, "92", "2026-11-01");
  assert.equal(result.noticeCount, 0);
  assert.equal(result.priceCount, 3);
  assert.equal(result.points.at(-1).date, "2026-10-30");
});
