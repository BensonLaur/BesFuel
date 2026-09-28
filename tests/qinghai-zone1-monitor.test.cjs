'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const monitor = require('../scripts/monitors/qinghai-zone1.cjs');
const verified = require('../data/verified/qinghai-zone1.json');
const { checkMonitors } = require('../scripts/check-monitors.cjs');
const { importVerified } = require('../scripts/import-verified.cjs');

const listUrl = 'http://fgw.qinghai.gov.cn/xwzx/tzgg/';
const articleUrl = 'http://fgw.qinghai.gov.cn/xwzx/tzgg/202610/t20261015_99999.html';
const imageUrl = 'http://fgw.qinghai.gov.cn/xwzx/tzgg/202610/W020261015123456789.JPG';

function list(title = '我省调整省内成品油最高零售价格', href = articleUrl) {
  return `<li class="clearfix"><a href="http://fgw.qinghai.gov.cn/xwzx/tzgg/202610/t20261016_99998.html"
    target="_blank">其他公告</a><span>[2026-10-16]</span></li>
    <li class="clearfix"><a href="${href}" target="_blank">${title}</a><span>[2026-10-15]</span></li>`;
}

function article(image = './W020261015123456789.JPG', published = '2026年10月15日 16:11') {
  return `<h1>我省调整省内成品油最高零售价格</h1>
    <span>发布时间：${published}</span>
    <p>根据国家统一规定，我省自2026年10月15日24时起同步调整省内各价区汽、柴油最高零售价格。</p>
    <p>附件：青海省汽、柴油最高零售价格表</p>
    <p><img src="${image}" title="捕获.JPG" /></p>`;
}

function readers({ title, href, image, published } = {}) {
  return { async getText(url) {
    if (url === listUrl) return list(title, href);
    if (url === articleUrl) return article(image, published);
    throw new Error(`unexpected URL: ${url}`);
  } };
}

test('discovers the official image and requires a human to review new litre prices', async () => {
  assert.deepEqual(await monitor.collect(readers()), {
    url: articleUrl,
    publishedDate: '2026-10-15',
    effectiveDate: '2026-10-16',
    imageUrl,
    requiresManualPriceReview: true,
  });
});

test('rejects unknown notice, date mismatch, and non-official image', async () => {
  await assert.rejects(monitor.collect(readers({ title: '我省预测省内成品油最高零售价格' })), /未知油价公告标题/);
  await assert.rejects(monitor.collect(readers({ href: 'http://fgw.qinghai.gov.cn/xwzx/tzgg/202610/t20261014_99999.html' })), /公告路径与列表日期不符/);
  await assert.rejects(monitor.collect(readers({ published: '2026年10月14日 16:11' })), /发布日期与列表不符/);
  await assert.rejects(monitor.collect(readers({ image: 'https://example.org/prices.jpg' })), /图片数量异常|不是预期/);
  await assert.rejects(monitor.collect(readers({ image: './W020261014123456789.JPG' })), /图片日期与公告不符/);
});

test('new image cannot silently replace the audited snapshot', async () => {
  const results = await checkMonitors({
    modules: [monitor],
    data: { regions: { 'qinghai-zone1': { source: { url: verified.notices.at(-1).url } } } },
    reader: () => readers(),
  });
  assert.equal(results[0].ok, true);
  assert.equal(results[0].needsReview, true);
  assert.equal('prices' in results[0].latest, false);
});

test('official first-zone history includes the July 3 adjustment and imports current prices', () => {
  assert.equal(verified.notices.length, 12);
  assert.match(verified.priceScope, /第一价区.*具体地区待省级正式划分文件复核/);
  assert.deepEqual(verified.notices.at(-1).prices, { 92: 8.57, 95: 9.19, diesel: 8.22 });
  assert.deepEqual(verified.notices.find(item => item.publishedDate === '2026-07-03').prices,
    { 92: 7.13, 95: 7.65, diesel: 6.75 });
  assert.deepEqual(verified.notices.map(item => item.effectiveDate),
    [...verified.notices.map(item => item.effectiveDate)].sort());
  for (const notice of verified.notices) {
    assert.match(notice.url, /^http:\/\/fgw\.qinghai\.gov\.cn\/(?:xwzx\/tzgg|sjfb\/jgdt)\/\d{6}\/t\d{8}_\d+\.html$/);
    assert.match(notice.imageUrl, /^http:\/\/fgw\.qinghai\.gov\.cn\/(?:xwzx\/tzgg|sjfb\/jgdt)\/\d{6}\/W\d+\.(?:JPG|png)$/);
    assert.ok(notice.prices.diesel < notice.prices['92'] && notice.prices['92'] < notice.prices['95']);
  }
  const existing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'prices.json'), 'utf8'));
  const data = importVerified(existing, verified);
  assert.equal(data.regions['qinghai-zone1'].grades.diesel.price, 8.22);
  assert.equal(data.regions['qinghai-zone1'].grades['92'].history.length, 12);
});
