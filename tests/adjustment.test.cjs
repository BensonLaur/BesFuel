const assert = require("node:assert/strict");
const test = require("node:test");
const { isWorkday, nextWindowAfter } = require("../scripts/next-window.cjs");
const { parseHome, verifyArticle, checkForecast, readCheckReport } = require("../scripts/read-market-forecast.cjs");
const { planAlerts, deliver } = require("../scripts/review-alerts.cjs");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

test("2026 holiday and makeup day move the ten-workday window to October 15", () => {
  assert.equal(isWorkday("2026-09-25"), false);
  assert.equal(isWorkday("2026-10-10"), true);
  assert.equal(nextWindowAfter("2026-09-24", "2026-09-28"), "2026-10-15");
  assert.equal(nextWindowAfter("2026-09-24", "2026-10-16"), "2026-10-29");
  assert.equal(nextWindowAfter("2026-12-31", "2026-12-31"), null);
});

test("unchanged official rounds provide the next-window anchor just like price changes", () => {
  assert.equal(nextWindowAfter("2026-10-15", "2026-10-16"), "2026-10-29");
  assert.equal(nextWindowAfter("2026-10-29", "2026-10-30"), "2026-11-12");
});

const home = `<table><tr><td>原油变化率</td><td>下轮油价预测</td><td>工作日</td><td>当前计算日</td></tr>
<tr><td><b>-4.70%</b></td><td><b><font>降0.18元/升</font></b></td><td>1</td>
<td><a href="/yuanyou/bianhualv/814.html">2026年9月28日</a></td></tr></table>
<div>下次调价：2026-10-15</div>`;
const article = `<title>2026年9月28日最新三地原油变化率</title>
<meta name="description" content="9月28日，国内第1个工作日，折合成油价下调0.18元升，调价详细时间为2026年10月15日24时开启。">`;

test("market estimate is tied to its article, calculation day and current window", () => {
  const forecast = parseHome(home, "2026-10-15", "2026-09-28");
  assert.equal(forecast.description, "预计下调约 0.18 元/升");
  assert.equal(forecast.workday, 1);
  assert.equal(forecast.sourceUrl, "https://www.tuanyou.net/yuanyou/bianhualv/814.html");
  assert.deepEqual(verifyArticle(article, forecast), forecast);
  assert.throws(() => parseHome(home, "2026-10-29", "2026-09-28"), /do not match/);
  assert.deepEqual(parseHome(home, "2026-10-15", "2026-10-06"), forecast);
  assert.throws(() => parseHome(home, "2026-10-15", "2026-09-27"), /safe bounds/);
  assert.throws(() => parseHome(home, "2026-10-15", "2026-10-16"), /safe bounds/);
  assert.throws(() => verifyArticle(article.replace("0.18", "0.81"), forecast), /disagrees/);
});

test("older estimates still require matching article values and valid dates and workdays", () => {
  const forecast = parseHome(home, "2026-10-15", "2026-10-06");
  assert.equal(forecast.updatedAt, "2026-09-28");
  assert.deepEqual(verifyArticle(article, forecast), forecast);
  assert.throws(() => verifyArticle(article.replace("下调", "上调"), forecast), /disagrees/);
  assert.throws(() => parseHome(home.replace("9月28日", "9月31日"), "2026-10-15", "2026-10-06"), /safe bounds/);
  assert.throws(() => parseHome(home.replace("<td>1</td>", "<td>11</td>"), "2026-10-15", "2026-10-06"), /safe bounds/);
});

// Key fields captured from the 2026-10-27 response that the old parser rejected.
const risingHome = home.replaceAll("-4.70%", "7.66%").replace("降0.18", "涨0.29")
  .replace("<td>1</td>", "<td>8</td>").replace("814.html", "831.html")
  .replace("2026年9月28日", "2026年10月27日").replace("2026-10-15", "2026-10-29");
const risingArticle = `<title>2026年10月27日最新三地原油变化率_油价调整最新消息 - 团友</title>
<meta name="description" content="10月27日，国内第8个工作日综合原油品种变化率为7.66%，国内汽、柴油油价上涨360元/吨，折合成油价上涨0.29元升，调价详细时间为2026年10月29日24时开启。" />`;

test("rising source wording and metadata formatting preserve direction, cents and units", () => {
  const up = parseHome(risingHome, "2026-10-29", "2026-10-28");
  for (const word of ["上涨", "上调"]) {
    for (const unit of ["元升", "元/升"]) {
      assert.deepEqual(verifyArticle(risingArticle.replaceAll("上涨", word).replace("0.29元升", "0.29" + unit), up), up);
    }
  }
  const reformatted = risingArticle.replace('<meta name="description" content="', "<META content='")
    .replace('" />', "' NAME='description' />").replace("0.29元升", " 0.29&nbsp;元 / 升 ");
  assert.deepEqual(verifyArticle(reformatted, up), up);
  for (const word of ["下调", "下降", "下跌"]) {
    assert.deepEqual(verifyArticle(article.replace("下调", word), parseHome(home, "2026-10-15", "2026-09-28")),
      parseHome(home, "2026-10-15", "2026-09-28"));
  }
  const decimal = { ...up, amountPerLiter: 0.2 };
  assert.deepEqual(verifyArticle(risingArticle.replace("0.29", "0.20"), decimal), decimal);
  assert.deepEqual(verifyArticle(risingArticle.replace("0.29", "0.2"), decimal), decimal);
});

test("semantic comparison still rejects conflicting dates, workdays, direction, amount and tonne units", () => {
  const up = parseHome(risingHome, "2026-10-29", "2026-10-28");
  for (const [from, to, reason] of [
    ["2026年10月27日", "2026年10月26日", "计算日期"],
    ["10月27日，", "10月26日，", "计算日期"],
    ["2026年10月29日", "2026年11月12日", "调价窗口"],
    ["第8个工作日", "第7个工作日", "工作日"],
    ["上涨0.29", "下跌0.29", "涨跌方向"],
    ["0.29元升", "0.92元升", "每升调幅"],
    ["0.29元升", "0.29元/吨", "每升调幅"],
    ["0.29元升", "0.29元升或上调0.30元/升", "唯一的每升调幅"],
    ["0.29元升", "0.290元升", "每升调幅"]
  ]) assert.throws(() => verifyArticle(risingArticle.replace(from, to), up), new RegExp(reason));
  assert.throws(() => verifyArticle(risingArticle + risingArticle, up), /disagrees/);
});

const reader = (summary = risingHome, detail = risingArticle) => async url => url.endsWith("/youjia/") ? summary : detail;
const alertReport = result => ({ version: 1, results: [result] });

test("market validation failures alert once and a verified collection resolves the alert", async () => {
  const bad = await checkForecast("2026-10-29", "2026-10-28", { readText: reader(risingHome, risingArticle.replace("0.29", "0.30")) });
  assert.equal(bad.forecast, undefined);
  assert.equal(bad.result.failure.url, "https://www.tuanyou.net/yuanyou/bianhualv/831.html");
  const plan = planAlerts(alertReport(bad.result), undefined, "1");
  assert.equal(plan.actions[0].kind, "alert");
  assert.equal(planAlerts(alertReport(bad.result), plan.state, "2").actions.length, 0);
  const good = await checkForecast("2026-10-29", "2026-10-28", { readText: reader() });
  assert.equal(good.forecast.amountPerLiter, 0.29);
  assert.deepEqual(planAlerts(alertReport(good.result), plan.state, "3").actions.map(a => a.kind), ["resolve"]);
  let posted;
  await deliver(plan.actions, { token: "test", repository: "owner/repo", fetcher: async (url, options) => {
    if (options.method === "POST") posted = JSON.parse(options.body);
    return new Response(JSON.stringify(options.method === "GET" ? [] : { number: 1 }), { status: 200 });
  } });
  assert.match(posted.body, /全国市场估算/);
  assert.match(posted.body, /第三方来源/);
  assert.doesNotMatch(posted.body, /官方依据|该地区/);
});

test("temporary market network failures use the existing three-run threshold and stale estimates stay dated", async () => {
  const failed = await checkForecast("2026-10-29", "2026-10-28", { readText: async () => {
    throw Object.assign(new Error("timed out"), { details: { category: "timeout", url: "https://www.tuanyou.net/youjia/" } });
  } });
  let state;
  for (let run = 1; run <= 3; run++) {
    const plan = planAlerts(alertReport(failed.result), state, String(run));
    assert.equal(plan.actions.length, run === 3 ? 1 : 0);
    state = plan.state;
  }
  const old = await checkForecast("2026-10-15", "2026-10-06", { readText: reader(home, article) });
  assert.equal(old.forecast.updatedAt, "2026-09-28");
  assert.equal(old.result.ok, false);
  assert.match(old.result.error, /超过两天/);
});

test("missing, malformed and previous-run market reports cannot silently count as a healthy check", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "besfuel-market-report-"));
  const file = path.join(directory, "report.json");
  try {
    assert.equal(readCheckReport(file, "2026-10-28")[0].ok, false);
    for (const content of ["invalid", JSON.stringify({ version: 1, checkedAt: "2026-10-27", results: [{ id: "market-forecast", ok: true }] }),
      JSON.stringify({ version: 1, checkedAt: "2026-10-28", results: [{ id: "guangdong", ok: true }] })]) {
      fs.writeFileSync(file, content);
      assert.equal(readCheckReport(file, "2026-10-28")[0].ok, false);
    }
    const result = { id: "market-forecast", ok: true };
    fs.writeFileSync(file, JSON.stringify({ version: 1, checkedAt: "2026-10-28", results: [result] }));
    assert.deepEqual(readCheckReport(file, "2026-10-28"), [result]);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("besfuel-market-report-"));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
