"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");
const model = require("../lib/crude.js");
const root = path.resolve(__dirname, "..");
const jsonPath = path.join(root, "data/crude-prices.json");
const scriptPath = path.join(root, "data/crude-prices.js");
const runFile = promisify(execFile);
const yahooUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function sourceUrl(id, provider = "eastmoney") {
  const definition = model.providers[provider]?.instruments[id];
  if (!definition) throw new Error("未知原油品种");
  if (provider === "yahoo") {
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(definition.symbol)}`);
    url.searchParams.set("interval", "1d");
    url.searchParams.set("range", "1y");
    return url.href;
  }
  if (provider === "sina") {
    const url = new URL("https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_BesFuel=/GlobalFuturesService.getGlobalFuturesDailyKLine");
    url.searchParams.set("symbol", definition.symbol);
    url.searchParams.set("source", "web");
    return url.href;
  }
  const url = new URL("https://push2his.eastmoney.com/api/qt/stock/kline/get");
  for (const [key, value] of Object.entries({
    secid: `${definition.market}.${definition.symbol}`, klt: "101", fqt: "1", lmt: "200", end: "20500000",
    iscca: "1", fields1: "f1,f2,f3,f4,f5,f6,f7,f8", fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64",
    ut: "f057cbcbce2a86e2866ab8877db1d059", forcect: "1"
  })) url.searchParams.set(key, value);
  return url.href;
}

function makeSeries(rows, id, fetchedAt, provider) {
  const source = model.providers[provider];
  const definition = source.instruments[id];
  const history = [];
  let intraday = null, previous = "";
  const today = model.dateInZone(fetchedAt, "Asia/Shanghai").date;
  for (const { date, price } of rows) {
    if (!model.validDate(date) || date <= previous || date > today) throw new Error(`${id}: 日线日期或数值无效`);
    const point = { date, price };
    if (model.completedSession(date, fetchedAt)) history.push(point);
    else {
      if (intraday) throw new Error(`${id}: 多条尚未完成的日线`);
      intraday = point;
    }
    previous = date;
  }
  const series = {
    name: definition.name, symbol: definition.symbol, sourceName: source.name, sourceUrl: definition.sourceUrl,
    currency: "USD", unit: "barrel", basis: source.basis, fetchedAt, history, intraday
  };
  model.validateSeries(series, id, fetchedAt);
  const latest = intraday || history.at(-1);
  if (Date.parse(today) - Date.parse(latest.date) > 7 * 86400000) throw new Error(`${id}: 来源日线超过七天未更新`);
  return series;
}

function parseResponse(payload, id, fetchedAt) {
  const definition = model.definitions[id];
  if (!definition || payload?.rc !== 0 || payload.data?.code !== definition.symbol ||
      payload.data.market !== Number(definition.market) || !Array.isArray(payload.data.klines)) {
    throw new Error(`${id}: 来源品种、市场或响应格式不符`);
  }
  const rows = payload.data.klines.map(row => {
    if (typeof row !== "string") throw new Error(`${id}: 日线格式无效`);
    const cells = row.split(",");
    if (cells.length !== 14 || !cells.slice(1, 5).every(value => /^-?\d+(?:\.\d+)?$/.test(value))) {
      throw new Error(`${id}: 日线数值无效`);
    }
    const [open, price, high, low] = cells.slice(1, 5).map(Number);
    if (low <= 0 || high > 500 || low > Math.min(open, price) || high < Math.max(open, price)) {
      throw new Error(`${id}: 日线开高低收不一致`);
    }
    return { date: cells[0], price };
  });
  return makeSeries(rows, id, fetchedAt, "eastmoney");
}

function parseSinaResponse(body, id, fetchedAt) {
  if (!model.providers.sina.instruments[id] || typeof body !== "string") throw new Error(`${id}: 新浪响应无效`);
  // Extract JSON only; never execute JavaScript returned by the quote service.
  const match = body.trim().match(/^(?:\/\*[\s\S]*?\*\/\s*)?var _BesFuel\s*=\s*\((\[[\s\S]*\])\);?$/);
  if (!match) throw new Error(`${id}: 新浪 JSONP 格式变化`);
  const payload = JSON.parse(match[1]);
  if (!Array.isArray(payload) || payload.length < 2 || payload.length > 20000) throw new Error(`${id}: 新浪日线长度无效`);
  const rows = payload.slice(-200).map(row => {
    if (!row || ![row.close, row.high, row.low].every(value => typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value))) {
      throw new Error(`${id}: 新浪日线数值无效`);
    }
    const price = Number(row.close), high = Number(row.high), low = Number(row.low);
    // Sina's open field sometimes lies outside its reported high/low. We only
    // publish the close series and validate that close against the day's range.
    if (low <= 0 || high > 500 || price < low || price > high) throw new Error(`${id}: 新浪日线收盘与高低价不一致`);
    return { date: row.date, price };
  });
  return makeSeries(rows, id, fetchedAt, "sina");
}

function parseYahooResponse(payload, id, fetchedAt) {
  const definition = model.providers.yahoo.instruments[id];
  const series = payload?.chart?.result?.[0], meta = series?.meta;
  if (!definition || payload?.chart?.error || payload?.chart?.result?.length !== 1 ||
      meta?.symbol !== definition.symbol || meta.currency !== "USD" || meta.instrumentType !== "FUTURE" ||
      meta.exchangeName !== "NYM" || meta.exchangeTimezoneName !== "America/New_York" || meta.dataGranularity !== "1d") {
    throw new Error(`${id}: Yahoo 品种、市场或响应格式不符`);
  }
  const times = series.timestamp, quotes = series.indicators?.quote?.[0];
  if (!Array.isArray(times) || times.length < 2 || times.length > 400 ||
      !["open", "close", "high", "low"].every(key => Array.isArray(quotes?.[key]) && quotes[key].length === times.length)) {
    throw new Error(`${id}: Yahoo 日线长度无效`);
  }
  let previous = 0;
  const rows = times.map((time, index) => {
    if (!Number.isSafeInteger(time) || time <= previous || time * 1000 > Date.parse(fetchedAt) + 300000) {
      throw new Error(`${id}: Yahoo 时间戳无效`);
    }
    previous = time;
    const values = [quotes.open[index], quotes.close[index], quotes.high[index], quotes.low[index]];
    // Yahoo sometimes includes empty sessions. Do not turn missing prices into zero.
    if (values.every(value => value === null)) return null;
    const [open, price, high, low] = values;
    if (!values.every(Number.isFinite) || low <= 0 || high > 500 ||
        low > Math.min(open, price) + 0.000001 || high < Math.max(open, price) - 0.000001) {
      throw new Error(`${id}: Yahoo 日线开高低收无效`);
    }
    const local = model.dateInZone(time * 1000, "America/New_York");
    // Historical bars start at local midnight, but the active bar may carry an
    // actual quote timestamp. Sunday evening belongs to Monday's futures session.
    const date = local.hour >= 18 ? new Date(Date.parse(local.date) + 86400000).toISOString().slice(0, 10) : local.date;
    const weekday = new Date(date).getUTCDay();
    if (weekday === 0 || weekday === 6) throw new Error(`${id}: Yahoo 交易日落在周末`);
    return { date, price: Math.round(price * 100) / 100 };
  }).filter(Boolean).slice(-200);
  return makeSeries(rows, id, fetchedAt, "yahoo");
}

async function proxyYahoo(url, proxy, runner) {
  const address = new URL(proxy);
  if (!["http:", "https:"].includes(address.protocol) || address.username || address.password) {
    throw new Error("Yahoo 代理须为不含账号密码的 HTTP(S) 地址");
  }
  let stdout;
  try {
    ({ stdout } = await runner(process.platform === "win32" ? "curl.exe" : "curl", [
      "--silent", "--show-error", "--connect-timeout", "8", "--max-time", "20",
      "--user-agent", yahooUserAgent, "--proxy", proxy, "--noproxy", "", "--write-out", "\n%{http_code}", url
    ], { windowsHide: true, encoding: "utf8", maxBuffer: 2000000, timeout: 25000 }));
  } catch (_) { throw new Error("Yahoo 代理请求失败；检查本地代理端口和 curl 是否可用"); }
  const split = stdout.lastIndexOf("\n");
  const status = Number(stdout.slice(split + 1));
  if (split < 0 || !Number.isInteger(status) || status < 100 || status > 599) throw new Error("Yahoo 代理响应格式无效");
  return { status, ok: status >= 200 && status < 300, text: async () => stdout.slice(0, split) };
}

async function fetchSource(url, provider, { fetcher = fetch, proxy = process.env.BESFUEL_YAHOO_PROXY, runner = runFile, sleep = delay } = {}) {
  let error;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = provider === "yahoo" && proxy ? await proxyYahoo(url, proxy, runner) :
        await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(15000),
          ...(provider === "yahoo" ? { headers: { "User-Agent": yahooUserAgent } } : {}) });
      if (!response.ok) {
        const failure = new Error(`行情来源 HTTP ${response.status}`);
        // Respect rate limits and access restrictions rather than retrying them.
        failure.retryable = response.status >= 500;
        throw failure;
      }
      const body = await response.text();
      if (Buffer.byteLength(body) > (provider === "sina" ? 2000000 : 300000)) throw new Error("行情响应过大");
      return provider === "sina" ? body : JSON.parse(body);
    } catch (failure) {
      error = failure;
      if (failure.retryable === false) break;
      if (attempt === 0) await sleep(1000);
    }
  }
  throw error;
}

async function updateSnapshot(previous, { reader = fetchSource, now = new Date(), provider } = {}) {
  const fetchedAt = new Date(now).toISOString();
  if (previous) model.validateSnapshot(previous, now);
  provider ??= previous ? model.providerId(previous.series.wti) : "eastmoney";
  if (!Object.hasOwn(model.providers, provider)) throw new Error("未知原油来源，仅支持 eastmoney、yahoo 或 sina");
  const switching = Boolean(previous && provider !== model.providerId(previous.series.wti));
  const series = {};
  const results = await Promise.allSettled(Object.keys(model.definitions).map(async id => {
    const parse = { eastmoney: parseResponse, yahoo: parseYahooResponse, sina: parseSinaResponse }[provider];
    const incoming = parse(await reader(sourceUrl(id, provider), provider), id, fetchedAt);
    const old = previous?.series[id];
    if (old) {
      const latestOld = old.intraday || old.history.at(-1);
      const latestNew = incoming.intraday || incoming.history.at(-1);
      if (fetchedAt < old.fetchedAt || latestNew.date < latestOld.date) throw new Error(`${id}: 拒绝行情回退`);
      const oldHistory = new Map(old.history.map(point => [point.date, point.price]));
      // Continuous series may be revised by a provider. Surface corrections for
      // review instead of silently rewriting a curve already shown to users.
      if (!switching && incoming.history.some(point => oldHistory.has(point.date) && oldHistory.get(point.date) !== point.price)) {
        throw new Error(`${id}: 已完成历史被来源修订，需复核后重新导入`);
      }
    }
    return { id, incoming };
  }));
  // Both curves form one candidate, including when refreshing the same provider.
  // Never publish a half-update or splice CFD prices into futures history.
  if (results.some(result => result.status === "rejected")) {
    const failures = results.filter(result => result.status === "rejected").map(result => result.reason.message);
    if (!previous) throw new Error(`首次采集未取得两个完整品种：${failures.join("；")}`);
    return { snapshot: structuredClone(previous), failures, updated: false };
  }
  Object.keys(model.definitions).forEach((id, index) => {
    series[id] = results[index].value.incoming;
  });
  const snapshot = { version: 1, usage: "local-preview", updatedAt: fetchedAt, series };
  model.validateSnapshot(snapshot, now);
  return { snapshot, failures: [], updated: true };
}

async function collectSnapshot(previous, { provider = "auto", now = new Date(), reader = fetchSource } = {}) {
  const checkedAt = new Date(now).toISOString();
  if (previous) model.validateSnapshot(previous, now);
  if (provider !== "auto" && !Object.hasOwn(model.providers, provider)) throw new Error("未知原油来源");
  const order = provider === "auto" ? model.providerPriority : [provider];
  const attempts = [];
  let candidate = null;
  for (const id of order) {
    try {
      const result = await updateSnapshot(previous, { provider: id, now, reader });
      if (!result.updated) throw new Error(result.failures.join("；"));
      for (const series of Object.values(result.snapshot.series)) {
        if (series.history.length < 90) throw new Error("历史不足 90 条，不能替代完整趋势曲线");
        if (model.view(series, 180, now).stale) throw new Error("行情日期超过四个自然日未更新");
      }
      attempts.push({ provider: id, ok: true, reason: "" });
      candidate = result.snapshot;
      break;
    } catch (error) {
      attempts.push({ provider: id, ok: false, reason: String(error.message).slice(0, 500) });
    }
  }
  if (!candidate && !previous) throw new Error(`所有候选来源均不可用：${attempts.map(attempt => `${attempt.provider}: ${attempt.reason}`).join("；")}`);
  const snapshot = candidate || structuredClone(previous);
  const activeProvider = model.providerId(snapshot.series.wti);
  snapshot.collection = {
    mode: provider === "auto" ? "auto" : "manual", outcome: candidate ? "updated" : "retained", checkedAt,
    activeProvider, attempts,
    switchedFrom: candidate && previous && model.providerId(previous.series.wti) !== activeProvider ? model.providerId(previous.series.wti) : null
  };
  // Failed checks update only collection status; price dates and collection
  // timestamps remain unchanged so an outage cannot make old quotes look fresh.
  model.validateSnapshot(snapshot, now);
  return { snapshot, updated: Boolean(candidate), attempts };
}

const crlf = value => value.replace(/\r\n|\r|\n/g, "\n").trimEnd().replace(/\n/g, "\r\n") + "\r\n";
function validateFiles(jsonFile = jsonPath, scriptFile = scriptPath) {
  const snapshot = model.validateSnapshot(JSON.parse(fs.readFileSync(jsonFile, "utf8")));
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(scriptFile, "utf8"), context, { timeout: 1000 });
  if (JSON.stringify(snapshot) !== JSON.stringify(context.window.BESFUEL_CRUDE_DATA)) throw new Error("原油 JSON 与本地副本不一致");
  return snapshot;
}
function writeSnapshot(snapshot, jsonFile = jsonPath, scriptFile = scriptPath) {
  model.validateSnapshot(snapshot);
  const json = crlf(JSON.stringify(snapshot, null, 2));
  const script = crlf(`// Generated from data/crude-prices.json; local preview only.\nwindow.BESFUEL_CRUDE_DATA = ${JSON.stringify(snapshot, null, 2)};`);
  const files = [jsonFile, scriptFile];
  const backups = files.map(file => fs.existsSync(file) ? fs.readFileSync(file) : null);
  let writing = false;
  try {
    fs.writeFileSync(jsonFile + ".tmp", json);
    fs.writeFileSync(scriptFile + ".tmp", script);
    validateFiles(jsonFile + ".tmp", scriptFile + ".tmp");
    writing = true;
    files.forEach(file => fs.renameSync(file + ".tmp", file));
  } catch (error) {
    if (writing) files.forEach((file, index) => {
      if (backups[index]) fs.writeFileSync(file, backups[index]);
      else if (fs.existsSync(file)) fs.unlinkSync(file);
    });
    throw error;
  } finally {
    for (const file of files) if (fs.existsSync(file + ".tmp")) fs.unlinkSync(file + ".tmp");
  }
}

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const unknown = args.find(arg => arg !== "--validate" && arg !== "--check" && !/^--source=(auto|eastmoney|yahoo|sina)$/.test(arg));
    if (unknown || args.filter(arg => arg.startsWith("--source=")).length > 1) throw new Error("参数无效：支持 --source=auto/eastmoney/yahoo/sina、--check 或 --validate");
    if (process.argv.includes("--validate")) {
      validateFiles(); console.log("原油快照与本地副本校验通过。"); return;
    }
    const previous = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, "utf8")) : null;
    const provider = args.find(arg => arg.startsWith("--source="))?.slice(9);
    const { snapshot, attempts, updated } = await collectSnapshot(previous, { provider });
    if (!args.includes("--check")) writeSnapshot(snapshot);
    if (args.includes("--check")) console.log("仅检查来源，不修改本站快照。");
    for (const attempt of attempts) {
      console.log(`${model.providers[attempt.provider].displayName}：${attempt.ok ? "校验通过" : `不可用，${attempt.reason}`}`);
    }
    for (const entry of Object.values(snapshot.series)) {
      console.log(`${model.providers[model.providerId(entry)].displayName} · ${entry.basis === "cfd-daily" ? "CFD 差价合约" : "期货参考"} · ${entry.name}：${entry.history.length} 条已完成日线，截至 ${entry.history.at(-1).date}${entry.intraday ? `；另有 ${entry.intraday.date} 盘中快照` : ""}`);
    }
    if (!updated) { console.warn("本次全部候选失败：保留原价格与采集时间，仅记录检查失败状态。"); process.exitCode = 1; }
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { sourceUrl, parseResponse, parseSinaResponse, parseYahooResponse, fetchSource, updateSnapshot, collectSnapshot, validateFiles, writeSnapshot };
