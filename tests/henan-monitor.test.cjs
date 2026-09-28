'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const monitor = require('../scripts/monitors/henan.cjs');
const { importVerified } = require('../scripts/import-verified.cjs');

const listUrl = 'https://fgw.henan.gov.cn/xwzx/tzgg/cpydj/';
const oldUrl = 'https://fgw.henan.gov.cn/2026/09-24/3432590.html';
const nextUrl = 'https://fgw.henan.gov.cn/2026/10-15/3500000.html';
const oldTitle = '我省成品油价格调整';
const nextTitle = '明日起我省调整成品油价格';

function list(items) {
  return `<div class="news-list"><ul>${items.map(({ url, date, title }) =>
    `<li><a href="${url}" target="_blank">${title}</a><span>${date}</span></li>`).join('')}` +
    '</ul><div id="pageArea"></div></div>';
}

function article(date, title, { diesel = '8.50', source = '价管处' } = {}) {
  const [year, month, day] = date.split('-').map(Number);
  return `<p class="yTit">${title}</p><div class="lyBox cl"><div class="sj fl">` +
    `<span>时间：${date} 18:18</span><span>来源：${source}</span></div></div>` +
    `<div class="conBox"><p>根据国家发展改革委统一部署，自${year}年${month}月${day}日24时起，` +
    '我省国VIB车用乙醇汽油和国VI车用柴油最高零售价格和批发价格如下：</p>' +
    '<p>最高零售价格：92号汽油价格上调0.30元/升，由8.62元/升调整为8.92元/升；' +
    '95号汽油价格上调0.32元/升，由9.21元/升调整为9.53元/升。' +
    `0号柴油价格上调0.29元/升，由8.29元/升调整为${diesel}元/升。</p>` +
    '<p>最高批发价格：92号汽油12000元/吨。</p></div>';
}

function reader(pages) {
  return async url => {
    assert.ok(url in pages, `unexpected request ${url}`);
    return pages[url];
  };
}

test('discovers newest official notice and reads three retail liter prices', async () => {
  const latest = await monitor.collect({ getText: reader({
    [listUrl]: list([
      { url: oldUrl.replace('https:', 'http:'), date: '2026-09-24', title: oldTitle },
      { url: nextUrl.replace('https:', 'http:'), date: '2026-10-15', title: nextTitle },
    ]),
    [nextUrl]: article('2026-10-15', nextTitle),
  }) });
  assert.deepEqual(latest, {
    url: nextUrl,
    publishedDate: '2026-10-15',
    effectiveDate: '2026-10-16',
    prices: { '92': 8.92, '95': 9.53, diesel: 8.5 },
    requiresManualPriceReview: true,
  });
});

test('rejects forged host, mismatched date, source, and missing grade', async () => {
  const cases = [
    { url: 'https://fgw.henan.gov.cn.evil.test/2026/10-15/3500000.html', html: article('2026-10-15', nextTitle), error: /不是预期的省发改委地址/ },
    { url: nextUrl, html: article('2026-10-14', nextTitle), error: /标题、日期或来源/ },
    { url: nextUrl, html: article('2026-10-15', nextTitle, { source: '未知来源' }), error: /标题、日期或来源/ },
    { url: nextUrl, html: article('2026-10-15', nextTitle).replace('0号柴油价格上调', '5号柴油价格上调'), error: /0号柴油最高零售升价缺失/ },
  ];
  for (const item of cases) {
    await assert.rejects(monitor.collect({ getText: reader({
      [listUrl]: list([{ url: item.url, date: '2026-10-15', title: nextTitle }]),
      [nextUrl]: item.html,
    }) }), item.error);
  }
});

test('18 provincial notices import as audited history', () => {
  const record = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'verified', 'henan.json'), 'utf8'));
  const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'prices.json'), 'utf8'));
  const merged = importVerified(snapshot, record);
  const region = merged.regions.henan;
  assert.equal(record.notices.length, 18);
  assert.equal(region.grades['92'].price, 8.62);
  assert.equal(region.grades['95'].price, 9.21);
  assert.equal(region.grades.diesel.price, 8.29);
  assert.equal(region.effectiveLabel, '2026-09-24 24:00 起');
  assert.equal(region.grades['92'].history.length, 18);
  assert.equal(region.grades['92'].history[0].date, '2026-01-21');
});
