(function (root) {
  "use strict";

  const definitions = {
    wti: { name: "WTI 原油", symbol: "CL00Y", market: "102", sourceUrl: "https://quote.eastmoney.com/globalfuture/CL00Y.html" },
    brent: { name: "布伦特原油", symbol: "B00Y", market: "112", sourceUrl: "https://quote.eastmoney.com/globalfuture/B00Y.html" }
  };
  const providers = {
    eastmoney: { name: "东方财富", displayName: "Eastmoney", basis: "continuous-futures-daily", instruments: definitions },
    yahoo: { name: "Yahoo Finance", displayName: "Yahoo Finance", basis: "nymex-futures-daily", instruments: {
      wti: { name: definitions.wti.name, symbol: "CL=F", sourceUrl: "https://finance.yahoo.com/quote/CL%3DF/" },
      brent: { name: definitions.brent.name, symbol: "BZ=F", sourceUrl: "https://finance.yahoo.com/quote/BZ%3DF/" }
    } },
    sina: { name: "新浪财经", displayName: "Sina Finance", basis: "cfd-daily", instruments: {
      wti: { name: definitions.wti.name, symbol: "CL", sourceUrl: "https://finance.sina.com.cn/futures/quotes/CL.shtml" },
      brent: { name: definitions.brent.name, symbol: "OIL", sourceUrl: "https://finance.sina.com.cn/futures/quotes/OIL.shtml" }
    } }
  };
  const providerPriority = ["eastmoney", "yahoo", "sina"];
  function providerId(series) {
    return Object.keys(providers).find(id => providers[id].name === series?.sourceName);
  }
  function validDate(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
  }
  function dateInZone(now, timeZone) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date(now)).map(part => [part.type, part.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
  }
  function completedSession(date, now) {
    const local = dateInZone(now, "America/New_York");
    // A trading date starts the previous evening. Wait until 18:00 New York time,
    // past both benchmarks' regular daily close, before treating its bar as complete.
    return date < local.date || (date === local.date && local.hour >= 18);
  }
  function assert(condition, message) { if (!condition) throw new Error(message); }
  function validTimestamp(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  }
  function validateSeries(series, id, now) {
    const provider = providers[providerId(series)];
    const definition = provider?.instruments[id];
    assert(definition && series && series.symbol === definition.symbol && series.name === definition.name &&
      series.sourceUrl === definition.sourceUrl && series.currency === "USD" && series.unit === "barrel" &&
      series.basis === provider.basis, `${id}: 品种或来源不正确`);
    assert(validTimestamp(series.fetchedAt) && Date.parse(series.fetchedAt) <= new Date(now).getTime() + 300000, `${id}: 采集时间无效或超前`);
    assert(Array.isArray(series.history) && series.history.length >= 2 && series.history.length <= 220, `${id}: 历史长度无效`);
    let previous = "";
    for (const point of series.history) {
      assert(validDate(point.date) && point.date > previous && completedSession(point.date, series.fetchedAt), `${id}: 历史日期无效、重复或尚未完成`);
      assert(Number.isFinite(point.price) && point.price > 0 && point.price <= 500, `${id}: 价格超出范围`);
      previous = point.date;
    }
    if (series.intraday !== null) {
      const point = series.intraday;
      const chinaDate = dateInZone(series.fetchedAt, "Asia/Shanghai").date;
      assert(point && validDate(point.date) && point.date > previous && point.date <= chinaDate &&
        !completedSession(point.date, series.fetchedAt), `${id}: 盘中日期无效`);
      assert(Number.isFinite(point.price) && point.price > 0 && point.price <= 500, `${id}: 盘中价格超出范围`);
    }
    return series;
  }
  function validateSnapshot(snapshot, now = new Date()) {
    assert(snapshot?.version === 1 && ["local-preview", "third-party-reference"].includes(snapshot.usage) && snapshot.series &&
      validTimestamp(snapshot.updatedAt) && Date.parse(snapshot.updatedAt) <= new Date(now).getTime() + 300000, "原油快照格式或时间无效");
    for (const id of Object.keys(definitions)) {
      validateSeries(snapshot.series[id], id, now);
      assert(snapshot.series[id].fetchedAt <= snapshot.updatedAt, "品种采集时间晚于快照时间");
    }
    assert(snapshot.series.wti.sourceName === snapshot.series.brent.sourceName, "两个品种必须使用同一数据来源");
    if (snapshot.collection !== undefined) {
      const info = snapshot.collection;
      assert(info && ["auto", "manual"].includes(info.mode) && ["updated", "retained"].includes(info.outcome) &&
        validTimestamp(info.checkedAt) && info.checkedAt >= snapshot.updatedAt &&
        Date.parse(info.checkedAt) <= new Date(now).getTime() + 300000 &&
        info.activeProvider === providerId(snapshot.series.wti), "原油采集状态无效");
      assert(info.switchedFrom === null || (providerPriority.includes(info.switchedFrom) &&
        info.switchedFrom !== info.activeProvider && info.outcome === "updated"), "原油来源切换状态无效");
      assert(Array.isArray(info.attempts) && info.attempts.length >= 1 && info.attempts.length <= 3 &&
        (info.mode === "auto" || info.attempts.length === 1), "原油采集尝试无效");
      info.attempts.forEach((attempt, index) => {
        assert(attempt && providerPriority.includes(attempt.provider) && typeof attempt.ok === "boolean" &&
          typeof attempt.reason === "string" && attempt.reason.length <= 500 &&
          (info.mode !== "auto" || attempt.provider === providerPriority[index]) &&
          (attempt.ok ? attempt.reason === "" : attempt.reason.length > 0) &&
          (!attempt.ok || index === info.attempts.length - 1), "原油采集尝试无效");
      });
      const last = info.attempts.at(-1);
      assert(info.outcome === "updated" ? last.ok && last.provider === info.activeProvider :
        info.attempts.every(attempt => !attempt.ok) && info.switchedFrom === null &&
        (info.mode !== "auto" || info.attempts.length === providerPriority.length), "原油采集结果无效");
    }
    return snapshot;
  }
  function view(series, days, now = new Date()) {
    const lastHistory = series.history.at(-1);
    // An unfinished bar remains a dated snapshot even after the session ends;
    // only a subsequent successful collection can promote it into history.
    const quote = series.intraday || lastHistory;
    const anchor = Date.parse(quote.date + "T00:00:00Z");
    const cutoff = anchor - days * 86400000;
    const points = series.history.filter(point => Date.parse(point.date + "T00:00:00Z") >= cutoff)
      .map(point => ({ ...point, kind: "daily" }));
    if (series.intraday) points.push({ ...series.intraday, kind: "intraday" });
    const previous = series.intraday ? lastHistory : series.history.at(-2);
    const difference = quote.price - previous.price;
    const today = dateInZone(now, "Asia/Shanghai").date;
    const age = (Date.parse(today + "T00:00:00Z") - anchor) / 86400000;
    return {
      points, quote, previous, difference, percent: difference / previous.price * 100,
      stale: age > 4 || new Date(now).getTime() - Date.parse(series.fetchedAt) > 4 * 86400000,
      isIntraday: Boolean(series.intraday), lastHistory
    };
  }

  const api = { definitions, providers, providerPriority, providerId, validDate, validTimestamp, dateInZone, completedSession, validateSeries, validateSnapshot, view };
  root.BesFuelCrude = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
