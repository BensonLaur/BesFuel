const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { updateAll, officialUrl } = require("../scripts/update-regions.cjs");
const { importVerified } = require("../scripts/import-verified.cjs");

const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "prices.json"), "utf8"));
const source = {
  id: "example", name: "示例地区", sourceName: "示例官方部门",
  priceScope: "官方最高零售价；加油站实际成交价可能不同。",
  allowedHostnames: ["official.example.gov.cn"],
  async collect() {
    return [{
      publishedDate: "2026-09-24", effectiveDate: "2026-09-25",
      url: "https://official.example.gov.cn/20260924.html",
      prices: { "92": 8.29, "95": 8.83, diesel: 8.02 }
    }];
  }
};

test("a verified source adds a region and keeps missing 98 unavailable", async () => {
  const { data, results } = await updateAll({
    sources: [source], initial: snapshot, today: "2026-09-28", reader: () => ({})
  });
  assert.deepEqual(results, [{ id: "example", ok: true, count: 1 }]);
  assert.equal(data.regions.example.grades["92"].price, 8.29);
  assert.deepEqual(data.regions.example.grades["92"].history, [{
    date: "2026-09-25", price: 8.29, sourceUrl: "https://official.example.gov.cn/20260924.html"
  }]);
  assert.equal(data.regions.example.grades["98"].price, null);
  assert.equal(snapshot.regions.example, undefined);
});

test("a conflicting source leaves trusted data untouched while other regions can update", async () => {
  const older = structuredClone(snapshot);
  older.regions.example = {
    name: "示例地区", priceScope: source.priceScope, checkedAt: "2026-09-28",
    source: { name: source.sourceName, url: "https://official.example.gov.cn/20260924.html" },
    effectiveLabel: "2026-09-24 24:00 起",
    grades: Object.fromEntries(["92", "95", "diesel"].map(grade => [grade, {
      price: grade === "92" ? 8.30 : grade === "95" ? 8.83 : 8.02,
      history: [{ date: "2026-09-25", price: grade === "92" ? 8.30 : grade === "95" ? 8.83 : 8.02,
        sourceUrl: "https://official.example.gov.cn/20260924.html" }]
    }]).concat([["98", { price: null, history: [] }]]))
  };
  const other = { ...source, id: "another", name: "另一地区" };
  const { data, results } = await updateAll({
    sources: [source, other], initial: older, today: "2026-09-28", reader: () => ({})
  });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /冲突/);
  assert.equal(results[1].ok, true);
  assert.equal(data.regions.example.grades["92"].price, 8.30);
  assert.equal(data.regions.another.grades["92"].price, 8.29);
});

test("an equal-price official mirror keeps the previously audited history link", async () => {
  const first = await updateAll({ sources: [source], initial: snapshot, today: "2026-09-28", reader: () => ({}) });
  const mirror = { ...source, async collect() {
    const notices = await source.collect();
    return [{ ...notices[0], url: "https://official.example.gov.cn/mirror.html" }];
  } };
  const second = await updateAll({ sources: [mirror], initial: first.data, today: "2026-09-28", reader: () => ({}) });
  assert.equal(second.results[0].ok, true);
  assert.equal(second.data.regions.example.grades["92"].history[0].sourceUrl,
    "https://official.example.gov.cn/20260924.html");
});

test("official URL allowlist excludes unrelated and credential-bearing hosts", () => {
  assert.equal(officialUrl("https://official.example.gov.cn/notice", source.allowedHostnames), true);
  assert.equal(officialUrl("https://official.example.gov.cn.evil.test/notice", source.allowedHostnames), false);
  assert.equal(officialUrl("https://user@official.example.gov.cn/notice", source.allowedHostnames), false);
});

test("manual imports reject tonne-only prices and attachments outside the official host", () => {
  const tonne = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "verified", "liaoning.json"), "utf8"));
  assert.throws(() => importVerified(snapshot, tonne), /仅元\/升核价记录/);
  const jilin = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "verified", "jilin.json"), "utf8"));
  jilin.notices[0].pdfUrl = "https://example.com/notice.pdf";
  assert.throws(() => importVerified(snapshot, jilin), /official pdfUrl/);
  const guizhou = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "verified", "guizhou-zone1.json"), "utf8"));
  guizhou.notices[0].dieselImageUrl = "https://example.com/diesel.png";
  assert.throws(() => importVerified(snapshot, guizhou), /official dieselImageUrl/);
});
