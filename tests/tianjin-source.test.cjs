'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const source = require('../scripts/sources/tianjin.cjs');

const listUrl = 'https://fzgg.tj.gov.cn/xxfb/tzggx/';
const latestUrl = `${listUrl}202609/t20260924_7382724.html`;
const earlierUrl = `${listUrl}202609/t20260911_7372816.html`;
const newsUrl = `${listUrl}202512/t20251208_7194109.html`;
const title = '天津市发展改革委关于调整我市成品油价格的公告';

function entry(url, day, entryTitle = title) {
  return `<li><a onclick="isDownLoad(this,'${url}')" title='${entryTitle}' target="_blank">` +
    `<span class="list-main-title">${entryTitle}</span>` +
    `<span class="list-main-date">${day}</span></a></li>`;
}

function article(day, [p92, p95, diesel], header = '（元/升）') {
  const [year, month, date] = day.split('-');
  return `<meta name="ArticleTitle" content="${title}">` +
    `<meta name="PubDate" content="${year}/${month}/${date} 17:07:13">` +
    '<div class="details-main-content" id="zoom">' +
    `<p>根据国家发展改革委公布的成品油价格调价信息，现将我市调整后的成品油最高零售、批发价格公布如下，自${year}年${Number(month)}月${Number(date)}日24时起执行。</p>` +
    '<div class="ue_table"><table><tbody>' +
    '<tr><td>品 种</td><td>最高零售价格</td><td>最高批发价格（约定配送）</td></tr>' +
    `<tr><td>（元/吨）</td><td>${header}</td><td>（元/吨）</td></tr>` +
    `<tr><td>92号乙醇汽油</td><td>11331</td><td>${p92}</td><td>11031</td></tr>` +
    `<tr><td>95号乙醇汽油</td><td>11973</td><td>${p95}</td><td>11673</td></tr>` +
    `<tr><td>0号柴油（标准品）</td><td>9620</td><td>${diesel}</td><td>9320</td></tr>` +
    '</tbody></table></div></div></div>';
}

function fixture(options = {}) {
  const pages = new Map([
    [listUrl, `<ul class="list-main-group">${entry(latestUrl, '2026-09-24')}${entry(earlierUrl, '2026-09-11')}</ul><script>var countPage = 1</script>`],
    [latestUrl, article('2026-09-24', ['8.61', '9.09', '8.31'], options.latestHeader)],
    [earlierUrl, article('2026-09-11', ['8.29', '8.76', '7.98'])
      .replace('自2026年9月11日24时', `自${options.earlierDay ?? '2026年9月11日'}24时`)],
  ]);
  return async (url) => {
    assert.ok(pages.has(url), `unexpected URL ${url}`);
    return pages.get(url);
  };
}

test('天津公告按元/升列读取，24时转换为次日并按生效日排序', async () => {
  const notices = await source.collect({ getText: fixture(), today: '2026-09-28' });
  assert.deepEqual(notices, [
    { effectiveDate: '2026-09-12', publishedDate: '2026-09-11', url: earlierUrl,
      prices: { '92': 8.29, '95': 8.76, diesel: 7.98 } },
    { effectiveDate: '2026-09-25', publishedDate: '2026-09-24', url: latestUrl,
      prices: { '92': 8.61, '95': 9.09, diesel: 8.31 } },
  ]);
  const beforeLatestEffective = await source.collect({ getText: fixture(), today: '2026-09-24' });
  assert.equal(beforeLatestEffective.length, 1);
  assert.equal(beforeLatestEffective[0].effectiveDate, '2026-09-12');
});

test('天津公告表格列标题变化时拒绝读取元/吨数值', async () => {
  await assert.rejects(
    source.collect({ getText: fixture({ latestHeader: '（元/吨）' }), today: '2026-09-28' }),
    /价格表列标题异常/,
  );
});

test('天津公告列表日期和正文调价日不一致时拒绝记录', async () => {
  await assert.rejects(
    source.collect({ getText: fixture({ earlierDay: '2026年9月10日' }), today: '2026-09-28' }),
    /生效时间与发布日期不符/,
  );
});

test('最新成品油文章标题变化时拒绝返回过期价格', async () => {
  const getText = async (url) => {
    if (url === listUrl) {
      return `<ul class="list-main-group">${entry(latestUrl, '2026-09-24', '成品油价格信息')}${entry(earlierUrl, '2026-09-11')}</ul><script>var countPage = 1</script>`;
    }
    return article('2026-09-11', ['8.29', '8.76', '7.98']);
  };
  await assert.rejects(source.collect({ getText, today: '2026-09-28' }), /未知的成品油公告标题/);
});

test('天津文字公告只从每升最高零售价格段落读取油号', async () => {
  const news = (price95) =>
    '<meta name="ArticleTitle" content="我市今日调整成品油价格">' +
    '<meta name="PubDate" content="2025/12/08 18:00:00">' +
    '<div class="details-main-content" id="zoom"><div>' +
    '<p>决定自2025年12月8日24时起下调成品油价格。0号柴油（标准品）每吨由7550元调整为7495元。</p>' +
    `<p>我市调整后的成品油最高零售价格每升分别为：89号汽油6.33元；92号汽油6.83元；95号汽油${price95}元；0号柴油6.47元。</p>` +
    '</div></div>';
  const listing = `<ul class="list-main-group">${entry(newsUrl, '2025-12-08', '我市今日调整成品油价格')}</ul>` +
    '<script>var countPage = 1</script>';
  const getText = async (url) => url === listUrl ? listing : news('7.22');
  assert.deepEqual(await source.collect({ getText, today: '2025-12-10' }), [{
    effectiveDate: '2025-12-09', publishedDate: '2025-12-08', url: newsUrl,
    prices: { '92': 6.83, '95': 7.22, diesel: 6.47 },
  }]);
  await assert.rejects(
    source.collect({ getText: async (url) => url === listUrl ? listing : news('722'), today: '2025-12-10' }),
    /95号汽油元\/升价格缺失或不唯一/,
  );
});
