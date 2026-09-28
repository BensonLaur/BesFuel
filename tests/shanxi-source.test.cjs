'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const source = require('../scripts/sources/shanxi.cjs');

const base = 'https://fgw.shanxi.gov.cn/tzgg/';
const latestPath = './202609/t20260924_10227169.shtml';
const olderPath = './202609/t20260911_10218734.shtml';
const latestUrl = new URL(latestPath, base).href;
const olderUrl = new URL(olderPath, base).href;

function item(path, date, title = '关于调整我省成品油零售价格的公告') {
  return `<li><i></i><a href="${path}" target="_blank" title="${title}">${title}</a><em>${date}</em></li>`;
}

function listing(items, page = 0, pageCount = 1) {
  return `<ul class="submenu-dropbox_subtabs_content fixmt10">${items}</ul>
    <script>createPageHTML(${pageCount},${page},"index","shtml")</script>`;
}

function article(date, values = { '92': '8.55', '95': '9.23', diesel: '8.38' },
  options = {}) {
  const { unit = '元/升', announced = date, title = '关于调整我省成品油零售价格的公告' } = options;
  const [year, month, day] = announced.split('-');
  return `<meta name="PubDate" content="${date} 17:30:00">
    <div class="detail-article-title"><h3>${title}</h3></div>
    <span><i>时间：</i>${date} 17:30</span>
    <!-- Main text -->
    <div class="article-body"><div class="trs_editor_view TRS_UEDITOR trs_paper_default trs_word">
      <p>自<span>${year}</span>年<span>${Number(month)}</span>月<span>${Number(day)}</span>日24时起，山西省内汽、柴油价格（标准品）每吨分别上调。</p>
      <p>山西省成品油最高零售价格表</p>
      <div class="ue_table"><table><tbody>
        <tr><td>品种</td><td>品号</td><td>最高零售价格（元/吨）</td><td>最高零售价格（${unit}）</td></tr>
        <tr><td>汽油（VIB）</td><td>89号</td><td>10760</td><td>8.00</td></tr>
        <tr><td>92号</td><td>11406</td><td>${values['92']}</td></tr>
        <tr><td>95号</td><td>12051</td><td>${values['95']}</td></tr>
        <tr><td>柴油（VI）</td><td>0号</td><td>9675</td><td>${values.diesel}</td></tr>
      </tbody></table></div>
    </div></div>
    <!-- /Main text -->`;
}

function reader(pages) {
  return async (url) => {
    assert.ok(Object.hasOwn(pages, url), `unexpected URL: ${url}`);
    return pages[url];
  };
}

test('discovers official announcements across pages and returns recent prices in effective order', async () => {
  // The list and table shapes match the Shanxi DRC pages checked on 2026-09-28.
  const pages = {
    [base]: listing(item(latestPath, '2026-09-24'), 0, 2),
    [`${base}index_1.shtml`]: listing(item(olderPath, '2026-09-11'), 1, 2),
    [latestUrl]: article('2026-09-24'),
    [olderUrl]: article('2026-09-11', { '92': '8.24', '95': '8.89', diesel: '8.04' }),
  };
  const result = await source.collect({ getText: reader(pages), today: '2026-09-28' });
  assert.deepEqual(result, [
    { effectiveDate: '2026-09-12', publishedDate: '2026-09-11', url: olderUrl,
      prices: { '92': 8.24, '95': 8.89, diesel: 8.04 } },
    { effectiveDate: '2026-09-25', publishedDate: '2026-09-24', url: latestUrl,
      prices: { '92': 8.55, '95': 9.23, diesel: 8.38 } },
  ]);
});

test('does not publish an announcement until the day after its 24:00 start', async () => {
  const pages = { [base]: listing(item(latestPath, '2026-09-24') + item(olderPath, '2026-09-11')),
    [latestUrl]: article('2026-09-24'),
    [olderUrl]: article('2026-09-11', { '92': '8.24', '95': '8.89', diesel: '8.04' }) };
  const result = await source.collect({ getText: reader(pages), today: '2026-09-24' });
  assert.deepEqual(result.map((notice) => notice.effectiveDate), ['2026-09-12']);
});

test('rejects a price table without yuan per liter or a required grade', async () => {
  for (const badArticle of [
    article('2026-09-24', undefined, { unit: '元/吨' }),
    article('2026-09-24', { '92': '8.55', '95': '', diesel: '8.38' }),
  ]) {
    await assert.rejects(source.collect({
      getText: reader({ [base]: listing(item(latestPath, '2026-09-24')), [latestUrl]: badArticle }),
      today: '2026-09-28',
    }), /价格/);
  }
});

test('rejects inconsistent article dates and nonofficial announcement links', async () => {
  await assert.rejects(source.collect({
    getText: reader({ [base]: listing(item(latestPath, '2026-09-24')),
      [latestUrl]: article('2026-09-24', undefined, { announced: '2026-09-23' }) }),
    today: '2026-09-28',
  }), /调价日期与发布日期不符/);
  await assert.rejects(source.collect({
    getText: reader({ [base]: listing(item('https://fgw.shanxi.gov.cn.evil.example/tzgg/202609/t20260924_10227169.shtml', '2026-09-24')) }),
    today: '2026-09-28',
  }), /不是预期的官网地址/);
});
