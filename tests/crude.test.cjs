const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const model = require("../lib/crude.js");
const { parseResponse, parseSinaResponse, sourceUrl, updateSnapshot, writeSnapshot, validateFiles } = require("../scripts/update-crude.cjs");
const now = "2026-10-19T01:00:00.000Z";

function payload(id) {
  const definition = model.definitions[id];
  return { rc: 0, data: { code: definition.symbol, market: Number(definition.market), klines: [
    "2026-10-15,95,97,98,94,100,0,0,0,0,0,0,0,0",
    "2026-10-16,97,99,100,96,100,0,0,0,0,0,0,0,0",
    "2026-10-19,99,98,100,97,100,0,0,0,0,0,0,0,0"
  ] } };
}
function snapshot() {
  return {
    version: 1, usage: "local-preview", updatedAt: now,
    series: { wti: parseResponse(payload("wti"), "wti", now), brent: parseResponse(payload("brent"), "brent", now) }
  };
}
function reader(url) { return payload(url.includes("CL00Y") ? "wti" : "brent"); }

function sinaBody(rows) {
  return `/*<script>location.href='//sina.com';</script>*/\nvar _BesFuel=(${JSON.stringify(rows || [
    { date: "2026-10-15", open: "120", high: "97", low: "90", close: "95" },
    { date: "2026-10-16", open: "95", high: "99", low: "94", close: "98" },
    { date: "2026-10-19", open: "98", high: "99", low: "96", close: "97" }
  ])});\n`;
}

test("Sina backup parses JSONP as data and identifies CFD rather than continuous futures", () => {
  const series = parseSinaResponse(sinaBody(), "wti", now);
  assert.equal(series.sourceName, "新浪财经");
  assert.equal(series.basis, "cfd-daily");
  assert.equal(series.symbol, "CL");
  assert.equal(series.history[0].price, 95);
  assert.deepEqual(series.intraday, { date: "2026-10-19", price: 97 });
  assert.equal(new URL(sourceUrl("brent", "sina")).searchParams.get("symbol"), "OIL");
  for (const body of ["globalThis.backupExecuted = true; " + sinaBody(), sinaBody() + "alert(1)", "var _Other=([]);", "<html>login</html>"]) {
    assert.throws(() => parseSinaResponse(body, "wti", now));
  }
  assert.equal(globalThis.backupExecuted, undefined);
});

test("Sina validates closes against reported ranges, dates, freshness and recent history length", () => {
  const rows = [
    { date: "2026-10-15", high: "97", low: "90", close: "95" },
    { date: "2026-10-16", high: "99", low: "94", close: "98" },
    { date: "2026-10-19", high: "99", low: "96", close: "97" }
  ];
  for (const mutate of [
    data => { data[0].close = "100"; }, data => { data[0].close = ""; },
    data => { data[0].close = null; }, data => { data[0].high = "501"; },
    data => { data[1].date = data[0].date; }, data => { data[2].date = "2026-10-20"; }
  ]) {
    const data = structuredClone(rows); mutate(data);
    assert.throws(() => parseSinaResponse(sinaBody(data), "wti", now));
  }
  assert.throws(() => parseSinaResponse(sinaBody(), "wti", "2026-10-30T01:00:00.000Z"), /七天/);
  const many = Array.from({ length: 205 }, (_, index) => ({
    date: new Date(Date.parse("2026-03-28") + index * 86400000).toISOString().slice(0, 10),
    high: "99", low: "90", close: index < 5 ? "-37" : "95"
  }));
  const series = parseSinaResponse(sinaBody(many), "wti", now);
  assert.equal(series.history.length, 200);
  assert.equal(series.history[0].date, many[5].date);
});

test("manual source switches replace both whole curves and subsequent updates retain selected provider", async () => {
  const previous = snapshot(), before = JSON.stringify(previous);
  const result = await updateSnapshot(previous, { provider: "sina", now, reader: async () => sinaBody() });
  assert.deepEqual(result.failures, []);
  assert.equal(result.updated, true);
  assert.equal(result.snapshot.series.wti.history[0].price, 95);
  assert.equal(result.snapshot.series.brent.sourceName, "新浪财经");
  assert.equal(JSON.stringify(previous), before);
  const urls = [];
  const next = await updateSnapshot(result.snapshot, { now, reader: async url => { urls.push(url); return sinaBody(); } });
  assert.equal(next.snapshot.series.wti.sourceName, "新浪财经");
  assert.ok(urls.every(url => new URL(url).hostname === "stock2.finance.sina.com.cn"));
  const restored = await updateSnapshot(next.snapshot, { provider: "eastmoney", now, reader });
  assert.deepEqual(restored.snapshot, previous);
  const revised = sinaBody().replace('"close":"95"', '"close":"96"');
  const correction = await updateSnapshot(next.snapshot, { now, reader: async () => revised });
  assert.equal(correction.failures.length, 2);
  assert.deepEqual(correction.snapshot, next.snapshot);
});

test("a failed or older backup cannot partly switch providers or replace a fresher snapshot", async () => {
  const previous = snapshot();
  const result = await updateSnapshot(previous, { provider: "sina", now, reader: async url => {
    if (new URL(url).searchParams.get("symbol") === "OIL") throw new Error("backup unavailable");
    return sinaBody();
  } });
  assert.equal(result.updated, false);
  assert.deepEqual(result.snapshot, previous);
  const older = sinaBody().replace(',{"date":"2026-10-19","open":"98","high":"99","low":"96","close":"97"}', "");
  const staleSwitch = await updateSnapshot(previous, { provider: "sina", now, reader: async () => older });
  assert.equal(staleSwitch.updated, false);
  assert.deepEqual(staleSwitch.snapshot, previous);
  await assert.rejects(updateSnapshot(previous, { provider: "unknown", now, reader }), /未知原油来源/);
  const mixed = structuredClone(previous);
  mixed.series.brent = parseSinaResponse(sinaBody(), "brent", now);
  assert.throws(() => model.validateSnapshot(mixed, now), /同一数据来源/);
  const mislabeled = structuredClone(mixed.series.brent); mislabeled.basis = "continuous-futures-daily";
  assert.throws(() => model.validateSeries(mislabeled, "brent", now), /品种或来源/);
});

test("separates Monday's active session from completed Friday history across the US weekend", () => {
  const series = parseResponse(payload("wti"), "wti", now);
  assert.deepEqual(series.history, [{ date: "2026-10-15", price: 97 }, { date: "2026-10-16", price: 99 }]);
  assert.deepEqual(series.intraday, { date: "2026-10-19", price: 98 });
  assert.equal(model.completedSession("2026-10-19", now), false);
  assert.equal(new URL(sourceUrl("wti")).searchParams.get("secid"), "102.CL00Y");
  assert.equal(new URL(sourceUrl("brent")).searchParams.get("secid"), "112.B00Y");
});

test("waits for the New York session boundary in both daylight and standard time", () => {
  assert.equal(model.completedSession("2026-03-09", "2026-03-09T21:59:00Z"), false);
  assert.equal(model.completedSession("2026-03-09", "2026-03-09T22:00:00Z"), true);
  assert.equal(model.completedSession("2026-11-02", "2026-11-02T22:59:00Z"), false);
  assert.equal(model.completedSession("2026-11-02", "2026-11-02T23:00:00Z"), true);
  // Beijing is already Saturday while Friday's US session is still running.
  assert.equal(model.completedSession("2026-10-16", "2026-10-16T21:30:00Z"), false);
});

test("rejects wrong instruments, source errors, invalid bars, duplicate dates and future data", () => {
  const mutations = [
    data => { data.rc = 1; }, data => { data.data.code = "B00Y"; }, data => { data.data.market = 112; },
    data => { data.data.klines[0] = "2026-02-30,95,97,98,94,100,0,0,0,0,0,0,0,0"; },
    data => { data.data.klines[0] = data.data.klines[1]; },
    data => { data.data.klines[0] = "2026-10-15,,97,98,94,100,0,0,0,0,0,0,0,0"; },
    data => { data.data.klines[0] = "2026-10-15,95,101,98,94,100,0,0,0,0,0,0,0,0"; },
    data => { data.data.klines[0] = "2026-10-15,95,97,98,96,100,0,0,0,0,0,0,0,0"; },
    data => { data.data.klines[2] = data.data.klines[2].replace("2026-10-19", "2026-10-20"); }
  ];
  for (const mutate of mutations) {
    const input = payload("wti"); mutate(input);
    assert.throws(() => parseResponse(input, "wti", now));
  }
});

test("does not promote an old unfinished snapshot merely because the clock advances", () => {
  const result = model.view(snapshot().series.wti, 30, "2026-10-20T02:00:00Z");
  assert.equal(result.isIntraday, true);
  assert.equal(result.lastHistory.date, "2026-10-16");
  assert.equal(result.points.at(-1).kind, "intraday");
  assert.equal(result.difference, -1);
  assert.ok(Math.abs(result.percent + 100 / 99) < 1e-8);
});

test("uses the most recent available date for range selection and flags old data", () => {
  const series = snapshot().series.wti;
  assert.equal(model.view(series, 30, "2026-10-19T02:00:00Z").stale, false);
  assert.equal(model.view(series, 30, "2026-10-26T02:00:00Z").stale, true);
  series.history.unshift({ date: "2026-09-01", price: 90 });
  assert.equal(model.view(series, 30, now).points.length, 3);
  assert.equal(model.view(series, 90, now).points.length, 4);
});

test("validates source URLs, real dates, timestamps, currency and completed-history semantics", () => {
  const mutations = [
    data => { data.series.wti.sourceUrl = "https://example.com"; },
    data => { data.series.wti.currency = "CNY"; },
    data => { data.series.wti.fetchedAt = "2026-02-30T00:00:00.000Z"; },
    data => { data.series.wti.intraday.date = "2026-10-20"; },
    data => { data.series.wti.history.push(data.series.wti.intraday); data.series.wti.intraday = null; },
    data => { data.series.wti.history[0].price = null; },
    data => { delete data.series.brent; }
  ];
  for (const mutate of mutations) { const data = snapshot(); mutate(data); assert.throws(() => model.validateSnapshot(data, now)); }
});

test("a failed instrument preserves both curves and their original timestamps", async () => {
  const previous = snapshot(), before = JSON.stringify(previous);
  const { snapshot: next, failures } = await updateSnapshot(previous, {
    now: "2026-10-19T02:00:00Z", reader: async url => {
      if (url.includes("CL00Y")) throw new Error("network unavailable");
      return reader(url);
    }
  });
  assert.equal(failures.length, 1);
  assert.deepEqual(next.series.wti, previous.series.wti);
  assert.deepEqual(next, previous);
  assert.equal(JSON.stringify(previous), before);
});

test("all-source failure preserves the entire snapshot and initial failure creates no partial data", async () => {
  const fail = async () => { throw new Error("offline"); };
  const previous = snapshot();
  const result = await updateSnapshot(previous, { reader: fail, now });
  assert.deepEqual(result.snapshot, previous);
  assert.equal(result.failures.length, 2);
  await assert.rejects(updateSnapshot(null, { reader: fail, now }), /首次采集/);
});

test("refuses history rollback, silently revised completed prices and stale sources", async () => {
  const previous = snapshot();
  for (const mutation of [
    data => { data.data.klines.pop(); },
    data => { data.data.klines[0] = data.data.klines[0].replace(",97,98,", ",96,98,"); }
  ]) {
    const result = await updateSnapshot(previous, { now, reader: async url => { const data = reader(url); mutation(data); return data; } });
    assert.equal(result.failures.length, 2);
    assert.deepEqual(result.snapshot, previous);
  }
  assert.throws(() => parseResponse(payload("wti"), "wti", "2026-10-30T01:00:00.000Z"), /七天/);
});

test("only a subsequent successful capture turns an active bar into completed history", async () => {
  const next = await updateSnapshot(snapshot(), { reader, now: "2026-10-19T23:10:00Z" });
  assert.equal(next.snapshot.series.wti.intraday, null);
  assert.equal(next.snapshot.series.wti.history.at(-1).date, "2026-10-19");
});

test("generated JSON and local script agree, use pure CRLF and detect a damaged copy", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "besfuel-crude-test-"));
  try {
    const json = path.join(dir, "data.json"), script = path.join(dir, "data.js");
    writeSnapshot(snapshot(), json, script);
    assert.deepEqual(validateFiles(json, script), snapshot());
    for (const file of [json, script]) assert.equal(/(?<!\r)\n|\r(?!\n)/.test(fs.readFileSync(file, "utf8")), false);
    fs.writeFileSync(script, "window.BESFUEL_CRUDE_DATA = {};\r\n");
    assert.throws(() => validateFiles(json, script), /不一致/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the checked-in local preview has a valid matching fallback script", () => {
  const data = validateFiles();
  assert.ok(data.series.wti.history.length > 90);
  assert.ok(data.series.brent.history.length > 90);
});
