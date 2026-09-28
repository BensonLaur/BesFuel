'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const monitor = require('../scripts/monitors/xizang-changdu.cjs');
const verified = require('../data/verified/xizang-changdu.json');
const { checkMonitors } = require('../scripts/check-monitors.cjs');
const { importVerified } = require('../scripts/import-verified.cjs');

const LIST = 'https://drc.xizang.gov.cn/zwgk_1941/tz/';
const NEXT = 'https://drc.xizang.gov.cn/fgdt/jggl/202610/t20261015_999999.html';
const LATEST = verified.notices.at(-1).url;
const TITLE = '西藏自治区成品油销售价格调整通知';

function article({ date = '2026年10月15日', pageDate = '2026-10-15', source = '价格处',
  zones = ['（一）拉萨价区（包括拉萨、日喀则、山南、林芝、那曲）', '（二）昌都价区', '（三）阿里价区'],
  prices = { 92: '9.80', 95: '10.35', diesel: '9.16' }, priceKind = '最高零售价格' } = {}) {
  return `<h1>${TITLE}</h1><p>发布时间：${pageDate} 来源：${source}</p>
    <p>我区成品油销售价格自${date}24时起同步调整。</p>
    <p>一、调整后的全区成品油销售价格</p><p>${zones[0]}</p>
    <p>92号汽油每吨由12000.00元上调为13000.00元，每升由9.48元上调为9.50元。</p>
    <p>${zones[1]}</p>
    <p>95号汽油每吨由13000.00元上调为14000.00元，每升由10.20元上调为${prices[95]}元。</p>
    <p>92号汽油每吨由12000.00元上调为13000.00元，每升由9.66元上调为${prices[92]}元。</p>
    <p>0号柴油每吨由11000.00元上调为12000.00元，每升由9.03元上调为${prices.diesel}元。</p>
    <p>${zones[2]}</p><p>此次上调后的价格为${priceKind}。</p>`;
}

function list(...urls) {
  return urls.map(url => `<li><a href="${url}">${TITLE}</a></li>`).join('');
}

function reader({ href = NEXT, body = article(), previous = false } = {}) {
  return { async getText(url) {
    if (url === LIST) return previous ? list(href, LATEST) : list(href);
    if (url === href) return body;
    if (url === LATEST && previous) return article({ date: '2026年9月24日', pageDate: '2026-09-24',
      prices: { 92: '9.66', 95: '10.20', diesel: '9.03' } });
    throw new Error(`unexpected URL: ${url}`);
  } };
}

test('finds the official Changdu section and waits until the 24:00 price is effective', async () => {
  assert.deepEqual(await monitor.collect({ ...reader(), today: '2026-10-16' }), {
    url: NEXT, publishedDate: '2026-10-15', effectiveDate: '2026-10-16',
    requiresManualPriceReview: true,
  });
  const prior = await monitor.collect({ ...reader({ previous: true }), today: '2026-10-15' });
  assert.equal(prior.url, LATEST);
  assert.equal(prior.effectiveDate, '2026-09-25');
});

test('accepts a notice posted four days after its signed and effective date', async () => {
  const href = 'https://drc.xizang.gov.cn/zwgk_1941/tz/202610/t20261019_999999.html';
  const result = await monitor.collect({ ...reader({ href,
    body: article({ pageDate: '2026-10-19' }) }), today: '2026-10-20' });
  assert.equal(result.publishedDate, '2026-10-15');
  assert.equal(result.effectiveDate, '2026-10-16');
});

test('rejects alien links, inconsistent notice dates, missing grade and wrong zone', async () => {
  for (const [input, expected] of [
    [reader({ href: 'https://drc.xizang.gov.cn.evil.example/fgdt/jggl/202610/t20261015_999999.html' }), /不是预期/],
    [reader({ href: 'https://drc.xizang.gov.cn/fgdt/jggl/202609/t20261015_999999.html' }), /月份与日期|不是预期/],
    [reader({ body: article({ pageDate: '2026-10-17' }) }), /网页日期与正文调价日期冲突/],
    [reader({ body: article({ zones: ['（一）拉萨价区', '（二）昌都价区', '（三）阿里价区'] }) }), /三价区/],
    [reader({ body: article({ prices: { 92: '9.80', 95: '10.35', diesel: '待核实' } }) }), /0号柴油每升价缺失/],
    [reader({ body: article({ priceKind: '预测价格' }) }), /最高零售价格性质未确认/],
    [reader({ body: article({ source: '匿名' }) }), /标题、来源/],
  ]) {
    await assert.rejects(monitor.collect({ ...input, today: '2026-10-16' }), expected);
  }
  await assert.rejects(monitor.collect({
    getText: async () => `<a href="${NEXT}">我区成品油销售价格按机制上调</a>`,
    today: '2026-10-16',
  }), /未知油价公告标题/);
});

test('new official notice flags manual review without replacing trusted snapshot', async () => {
  const result = await checkMonitors({
    modules: [monitor],
    data: { regions: { 'xizang-changdu': { source: { url: verified.notices.at(-2).url } } } },
    reader: () => reader({ href: LATEST,
      body: article({ date: '2026年9月24日', pageDate: '2026-09-24' }) }),
  });
  assert.equal(result[0].ok, true);
  assert.equal(result[0].needsReview, true);
  assert.equal('prices' in result[0].latest, false);
});

test('12 signed official notices retain Changdu prices, effective dates and source URLs', () => {
  const expected = [
    [9.51, 10.05, 8.88], [9.77, 10.31, 9.14], [9.82, 10.38, 9.20],
    [9.41, 9.94, 8.77], [9.00, 9.51, 8.35], [8.25, 8.71, 7.58],
    [8.49, 8.96, 7.82], [9.03, 9.53, 8.38], [8.85, 9.34, 8.19],
    [9.14, 9.66, 8.49], [9.35, 9.87, 8.71], [9.66, 10.20, 9.03],
  ];
  assert.equal(verified.notices.length, 12);
  assert.match(verified.priceScope, /昌都价区/);
  for (let i = 0; i < verified.notices.length; i += 1) {
    const notice = verified.notices[i];
    assert.deepEqual(['92', '95', 'diesel'].map(grade => notice.prices[grade]), expected[i]);
    assert.match(notice.url, /^https:\/\/drc\.xizang\.gov\.cn\/(?:zwgk_1941\/tz|fgdt\/jggl)\/\d{6}\/t\d{8}_\d+\.html$/);
    assert.equal(notice.effectiveDate, new Date(Date.parse(`${notice.publishedDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10));
    if (i) assert.ok(notice.effectiveDate > verified.notices[i - 1].effectiveDate);
  }
  // 6 月通知正文署期 18 日、19 日生效，官网 22 日补登，不应把补登日期当执行日。
  assert.match(verified.notices[4].url, /t20260622_/);
  assert.equal(verified.notices[4].publishedDate, '2026-06-18');
  const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'prices.json'), 'utf8'));
  const imported = importVerified(snapshot, verified).regions[verified.id];
  assert.equal(imported.grades['92'].price, 9.66);
  assert.equal(imported.grades['95'].price, 10.20);
  assert.equal(imported.grades.diesel.price, 9.03);
  assert.equal(imported.grades['92'].history.length, 12);
});
