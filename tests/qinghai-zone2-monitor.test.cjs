'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const monitor = require('../scripts/monitors/qinghai-zone2.cjs');
const verified = require('../data/verified/qinghai-zone2.json');
const { importVerified } = require('../scripts/import-verified.cjs');
const snapshot = require('../data/prices.json');

const HOST = 'http://fgw.qinghai.gov.cn';
const NOTICE_LIST = `${HOST}/xwzx/tzgg/`;
const PRICE_LIST = `${HOST}/sjfb/jgdt/`;
const LATEST_URL = `${HOST}/xwzx/tzgg/202609/t20260924_92769.html`;
const LATEST_IMAGE = `${HOST}/xwzx/tzgg/202609/W020260924585955568253.JPG`;
const PRICE_URL = `${HOST}/sjfb/jgdt/202609/t20260924_92768.html`;
const JULY_URL = `${HOST}/sjfb/jgdt/202607/t20260703_92127.html`;
const JULY_IMAGE = `${HOST}/sjfb/jgdt/202607/W020260703627584909872.png`;
const TITLE = '我省调整省内成品油最高零售价格';

function item(url, date, title = TITLE) {
  return `<li class="clearfix"><a href="${url}" target="_blank">${title}</a><span>[${date}]</span></li>`;
}

function list(url, date = '2026-09-24') {
  const section = url.includes('/sjfb/jgdt/') ? 'sjfb/jgdt' : 'xwzx/tzgg';
  const previousDate = date === '2026-09-24' ? '2026-09-11' : '2026-06-04';
  const stamp = previousDate.replaceAll('-', '');
  return `<ul>${item(url, date)}${item(`${HOST}/${section}/${stamp.slice(0, 6)}/t${stamp}_99999.html`, previousDate)}</ul>`;
}

function article({ date = '2026年09月24日', title = TITLE, source = '价格处提供',
  effective = '2026年9月24日24时起', image = `./${LATEST_IMAGE.split('/').at(-1)}` } = {}) {
  return `<h1>${title}</h1><script>来源：${source}</script>
    <span>发布时间：${date} 16:11</span>
    <div class="view TRS_UEDITOR"><p>我省自${effective}同步调整省内各价区汽、柴油最高零售价格。</p>
    <img src="${image}" /></div>`;
}

function jpeg() {
  return Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(5500)]);
}

function png() {
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(5500)]);
}

function reader({ notices = list(LATEST_URL), prices = list(PRICE_URL),
  body = article(), image = jpeg() } = {}) {
  return {
    getText: async url => {
      if (url === NOTICE_LIST) return notices;
      if (url === PRICE_LIST) return prices;
      assert.equal(url, LATEST_URL);
      return body;
    },
    getBuffer: async url => (assert.equal(url, LATEST_IMAGE), { buffer: image }),
  };
}

test('prefers the formal notice over same-day price-dynamic mirror and requires image review', async () => {
  const result = await monitor.collect({ ...reader(), today: '2026-09-28' });
  assert.deepEqual(result, {
    publishedDate: '2026-09-24', effectiveDate: '2026-09-25',
    url: LATEST_URL, imageUrl: LATEST_IMAGE, requiresManualPriceReview: true,
  });
  assert.equal('prices' in result, false);
});

test('finds a price-dynamic notice when the announcement column omitted July 3', async () => {
  const result = await monitor.collect({
    getText: async url => {
      if (url === NOTICE_LIST) return list(`${HOST}/xwzx/tzgg/202606/t20260618_92012.html`, '2026-06-18');
      if (url === PRICE_LIST) return list(JULY_URL, '2026-07-03');
      assert.equal(url, JULY_URL);
      return article({ date: '2026年07月03日', source: '价格处供稿',
        effective: '2026年7月3日24时起', image: `./${JULY_IMAGE.split('/').at(-1)}` });
    },
    getBuffer: async url => (assert.equal(url, JULY_IMAGE), { buffer: png() }),
    today: '2026-07-04',
  });
  assert.equal(result.url, JULY_URL);
  assert.equal(result.effectiveDate, '2026-07-04');
});

test('rejects forged source, inconsistent dates, foreign images and invalid file signatures', async () => {
  for (const [input, pattern] of [
    [reader({ notices: list('http://fgw.qinghai.gov.cn.evil.example/xwzx/tzgg/202609/t20260924_92769.html') }), /不是预期的官网地址/],
    [reader({ body: article({ date: '2026年09月23日' }) }), /标题、来源或日期异常/],
    [reader({ body: article({ source: '未知来源' }) }), /标题、来源或日期异常/],
    [reader({ body: article({ effective: '2026年9月25日24时起' }) }), /24 时执行时间/],
    [reader({ body: article({ image: 'http://example.com/table.JPG' }) }), /价格表图片缺失或重复/],
    [reader({ image: Buffer.alloc(5503) }), /图片内容异常/],
  ]) {
    await assert.rejects(monitor.collect({ ...input, today: '2026-09-28' }), pattern);
  }
});

test('12 manually checked official images preserve second-zone liter prices and geography', () => {
  const expected = [
    [8.50, 9.12, 8.15], [8.76, 9.39, 8.42], [8.82, 9.46, 8.47],
    [8.40, 9.01, 8.05], [7.99, 8.56, 7.62], [7.22, 7.74, 6.85],
    [7.46, 8.00, 7.09], [8.01, 8.59, 7.65], [7.83, 8.39, 7.46],
    [8.13, 8.72, 7.77], [8.34, 8.94, 7.98], [8.66, 9.28, 8.31],
  ];
  assert.equal(verified.notices.length, expected.length);
  assert.match(verified.priceScope, /第二价区.*具体地区待省级正式划分文件复核/);
  assert.equal(verified.unit, '元/升');
  for (let index = 0; index < verified.notices.length; index += 1) {
    const notice = verified.notices[index];
    const stamp = notice.publishedDate.replaceAll('-', '');
    const base = `^${HOST}/(?:xwzx/tzgg|sjfb/jgdt)/${stamp.slice(0, 6)}/`;
    assert.deepEqual(['92', '95', 'diesel'].map(grade => notice.prices[grade]), expected[index]);
    assert.match(notice.url, new RegExp(`${base}t${stamp}_\\d+\\.html$`));
    assert.match(notice.imageUrl, new RegExp(`${base}W020${stamp.slice(2)}\\d+\\.(?:JPG|png)$`));
    assert.equal(notice.effectiveDate,
      new Date(Date.parse(`${notice.publishedDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10));
    if (index) assert.ok(notice.effectiveDate > verified.notices[index - 1].effectiveDate);
  }
  assert.equal(verified.notices[5].url, JULY_URL);
  const imported = importVerified(snapshot, verified).regions[verified.id];
  assert.equal(imported.grades['92'].price, 8.66);
  assert.equal(imported.grades['95'].price, 9.28);
  assert.equal(imported.grades.diesel.price, 8.31);
  assert.equal(imported.grades['92'].history.length, 12);
});
