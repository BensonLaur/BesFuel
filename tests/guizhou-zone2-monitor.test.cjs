'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const monitor = require('../scripts/monitors/guizhou-zone2.cjs');
const verified = require('../data/verified/guizhou-zone2.json');
const { checkMonitors } = require('../scripts/check-monitors.cjs');

const listUrl = 'https://fgw.guizhou.gov.cn/fggz/tzgg/index.html';
const articleUrl = 'https://fgw.guizhou.gov.cn/fggz/tzgg/202610/t20261015_90999999.html';
const title = '2026年10月15日24时起贵州成品油价格调整';

function list() {
  return `<li><a TARGET="_blank" title="普通公告" href="https://fgw.guizhou.gov.cn/other">普通公告</a><span>2026-10-16</span></li>
    <li><a TARGET="_blank" title="${title}" href="${articleUrl}">${title}</a><span>2026-10-15</span></li>`;
}

function article(gas = './W020261015123456789012.png', diesel = './W020261015123456789013.jpg') {
  return `<meta name="ArticleTitle" content="${title}">
    <meta name="PubDate" content="2026-10-15 16:56:18">
    <div class="Article_Con aBox">
      <p>贵州省各价区汽油销售价格表</p><p>贵州省各价区柴油销售价格表</p>
      <img data-src="https://mmbiz.qpic.cn/example" src="${gas}">
      <img src="${diesel}">
    </div>`;
}

function getText(contents) {
  return async (url) => {
    if (url === listUrl) return list();
    if (url === articleUrl) return contents;
    throw new Error(`unexpected URL: ${url}`);
  };
}

test('discovers the newest official notice but leaves two image price tables for review', async () => {
  const result = await monitor.collect({ getText: getText(article()) });
  assert.deepEqual(result, {
    url: articleUrl,
    publishedDate: '2026-10-15',
    effectiveDate: '2026-10-16',
    imageUrls: [
      'https://fgw.guizhou.gov.cn/fggz/tzgg/202610/W020261015123456789012.png',
      'https://fgw.guizhou.gov.cn/fggz/tzgg/202610/W020261015123456789013.jpg',
    ],
    requiresManualPriceReview: true,
  });
  assert.equal('prices' in result, false);
});

test('rejects a nonofficial image rather than accepting a price table from another host', async () => {
  await assert.rejects(
    monitor.collect({ getText: getText(article('https://example.com/price.png')) }),
    /价格表图片数量异常|价格表图片不是预期的省发改委地址/,
  );
});

test('new announcement URL is reported for manual price review', async () => {
  const results = await checkMonitors({
    modules: [monitor],
    data: { regions: { 'guizhou-zone2': { source: { url: verified.notices.at(-1).url } } } },
    reader: () => ({ getText: getText(article()) }),
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].needsReview, true);
});

test('audited second-zone history remains distinct and links both official tables', () => {
  assert.equal(verified.notices.length, 11);
  assert.match(verified.priceScope, /安顺、黔南.*修文县、开阳县、息烽县、清镇市/);
  assert.deepEqual(verified.notices.at(-1).prices, { 92: 8.77, 95: 9.27, diesel: 8.43 });
  const dates = verified.notices.map((notice) => notice.effectiveDate);
  assert.deepEqual(dates, [...dates].sort());
  for (const notice of verified.notices) {
    assert.match(notice.url, /^https:\/\/fgw\.guizhou\.gov\.cn\/fggz\/tzgg\/\d{6}\/t\d{8}_\d+\.html$/);
    for (const image of [notice.imageUrl, notice.dieselImageUrl]) {
      assert.match(image, /^https:\/\/fgw\.guizhou\.gov\.cn\/fggz\/tzgg\/\d{6}\/W\d+(?:_ORIGIN)?\.(?:png|jpg)$/);
    }
    for (const price of Object.values(notice.prices)) {
      assert.ok(price >= 5 && price <= 15);
    }
  }
});
