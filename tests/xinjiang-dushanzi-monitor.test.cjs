'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const monitor = require('../scripts/monitors/xinjiang-dushanzi.cjs');
const verified = require('../data/verified/xinjiang-dushanzi.json');
const { importVerified } = require('../scripts/import-verified.cjs');

const listUrl = 'https://www.klmy.gov.cn/search/db9694580ad74929979e1981b8c534f9?page=1&_pageSize=100&_isAgg=true&_isJson=true&_template=index&_rangeTimeGte=&_channelName=';
const currentUrl = 'https://www.klmy.gov.cn/klmys/c100186/202609/12cf558ed5584d25b75d1f4e709f8746.shtml';
const futureUrl = 'https://www.klmy.gov.cn/klmys/c100186/202610/1234567890abcdef1234567890abcdef.shtml';
const currentTitle = '2026年9月24日24时起我市成品油价格按机制上调';

function listing({ title = currentTitle, url = currentUrl, date = '2026-09-24',
  future = false } = {}) {
  const item = (name, href, day) => ({
    title: name, url: href.replace('https:', 'http:'),
    publishedTimeStr: `${day} 17:18:49`, channelCodeName: 'c100186', channelName: '价格信息',
  });
  const results = [item(title, url, date)];
  if (future) results.unshift(item('2026年10月15日24时起我市成品油价格按机制下调', futureUrl, '2026-10-15'));
  return JSON.stringify({ data: { channelId: 'db9694580ad74929979e1981b8c534f9', results } });
}

function article({ title = currentTitle, date = '2026-09-24',
  zoneHeader = '克拉玛依区、白碱滩区、乌尔禾区 独山子区',
  dieselMain = '8.18', dieselDushanzi = '8.00', dieselDensity = '840.4',
  gasolineDushanzi = '8.48', unit = '元/升' } = {}) {
  return `<meta name="ArticleTitle" content="${title}"/>
    <meta name="ContentSource" content="市发展和改革委员会"/>
    <meta name="PubDate" content="${date} 17:18">
    <UCAPTITLE>${title}</UCAPTITLE>
    <UCAPCONTENT><p>按照国家发展改革委通知要求，自2026年9月24日24时起，我市调整成品油销售价格。</p>
    <p>附：克拉玛依市各加油站成品油最高零售价格表 ${unit}</p>
    <table><tr><td>品种</td><td>规定价格（元/吨）</td><td>${zoneHeader}</td></tr>
      <tr><td>92号汽油（Ⅴ）</td><td>11098</td><td>764.3</td><td>8.48</td><td>764.3</td><td>${gasolineDushanzi}</td></tr>
      <tr><td>95号汽油（Ⅴ）</td><td>11726</td><td>779</td><td>9.13</td><td>779</td><td>9.13</td></tr>
      <tr><td>0号车用柴油(Ⅴ)</td><td>9515</td><td>859.6</td><td>${dieselMain}</td><td>${dieselDensity}</td><td>${dieselDushanzi}</td></tr>
    </table><p>克拉玛依市发展和改革委员会 2026年9月24日</p></UCAPCONTENT>`;
}

function reader({ list = listing(), body = article() } = {}) {
  return { async getText(url) {
    if (url === listUrl) return list;
    if (url === currentUrl) return body;
    throw new Error(`unexpected URL: ${url}`);
  } };
}

test('reads the official independent Dushanzi price column and effective date', async () => {
  assert.deepEqual(await monitor.collect({ ...reader(), today: '2026-09-29' }), {
    url: currentUrl, publishedDate: '2026-09-24', effectiveDate: '2026-09-25',
    prices: { 92: 8.48, 95: 9.13, diesel: 8.00 }, requiresManualPriceReview: true,
  });
});

test('ignores an announced but not yet effective future adjustment', async () => {
  const result = await monitor.collect({ ...reader({ list: listing({ future: true }) }), today: '2026-09-29' });
  assert.equal(result.url, currentUrl);
});

test('rejects a foreign article, duplicate period, or inconsistent listing date', async () => {
  await assert.rejects(monitor.collect({ ...reader({ list: listing({ url: 'https://example.org/klmys/c100186/202609/12cf558ed5584d25b75d1f4e709f8746.shtml' }) }), today: '2026-09-29' }), /非预期/);
  const duplicate = JSON.parse(listing());
  duplicate.data.results.push(duplicate.data.results[0]);
  await assert.rejects(monitor.collect({ ...reader({ list: JSON.stringify(duplicate) }), today: '2026-09-29' }), /重复/);
  await assert.rejects(monitor.collect({ ...reader({ list: listing({ date: '2026-09-23' }) }), today: '2026-09-29' }), /列表日期/);
});

test('rejects a swapped diesel column, invalid density, or missing price unit', async () => {
  for (const body of [
    article({ dieselDushanzi: '8.18' }),
    article({ dieselDensity: '859.6' }),
    article({ gasolineDushanzi: '8.18' }),
    article({ unit: '元/吨' }),
    article({ zoneHeader: '克拉玛依区、白碱滩区、乌尔禾区' }),
  ]) {
    await assert.rejects(monitor.collect({ ...reader({ body }), today: '2026-09-29' }), /双价区|价格表/);
  }
});

test('preserves twelve individually sourced Dushanzi rounds and imports only its prices', () => {
  assert.equal(verified.unit, '元/升');
  assert.equal(verified.notices.length, 12);
  assert.equal(verified.notices.at(-1).effectiveDate, '2026-09-25');
  assert.deepEqual(verified.notices.at(-1).prices, { 92: 8.48, 95: 9.13, diesel: 8.00 });
  assert.ok(verified.notices.every(notice => notice.url.startsWith('https://www.klmy.gov.cn/klmys/c100186/') &&
    Number.isFinite(notice.prices.diesel)));
  const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/prices.json'), 'utf8'));
  const imported = importVerified(snapshot, verified);
  assert.equal(imported.regions['xinjiang-dushanzi'].grades.diesel.price, 8.00);
  assert.equal(imported.regions['xinjiang-dushanzi'].grades.diesel.history.length, 12);
});
