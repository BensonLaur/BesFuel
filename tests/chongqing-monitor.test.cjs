'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const monitor = require('../scripts/monitors/chongqing.cjs');
const verified = require('../data/verified/chongqing.json');
const { checkMonitors } = require('../scripts/check-monitors.cjs');
const { importVerified } = require('../scripts/import-verified.cjs');

const listUrl = 'https://fzggw.cq.gov.cn/zwgk/zfxxgkml/jgxx/jgzc/';
const articleUrl = 'https://fzggw.cq.gov.cn/zwgk/zfxxgkml/jgxx/jgzc/202610/t20261015_999999.html';

function article({ date = '2026年10月15日', pageDate = '2026-10-15',
  diesel = '8.54', version = '（Ⅵ）', wholesale = '9400', unit = '元/升' } = {}) {
  return `<meta name="ArticleTitle" content="重庆市成品油价格调整">
    <meta name="PubDate" content="${pageDate} 17:30">
    <meta name="ContentSource" content="市发展改革委">
    <p>现将我市汽、柴油最高零售、批发价格公布如下，自${date}24时起执行。</p>
    <table><tr><td>品种</td><td colspan="4">最高销售价格</td></tr>
      <tr><td>规格</td><td>标准</td><td>零售价（${unit}）</td><td>零售价（元/吨）</td><td>批发价（元/吨）</td></tr>
      <tr><td>89号汽油</td><td>（ⅥB）</td><td>8.42</td><td>11220</td><td>10920</td></tr>
      <tr><td>92号汽油</td><td>（ⅥB）</td><td>8.88</td><td>11840</td><td>11540</td></tr>
      <tr><td>95号汽油</td><td>（ⅥB）</td><td>9.52</td><td>12690</td><td>12390</td></tr>
      <tr><td>0号柴油</td><td>${version}</td><td>${diesel}</td><td>9700</td><td>${wholesale}</td></tr>
      <tr><td>-10号柴油</td><td>（Ⅵ）</td><td>9.01</td><td>10282</td><td>9982</td></tr></table>`;
}

function readers({ href = articleUrl, listDate = '2026-10-15', body = article() } = {}) {
  return { async getText(url) {
    if (url === listUrl) return `<main>价格政策
      <li class="clearfix"><a href="./202609/t20260924_16130868.html" title="重庆市成品油价格调整">重庆市成品油价格调整</a><span class="rt">2026-09-24</span></li>
      <li class="clearfix"><a href="${href}" title="重庆市成品油价格调整">重庆市成品油价格调整</a><span class="rt">${listDate}</span></li></main>`;
    if (url === href) return body;
    throw new Error(`unexpected URL: ${url}`);
  } };
}

test('finds latest municipal notice and reads only the liter retail column', async () => {
  assert.deepEqual(await monitor.collect(readers()), {
    url: articleUrl,
    publishedDate: '2026-10-15',
    effectiveDate: '2026-10-16',
    prices: { 92: 8.88, 95: 9.52, diesel: 8.54 },
    requiresManualPriceReview: true,
  });
});

test('accepts one-day late publication while keeping the 24:00 adjustment date', async () => {
  const url = 'https://fzggw.cq.gov.cn/zwgk/zfxxgkml/jgxx/jgzc/202610/t20261016_999999.html';
  const result = await monitor.collect(readers({
    href: url,
    listDate: '2026-10-16',
    body: article({ date: '2026年10月15日', pageDate: '2026-10-16' }),
  }));
  assert.equal(result.publishedDate, '2026-10-15');
  assert.equal(result.effectiveDate, '2026-10-16');
});

test('rejects foreign host, path mismatch and inconsistent effective date', async () => {
  await assert.rejects(monitor.collect(readers({ href: 'https://example.org/zwgk/zfxxgkml/jgxx/jgzc/202610/t20261015_999999.html' })), /不是预期/);
  await assert.rejects(monitor.collect(readers({ href: 'https://fzggw.cq.gov.cn/zwgk/zfxxgkml/jgxx/jgzc/202609/t20261015_999999.html' })), /路径月份与日期不符/);
  await assert.rejects(monitor.collect(readers({ body: article({ date: '2026年10月16日' }) })), /发布日期与调价日期冲突/);
});

test('rejects missing or malformed liter price, fuel standard, and wholesale column', async () => {
  await assert.rejects(monitor.collect(readers({ body: article({ diesel: '待核实' }) })), /元\/升或吨价表列异常/);
  await assert.rejects(monitor.collect(readers({ body: article({ version: '（Ⅴ）' }) })), /元\/升或吨价表列异常/);
  await assert.rejects(monitor.collect(readers({ body: article({ wholesale: '9399' }) })), /元\/升或吨价表列异常/);
  await assert.rejects(monitor.collect(readers({ body: article({ unit: '元/吨' }) })), /元\/升单位缺失/);
  await assert.rejects(monitor.collect(readers({ body: article().replace('<td>0号柴油</td>', '<td>5号柴油</td>') })), /缺少可信的 92、95 或 0 号/);
});

test('new notice is flagged while the vetted 12-period citywide price snapshot stays intact', async () => {
  const results = await checkMonitors({
    modules: [monitor],
    data: { regions: { chongqing: { source: { url: verified.notices.at(-1).url } } } },
    reader: () => readers(),
  });
  assert.equal(results[0].ok, true);
  assert.equal(results[0].needsReview, true);
  assert.deepEqual(results[0].latest.prices, { 92: 8.88, 95: 9.52, diesel: 8.54 });
});

test('12 official tables include late-posted April and July notices and import cleanly', () => {
  assert.equal(verified.unit, '元/升');
  assert.equal(verified.notices.length, 12);
  assert.match(verified.priceScope, /未列区县价区/);
  assert.deepEqual(verified.notices.at(-1).prices, { 92: 8.67, 95: 9.16, diesel: 8.36 });
  assert.deepEqual(verified.notices.find(item => item.publishedDate === '2026-07-03').prices,
    { 92: 7.25, 95: 7.66, diesel: 6.90 });
  assert.match(verified.notices.find(item => item.publishedDate === '2026-04-21').url, /t20260422_/);
  assert.equal(verified.notices.find(item => item.publishedDate === '2026-07-03').effectiveDate, '2026-07-04');
  assert.deepEqual(verified.notices.map(item => item.effectiveDate),
    [...verified.notices.map(item => item.effectiveDate)].sort());
  for (const notice of verified.notices) {
    assert.match(notice.url, /^https:\/\/fzggw\.cq\.gov\.cn\/zwgk\/zfxxgkml\/jgxx\/jgzc\/\d{6}\/t\d{8}_\d+\.html$/);
    assert.ok(notice.prices.diesel < notice.prices['92'] && notice.prices['92'] < notice.prices['95']);
  }
  const existing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'prices.json'), 'utf8'));
  const imported = importVerified(existing, verified);
  assert.equal(imported.regions.chongqing.grades['92'].price, 8.67);
  assert.equal(imported.regions.chongqing.grades.diesel.history.length, 12);
});
