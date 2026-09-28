'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const monitor = require('../scripts/monitors/yunnan-zone3.cjs');
const verified = require('../data/verified/yunnan-zone3.json');
const { importVerified } = require('../scripts/import-verified.cjs');
const snapshot = require('../data/prices.json');

const HOST = 'https://yndrc.yn.gov.cn';
const LIST_URL = `${HOST}/html/fagaishuju/jiagegongbu/meidianyouqi/`;
const CURRENT_PATH = '/html/2026/meidianyouqi_0924/28568.html';
const PREVIOUS_PATH = '/html/2026/jiageyushoufei_0911/28416.html';
const PDF_PATH = '/uploadfile/s2/2026/0924/20260924055055206.pdf';
const PREVIOUS_PDF_PATH = '/uploadfile/s2/2026/0911/20260911040605431.pdf';
const TITLE = '云南省成品油价格按机制调整';

function listItem(path, date, title = TITLE) {
  return `<li><a href="${path}">${title}</a><span>${date}</span></li>`;
}

function list(first = listItem(CURRENT_PATH, '2026-09-24')) {
  return `<meta name="ColumnName" content="成品油价格"><div class="list-content"><ul>
    ${first}${listItem(PREVIOUS_PATH, '2026-09-11')}
    <div class="pagenav"></div></ul></div>`;
}

function article({ date = '2026-09-24', title = TITLE, column = '成品油价格',
  source = '价格收费管理处', pdfPath = PDF_PATH, time = '9月24日24时起' } = {}) {
  return `<meta name="ColumnName" content="${column}">
    <meta name="ArticleTitle" content="${title}">
    <meta name="PubDate" content="${date} 17:50:58">
    <meta name="ContentSource" content="${source}">
    <div class="show-title">${title}</div><div class="show-detail">
    <p>自${time}调整价格。</p>
    <a href="${pdfPath}">云南省各地区汽、柴油最高零售价格表</a></div>`;
}

function pdf() {
  return Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(2048), Buffer.from('%%EOF')]);
}

function reader(listHtml = list(), articleHtml = article(), pdfBody = pdf()) {
  return {
    getText: async url => {
      if (url === LIST_URL) return listHtml;
      assert.equal(url, `${HOST}${CURRENT_PATH}`);
      return articleHtml;
    },
    getBuffer: async url => {
      assert.equal(url, `${HOST}${PDF_PATH}`);
      return { buffer: pdfBody };
    },
  };
}

test('finds the current official PDF while leaving liter prices for manual verification', async () => {
  const entry = await monitor.collect({ ...reader(), today: '2026-09-28' });
  assert.deepEqual(entry, {
    publishedDate: '2026-09-24', effectiveDate: '2026-09-25',
    url: `${HOST}${CURRENT_PATH}`, pdfUrl: `${HOST}${PDF_PATH}`,
    requiresManualPriceReview: true,
  });
  assert.equal('prices' in entry, false);
});

test('holds the previous official price until the midnight effective date', async () => {
  const previousUrl = `${HOST}${PREVIOUS_PATH}`;
  const entry = await monitor.collect({
    getText: async url => url === LIST_URL ? list() : (assert.equal(url, previousUrl),
      article({ date: '2026-09-11', pdfPath: PREVIOUS_PDF_PATH, time: '9月11日24时起' })),
    getBuffer: async url => (assert.equal(url, `${HOST}${PREVIOUS_PDF_PATH}`), { buffer: pdf() }),
    today: '2026-09-24',
  });
  assert.equal(entry.url, previousUrl);
  assert.equal(entry.effectiveDate, '2026-09-12');
});

test('rejects unexpected official structure, changed host, dates, attachment or PDF', async () => {
  for (const [input, pattern] of [
    [reader(list(listItem('https://yndrc.yn.gov.cn.evil.example/html/2026/meidianyouqi_0924/28568.html', '2026-09-24'))), /不是预期的官网地址/],
    [reader(list(listItem(CURRENT_PATH, '2026-09-24', '云南省成品油价格预测'))), /未知的成品油公告标题/],
    [reader(list(), article({ date: '2026-09-23' })), /正文标题、日期或发布单位/],
    [reader(list(), article({ source: '未知来源' })), /正文标题、日期或发布单位/],
    [reader(list(), article({ time: '9月25日24时起' })), /24 时生效时间/],
    [reader(list(), article({ pdfPath: 'https://example.com/prices.pdf' })), /不是预期的官网地址/],
    [reader(list(), article(), Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(2048)])), /PDF 内容异常/],
  ]) {
    await assert.rejects(monitor.collect({ ...input, today: '2026-09-28' }), pattern);
  }
});

test('12 independently checked official tables retain the four prefectures and prices', () => {
  assert.equal(verified.notices.length, 12);
  assert.equal(verified.unit, '元/升');
  assert.match(verified.priceScope, /昭通、红河、文山、大理四州市/);
  assert.deepEqual(verified.notices.at(-1).prices, { '92': 8.91, '95': 9.55, diesel: 8.54 });
  assert.equal(verified.notices.at(-1).url, `${HOST}${CURRENT_PATH}`);
  assert.equal(verified.notices.at(-1).pdfUrl, `${HOST}${PDF_PATH}`);
  for (let index = 0; index < verified.notices.length; index += 1) {
    const notice = verified.notices[index];
    const stamp = notice.publishedDate.replaceAll('-', '');
    assert.match(notice.url, new RegExp(`^${HOST}/html/2026/(?:jiageyushoufei|meidianyouqi)_${stamp.slice(4)}/\\d+\\.html$`));
    assert.match(notice.pdfUrl, new RegExp(`^${HOST}/uploadfile/s2/2026/${stamp.slice(4)}/${stamp}\\d{9}\\.pdf$`));
    assert.equal(notice.effectiveDate,
      new Date(Date.parse(`${notice.publishedDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10));
    if (index) assert.ok(notice.effectiveDate > verified.notices[index - 1].effectiveDate);
    for (const grade of ['92', '95', 'diesel']) {
      assert.ok(Number.isFinite(notice.prices[grade]) && notice.prices[grade] > 6 && notice.prices[grade] < 12);
    }
  }
  const imported = importVerified(snapshot, verified).regions[verified.id];
  assert.equal(imported.grades['92'].price, 8.91);
  assert.equal(imported.grades['92'].history.length, 12);
});
