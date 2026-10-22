const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const model = require("../lib/crude.js");
const { writeSnapshot, validateFiles } = require("../scripts/update-crude.cjs");
const { updateForCI } = require("../scripts/update-crude-ci.cjs");
const now = "2026-10-22T00:00:00.000Z";

function seed() {
  const dates = [];
  for (let time = Date.parse("2026-10-21"); dates.length < 100; time -= 86400000) {
    if (![0, 6].includes(new Date(time).getUTCDay())) dates.unshift(new Date(time).toISOString().slice(0, 10));
  }
  return { version: 1, usage: "third-party-reference", updatedAt: "2026-10-21T23:00:00.000Z",
    series: Object.fromEntries(Object.entries(model.definitions).map(([id, definition]) => [id, {
      name: definition.name, symbol: definition.symbol, sourceName: "东方财富", sourceUrl: definition.sourceUrl,
      currency: "USD", unit: "barrel", basis: "continuous-futures-daily", fetchedAt: "2026-10-21T23:00:00.000Z",
      history: dates.map(date => ({ date, price: 95 })), intraday: null
    }])) };
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "besfuel-crude-ci-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const json = path.join(directory, "crude-prices.json"), script = path.join(directory, "crude-prices.js");
  const previous = seed();
  writeSnapshot(previous, json, script);
  return { directory, json, script, previous };
}

test("CI publishes outage status and summary without changing trusted curves or quote times", async t => {
  const { directory, json, script, previous } = fixture(t), warnings = [];
  const summaryFile = path.join(directory, "summary.md");
  const result = await updateForCI({ directory, now, summaryFile, log: () => {}, warn: value => warnings.push(value),
    reader: async () => { throw new Error("HTTP 503"); } });
  assert.equal(result.updated, false);
  const saved = validateFiles(json, script);
  assert.deepEqual(saved.series, previous.series);
  assert.equal(saved.updatedAt, previous.updatedAt);
  assert.equal(saved.collection.checkedAt, now);
  assert.equal(saved.collection.outcome, "retained");
  assert.equal(warnings.length, 1);
  assert.match(fs.readFileSync(summaryFile, "utf8"), /全部来源失败/);
  assert.match(fs.readFileSync(summaryFile, "utf8"), /Yahoo Finance：HTTP 503/);
});

test("CI publishes a successful fallback with the source and failed attempt preserved", async t => {
  const { directory, json, script, previous } = fixture(t);
  const result = await updateForCI({ directory, now, summaryFile: "", log: () => {}, warn: () => assert.fail("unexpected warning"),
    reader: async (_, provider) => {
      if (provider !== "sina") throw new Error("HTTP 403");
      return `var _BesFuel=(${JSON.stringify([...previous.series.wti.history.map(point =>
        ({ date: point.date, high: "90", low: "80", close: "85" })),
        { date: "2026-10-22", high: "90", low: "80", close: "86" }])});`;
    } });
  assert.equal(result.updated, true);
  const saved = validateFiles(json, script);
  assert.equal(saved.usage, "third-party-reference");
  assert.equal(saved.collection.activeProvider, "sina");
  assert.equal(saved.collection.switchedFrom, "eastmoney");
  assert.equal(saved.updatedAt, now);
  assert.deepEqual(saved.collection.attempts.map(attempt => attempt.ok), [false, false, true]);
});

test("CI blocks deployment when local snapshot files disagree and makes no source requests", async t => {
  const { directory, json, script } = fixture(t);
  const original = fs.readFileSync(json);
  fs.writeFileSync(script, "window.BESFUEL_CRUDE_DATA = {};\r\n");
  await assert.rejects(updateForCI({ directory, now, log: () => {}, reader: async () => assert.fail("must validate before fetching") }), /不一致/);
  assert.deepEqual(fs.readFileSync(json), original);
});
