'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const monitor = require('../scripts/monitors/yunnan-kunming.cjs');
const verified = require('../data/verified/yunnan-kunming.json');

const LIST_URL = 'https://yndrc.yn.gov.cn/html/fagaishuju/jiagegongbu/meidianyouqi/';
const CURRENT_PATH = '/html/2026/meidianyouqi_0924/28568.html';
const PRIOR_PATH = '/html/2026/jiageyushoufei_0911/28416.html';
const CURRENT_URL = `https://yndrc.yn.gov.cn${CURRENT_PATH}`;
const PDF_PATH = '/uploadfile/s2/2026/0924/20260924055055206.pdf';
const PDF_URL = `https://yndrc.yn.gov.cn${PDF_PATH}`;
const TITLE = '云南省成品油价格按机制调整';

function item(path, date, title = TITLE) {
  return `<li><a href="${path}">${title}</a><span>${date}</span></li>`;
}

function list(current = item(CURRENT_PATH, '2026-09-24')) {
  return `<meta name="ColumnName" content="成品油价格">
    <div class="list-content"><ul>${current}${item(PRIOR_PATH, '2026-09-11')}
    <div class="pagenav"></div></ul></div>`;
}

function article(options = {}) {
  return `<meta name="ColumnName" content="${options.column || '成品油价格'}">
    <meta name="ArticleTitle" content="${options.title || TITLE}">
    <meta name="PubDate" content="${options.date || '2026-09-24'} 17:50:58">
    <meta name="ContentSource" content="价格收费管理处">
    <div class="show-title">${options.title || TITLE}</div>
    <div class="show-detail"><p>自9月24日24时起调整价格。</p>
    <a href="${options.pdfPath || PDF_PATH}">云南省各地区汽、柴油最高零售价格表</a></div>`;
}

function reader(listHtml = list(), articleHtml = article(),
  pdf = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(2048)])) {
  return {
    getText: async url => {
      if (url === LIST_URL) return listHtml;
      assert.equal(url, CURRENT_URL);
      return articleHtml;
    },
    getBuffer: async url => {
      assert.equal(url, PDF_URL);
      return { buffer: pdf };
    },
  };
}

test('detects the latest official PDF and requires human liter-price review', async () => {
  const latest = await monitor.collect({ ...reader(), today: '2026-09-25' });
  assert.deepEqual(latest, {
    title: TITLE, publishedDate: '2026-09-24', effectiveDate: '2026-09-25',
    url: CURRENT_URL, pdfUrl: PDF_URL, requiresManualLiterReview: true,
  });
  assert.equal('prices' in latest, false);
});

test('keeps the previous published price until the 24:00 change takes effect', async () => {
  const previousUrl = `https://yndrc.yn.gov.cn${PRIOR_PATH}`;
  const previousPdf = 'https://yndrc.yn.gov.cn/uploadfile/s2/2026/0911/20260911040605431.pdf';
  const pages = {
    [LIST_URL]: list(),
    [previousUrl]: article({ date: '2026-09-11', pdfPath: new URL(previousPdf).pathname })
      .replaceAll('9月24日', '9月11日'),
  };
  const latest = await monitor.collect({
    getText: async url => pages[url],
    getBuffer: async url => {
      assert.equal(url, previousPdf);
      return { buffer: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(2048)]) };
    },
    today: '2026-09-24',
  });
  assert.equal(latest.url, previousUrl);
  assert.equal(latest.effectiveDate, '2026-09-12');
});

test('rejects changed source, dates, PDF path and malformed PDF', async () => {
  for (const [input, pattern] of [
    [reader(list(item('https://yndrc.yn.gov.cn.evil.example/html/2026/meidianyouqi_0924/28568.html', '2026-09-24'))), /不是预期的官网地址/],
    [reader(list(item(CURRENT_PATH, '2026-09-24', '云南省成品油价格预测'))), /未知的成品油公告标题/],
    [reader(list(), article({ date: '2026-09-23' })), /正文标题、日期或发布单位/],
    [reader(list(), article({ pdfPath: 'https://example.com/prices.pdf' })), /不是预期的官网地址/],
    [reader(list(), article(), Buffer.alloc(2048, 88)), /PDF 内容异常/],
  ]) {
    await assert.rejects(monitor.collect({ ...input, today: '2026-09-25' }), pattern);
  }
});

test('verified record holds 25 dated Kunming PDF tables and current prices', () => {
  assert.equal(verified.notices.length, 25);
  assert.equal(verified.unit, '元/升');
  assert.match(verified.priceScope, /昆明地区/);
  assert.deepEqual(verified.notices.at(-1).prices, { '92': 8.76, '95': 9.4, diesel: 8.37 });
  assert.equal(verified.notices.at(-1).url, CURRENT_URL);
  for (let index = 0; index < verified.notices.length; index += 1) {
    const notice = verified.notices[index];
    const date = notice.publishedDate.replaceAll('-', '');
    assert.match(notice.pdfUrl, new RegExp(`^https://yndrc\\.yn\\.gov\\.cn/uploadfile/s2/${date.slice(0, 4)}/${date.slice(4)}/${date}\\d{9}\\.pdf$`));
    assert.equal(notice.effectiveDate, new Date(Date.parse(`${notice.publishedDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10));
    if (index) assert.ok(notice.effectiveDate > verified.notices[index - 1].effectiveDate);
    for (const grade of ['92', '95', 'diesel']) {
      assert.ok(Number.isFinite(notice.prices[grade]) && notice.prices[grade] > 6 && notice.prices[grade] < 12);
    }
  }
});
