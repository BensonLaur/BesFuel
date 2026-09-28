'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const monitor = require('../scripts/monitors/shaanxi-midnorth.cjs');
const verified = require('../data/verified/shaanxi-midnorth.json');
const { checkMonitors } = require('../scripts/check-monitors.cjs');
const { importVerified } = require('../scripts/import-verified.cjs');

const listUrl = 'https://sndrc.shaanxi.gov.cn/sy/xwxx/gggg/index.html';
const articleUrl = 'https://sndrc.shaanxi.gov.cn/sy/xwxx/gggg/202610/t20261015_3999999.html';
const imageUrl = 'https://sndrc.shaanxi.gov.cn/sy/xwxx/gggg/202610/W020261015123456789012_ORIGIN.png';

function list(title = '陕西省成品油价格调整通告', href = './202610/t20261015_3999999.html') {
  return `<li><a href="./202610/t20261016_3999998.html">其他公告</a><span>2026-10-16</span></li>
    <li><a href="${href}">${title}</a><span>2026-10-15</span></li>`;
}

function article(image = './W020261015123456789012_ORIGIN.png') {
  return `<title> 陕西省成品油价格调整通告</title>
    <span>发布时间：2026-10-15</span>
    <p>现将我省汽、柴油最高零售价格公布如下，自2026年10月15日24时起执行。</p>
    <p><img src="${image}" alt="" /></p>
    <p>陕西省发展和改革委员会　2026年10月15日</p>`;
}

function readers({ title, href, image } = {}) {
  return { async getText(url) {
    if (url === listUrl) return list(title, href);
    if (url === articleUrl) return article(image);
    throw new Error(`unexpected URL: ${url}`);
  } };
}

test('discovers the official table image and leaves new litre prices for manual review', async () => {
  assert.deepEqual(await monitor.collect(readers()), {
    url: articleUrl,
    publishedDate: '2026-10-15',
    effectiveDate: '2026-10-16',
    imageUrl,
    requiresManualPriceReview: true,
  });
});

test('rejects unrecognized oil notice, external image and mismatched image date', async () => {
  await assert.rejects(monitor.collect(readers({ title: '陕西省成品油价格预测通告' })), /未知油价公告标题/);
  await assert.rejects(monitor.collect(readers({ image: 'https://example.org/prices.png' })), /图片数量异常|不是预期/);
  await assert.rejects(monitor.collect(readers({ image: './W020261014123456789012.png' })), /图片日期与公告不符/);
});

test('new announcement requires review and cannot overwrite trusted prices', async () => {
  const results = await checkMonitors({
    modules: [monitor],
    data: { regions: { 'shaanxi-midnorth': { source: { url: verified.notices.at(-1).url } } } },
    reader: () => readers(),
  });
  assert.equal(results[0].ok, true);
  assert.equal(results[0].needsReview, true);
  assert.equal('prices' in results[0].latest, false);
});

test('audited history combines the northern gasoline row with the non-Xian diesel row', () => {
  assert.equal(verified.notices.length, 12);
  assert.match(verified.priceScope, /中北部价区.*其他价区.*不含西安市区/);
  assert.deepEqual(verified.notices.at(-1).prices, { 92: 8.49, 95: 8.97, diesel: 8.36 });
  assert.notEqual(verified.notices.at(-1).prices.diesel, 8.19); // 官方西安市区 0 号柴油价。
  assert.deepEqual(verified.notices.map((notice) => notice.effectiveDate),
    [...verified.notices.map((notice) => notice.effectiveDate)].sort());
  for (const notice of verified.notices) {
    assert.match(notice.url, /^https:\/\/sndrc\.shaanxi\.gov\.cn\/sy\/xwxx\/gggg\/\d{6}\/t\d{8}_\d+\.html$/);
    assert.match(notice.imageUrl, /^https:\/\/sndrc\.shaanxi\.gov\.cn\/sy\/xwxx\/gggg\/\d{6}\/W\d+(?:_ORIGIN)?\.png$/);
    assert.ok(notice.prices.diesel < notice.prices['92'] && notice.prices['92'] < notice.prices['95']);
  }
  const existing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'prices.json'), 'utf8'));
  const data = importVerified(existing, verified);
  assert.equal(data.regions['shaanxi-midnorth'].grades.diesel.price, 8.36);
  assert.equal(data.regions['shaanxi-midnorth'].grades['92'].history.length, 12);
});
