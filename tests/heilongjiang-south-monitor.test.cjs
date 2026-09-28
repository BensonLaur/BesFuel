'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const monitor = require('../scripts/monitors/heilongjiang-south.cjs');
const verified = require('../data/verified/heilongjiang-south.json');

const listUrl = 'https://drc.hlj.gov.cn/common/search/b7cc7a3d659240c7a92b07e66eff9824?_isAgg=true&_isJson=true&_pageSize=30&_template=index&_rangeTimeGte=&_channelName=&page=1';
const articleUrl = 'https://drc.hlj.gov.cn/drc/c111486/202610/c00_31990001.shtml';
const title = '我省调整成品油价格';

function listing() {
  return JSON.stringify({ data: { results: [
    { title: '玉米价格', publishedTimeStr: '2026-10-15 17:00:00', url: '/drc/other.shtml' },
    { title, publishedTimeStr: '2026-10-15 16:51:57', url: '/drc/c111486/202610/c00_31990001.shtml' },
    { title, publishedTimeStr: '2026-09-24 16:51:57', url: '/drc/c111486/202609/c00_31979097.shtml' },
  ] } });
}

function article(image = '31990001/images/价格表.png') {
  return `<h1 class="article_title">${title}</h1>
    <span class="date">日期：<b>2026-10-15 16:51</b></span>
    <div class="article_content" id="zoomcon">
      <p>自20<span>26</span>年10月15日24时起，</p>
      <p>89号汽油最高零售价格为每吨10690元，0号柴油最高零售价格为每吨9620元。</p>
      <img src="${image}">
    </div><!--正文 end-->`;
}

function reader(html) {
  return async (url) => {
    if (url === listUrl) return listing();
    if (url === articleUrl) return html;
    throw new Error(`unexpected URL: ${url}`);
  };
}

test('discovers the latest price notice while leaving image tonnes for manual review', async () => {
  const result = await monitor.collect({ getText: reader(article()), today: '2026-10-15' });
  assert.deepEqual(result, {
    url: articleUrl,
    publishedDate: '2026-10-15',
    effectiveDate: '2026-10-16',
    imageUrl: 'https://drc.hlj.gov.cn/drc/c111486/202610/31990001/images/%E4%BB%B7%E6%A0%BC%E8%A1%A8.png',
    requiresManualPriceReview: true,
    coefficientNoticeUrl: 'https://drc.hlj.gov.cn/drc/c111433/202604/c00_31936584.shtml',
    coefficientValidFrom: '2026-05-01',
    coefficientValidThrough: '2026-10-31',
    requiresManualCoefficientReview: false,
  });
  assert.equal('prices' in result, false);
});

test('rejects a price image outside the announcement directory', async () => {
  await assert.rejects(
    monitor.collect({ getText: reader(article('https://example.com/price.png')), today: '2026-10-15' }),
    /价格表图片不是预期的省发改委地址/,
  );
});

test('requires coefficient review outside the verified season even if the notice URL is unchanged', async () => {
  const flags = [];
  for (const today of ['2026-04-30', '2026-05-01', '2026-10-31', '2026-11-01']) {
    const result = await monitor.collect({ getText: reader(article()), today });
    assert.equal(result.url, articleUrl);
    flags.push(result.requiresManualCoefficientReview);
  }
  assert.deepEqual(flags, [true, false, false, true]);
});

test('verified history uses each official tonne price and the published summer conversion', () => {
  assert.equal(verified.conversion.validFrom, '2026-05-01');
  assert.equal(verified.conversion.validThrough, '2026-10-31');
  assert.equal(verified.notices.length, 11);
  for (const notice of verified.notices) {
    assert.ok(notice.effectiveDate >= verified.conversion.validFrom &&
      notice.effectiveDate <= verified.conversion.validThrough);
    for (const grade of ['92', '95', 'diesel']) {
      const cents = Math.round(notice.tonPrices[grade] * 100 /
        verified.conversion.litersPerTon[grade]);
      assert.equal(notice.prices[grade], cents / 100);
    }
  }
  assert.deepEqual(verified.notices.at(-1).prices, { 92: 8.58, 95: 9.19, diesel: 8.08 });
});
