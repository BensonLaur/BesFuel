'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const monitor = require('../scripts/monitors/xizang-ngari.cjs');
const verified = require('../data/verified/xizang-ngari.json');
const { checkMonitors } = require('../scripts/check-monitors.cjs');
const { importVerified } = require('../scripts/import-verified.cjs');

const listUrl = 'https://drc.xizang.gov.cn/zwgk_1941/tz/';
const articleUrl = 'https://drc.xizang.gov.cn/fgdt/jggl/202610/t20261015_999999.html';

function article({ zone = '阿里价区', diesel = '9.40', date = '2026年10月15日',
  pageDate = '2026-10-15' } = {}) {
  return `<h1>西藏自治区成品油销售价格调整通知</h1>
    <p>发布时间：${pageDate} 来源：价格处</p>
    <p>我区成品油销售价格自${date}24时起同步调整。</p>
    <p>一、调整后的全区成品油销售价格</p>
    <p>（一）拉萨价区（包括拉萨、日喀则、山南、林芝、那曲）</p>
    <p>95号汽油每吨由12916.77元上调为13,369.99元，每升由9.69元上调为10.15元。</p>
    <p>92号汽油每吨由12241.95元上调为12,655.80元，每升由9.17元上调为9.61元。</p>
    <p>0号柴油每吨由10030.00元上调为10,419.40元，每升由8.50元上调为8.95元。</p>
    <p>（二）昌都价区</p>
    <p>95号汽油每吨由13000.00元上调为13,400.00元，每升由9.88元上调为10.36元。</p>
    <p>（三）${zone}</p>
    <p>95号汽油每吨由13,490.33元上调为13,931.54元，每升由10.09元上调为10.42元。</p>
    <p>92号汽油每吨由12,777.90元上调为13,192.68元，每升由9.55元上调为9.86元。</p>
    <p>0号柴油每吨由10,531.62元上调为10,921.68元，每升由8.91元上调为${diesel}元。</p>
    <p>二、根据国家关于国Ⅵ油品升级要求</p>`;
}

function readers({ href = articleUrl, body = article() } = {}) {
  return { async getText(url) {
    if (url === listUrl) return `<a href="/zwgk_1941/tz/202609/t20260924_560588.html">西藏自治区成品油销售价格调整通知</a>
      <a href="${href}">西藏自治区成品油销售价格调整通知</a>`;
    if (url === href) return body;
    throw new Error(`unexpected URL: ${url}`);
  } };
}

test('finds latest official article and checks Ali section separately from Lhasa and Chamdo', async () => {
  assert.deepEqual(await monitor.collect(readers()), {
    url: articleUrl,
    publishedDate: '2026-10-15',
    effectiveDate: '2026-10-16',
    requiresManualPriceReview: true,
  });
});

test('accepts a late published official notice but keeps 24:00 effective date', async () => {
  const url = 'https://drc.xizang.gov.cn/zwgk_1941/tz/202610/t20261019_999999.html';
  assert.equal((await monitor.collect(readers({
    href: url,
    body: article({ date: '2026年10月15日', pageDate: '2026-10-19' }),
  }))).effectiveDate, '2026-10-16');
});

test('rejects foreign host, altered URL dates, missing Ali zone or diesel liter price', async () => {
  await assert.rejects(monitor.collect(readers({ href: 'https://example.org/202610/t20261015_999999.html' })), /不是预期/);
  await assert.rejects(monitor.collect(readers({ href: 'https://drc.xizang.gov.cn/fgdt/jggl/202609/t20261015_999999.html' })), /月份与日期不符/);
  await assert.rejects(monitor.collect(readers({ body: article({ zone: '昌都价区' }) })), /范围或价格分段异常/);
  await assert.rejects(monitor.collect(readers({ body: article({ diesel: '待核实' }) })), /0号柴油每升价缺失/);
  await assert.rejects(monitor.collect(readers({ body: article({ date: '2026年10月20日' }) })), /日期冲突/);
});

test('new notice requires review without replacing trusted prices', async () => {
  const results = await checkMonitors({
    modules: [monitor],
    data: { regions: { 'xizang-ngari': { source: { url: verified.notices.at(-1).url } } } },
    reader: () => readers(),
  });
  assert.equal(results[0].ok, true);
  assert.equal(results[0].needsReview, true);
  assert.equal('prices' in results[0].latest, false);
});

test('12 audited Ali periods import as an independent price zone', () => {
  assert.equal(verified.unit, '元/升');
  assert.equal(verified.notices.length, 12);
  assert.match(verified.priceScope, /阿里价区.*拉萨、昌都价区分别定价/);
  assert.deepEqual(verified.notices.at(-1).prices, { 92: 9.86, 95: 10.42, diesel: 9.24 });
  assert.deepEqual(verified.notices.find(item => item.publishedDate === '2026-07-03').prices,
    { 92: 8.45, 95: 8.92, diesel: 7.78 });
  assert.equal(verified.notices.find(item => item.publishedDate === '2026-06-18').effectiveDate, '2026-06-19');
  assert.match(verified.notices.find(item => item.publishedDate === '2026-08-28').url, /t20260831_/);
  assert.deepEqual(verified.notices.map(item => item.effectiveDate),
    [...verified.notices.map(item => item.effectiveDate)].sort());
  for (const notice of verified.notices) {
    assert.match(notice.url, /^https:\/\/drc\.xizang\.gov\.cn\/(?:zwgk_1941\/tz|fgdt\/jggl)\/\d{6}\/t\d{8}_\d+\.html$/);
    assert.ok(notice.prices.diesel < notice.prices['92'] && notice.prices['92'] < notice.prices['95']);
  }
  const existing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'prices.json'), 'utf8'));
  const data = importVerified(existing, verified);
  assert.equal(data.regions['xizang-ngari'].grades.diesel.price, 9.24);
  assert.equal(data.regions['xizang-ngari'].grades['95'].history.length, 12);
  assert.equal(data.regions['xizang-ngari'].name, '西藏·阿里价区');
});
