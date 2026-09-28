'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const source = require('../scripts/sources/beijing.cjs');

const base = 'https://fgw.beijing.gov.cn/fgwzwgk/2024zcwj/bwqtwj/';
const latestPath = './202609/t20260924_4879948.htm';
const earlierPath = './202609/t20260911_4860093.htm';

function article({ published, effective, prices, tableOverride = {}, title = '本市成品油价格调整' }) {
  const [year, month, day] = published.split('-');
  const values = { ...prices, ...tableOverride };
  const row = (label, value) => `<tr><td>${label}</td><td>10000</td><td>9900</td><td>10300</td><td>${value}</td></tr>`;
  return `
    <li>[实施日期] <span>${effective}</span></li>
    <li>[发布日期] <span>${published}</span></li>
    <div class="xl_title">${title}</div>
    <div class="xl_content">
      <p>本市汽、柴油最高零售价格自${year}年${Number(month)}月${Number(day)}日24时起；
      92号汽油由每升8.00元调整为${prices['92']}元；
      95号汽油由每升8.50元调整为${prices['95']}元；
      0号柴油由每升7.50元调整为${prices.diesel}元。</p>
      <table>
        <tr><td>品名</td><td>最高批发价格</td><td>最高零售价格</td></tr>
        <tr><td>配送制元/吨</td><td>非配送制元/吨</td><td>元/吨</td><td>元/升</td></tr>
        ${row('92号汽油', values['92'])}
        ${row('95号汽油', values['95'])}
        ${row('0号柴油', values.diesel)}
      </table>
    </div>`;
}

const listing = `
  <li><a href="${latestPath}" title="本市成品油价格调整">本市成品油价格调整</a><span>2026-09-24</span></li>
  <li><a href="${earlierPath}" title="本市成品油价格调整">本市成品油价格调整</a><span>2026-09-11</span></li>
  <script>var countPage = 1;</script>`;

function getText(overrides = {}) {
  const pages = {
    [base]: listing,
    [new URL(latestPath, base).href]: article({
      published: '2026-09-24', effective: '2026-09-25',
      prices: { '92': 8.61, '95': 9.17, diesel: 8.36 },
    }),
    [new URL(earlierPath, base).href]: article({
      published: '2026-09-11', effective: '2026-09-12',
      prices: { '92': 8.29, '95': 8.83, diesel: 8.02 },
    }),
    ...overrides,
  };
  return async (url) => {
    assert.ok(url in pages, `unexpected URL: ${url}`);
    return pages[url];
  };
}

test('collects official per-litre retail prices in effective-date order', async () => {
  const records = await source.collect({ getText: getText(), today: '2026-09-28' });
  assert.deepEqual(records.map(({ effectiveDate, prices }) => ({ effectiveDate, prices })), [
    { effectiveDate: '2026-09-12', prices: { '92': 8.29, '95': 8.83, diesel: 8.02 } },
    { effectiveDate: '2026-09-25', prices: { '92': 8.61, '95': 9.17, diesel: 8.36 } },
  ]);
});

test('rejects a table/body price disagreement', async () => {
  const altered = article({
    published: '2026-09-24', effective: '2026-09-25',
    prices: { '92': 8.61, '95': 9.17, diesel: 8.36 },
    tableOverride: { '92': 8.62 },
  });
  await assert.rejects(
    source.collect({ getText: getText({ [new URL(latestPath, base).href]: altered }), today: '2026-09-28' }),
    /正文与元\/升价格表不符/,
  );
});

test('rejects ambiguous effective dates in official metadata', async () => {
  const altered = article({
    published: '2026-09-24', effective: '2026-09-24',
    prices: { '92': 8.61, '95': 9.17, diesel: 8.36 },
  });
  await assert.rejects(
    source.collect({ getText: getText({ [new URL(latestPath, base).href]: altered }), today: '2026-09-28' }),
    /实施日期与正文生效时间不符/,
  );
});
