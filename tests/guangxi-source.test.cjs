'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const source = require('../scripts/sources/guangxi.cjs');

const base = 'http://fgw.gxzf.gov.cn/xwzx/xwfb/';
const latest = `${base}t28168631.shtml`;
const previous = `${base}t28124728.shtml`;
const latestPrices = { '92': 8.67, '95': 9.36, diesel: 8.36 };
const earlierPrices = { '92': 8.35, '95': 9.02, diesel: 8.03 };

function listing({ latestHref = './t28168631.shtml', latestTitle = '2026年9月24日24时起广西成品油价格调整' } = {}) {
  return `<ul class="more-list">
    <li><span>2026-09-24</span><a href="${latestHref}" title="${latestTitle}">新公告</a></li>
    <li><span>2026-09-15</span><a href="./t100.shtml" title="非油价新闻">新闻</a></li>
  </ul><ul class="more-list">
    <li><span>2026-09-11</span><a href="./t28124728.shtml" title="2026年9月11日24时起广西成品油价格调整">旧公告</a></li>
  </ul><script>createPageHTML(1,0, "index","shtml","3");</script>`;
}

function article({ day, url, current, prior, table = current, tableDay = day,
  title = `2026年9月${day}日24时起广西成品油价格调整` }) {
  const date = `2026-09-${day}`;
  const row = (grade, ton, litre) => `<tr><td>${grade}</td><td>${ton - 300}</td><td>${ton}</td><td>${litre.toFixed(2)}</td></tr>`;
  return `<meta name="ArticleTitle" content="${title}">
    <meta name="PubDate" content="${date} 19:30">
    <meta name="ContentSource" content="价格和收费管理处">
    <meta name="Url" content="${url}">
    <h1>${title}</h1>
    <!-- 正文s --><div class="trs_editor_view">
      <p>92号汽油从${prior['92']}元/升调整到${current['92']}元/升；
      95号汽油从${prior['95']}元/升调整到${current['95']}元/升；
      国VI标准0号车用柴油从${prior.diesel}元/升调整到${current.diesel}元/升。</p>
      <p>广西市场成品油最高销售价格表</p>
      <p>(执行时间:2026年9月${tableDay}日24时起)</p>
      <table>
        <tr><td>项目</td><td></td><td>最高批发价格</td><td>最高零售价格(元)</td></tr>
        <tr><td>品种</td><td>规格</td><td>元/吨</td><td>吨</td><td>升</td></tr>
        <tr><td>国VIB车用汽油</td><td>89#</td><td>10535</td><td>10835</td><td>8.07</td></tr>
        ${row('92#', 11485, table['92'])}
        ${row('95#', 12135, table['95'])}
        <tr><td>国VI车用柴油</td><td>0#</td><td>9455</td><td>9755</td><td>${table.diesel.toFixed(2)}</td></tr>
      </table>
    </div><!-- 正文e -->`;
}

function reader(overrides = {}) {
  const pages = {
    [base]: listing(),
    [latest]: article({ day: '24', url: latest, current: latestPrices, prior: earlierPrices }),
    [previous]: article({ day: '11', url: previous, current: earlierPrices,
      prior: { '92': 8.14, '95': 8.80, diesel: 7.81 } }),
    ...overrides,
  };
  return async (url) => {
    assert.ok(Object.hasOwn(pages, url), `unexpected URL: ${url}`);
    return pages[url];
  };
}

test('discovers separate list blocks and verifies latest and historical per-litre prices', async () => {
  const notices = await source.collect({ getText: reader(), today: '2026-09-28' });
  assert.deepEqual(notices.map(({ effectiveDate, prices }) => ({ effectiveDate, prices })), [
    { effectiveDate: '2026-09-12', prices: earlierPrices },
    { effectiveDate: '2026-09-25', prices: latestPrices },
  ]);
  assert.equal(notices.at(-1).url, latest);
});

test('rejects a disagreement between narrative and official per-litre table', async () => {
  const wrong = article({ day: '24', url: latest, current: latestPrices, prior: earlierPrices,
    table: { ...latestPrices, '92': 8.68 } });
  await assert.rejects(source.collect({ getText: reader({ [latest]: wrong }), today: '2026-09-28' }),
    /正文与元\/升价格表不符/);
});

test('rejects a forged source domain before reading an article', async () => {
  const wrong = listing({ latestHref: 'http://example.com/xwzx/xwfb/t28168631.shtml' });
  await assert.rejects(source.collect({ getText: reader({ [base]: wrong }), today: '2026-09-28' }),
    /不是预期的官网地址/);
});

test('rejects a table date that disagrees with its announcement', async () => {
  const wrong = article({ day: '24', url: latest, current: latestPrices, prior: earlierPrices, tableDay: '23' });
  await assert.rejects(source.collect({ getText: reader({ [latest]: wrong }), today: '2026-09-28' }),
    /执行日期与公告日期不符/);
});

test('rejects gaps or contradictory prices between successive official notices', async () => {
  const wrong = article({ day: '24', url: latest, current: latestPrices,
    prior: { ...earlierPrices, '95': 9.03 } });
  await assert.rejects(source.collect({ getText: reader({ [latest]: wrong }), today: '2026-09-28' }),
    /价格历史不连续/);
});

test('holds back a newly published notice until its midnight effective time', async () => {
  const notices = await source.collect({ getText: reader(), today: '2026-09-24' });
  assert.equal(notices.at(-1).effectiveDate, '2026-09-12');
});
