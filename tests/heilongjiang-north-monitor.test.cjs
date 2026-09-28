'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const monitor = require('../scripts/monitors/heilongjiang-north.cjs');
const verified = require('../data/verified/heilongjiang-north.json');

const listUrl = 'https://drc.hlj.gov.cn/common/search/b7cc7a3d659240c7a92b07e66eff9824?_isAgg=true&_isJson=true&_pageSize=30&_template=index&_rangeTimeGte=&_channelName=&page=1';
const articleUrl = 'https://drc.hlj.gov.cn/drc/c111486/202610/c00_31990001.shtml';

function reader(url) {
  if (url === listUrl) return JSON.stringify({ data: { results: [
    { title: '我省调整成品油价格', publishedTimeStr: '2026-10-15 16:51:57',
      url: '/drc/c111486/202610/c00_31990001.shtml' },
  ] } });
  if (url === articleUrl) return `<h1 class="article_title">我省调整成品油价格</h1>
    <span class="date">日期：<b>2026-10-15 16:51</b></span>
    <div class="article_content" id="zoomcon">
      <p>自2026年10月15日24时起，</p>
      <p>89号汽油最高零售价格为每吨10690元，0号柴油最高零售价格为每吨9620元。</p>
      <img src="31990001/images/价格表.png">
    </div><!--正文 end-->`;
  throw new Error(`unexpected URL: ${url}`);
}

test('north zone monitor discovers the provincial notice without inferring image prices', async () => {
  const result = await monitor.collect({ getText: reader, today: '2026-10-15' });
  assert.equal(result.url, articleUrl);
  assert.equal(result.effectiveDate, '2026-10-16');
  assert.equal(result.requiresManualPriceReview, true);
  assert.equal('prices' in result, false);
  assert.equal(result.coefficientRuleUrl,
    'https://drc.hlj.gov.cn/drc/c111444/201701/c00_31467233.shtml');
  assert.equal(result.requiresManualCoefficientReview, false);
});

test('north zone requires a new coefficient review on November 1 with unchanged price notice', async () => {
  const before = await monitor.collect({ getText: reader, today: '2026-10-31' });
  const after = await monitor.collect({ getText: reader, today: '2026-11-01' });
  assert.equal(before.url, after.url);
  assert.equal(before.requiresManualCoefficientReview, false);
  assert.equal(after.requiresManualCoefficientReview, true);
});

test('all audited northern prices use the official northern summer coefficient', () => {
  assert.equal(verified.priceScope.includes('齐齐哈尔'), true);
  assert.equal(verified.priceScope.includes('抚远'), true);
  assert.equal(verified.conversion.validFrom, '2026-05-01');
  assert.equal(verified.conversion.validThrough, '2026-10-31');
  assert.deepEqual(verified.conversion.litersPerTon, {
    92: 1314.92, 95: 1296.64, diesel: 1186.6,
  });
  assert.equal(verified.notices.length, 11);
  for (const notice of verified.notices) {
    assert.ok(notice.effectiveDate >= verified.conversion.validFrom &&
      notice.effectiveDate <= verified.conversion.validThrough);
    for (const grade of ['92', '95', 'diesel']) {
      assert.equal(notice.prices[grade],
        Math.round(notice.tonPrices[grade] * 100 /
          verified.conversion.litersPerTon[grade]) / 100);
    }
  }
  assert.deepEqual(verified.notices.at(-1).prices, { 92: 8.62, 95: 9.23, diesel: 8.11 });
});
