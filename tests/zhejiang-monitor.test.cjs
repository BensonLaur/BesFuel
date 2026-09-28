'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const monitor = require('../scripts/monitors/zhejiang.cjs');

const API = 'https://fzggw.zj.gov.cn/api-gateway/jpaas-publish-server/front/page/build/unit';
const TITLE = '浙江省成品油价格调整';
const PATH = '/col/col1632199/cpyjg/art/2026/art_ed9666e8c2204d60b9207d75412e7cee.html';
const ARTICLE_URL = `https://fzggw.zj.gov.cn${PATH}`;
const SECOND_PATH = '/col/col1599544/art/2026/art_00f45baf51384f3c9d3db61b19852946.html';

function listing({ date = '2026-09-24', path = PATH, title = TITLE } = {}) {
  const html = `<ul><div id="信息列表"><div class="page-content">
    <li class="clearfix"><a class="bt-left" title="${title}" href="${path}" target="_blank">${title}</a><span class="bt-right">${date}</span></li>
    <li class="clearfix"><a class="bt-left" title="${TITLE}" href="${SECOND_PATH}" target="_blank">${TITLE}</a><span class="bt-right">2026-09-11</span></li>
    </div></div></ul>`;
  return JSON.stringify({ success: true, data: { html } });
}

function article({ date = '2026-09-24', title = TITLE, column = '成品油价格',
  source = '价格处', price95 = '9.12', effectiveText } = {}) {
  const [year, month, day] = date.split('-');
  return `<meta name="ColumnName" content="${column}">
    <meta name="ArticleTitle" content="${title}">
    <meta name="PubDate" content="${date} 17:55">
    <meta name="ContentSource" content="${source}">
    <span>发布日期：${date} 17:55</span>
    <p>${effectiveText || `自${year}年${Number(month)}月${Number(day)}日24时起。`}</p>
    <table><tr><td>品种</td><td>型号</td><td>零售价</td><td>批发价</td></tr>
    <tr><td>元/吨</td><td>元/升</td><td>元/吨</td></tr>
    <tr><td>汽油</td><td>92号（VIB）</td><td>11390</td><td>8.58</td><td>11090</td></tr>
    <tr><td>汽油</td><td>95号（VIB）</td><td>12034</td><td>${price95}</td><td>11734</td></tr>
    <tr><td>柴油</td><td>0号（Ⅵ）</td><td>9675</td><td>8.28</td><td>9375</td></tr></table>`;
}

function reader(list, page = article(), expectedUrl = ARTICLE_URL) {
  return async url => {
    if (url.startsWith(API)) {
      const query = new URL(url).searchParams;
      assert.equal(query.get('tagId'), '信息列表');
      assert.equal(query.get('pageId'), 'WjmRjo8myrcFv0ZgeuKKh');
      return list;
    }
    assert.equal(url, expectedUrl);
    return page;
  };
}

test('discovers the new official column and holds the latest liter prices for verified review', async () => {
  const latest = await monitor.collect({ getText: reader(listing()), today: '2026-09-29' });
  assert.deepEqual(latest, {
    title: TITLE, publishedDate: '2026-09-24', effectiveDate: '2026-09-25',
    url: ARTICLE_URL, prices: { '92': 8.58, '95': 9.12, diesel: 8.28 },
    requiresManualLiterReview: true,
  });
});

test('accepts an official oil notice filed under 通知公告 and excludes future effective notices', async () => {
  const latest = await monitor.collect({
    getText: reader(listing(), article({ date: '2026-09-11', column: '通知公告' }),
      `https://fzggw.zj.gov.cn${SECOND_PATH}`),
    today: '2026-09-24',
  });
  assert.equal(latest.publishedDate, '2026-09-11');
  assert.equal(latest.effectiveDate, '2026-09-12');
});

test('refuses stale discovery so a dropped official column cannot appear current', async () => {
  const old = JSON.stringify({ success: true, data: { html:
    '<div id="信息列表"><li class="clearfix"><a class="bt-left" title="浙江省成品油价格调整" ' +
    'href="/col/col1229629046/art/2026/art_7c2b4abc9fbe46d8b9a8a9a9d09b7af3.html">' +
    '浙江省成品油价格调整</a><span class="bt-right">2026-03-23</span></li></div>' } });
  await assert.rejects(monitor.collect({
    getText: reader(old), today: '2026-09-29',
  }), /最新油价公告仅到 2026-03-23/);
});

test('rejects nonofficial URLs, altered metadata, missing effective date and broken liter table', async () => {
  const cases = [
    [listing({ path: 'https://fzggw.zj.gov.cn.evil.example/col/col1632199/cpyjg/art/2026/art_ed9666e8c2204d60b9207d75412e7cee.html' }), article(), /非预期官方公告地址/],
    [listing({ path: '/col/col1632199/cpyjg/art/2025/art_ed9666e8c2204d60b9207d75412e7cee.html' }), article(), /非预期官方公告地址/],
    [listing({ title: '浙江省成品油价格预测' }), article(), /未知的油价公告标题/],
    [listing(), article({ source: '未知' }), /正文标题、栏目、来源或日期/],
    [listing(), article({ effectiveText: '自9月25日24时起。' }), /24 时生效日期/],
    [listing(), article({ price95: '9120' }), /95 元\/升价格/],
    [JSON.stringify({ success: false, data: { html: '' } }), article(), /列表结构异常/],
  ];
  for (const [list, page, message] of cases) {
    await assert.rejects(monitor.collect({
      getText: reader(list, page), today: '2026-09-29',
    }), message);
  }
});
