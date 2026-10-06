const assert = require("node:assert/strict");
const test = require("node:test");
const { isWorkday, nextWindowAfter } = require("../scripts/next-window.cjs");
const { parseHome, verifyArticle } = require("../scripts/read-market-forecast.cjs");

test("2026 holiday and makeup day move the ten-workday window to October 15", () => {
  assert.equal(isWorkday("2026-09-25"), false);
  assert.equal(isWorkday("2026-10-10"), true);
  assert.equal(nextWindowAfter("2026-09-24", "2026-09-28"), "2026-10-15");
  assert.equal(nextWindowAfter("2026-09-24", "2026-10-16"), "2026-10-29");
  assert.equal(nextWindowAfter("2026-12-31", "2026-12-31"), null);
});

const home = `<table><tr><td>原油变化率</td><td>下轮油价预测</td><td>工作日</td><td>当前计算日</td></tr>
<tr><td><b>-4.70%</b></td><td><b><font>降0.18元/升</font></b></td><td>1</td>
<td><a href="/yuanyou/bianhualv/814.html">2026年9月28日</a></td></tr></table>
<div>下次调价：2026-10-15</div>`;
const article = `<title>2026年9月28日最新三地原油变化率</title>
<meta name="description" content="9月28日，折合成油价下调0.18元升，调价详细时间为2026年10月15日24时开启。">`;

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
