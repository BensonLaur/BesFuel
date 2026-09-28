'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const monitor = require('../scripts/monitors/xinjiang-karamay-main.cjs');
const { importVerified } = require('../scripts/import-verified.cjs');

const listUrl = 'https://www.klmy.gov.cn/search/db9694580ad74929979e1981b8c534f9?page=1&_pageSize=30&_isAgg=true&_isJson=true&_template=index&_rangeTimeGte=&_channelName=';
const oldUrl = 'https://www.klmy.gov.cn/klmys/c100186/202609/12cf558ed5584d25b75d1f4e709f8746.shtml';
const newUrl = 'https://www.klmy.gov.cn/klmys/c100186/202610/1234567890abcdef1234567890abcdef.shtml';
const oldTitle = '2026年9月24日24时起我市成品油价格按机制上调';
const newTitle = '2026年10月15日24时起我市成品油价格按机制下调';

function list(items) {
  return JSON.stringify({ data: { results: items.map(({ date, title, url }) => ({
    title, url, publishedTimeStr: `${date} 17:18:49`,
    channelCodeName: 'c100186', channelName: '价格信息',
  })) } });
}

function article({ title = newTitle, date = '2026-10-15', source = '市发展和改革委员会',
  unit = '元/升', area = '克拉玛依区、白碱滩区乌尔禾区', diesel = '7.94',
  dieselDensity = '859.6' } = {}) {
  const [year, month, day] = date.split('-').map(Number);
  const row = (grade, tonne, density, liter, density2, liter2) =>
    `<tr><td>${grade}</td><td>${tonne}</td><td>${density}</td><td>${liter}</td>` +
    `<td>${density2}</td><td>${liter2}</td></tr>`;
  return `<meta name="ArticleTitle" content="${title}"/>` +
    `<meta name="PubDate" content="${date} 17:18">` +
    `<meta name="ContentSource" content="${source}"/>` +
    `<UCAPTITLE>${title}</UCAPTITLE>` +
    `<UCAPCONTENT><p>自${year}年${month}月${day}日24时起执行。</p>` +
    `<p>克拉玛依市各加油站成品油最高零售价格表</p>` +
    `<table><tr><td>${unit}</td></tr>` +
    `<tr><td>品种</td><td>规定价格（元/吨）</td><td colspan="2">${area}</td>` +
    `<td colspan="2">独山子区</td></tr>` +
    row('92号汽油（Ⅴ）', '10470', '764.3', '8.00', '764.3', '8.00') +
    row('95号汽油（Ⅴ）', '11070', '779', '8.62', '779', '8.62') +
    row('0号车用柴油(Ⅴ)', '9240', dieselDensity, diesel, '840.4', '7.77') +
    `</table><p>克拉玛依市发展和改革委员会</p></UCAPCONTENT>`;
}

function reader(pages) {
  return async url => {
    assert.ok(url in pages, `unexpected request ${url}`);
    return pages[url];
  };
}

test('discovers the newest municipal notice and keeps the named city-area price column', async () => {
  const latest = await monitor.collect({ getText: reader({
    [listUrl]: list([
      { date: '2026-09-24', title: oldTitle, url: oldUrl },
      { date: '2026-10-15', title: newTitle, url: newUrl.replace('https:', 'http:') },
    ]),
    [newUrl]: article(),
  }), today: '2026-10-16' });
  assert.deepEqual(latest, {
    url: newUrl,
    publishedDate: '2026-10-15',
    effectiveDate: '2026-10-16',
    prices: { '92': 8, '95': 8.62, diesel: 7.94 },
    requiresManualPriceReview: true,
  });
});

test('leaves an announced future adjustment out until its price takes effect', async () => {
  const current = await monitor.collect({ getText: reader({
    [listUrl]: list([
      { date: '2026-10-15', title: newTitle, url: newUrl },
      { date: '2026-09-24', title: oldTitle, url: oldUrl },
    ]),
    [oldUrl]: article({ title: oldTitle, date: '2026-09-24' }),
  }), today: '2026-10-15' });
  assert.equal(current.publishedDate, '2026-09-24');
});

test('rejects a forged host, mismatched source, missing city scope, wrong unit, and inconsistent prices', async () => {
  const cases = [
    { url: 'https://www.klmy.gov.cn.evil.test/klmys/c100186/202610/1234567890abcdef1234567890abcdef.shtml', html: article(), error: /非预期的市政府正文地址/ },
    { url: newUrl, html: article({ source: '未知来源' }), error: /标题、日期或来源/ },
    { url: newUrl, html: article({ date: '2026-10-14' }), error: /标题、日期或来源/ },
    { url: newUrl, html: article({ area: '全疆' }), error: /适用区缺失/ },
    { url: newUrl, html: article({ unit: '元/公斤' }), error: /升价表、单位或适用区缺失/ },
    { url: newUrl, html: article({ diesel: '7.95' }), error: /升价与官方吨价、密度不符/ },
  ];
  for (const item of cases) {
    await assert.rejects(monitor.collect({ getText: reader({
      [listUrl]: list([{ date: '2026-10-15', title: newTitle, url: item.url }]),
      [newUrl]: item.html,
    }), today: '2026-10-16' }), item.error);
  }
});

test('18 signed city notices import as audited, city-scoped history', () => {
  const record = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'verified', 'xinjiang-karamay-main.json'), 'utf8'));
  const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'prices.json'), 'utf8'));
  const merged = importVerified(snapshot, record);
  const region = merged.regions['xinjiang-karamay-main'];
  assert.equal(record.notices.length, 18);
  assert.equal(region.grades['92'].price, 8.48);
  assert.equal(region.grades['95'].price, 9.13);
  assert.equal(region.grades.diesel.price, 8.18);
  assert.equal(region.grades.diesel.history.length, 18);
  assert.match(region.priceScope, /克拉玛依区、白碱滩区、乌尔禾区/);
});
