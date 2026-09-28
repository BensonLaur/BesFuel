'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const monitor = require('../scripts/monitors/shandong.cjs');
const verified = require('../data/verified/shandong.json');
const { checkMonitors } = require('../scripts/check-monitors.cjs');
const { importVerified } = require('../scripts/import-verified.cjs');

const listUrl = 'https://fgw.weihai.gov.cn/col/col53887/index.html';
const articleUrl = 'https://fgw.weihai.gov.cn/art/2026/10/15/art_53887_99999999.html';

function article({ diesel = '8.54', date = '2026年10月15日', titleDate = '2026年10月15日',
  pageDate = '2026-10-15', duplicateDiesel = false } = {}) {
  return `<meta name="ArticleTitle" content="${titleDate}24时起，我省成品油价格按机制上调">
    <meta name="PubDate" content="${pageDate} 16:13">
    <div class="art_con"><p>根据国家发展改革委发布的调价信息，自${date}24时起，我省汽、柴油最高零售价格调整。</p>
    <p>山东省成品油最高批发价格和零售价格表</p>
    <table><tr><td>品种</td><td>最高零售价格 元/升</td><td>配送</td><td>未配送</td></tr>
      <tr><td>89号</td><td>8.25</td><td>10500</td><td>10450</td></tr>
      <tr><td>92号</td><td>8.88</td><td>11450</td><td>11400</td></tr>
      <tr><td>95号</td><td>9.52</td><td>12100</td><td>12050</td></tr>
      <tr><td>0号</td><td>${diesel}</td><td>9700</td><td>9650</td></tr>
      ${duplicateDiesel ? '<tr><td>0号</td><td>8.55</td><td>9700</td><td>9650</td></tr>' : ''}
      <tr><td>-10号</td><td>9.01</td><td>10300</td><td>10250</td></tr></table></div>`;
}

function readers({ href = articleUrl, body = article() } = {}) {
  return { async getText(url) {
    if (url === listUrl) return `<main>价格信息
      <a href="/art/2026/9/24/art_53887_6642605.html" title="2026年9月24日24时起，我省成品油价格按机制上调">旧公告</a><span>2026-09-24</span>
      <a href="${href}" title="2026年10月15日24时起，我省成品油价格按机制上调">新公告</a><span>2026-10-15</span></main>`;
    if (url === href) return body;
    throw new Error(`unexpected URL: ${url}`);
  } };
}

test('discovers latest provincial notice and reads only the liter retail column', async () => {
  assert.deepEqual(await monitor.collect(readers()), {
    url: articleUrl,
    publishedDate: '2026-10-15',
    effectiveDate: '2026-10-16',
    prices: { 92: 8.88, 95: 9.52, diesel: 8.54 },
    requiresManualPriceReview: true,
  });
});

test('rejects foreign source, conflicting path date, and article date', async () => {
  await assert.rejects(monitor.collect(readers({ href: 'https://example.org/art/2026/10/15/art_53887_99999999.html' })), /不是预期/);
  await assert.rejects(monitor.collect(readers({ href: 'https://fgw.weihai.gov.cn/art/2026/10/16/art_53887_99999999.html' })), /列表日期与公告路径不符/);
  await assert.rejects(monitor.collect(readers({ body: article({ pageDate: '2026-10-14' }) })), /标题或发布日期与列表不符/);
  await assert.rejects(monitor.collect(readers({ body: article({ date: '2026年10月14日' }) })), /生效时间缺失/);
});

test('rejects missing, duplicate or malformed 0号柴油 retail rows', async () => {
  await assert.rejects(monitor.collect(readers({ body: article({ diesel: '待核实' }) })), /元\/升或批发价表列异常/);
  await assert.rejects(monitor.collect(readers({ body: article({ duplicateDiesel: true }) })), /元\/升或批发价表列异常/);
  await assert.rejects(monitor.collect(readers({ body: article().replace('<td>0号</td>', '<td>1号</td>') })), /缺少可信的 92、95 或 0 号/);
});

test('new official notice is flagged for manual review', async () => {
  const results = await checkMonitors({
    modules: [monitor],
    data: { regions: { shandong: { source: { url: verified.notices.at(-1).url } } } },
    reader: () => readers(),
  });
  assert.equal(results[0].ok, true);
  assert.equal(results[0].needsReview, true);
  assert.deepEqual(results[0].latest.prices, { 92: 8.88, 95: 9.52, diesel: 8.54 });
});

test('12 independently linked government tables import as one province price zone', () => {
  assert.equal(verified.notices.length, 12);
  assert.equal(verified.unit, '元/升');
  assert.match(verified.priceScope, /未另列市县价区/);
  assert.match(verified.notices.at(-1).url, /^https:\/\/fgw\.weihai\.gov\.cn\//);
  assert.match(verified.notices.at(-1).originalUrl, /^http:\/\/fgw\.shandong\.gov\.cn\//);
  assert.deepEqual(verified.notices.at(-1).prices, { 92: 8.57, 95: 9.20, diesel: 8.21 });
  assert.deepEqual(verified.notices.find(item => item.publishedDate === '2026-07-03').prices,
    { 92: 7.14, 95: 7.66, diesel: 6.74 });
  assert.deepEqual(verified.notices.map(item => item.effectiveDate),
    [...verified.notices.map(item => item.effectiveDate)].sort());
  for (const notice of verified.notices) {
    const url = new URL(notice.url);
    assert.ok(verified.allowedHostnames.includes(url.hostname));
    assert.equal(notice.prices.diesel < notice.prices['92'] && notice.prices['92'] < notice.prices['95'], true);
  }
  const existing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'prices.json'), 'utf8'));
  const imported = importVerified(existing, verified);
  assert.equal(imported.regions.shandong.grades['92'].price, 8.57);
  assert.equal(imported.regions.shandong.grades['95'].history.length, 12);
});
