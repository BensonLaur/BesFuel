'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const monitor = require('../scripts/monitors/yunnan-zone2.cjs');
const verified = require('../data/verified/yunnan-zone2.json');
const { checkMonitors } = require('../scripts/check-monitors.cjs');
const { importVerified } = require('../scripts/import-verified.cjs');

const listUrl = 'https://yndrc.yn.gov.cn/html/fagaishuju/jiagegongbu/';
const articleUrl = 'https://yndrc.yn.gov.cn/html/2026/meidianyouqi_1015/29999.html';
const pdfUrl = 'https://yndrc.yn.gov.cn/uploadfile/s2/2026/1015/20261015012345678.pdf';

function listing(title = '云南省成品油价格按机制调整', href = '/html/2026/meidianyouqi_1015/29999.html') {
  return `<li><a href="/html/2026/jiageyushoufei_1016/30000.html">云南省重要民生商品零售价格情况</a><span>2026-10-16</span></li>
    <li><a href="${href}">${title}</a><span>2026-10-15</span></li>`;
}

function article(attachment = '/uploadfile/s2/2026/1015/20261015012345678.pdf') {
  return `<meta name="ArticleTitle" content="云南省成品油价格按机制调整">
    <meta name="PubDate" content="2026-10-15 17:50:58">
    <p>自10月15日24时起，调整后云南省各地区的汽、柴油最高零售价格见附表。</p>
    <p>附表：<a href="${attachment}">云南省各地区汽、柴油最高零售价格表</a></p>
    <p>2026年10月15日</p>`;
}

function readers({ title, href, attachment } = {}) {
  return { async getText(url) {
    if (url === listUrl) return listing(title, href);
    if (url === articleUrl) return article(attachment);
    throw new Error(`unexpected URL: ${url}`);
  } };
}

test('discovers the latest official notice and PDF for manual yuan-per-litre review', async () => {
  assert.deepEqual(await monitor.collect(readers()), {
    url: articleUrl,
    publishedDate: '2026-10-15',
    effectiveDate: '2026-10-16',
    pdfUrl,
    requiresManualPriceReview: true,
  });
});

test('rejects changed title, off-host links and PDF date mismatch', async () => {
  await assert.rejects(monitor.collect(readers({ title: '云南省成品油价格预测' })), /未知油价公告标题/);
  await assert.rejects(monitor.collect(readers({ href: 'https://example.org/notice.html' })), /不是预期/);
  await assert.rejects(monitor.collect(readers({ attachment: '/uploadfile/s2/2026/1014/20261014012345678.pdf' })),
    /PDF 日期与公告不符/);
});

test('a new PDF notice is flagged for review while the verified snapshot stays available', async () => {
  const results = await checkMonitors({
    modules: [monitor],
    data: { regions: { 'yunnan-zone2': { source: { url: verified.notices.at(-1).url } } } },
    reader: () => readers(),
  });
  assert.equal(results[0].ok, true);
  assert.equal(results[0].needsReview, true);
  assert.equal('prices' in results[0].latest, false);
});

test('twelve audited PDF tables have ordered effective dates and distinct second-zone prices', () => {
  assert.equal(verified.notices.length, 12);
  assert.match(verified.priceScope, /曲靖、楚雄、玉溪/);
  assert.deepEqual(verified.notices.at(-1).prices, { 92: 8.83, 95: 9.48, diesel: 8.45 });
  assert.deepEqual(verified.notices.map((notice) => notice.effectiveDate),
    [...verified.notices.map((notice) => notice.effectiveDate)].sort());
  for (const notice of verified.notices) {
    assert.match(notice.url, /^https:\/\/yndrc\.yn\.gov\.cn\/html\/2026\/[a-z]+_\d{4}\/\d+\.html$/);
    assert.match(notice.pdfUrl, /^https:\/\/yndrc\.yn\.gov\.cn\/uploadfile\/s2\/2026\/\d{4}\/\d{17}\.pdf$/);
    assert.ok(notice.prices.diesel < notice.prices['92'] && notice.prices['92'] < notice.prices['95']);
  }
  const existing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'prices.json'), 'utf8'));
  const data = importVerified(existing, verified);
  assert.equal(data.regions['yunnan-zone2'].grades['92'].price, 8.83);
  assert.equal(data.regions['yunnan-zone2'].grades['92'].history.length, 12);
});
