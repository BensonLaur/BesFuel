const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const model = require("../lib/crude.js");
const { sourceUrl, parseResponse, parseYahooResponse, fetchSource, collectSnapshot, writeSnapshot, validateFiles } = require("../scripts/update-crude.cjs");
const now = "2026-10-19T02:45:00.000Z";

function dates(last = "2026-10-16") {
  const result = [];
  for (let time = Date.parse(last); result.length < 100; time -= 86400000) {
    if (![0, 6].includes(new Date(time).getUTCDay())) result.unshift(new Date(time).toISOString().slice(0, 10));
  }
  return result;
}
function eastmoney(id, last) {
  const definition = model.definitions[id];
  const klines = dates(last).map(date => `${date},94,95,98,90,100,0,0,0,0,0,0,0,0`);
  if (!last) klines.push("2026-10-19,95,96,98,90,100,0,0,0,0,0,0,0,0");
  return { rc: 0, data: { code: definition.symbol, market: Number(definition.market), klines } };
}
function yahoo(id) {
  return { chart: { error: null, result: [{
    meta: { symbol: model.providers.yahoo.instruments[id].symbol, currency: "USD", instrumentType: "FUTURE",
      exchangeName: "NYM", exchangeTimezoneName: "America/New_York", dataGranularity: "1d" },
    timestamp: [...dates().map(date => Date.parse(date + "T04:00:00Z") / 1000), Date.parse("2026-10-19T02:33:00Z") / 1000],
    indicators: { quote: [{ open: Array(101).fill(90), high: Array(101).fill(99), low: Array(101).fill(89),
      close: [...Array(100).fill(91.330001831), 92.169998169] }] }
  }] } };
}
function sina() {
  const rows = [...dates(), "2026-10-19"].map(date => ({ date, high: "88", low: "80", close: "85" }));
  return `var _BesFuel=(${JSON.stringify(rows)});`;
}
function previous() {
  return { version: 1, usage: "local-preview", updatedAt: now,
    series: Object.fromEntries(["wti", "brent"].map(id => [id, parseResponse(eastmoney(id), id, now)])) };
}
function goodReader(url, provider) {
  const id = provider === "eastmoney" ? (url.includes("CL00Y") ? "wti" : "brent") :
    provider === "yahoo" ? (url.includes("CL%3DF") ? "wti" : "brent") :
      (new URL(url).searchParams.get("symbol") === "CL" ? "wti" : "brent");
  return provider === "eastmoney" ? eastmoney(id) : provider === "yahoo" ? yahoo(id) : sina();
}

test("Yahoo normalizes the Sunday evening session and rounds floating point quotes to cents", () => {
  const series = parseYahooResponse(yahoo("wti"), "wti", now);
  assert.equal(series.history.length, 100);
  assert.equal(series.history.at(-1).date, "2026-10-16");
  assert.equal(series.history.at(-1).price, 91.33);
  assert.deepEqual(series.intraday, { date: "2026-10-19", price: 92.17 });
  assert.equal(series.basis, "nymex-futures-daily");
  assert.equal(series.symbol, "CL=F");
  assert.equal(new URL(sourceUrl("brent", "yahoo")).pathname.split("/").at(-1), "BZ%3DF");
});

test("Yahoo handles winter session dates and only completes a bar after a later successful capture", () => {
  const data = yahoo("wti");
  data.chart.result[0].timestamp[data.chart.result[0].timestamp.length - 1] = Date.parse("2026-11-02T00:10:00Z") / 1000;
  const winter = parseYahooResponse(data, "wti", "2026-11-02T01:00:00.000Z");
  assert.equal(winter.intraday.date, "2026-11-02");
  const closed = yahoo("wti");
  closed.chart.result[0].timestamp[100] = Date.parse("2026-10-19T21:59:00Z") / 1000;
  const completed = parseYahooResponse(closed, "wti", "2026-10-19T22:10:00.000Z");
  assert.equal(completed.intraday, null);
  assert.equal(completed.history.at(-1).date, "2026-10-19");
});

test("Yahoo rejects wrong metadata, malformed prices, future timestamps and ambiguous dates", () => {
  const mutations = [
    data => { data.meta.symbol = "BZ=F"; }, data => { data.meta.exchangeName = "ICE"; },
    data => { data.meta.currency = "CNY"; }, data => { data.meta.instrumentType = "EQUITY"; },
    data => { data.meta.dataGranularity = "1m"; }, data => { data.meta.exchangeTimezoneName = "UTC"; },
    data => { data.indicators.quote[0].close[0] = null; },
    data => { data.indicators.quote[0].close[0] = 200; },
    data => { data.timestamp[1] = data.timestamp[0]; },
    data => { data.timestamp[100] = Date.parse("2026-10-20T02:00:00Z") / 1000; },
    data => { data.timestamp[100] = Date.parse("2026-10-18T04:00:00Z") / 1000; },
    data => { data.indicators.quote[0].low.pop(); }
  ];
  for (const mutate of mutations) {
    const data = yahoo("wti"); mutate(data.chart.result[0]);
    assert.throws(() => parseYahooResponse(data, "wti", now));
  }
  const empty = yahoo("wti");
  for (const key of ["open", "close", "high", "low"]) empty.chart.result[0].indicators.quote[0][key][3] = null;
  assert.equal(parseYahooResponse(empty, "wti", now).history.length, 99);
  assert.throws(() => parseYahooResponse({ chart: { result: null, error: { code: "Unauthorized" } } }, "wti", now));
});

test("automatic collection prefers Eastmoney and makes no unnecessary backup requests", async () => {
  const calls = [];
  const result = await collectSnapshot(previous(), { now, reader: async (url, provider) => { calls.push(provider); return goodReader(url, provider); } });
  assert.deepEqual(calls, ["eastmoney", "eastmoney"]);
  assert.equal(result.updated, true);
  assert.equal(result.snapshot.collection.activeProvider, "eastmoney");
  assert.deepEqual(result.attempts, [{ provider: "eastmoney", ok: true, reason: "" }]);
});

test("one failed primary instrument falls back to two complete Yahoo curves without splicing", async () => {
  const old = previous(), before = JSON.stringify(old), calls = [];
  const result = await collectSnapshot(old, { now, reader: async (url, provider) => {
    calls.push(provider);
    if (provider === "eastmoney" && url.includes("B00Y")) throw new Error("timeout");
    return goodReader(url, provider);
  } });
  assert.deepEqual(calls, ["eastmoney", "eastmoney", "yahoo", "yahoo"]);
  assert.deepEqual(result.attempts.map(attempt => attempt.ok), [false, true]);
  assert.equal(result.snapshot.collection.switchedFrom, "eastmoney");
  for (const series of Object.values(result.snapshot.series)) {
    assert.equal(series.sourceName, "Yahoo Finance");
    assert.equal(series.history.length, 100);
    assert.ok(series.history.every(point => point.price === 91.33));
    assert.equal(model.view(series, 30, now).difference.toFixed(2), "0.84");
  }
  assert.equal(JSON.stringify(old), before);
});

test("automatic collection falls through Yahoo to Sina, then recovers to Eastmoney next run", async () => {
  const fallback = await collectSnapshot(previous(), { now, reader: async (url, provider) => {
    if (provider !== "sina") throw new Error("unavailable");
    return goodReader(url, provider);
  } });
  assert.deepEqual(fallback.attempts.map(attempt => attempt.provider), ["eastmoney", "yahoo", "sina"]);
  assert.equal(fallback.snapshot.collection.activeProvider, "sina");
  const recovered = await collectSnapshot(fallback.snapshot, { now, reader: goodReader });
  assert.equal(recovered.snapshot.collection.activeProvider, "eastmoney");
  assert.equal(recovered.snapshot.collection.switchedFrom, "sina");
  assert.equal(recovered.attempts.length, 1);
  const next = await collectSnapshot(recovered.snapshot, { now, reader: goodReader });
  assert.equal(next.snapshot.collection.switchedFrom, null);
});

test("all-source outage records failure while preserving original prices and data timestamps", async () => {
  const old = previous();
  const result = await collectSnapshot(old, { now: "2026-10-19T03:00:00.000Z", reader: async () => { throw new Error("offline"); } });
  assert.equal(result.updated, false);
  assert.deepEqual(result.snapshot.series, old.series);
  assert.equal(result.snapshot.updatedAt, old.updatedAt);
  assert.equal(result.snapshot.collection.checkedAt, "2026-10-19T03:00:00.000Z");
  assert.equal(result.snapshot.collection.outcome, "retained");
  assert.equal(result.snapshot.collection.switchedFrom, null);
  assert.ok(result.attempts.every(attempt => !attempt.ok));
  const invalid = structuredClone(result.snapshot); invalid.collection.attempts[0].provider = "yahoo";
  assert.throws(() => model.validateSnapshot(invalid, "2026-10-19T03:00:00.000Z"));
  await assert.rejects(collectSnapshot(null, { now, reader: async () => { throw new Error("offline"); } }), /所有候选/);
});

test("stale, incomplete, revised or rolled-back primary data cannot stop fallback", async () => {
  for (const bad of [
    id => eastmoney(id, "2026-10-13"),
    id => { const data = eastmoney(id); data.data.klines = data.data.klines.slice(-3); return data; },
    id => { const data = eastmoney(id); data.data.klines.pop(); return data; },
    id => { const data = eastmoney(id); data.data.klines[0] = data.data.klines[0].replace(",95,98,", ",96,98,"); return data; }
  ]) {
    const result = await collectSnapshot(previous(), { now, reader: async (url, provider) => {
      if (provider === "eastmoney") return bad(url.includes("CL00Y") ? "wti" : "brent");
      return goodReader(url, provider);
    } });
    assert.equal(result.snapshot.collection.activeProvider, "yahoo");
  }
  const staleInitial = await collectSnapshot(null, { now, reader: async (url, provider) => provider === "eastmoney"
    ? eastmoney(url.includes("CL00Y") ? "wti" : "brent", "2026-10-14") : goodReader(url, provider) });
  assert.equal(staleInitial.snapshot.collection.activeProvider, "yahoo");
});

test("an explicit manual source does not silently fall back", async () => {
  const calls = [];
  const result = await collectSnapshot(previous(), { provider: "yahoo", now, reader: async (_, provider) => {
    calls.push(provider); throw new Error("HTTP 403");
  } });
  assert.equal(result.updated, false);
  assert.deepEqual(calls, ["yahoo", "yahoo"]);
  assert.equal(result.snapshot.collection.mode, "manual");
  assert.equal(result.attempts.length, 1);
});

test("outage status persists in matching JSON and offline files without refreshing old quote timestamps", async () => {
  const old = previous();
  const result = await collectSnapshot(old, { now: "2026-10-19T03:00:00.000Z", reader: async () => { throw new Error("offline"); } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "besfuel-crude-outage-"));
  try {
    const json = path.join(dir, "data.json"), script = path.join(dir, "data.js");
    writeSnapshot(result.snapshot, json, script);
    const saved = validateFiles(json, script);
    assert.equal(saved.collection.outcome, "retained");
    assert.equal(saved.collection.checkedAt, "2026-10-19T03:00:00.000Z");
    assert.equal(saved.updatedAt, old.updatedAt);
    assert.deepEqual(saved.series, old.series);
    const recovered = await collectSnapshot(saved, { now: "2026-10-19T03:05:00.000Z", reader: goodReader });
    assert.equal(recovered.snapshot.collection.outcome, "updated");
    assert.ok(recovered.snapshot.updatedAt > saved.updatedAt);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("rate limits and forbidden responses are not retried, while a transient server error is", async () => {
  for (const status of [403, 429]) {
    let calls = 0;
    await assert.rejects(fetchSource(sourceUrl("wti", "yahoo"), "yahoo", { proxy: "", fetcher: async () => {
      calls++; return { ok: false, status };
    }, sleep: async () => assert.fail("must not retry access restrictions") }), new RegExp(String(status)));
    assert.equal(calls, 1);
  }
  let calls = 0, waited = 0;
  const data = await fetchSource(sourceUrl("wti", "yahoo"), "yahoo", { proxy: "", fetcher: async (_, options) => {
    assert.ok(options.headers["User-Agent"].includes("Mozilla"));
    calls++; return calls === 1 ? { ok: false, status: 503 } : { ok: true, text: async () => JSON.stringify(yahoo("wti")) };
  }, sleep: async ms => { waited += ms; } });
  assert.equal(calls, 2); assert.equal(waited, 1000);
  assert.equal(data.chart.result[0].meta.symbol, "CL=F");
});

test("an explicit proxy applies only to Yahoo and does not change system proxy settings", async () => {
  let runs = 0;
  const data = await fetchSource(sourceUrl("wti", "yahoo"), "yahoo", { proxy: "http://127.0.0.1:7890", runner: async (_, args, options) => {
    runs++;
    assert.equal(args[args.indexOf("--proxy") + 1], "http://127.0.0.1:7890");
    assert.equal(options.windowsHide, true);
    return { stdout: JSON.stringify(yahoo("wti")) + "\n200" };
  } });
  assert.equal(data.chart.result[0].meta.symbol, "CL=F");
  await fetchSource(sourceUrl("wti"), "eastmoney", { proxy: "http://127.0.0.1:7890", runner: async () => assert.fail("Eastmoney must not use Yahoo proxy"),
    fetcher: async () => ({ ok: true, text: async () => JSON.stringify(eastmoney("wti")) }) });
  assert.equal(runs, 1);
});
