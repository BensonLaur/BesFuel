'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const monitor = require('../scripts/monitors/xizang-lhasa.cjs');
const verified = require('../data/verified/xizang-lhasa.json');
const { checkMonitors } = require('../scripts/check-monitors.cjs');
const { importVerified } = require('../scripts/import-verified.cjs');

const listUrl = 'https://drc.xizang.gov.cn/zwgk_1941/tz/';
const articleUrl = 'https://drc.xizang.gov.cn/fgdt/jggl/202610/t20261015_999999.html';

function article({ scope = '拉萨、日喀则、山南、林芝、那曲', diesel = '8.95',
  date = '2026年10月15日', pageDate = '2026-10-15' } = {}) {
  return `<h1>西藏自治区成品油销售价格调整通知</h1>
    <p>发布时间：${pageDate} 来源：价格处</p>
    <p>我区成品油销售价格自${date}24时起同步调整。</p>
    <p>一、调整后的全区成品油销售价格</p>
    <p>（一）拉萨价区（包括${scope}）</p>
    <p>95号汽油每吨由12916.77元上调为13,369.99元，每升由9.69元上调为10.15元。</p>
    <p>92号汽油每吨由12241.95元上调为12,655.80元，每升由9.17元上调为9.61元。</p>
    <p>0号柴油每吨由10030.00元上调为10,419.40元，每升由8.50元上调为${diesel}元。</p>
    <p>（二）昌都价区</p>`;
}

function readers({ href = articleUrl, body = article() } = {}) {
  return { async getText(url) {
    if (url === listUrl) return `<a href="${href}">西藏自治区成品油销售价格调整通知</a>`;
    if (url === href) return body;
    throw new Error(`unexpected URL: ${url}`);
  } };
}

test('discovers latest official notice and verifies Lhasa scope and three grades', async () => {
  assert.deepEqual(await monitor.collect(readers()), {
    url: articleUrl,
    publishedDate: '2026-10-15',
    effectiveDate: '2026-10-16',
    requiresManualPriceReview: true,
  });
});

test('accepts an official notice posted four days after the adjustment', async () => {
  const url = 'https://drc.xizang.gov.cn/zwgk_1941/tz/202610/t20261019_999999.html';
  assert.deepEqual(await monitor.collect(readers({
    href: url,
    body: article({ date: '2026年10月15日', pageDate: '2026-10-19' }),
  })), {
    url,
    publishedDate: '2026-10-15',
    effectiveDate: '2026-10-16',
    requiresManualPriceReview: true,
  });
});

test('rejects foreign notices, changed coverage, and missing diesel price', async () => {
  await assert.rejects(monitor.collect(readers({ href: 'https://example.org/202610/t20261015_999999.html' })), /不是预期/);
  await assert.rejects(monitor.collect(readers({ href: 'https://drc.xizang.gov.cn/fgdt/jggl/202609/t20261015_999999.html' })), /月份与日期不符/);
  await assert.rejects(monitor.collect(readers({ body: article({ scope: '拉萨、日喀则' }) })), /范围或价格分段异常/);
  await assert.rejects(monitor.collect(readers({ body: article({ diesel: '待核实' }) })), /0号柴油每升价缺失/);
});

test('new announcement requires review while trusted prices remain untouched', async () => {
  const results = await checkMonitors({
    modules: [monitor],
    data: { regions: { 'xizang-lhasa': { source: { url: verified.notices.at(-1).url } } } },
    reader: () => readers(),
  });
  assert.equal(results[0].ok, true);
  assert.equal(results[0].needsReview, true);
  assert.equal('prices' in results[0].latest, false);
});

test('audited history keeps the five-city zone and the delayed June notice', () => {
  assert.equal(verified.notices.length, 12);
  assert.match(verified.priceScope, /拉萨、日喀则、山南、林芝、那曲/);
  assert.deepEqual(verified.notices.at(-1).prices, { 92: 9.48, 95: 10.03, diesel: 8.83 });
  assert.equal(verified.notices.find(item => item.publishedDate === '2026-06-18').effectiveDate, '2026-06-19');
  assert.match(verified.notices.find(item => item.publishedDate === '2026-06-18').url, /t20260622_/);
  assert.deepEqual(verified.notices.map(item => item.effectiveDate),
    [...verified.notices.map(item => item.effectiveDate)].sort());
  for (const notice of verified.notices) {
    assert.match(notice.url, /^https:\/\/drc\.xizang\.gov\.cn\/(?:zwgk_1941\/tz|fgdt\/jggl)\/\d{6}\/t\d{8}_\d+\.html$/);
    assert.ok(notice.prices.diesel < notice.prices['92'] && notice.prices['92'] < notice.prices['95']);
  }
  const existing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'prices.json'), 'utf8'));
  const data = importVerified(existing, verified);
  assert.equal(data.regions['xizang-lhasa'].grades.diesel.price, 8.83);
  assert.equal(data.regions['xizang-lhasa'].grades['92'].history.length, 12);
});
