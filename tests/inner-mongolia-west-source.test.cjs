'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const source = require('../scripts/sources/inner-mongolia-west.cjs');

const listUrl = 'https://fgw.nmg.gov.cn/ywgz/jfgz/cpyjg/index.html';
const latest = 'https://fgw.nmg.gov.cn/ywgz/jfgz/cpyjg/202609/t20260924_2958605.html';
const older = 'https://fgw.nmg.gov.cn/ywgz/jfgz/cpyjg/202609/t20260911_2952758.html';
const scope = '西部价区包括呼和浩特市、包头市、乌兰察布市、鄂尔多斯市、巴彦淖尔市、乌海市和阿拉善盟';
const westTitle = '内蒙古自治区西部价区汽、柴油最高批发、零售价格表';
const eastTitle = '内蒙古自治区东部价区汽、柴油最高批发、零售价格表';

function listing(href = './202609/t20260924_2958605.html') {
  return `<ul class="newsList">
    <li><a href="${href}" title="我区成品油价格调整">我区成品油价格调整</a><span>2026-09-24</span></li>
    <li><a href="./202609/t20260911_2952758.html" title="我区成品油价格调整">我区成品油价格调整</a><span>2026-09-11</span></li>
  </ul><script>var currentPage = 0; var countPage = 14;</script>`;
}

function table(prices, ton = { '92': 11347, '95': 11990, diesel: 9635 }) {
  const row = (label, tonnes, litre) =>
    `<tr><td>${label}</td><td>${tonnes}</td><td>${litre.toFixed(2)}</td><td>${tonnes - 318}</td><td>${tonnes - 378}</td></tr>`;
  return `<table>
    <tr><td>品种</td><td>型号</td><td>最高零售价</td><td>最高批发价（元/吨）</td></tr>
    <tr><td>元/吨</td><td>元/升</td><td>配送制</td><td>非配送制</td></tr>
    <tr><td>汽油</td><td>89号（ⅥA）</td><td>10705</td><td></td><td>10405</td><td>10345</td></tr>
    <tr><td>（标准品）</td></tr>
    ${row('92号（ⅥA）', ton['92'], prices['92'])}
    ${row('95号（ⅥA）', ton['95'], prices['95'])}
    <tr><td>柴油</td><td>0号（Ⅵ）</td><td>${ton.diesel}</td><td>${prices.diesel.toFixed(2)}</td><td>${ton.diesel - 300}</td><td>${ton.diesel - 360}</td></tr>
    <tr><td>（标准品）</td></tr>
    <tr><td>-10号（Ⅵ）</td><td>10213</td><td>8.67</td><td>9895</td><td>9835</td></tr>
  </table>`;
}

function article({ day = '24', prices = { '92': 8.62, '95': 9.15, diesel: 8.14 },
  west = table(prices), east = table({ '92': 8.68, '95': 9.24, diesel: 8.16 }),
  zone = scope, site = '内蒙古自治区发展和改革委员会',
  westHeading = westTitle } = {}) {
  const date = `2026年9月${Number(day)}日`;
  return `<meta name="SiteName" content="${site}" />
    <meta name="ContentSource" content="${site}" />
    <meta name="ArticleTitle" content='我区成品油价格调整' />
    <meta name="PubDate" content="2026年09月${day}日 15:30" />
    <h1 class="xl-title">我区成品油价格调整</h1>
    <div class="xl-cont">
      <p>我区汽、柴油价格自${date}24时起调整。</p>
      <p>${westHeading}（自${date}24时起执行）</p>${west}
      <p>${eastTitle}（自${date}24时起执行）</p>${east}
      <p>5、${zone}；东部价区包括呼伦贝尔市、兴安盟、通辽市、赤峰市和锡林郭勒盟。</p>
    </div><div class="xl-fjxz"></div>`;
}

function reader(overrides = {}) {
  const pages = {
    [listUrl]: listing(),
    [latest]: article(),
    [older]: article({ day: '11',
      prices: { '92': 8.30, '95': 8.81, diesel: 7.82 },
      west: table({ '92': 8.30, '95': 8.81, diesel: 7.82 },
        { '92': 10929, '95': 11547, diesel: 9250 }),
      east: table({ '92': 8.35, '95': 8.89, diesel: 7.84 },
        { '92': 10929, '95': 11547, diesel: 9250 }),
    }),
    ...overrides,
  };
  return async url => {
    assert.ok(Object.hasOwn(pages, url), `unexpected URL: ${url}`);
    return pages[url];
  };
}

test('reads the western per-litre table and keeps two official historical notices', async () => {
  const notices = await source.collect({ getText: reader(), today: '2026-09-28' });
  assert.deepEqual(notices.map(({ effectiveDate, prices }) => ({ effectiveDate, prices })), [
    { effectiveDate: '2026-09-12', prices: { '92': 8.30, '95': 8.81, diesel: 7.82 } },
    { effectiveDate: '2026-09-25', prices: { '92': 8.62, '95': 9.15, diesel: 8.14 } },
  ]);
  assert.equal(notices.at(-1).url, latest);
});

test('rejects a forged article domain or inconsistent official identity', async () => {
  await assert.rejects(source.collect({
    getText: reader({ [listUrl]: listing('https://example.com/fake.html') }), today: '2026-09-28',
  }), /不是预期的自治区发改委地址/);
  await assert.rejects(source.collect({
    getText: reader({ [latest]: article({ site: '其他站点' }) }), today: '2026-09-28',
  }), /正文官网、标题或日期与列表不符/);
});

test('rejects missing western coverage or an incorrectly ordered table', async () => {
  await assert.rejects(source.collect({
    getText: reader({ [latest]: article({ zone: '西部价区包括鄂尔多斯市' }) }), today: '2026-09-28',
  }), /价区覆盖范围异常/);
  await assert.rejects(source.collect({
    getText: reader({ [latest]: article({ westHeading: eastTitle }) }), today: '2026-09-28',
  }), /附表价区顺序或日期异常/);
});

test('rejects a missing yuan-per-litre price or inconsistent east/west tonnage', async () => {
  await assert.rejects(source.collect({
    getText: reader({ [latest]: article({ west: table({ '92': NaN, '95': 9.15, diesel: 8.14 }) }) }),
    today: '2026-09-28',
  }), /元\/升价格行异常/);
  await assert.rejects(source.collect({
    getText: reader({ [latest]: article({ east: table({ '92': 8.68, '95': 9.24, diesel: 8.16 },
      { '92': 11348, '95': 11990, diesel: 9635 }) }) }), today: '2026-09-28',
  }), /东西部官方吨价不一致/);
});

test('does not expose a published notice before its midnight effective time', async () => {
  const notices = await source.collect({ getText: reader(), today: '2026-09-24' });
  assert.equal(notices.at(-1).effectiveDate, '2026-09-12');
});
