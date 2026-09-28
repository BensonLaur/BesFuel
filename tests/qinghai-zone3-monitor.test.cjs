'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const monitor = require('../scripts/monitors/qinghai-zone3.cjs');
const verified = require('../data/verified/qinghai-zone3.json');
const { importVerified } = require('../scripts/import-verified.cjs');

const NOTICE_LIST = 'http://fgw.qinghai.gov.cn/xwzx/tzgg/';
const PRICE_LIST = 'http://fgw.qinghai.gov.cn/sjfb/jgdt/';
const CURRENT_URL = 'http://fgw.qinghai.gov.cn/xwzx/tzgg/202609/t20260924_92769.html';
const CURRENT_IMAGE = 'http://fgw.qinghai.gov.cn/xwzx/tzgg/202609/W020260924585955568253.JPG';
const PRIOR_URL = 'http://fgw.qinghai.gov.cn/xwzx/tzgg/202609/t20260911_92671.html';
const PRIOR_IMAGE = 'http://fgw.qinghai.gov.cn/xwzx/tzgg/202609/W020260911615860867869.JPG';
const JULY_URL = 'http://fgw.qinghai.gov.cn/sjfb/jgdt/202607/t20260703_92127.html';
const JULY_IMAGE = 'http://fgw.qinghai.gov.cn/sjfb/jgdt/202607/W020260703627584909872.png';
const TITLE = '我省调整省内成品油最高零售价格';

function row(url, date, title = TITLE) {
  return `<li class="clearfix"><a href="${url}" target="_blank">${title}</a><span>[${date}]</span></li>`;
}

function list(...rows) {
  return `<ul class=" clearfix con-item listcontent_ul overflows">
    ${rows.join('')}</ul>`;
}

function article({ title = TITLE, date = '2026-09-24', image = CURRENT_IMAGE,
  table = false } = {}) {
  const [year, month, day] = date.split('-');
  return `<div>${title}</div><div>发布时间：${year}年${month}月${day}日 16:11</div>
    <p>我省自${year}年${Number(month)}月${Number(day)}日24时起同步调整省内各价区汽、柴油最高零售价格。</p>
    <p>附件：青海省汽、柴油最高零售价格表</p>
    ${image ? `<img src="${image}">` : ''}
    ${table ? '<table><tr><td>三价区</td><td>8.76</td></tr></table>' : ''}`;
}

const jpeg = Buffer.concat([Buffer.from('ffd8ff', 'hex'), Buffer.alloc(2500)]);

function reader(notice = list(row(CURRENT_URL, '2026-09-24'), row(PRIOR_URL, '2026-09-11')),
  prices = list(row(CURRENT_URL, '2026-09-24')), body = article(), image = jpeg) {
  return {
    getText: async url => {
      if (url === NOTICE_LIST) return notice;
      if (url === PRICE_LIST) return prices;
      assert.equal(url, CURRENT_URL);
      return body;
    },
    getBuffer: async url => (assert.equal(url, CURRENT_IMAGE), { buffer: image }),
  };
}

test('monitors the latest official third-zone image and requires human price reading', async () => {
  const latest = await monitor.collect({ ...reader(), today: '2026-09-28' });
  assert.deepEqual(latest, { title: TITLE, publishedDate: '2026-09-24',
    effectiveDate: '2026-09-25', url: CURRENT_URL, imageUrl: CURRENT_IMAGE,
    requiresManualLiterReview: true });
  assert.equal('prices' in latest, false);
});

test('keeps the prior price until a 24:00 adjustment becomes effective', async () => {
  const latest = await monitor.collect({
    getText: async url => {
      if (url === NOTICE_LIST) return list(row(CURRENT_URL, '2026-09-24'), row(PRIOR_URL, '2026-09-11'));
      if (url === PRICE_LIST) return list(row(CURRENT_URL, '2026-09-24'), row(PRIOR_URL, '2026-09-11'));
      assert.equal(url, PRIOR_URL);
      return article({ date: '2026-09-11', image: PRIOR_IMAGE });
    },
    getBuffer: async url => (assert.equal(url, PRIOR_IMAGE), { buffer: jpeg }),
    today: '2026-09-24',
  });
  assert.equal(latest.url, PRIOR_URL);
  assert.equal(latest.effectiveDate, '2026-09-12');
});

test('finds a notice omitted from the notifications column in the price column', async () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(2500)]);
  const latest = await monitor.collect({
    getText: async url => {
      if (url === NOTICE_LIST) return list(row(PRIOR_URL, '2026-06-18'));
      if (url === PRICE_LIST) return list(row(JULY_URL, '2026-07-03'));
      assert.equal(url, JULY_URL);
      return article({ date: '2026-07-03', image: JULY_IMAGE });
    },
    getBuffer: async url => (assert.equal(url, JULY_IMAGE), { buffer: png }),
    today: '2026-07-04',
  });
  assert.equal(latest.url, JULY_URL);
  assert.equal(latest.imageUrl, JULY_IMAGE);
});

test('accepts an official HTML price table while still requiring manual liter review', async () => {
  const url = 'http://fgw.qinghai.gov.cn/xwzx/tzgg/202511/t20251110_90496.html';
  const latest = await monitor.collect({
    getText: async value => value === NOTICE_LIST ? list(row(url, '2025-11-10',
      '我省按照价格形成机制上调省内成品油最高零售价格')) : value === PRICE_LIST ?
      list(row(url, '2025-11-10', '我省按照价格形成机制上调省内成品油最高零售价格')) :
      (assert.equal(value, url), article({ date: '2025-11-10', image: null, table: true,
        title: '我省按照价格形成机制上调省内成品油最高零售价格' })),
    getBuffer: async () => { throw new Error('HTML table has no image'); },
    today: '2025-11-11',
  });
  assert.equal(latest.tableFormat, 'html');
  assert.equal(latest.requiresManualLiterReview, true);
});

test('rejects altered host, publication date, attachment URL and image content', async () => {
  for (const [input, pattern] of [
    [reader(list(row(CURRENT_URL.replace('fgw.qinghai.gov.cn/',
      'fgw.qinghai.gov.cn.evil.example/'), '2026-09-24'))), /不是预期的官网地址/],
    [reader(undefined, undefined, article({ date: '2026-09-23' })), /标题、发布日期或生效时间/],
    [reader(undefined, undefined, article({ image: 'http://evil.example/W020260924585955568253.JPG' })), /不是预期的官网地址/],
    [reader(undefined, undefined, article(), Buffer.alloc(2503)), /图片内容异常/],
  ]) {
    await assert.rejects(monitor.collect({ ...input, today: '2026-09-28' }), pattern);
  }
});

test('verified record has 25 ordered official tables and the latest third-zone prices', () => {
  assert.equal(verified.notices.length, 25);
  assert.match(verified.priceScope, /三价区/);
  assert.deepEqual(verified.notices.at(-1).prices, { '92': 8.76, '95': 9.39, diesel: 8.42 });
  const htmlNotice = verified.notices.find(notice => notice.publishedDate === '2025-11-10');
  assert.equal('imageUrl' in htmlNotice, false);
  assert.match(htmlNotice.url, /^http:\/\/fgw\.qinghai\.gov\.cn\//);
  const recovered = verified.notices.find(notice => notice.publishedDate === '2026-07-03');
  assert.match(recovered.url, /\/sjfb\/jgdt\//);
  for (let index = 0; index < verified.notices.length; index += 1) {
    const notice = verified.notices[index];
    assert.match(notice.url, /^http:\/\/fgw\.qinghai\.gov\.cn\/(?:xwzx\/tzgg|sjfb\/jgdt)\/\d{6}\/t\d{8}_\d+\.html$/);
    if (notice.imageUrl) assert.match(notice.imageUrl,
      /^http:\/\/fgw\.qinghai\.gov\.cn\/(?:xwzx\/tzgg|sjfb\/jgdt)\/\d{6}\/W020\d{18}\.(?:png|JPG)$/);
    assert.equal(notice.effectiveDate,
      new Date(Date.parse(`${notice.publishedDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10));
    if (index) assert.ok(notice.effectiveDate > verified.notices[index - 1].effectiveDate);
    for (const grade of ['92', '95', 'diesel']) {
      assert.ok(Number.isFinite(notice.prices[grade]) && notice.prices[grade] > 6 && notice.prices[grade] < 10);
    }
  }
  const imported = importVerified(require('../data/prices.json'), verified);
  assert.equal(imported.regions['qinghai-zone3'].grades.diesel.price, 8.42);
});
