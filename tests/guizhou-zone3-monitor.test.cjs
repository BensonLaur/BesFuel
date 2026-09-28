'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const monitor = require('../scripts/monitors/guizhou-zone3.cjs');
const verified = require('../data/verified/guizhou-zone3.json');

const base = 'https://fgw.guizhou.gov.cn/fggz/tzgg/';
const oldUrl = `${base}202609/t20260924_90940085.html`;
const newUrl = `${base}202610/t20261015_91000123.html`;
const newTitle = '2026年10月15日24时起贵州成品油价格调整';

function list({ title = newTitle, href = newUrl } = {}) {
  return `<ul class="NewsList">
    <li><a TARGET="_blank" title="${title}" href="${href}">${title}</a><span>2026-10-15</span></li>
    <li><a title="其他公告" href="${base}202610/t20261014_91000001.html">其他公告</a><span>2026-10-14</span></li>
    <li><a title="2026年9月24日24时起贵州成品油价格调整" href="${oldUrl}">旧公告</a><span>2026-09-24</span></li>
  </ul>`;
}

function article({ gasoline = './W020261015123456789012.png',
  diesel = './W020261015123456789013.png', source = '贵州省发展和改革委员会' } = {}) {
  return `<meta name="SiteName" content="${source}">
    <meta name="ArticleTitle" content="${newTitle}">
    <meta name="PubDate" content="2026-10-15 16:56:18">
    <div class="ArticleTitle">${newTitle}</div>
    <font id="Zoom"><div>
      <p>根据国际市场油价变化情况，国家发展改革委决定自2026年10月15日24时起调整国内成品油价格。</p>
      <p>附件：1．贵州省各价区汽油销售价格表</p>
      <p>2．贵州省各价区柴油（国VI）销售价格表</p>
      <img src="${gasoline}" /><img src="${diesel}" />
    </div></font>`;
}

function getText(listHtml, articleHtml) {
  return async (url) => {
    if (url === base) return listHtml;
    assert.equal(url, newUrl);
    return articleHtml;
  };
}

test('finds a newer official announcement and flags both images for human price review', async () => {
  const result = await monitor.collect({ getText: getText(list(), article()) });
  assert.deepEqual(result, {
    url: newUrl,
    publishedDate: '2026-10-15',
    gasolineImageUrl: `${base}202610/W020261015123456789012.png`,
    dieselImageUrl: `${base}202610/W020261015123456789013.png`,
    requiresManualPriceReview: true,
  });
  assert.equal('prices' in result, false);
});

test('rejects an image outside the official article directory', async () => {
  await assert.rejects(monitor.collect({
    getText: getText(list(), article({ diesel: 'https://example.com/price.png' })),
  }), /柴油价格图片不是预期的官网地址/);
});

test('rejects an incomplete pair of price attachments', async () => {
  await assert.rejects(monitor.collect({
    getText: getText(list(), article().replace(/<img src="\.\/W020261015123456789013\.png" \/>/, '')),
  }), /附件图片数量异常/);
});

test('rejects an unrecognized oil-price title or unexpected website identity', async () => {
  await assert.rejects(monitor.collect({
    getText: getText(list({ title: '2026年10月15日贵州成品油价格预报' }), article()),
  }), /未知标题/);
  await assert.rejects(monitor.collect({
    getText: getText(list(), article({ source: '非官方站点' })),
  }), /官网、标题或日期与列表不符/);
});

test('the seven reviewed third-zone records retain separate official gasoline and diesel provenance', () => {
  assert.equal(verified.id, monitor.id);
  assert.match(verified.priceScope, /遵义、六盘水、铜仁、黔东南、黔西南、毕节/);
  assert.deepEqual(verified.notices.map((notice) => notice.prices), [
    { '92': 7.37, '95': 7.79, diesel: 6.99 },
    { '92': 7.61, '95': 8.04, diesel: 7.24 },
    { '92': 8.16, '95': 8.62, diesel: 7.80 },
    { '92': 7.98, '95': 8.43, diesel: 7.61 },
    { '92': 8.28, '95': 8.75, diesel: 7.92 },
    { '92': 8.49, '95': 8.97, diesel: 8.13 },
    { '92': 8.81, '95': 9.30, diesel: 8.46 },
  ]);
  for (const notice of verified.notices) {
    assert.equal(notice.effectiveDate > notice.publishedDate, true);
    const directory = new URL('.', notice.url).href;
    assert.match(notice.url, /^https:\/\/fgw\.guizhou\.gov\.cn\/fggz\/tzgg\/\d{6}\/t\d{8}_\d+\.html$/);
    assert.equal(notice.imageUrl.startsWith(directory), true);
    assert.equal(notice.dieselImageUrl.startsWith(directory), true);
    assert.notEqual(notice.imageUrl, notice.dieselImageUrl);
  }
});
