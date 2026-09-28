'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const monitor = require('../scripts/monitors/anhui.cjs');
const { importVerified } = require('../scripts/import-verified.cjs');

const listUrl = 'https://fzggw.ah.gov.cn/ywdt/tzgg/index.html';
const oldUrl = 'https://fzggw.ah.gov.cn/ywdt/tzgg/150688401.html';
const nextUrl = 'https://fzggw.ah.gov.cn/ywdt/tzgg/150800001.html';
const title = '安徽省发展改革委关于调整安徽省成品油价格的通告';

function list(items) {
  return `<ul class="doc_list list-49637171">${items.map(({ url, date }) =>
    `<li class="odd"><a href="${url}" title="${title}" class="left"><span>${title}</span></a>` +
    `<span class="right date">${date}</span></li>`).join('')}</ul>`;
}

function article(date, { diesel = '8.50', unit = '单位：元／吨，元／升' } = {}) {
  const [year, month, day] = date.split('-').map(Number);
  const row = (grade, tonne, liter, wholesale) => `<tr><td><span>${grade}</span></td>` +
    `<td>${tonne}</td><td><span>${liter}</span></td><td>${wholesale}</td></tr>`;
  return `<h1 class="newstitle">${title}</h1>` +
    `<div>发布日期：${date} 15:49</div><div>信息来源：省发展改革委</div>` +
    `<p>安徽省汽柴油最高零售和批发价格表（自 ${year} 年 ${month} 月 ${day} 日 24 时起执行）</p>` +
    `<p>${unit}</p><table>${row('92#国ⅥB乙醇汽油', '11500', '8.64', '11200')}` +
    row('95#国ⅥB乙醇汽油', '12100', '9.24', '11800') +
    row('0#国Ⅵ车用柴油', '9800', diesel, '9500') + '</table>';
}

function reader(pages) {
  return async url => {
    assert.ok(url in pages, `unexpected request ${url}`);
    return pages[url];
  };
}

test('discovers the latest provincial notice and reads only the 元/升 column', async () => {
  const latest = await monitor.collect({ getText: reader({
    [listUrl]: list([{ url: oldUrl, date: '2026-09-24' },
      { url: nextUrl, date: '2026-10-15' }]),
    [nextUrl]: article('2026-10-15'),
  }) });
  assert.deepEqual(latest, {
    url: nextUrl,
    publishedDate: '2026-10-15',
    effectiveDate: '2026-10-16',
    prices: { '92': 8.64, '95': 9.24, diesel: 8.5 },
    requiresManualPriceReview: true,
  });
});

test('rejects a forged URL, wrong date, missing price, and changed units', async () => {
  const cases = [
    { url: 'https://fzggw.ah.gov.cn.evil.test/ywdt/tzgg/150800001.html', date: '2026-10-15', html: article('2026-10-15'), error: /不是预期的省发改委地址/ },
    { url: nextUrl, date: '2026-10-15', html: article('2026-10-16'), error: /正文标题、来源或发布日期/ },
    { url: nextUrl, date: '2026-10-15', html: article('2026-10-15').replace('0#国Ⅵ车用柴油', '5#国Ⅵ车用柴油'), error: /缺少可信/ },
    { url: nextUrl, date: '2026-10-15', html: article('2026-10-15', { unit: '单位：元／吨' }), error: /单位异常/ },
  ];
  for (const item of cases) {
    await assert.rejects(monitor.collect({ getText: reader({
      [listUrl]: list([{ url: item.url, date: item.date }]),
      [nextUrl]: item.html,
    }) }), item.error);
  }
});

test('18 official notices import as chronological audited history', () => {
  const record = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'verified', 'anhui.json'), 'utf8'));
  const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'prices.json'), 'utf8'));
  const merged = importVerified(snapshot, record);
  const region = merged.regions.anhui;
  assert.equal(record.notices.length, 18);
  assert.equal(region.grades['92'].price, 8.55);
  assert.equal(region.grades['95'].price, 9.14);
  assert.equal(region.grades.diesel.price, 8.34);
  assert.equal(region.effectiveLabel, '2026-09-24 24:00 起');
  assert.equal(region.grades['92'].history.length, 18);
  assert.equal(region.grades['92'].history[0].date, '2026-01-21');
});
