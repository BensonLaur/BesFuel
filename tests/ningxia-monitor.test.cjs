'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const monitor = require('../scripts/monitors/ningxia.cjs');
const { importVerified } = require('../scripts/import-verified.cjs');

const listUrl = 'https://fzggw.nx.gov.cn/tzgg/';
const oldUrl = 'https://fzggw.nx.gov.cn/tzgg/202609/t20260924_5357138.html';
const nextUrl = 'https://fzggw.nx.gov.cn/tzgg/202610/t20261015_6000000.html';
const oldTitle = '宁夏成品油价格调整公告（2026年第18号）';
const nextTitle = '宁夏成品油价格调整公告（2026年第19号）';

function list(items) {
  return `<ul class="newslist">${items.map(({ url, date, title }) =>
    `<li><a href="${url}">${title}</a><span class="time">${date}</span></li>`).join('')}</ul>`;
}

function article({ title = nextTitle, posted = '2026-10-15', signed = '2026-10-15',
  effective = signed, source = '自治区发展和改革委员会', diesel = '8.46', unit = '元/升' } = {}) {
  const [year, month, day] = signed.split('-').map(Number);
  const [eYear, eMonth, eDay] = effective.split('-').map(Number);
  const row = (label, tonne, liter) => `<tr><td>${label}</td><td>${tonne}</td><td>${liter}</td></tr>`;
  return `<meta name="ArticleTitle" content="${title}">` +
    `<meta name="PubDate" content="${posted} 16:02">` +
    `<meta name="ContentSource" content="${source}" />` +
    `<div class="xilan-title">${title}</div>` +
    `<p>自${eYear}年${eMonth}月${eDay}日24时起执行。</p>` +
    `<p>宁夏回族自治区发展和改革委员会${year}年${month}月${day}日</p>` +
    `<p>宁夏市场成品油最高零售价格表</p>` +
    `<table><tr><th>最高零售价</th><th>元/吨</th><th>${unit}</th></tr>` +
    row('92号车用汽油（106%）', '11400', '8.55') +
    row('95号车用汽油（112%）', '12045', '9.03') +
    row('0号车用柴油（100%）', '9960', diesel) + '</table>';
}

function reader(pages) {
  return async url => {
    assert.ok(url in pages, `unexpected request ${url}`);
    return pages[url];
  };
}

test('discovers newest official notice and reads the three maximum retail liter prices', async () => {
  const latest = await monitor.collect({ getText: reader({
    [listUrl]: list([
      { url: './202609/t20260924_5357138.html', date: '2026-09-24', title: oldTitle },
      { url: './202610/t20261015_6000000.html', date: '2026-10-15', title: nextTitle },
    ]),
    [nextUrl]: article(),
  }) });
  assert.deepEqual(latest, {
    url: nextUrl,
    publishedDate: '2026-10-15',
    effectiveDate: '2026-10-16',
    prices: { '92': 8.55, '95': 9.03, diesel: 8.46 },
    requiresManualPriceReview: true,
  });
});

test('recognizes a notice posted after its signed effective date', async () => {
  const delayedUrl = 'https://fzggw.nx.gov.cn/tzgg/202610/t20261018_6000001.html';
  const result = await monitor.collect({ getText: reader({
    [listUrl]: list([{ url: delayedUrl, date: '2026-10-18', title: nextTitle }]),
    [delayedUrl]: article({ posted: '2026-10-18', signed: '2026-10-15' }),
  }) });
  assert.equal(result.publishedDate, '2026-10-15');
  assert.equal(result.effectiveDate, '2026-10-16');
});

test('rejects forged host, mismatched metadata, unit, and incomplete price table', async () => {
  const cases = [
    { url: 'https://fzggw.nx.gov.cn.evil.test/tzgg/202610/t20261015_6000000.html', html: article(), error: /不是预期的自治区发改委地址/ },
    { url: nextUrl, html: article({ posted: '2026-10-14' }), error: /正文标题、发布日期或来源/ },
    { url: nextUrl, html: article({ source: '未知来源' }), error: /正文标题、发布日期或来源/ },
    { url: nextUrl, html: article({ effective: '2026-10-14' }), error: /署名、上站与生效日期/ },
    { url: nextUrl, html: article({ unit: '元/公斤' }), error: /正文署名、生效时间或升价表/ },
    { url: nextUrl, html: article().replace('0号车用柴油（100%）', '5号车用柴油（100%）'), error: /缺少可信的 92、95 或 0 号/ },
  ];
  for (const item of cases) {
    await assert.rejects(monitor.collect({ getText: reader({
      [listUrl]: list([{ url: item.url, date: '2026-10-15', title: nextTitle }]),
      [nextUrl]: item.html,
    }) }), item.error);
  }
});

test('18 signed provincial notices import as audited history', () => {
  const record = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'verified', 'ningxia.json'), 'utf8'));
  const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'prices.json'), 'utf8'));
  const merged = importVerified(snapshot, record);
  const region = merged.regions.ningxia;
  assert.equal(record.notices.length, 18);
  assert.equal(region.grades['92'].price, 8.5);
  assert.equal(region.grades['95'].price, 8.98);
  assert.equal(region.grades.diesel.price, 8.18);
  assert.equal(region.effectiveLabel, '2026-09-24 24:00 起');
  assert.equal(region.grades['92'].history.length, 18);
  assert.equal(region.grades['92'].history[16].date, '2026-09-12');
  assert.equal(record.notices[16].postedDate, '2026-09-15');
});
