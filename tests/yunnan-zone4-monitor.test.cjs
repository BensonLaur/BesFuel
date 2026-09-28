'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const monitor = require('../scripts/monitors/yunnan-zone4.cjs');
const zone4 = require('../data/verified/yunnan-zone4.json');
const kunming = require('../data/verified/yunnan-kunming.json');

const LIST_URL = 'https://yndrc.yn.gov.cn/html/fagaishuju/jiagegongbu/meidianyouqi/';
const ARTICLE_URL = 'https://yndrc.yn.gov.cn/html/2026/meidianyouqi_0924/28568.html';
const PDF_URL = 'https://yndrc.yn.gov.cn/uploadfile/s2/2026/0924/20260924055055206.pdf';
const TITLE = '云南省成品油价格按机制调整';

test('fourth zone follows the same dated provincial PDF bulletin', async () => {
  const listing = `<meta name="ColumnName" content="成品油价格"><div class="list-content"><ul>
    <li><a href="/html/2026/meidianyouqi_0924/28568.html">${TITLE}</a><span>2026-09-24</span></li>
    <div class="pagenav"></div></ul></div>`;
  const article = `<meta name="ColumnName" content="成品油价格">
    <meta name="ArticleTitle" content="${TITLE}">
    <meta name="PubDate" content="2026-09-24 17:50:58">
    <meta name="ContentSource" content="价格收费管理处">
    <div class="show-title">${TITLE}</div>
    <p>自9月24日24时起调整。</p>
    <a href="/uploadfile/s2/2026/0924/20260924055055206.pdf">云南省各地区汽、柴油最高零售价格表</a>`;
  const latest = await monitor.collect({
    getText: async url => {
      if (url === LIST_URL) return listing;
      assert.equal(url, ARTICLE_URL);
      return article;
    },
    getBuffer: async url => {
      assert.equal(url, PDF_URL);
      return { buffer: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(2048)]) };
    },
    today: '2026-09-28',
  });
  assert.equal(monitor.id, 'yunnan-zone4');
  assert.equal(latest.url, ARTICLE_URL);
  assert.equal(latest.pdfUrl, PDF_URL);
  assert.equal(latest.requiresManualLiterReview, true);
  assert.equal('prices' in latest, false);
});

test('fourth-zone history matches 25 official dates and never substitutes Kunming prices', () => {
  assert.equal(zone4.notices.length, 25);
  assert.equal(zone4.unit, '元/升');
  assert.match(zone4.priceScope, /第四价区（普洱、保山、丽江）/);
  assert.deepEqual(zone4.notices.at(-1).prices, { '92': 8.99, '95': 9.63, diesel: 8.62 });
  assert.equal(zone4.notices.at(-1).pdfUrl, PDF_URL);
  for (let index = 0; index < zone4.notices.length; index += 1) {
    const item = zone4.notices[index];
    const base = kunming.notices[index];
    assert.equal(item.publishedDate, base.publishedDate);
    assert.equal(item.effectiveDate, base.effectiveDate);
    assert.equal(item.url, base.url);
    assert.equal(item.pdfUrl, base.pdfUrl);
    for (const grade of ['92', '95', 'diesel']) {
      assert.ok(item.prices[grade] > base.prices[grade], `${item.publishedDate}/${grade}`);
      assert.ok(item.prices[grade] - base.prices[grade] < 0.3, `${item.publishedDate}/${grade}`);
    }
  }
});
