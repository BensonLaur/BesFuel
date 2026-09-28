'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const monitor = require('../scripts/monitors/shaanxi-xian.cjs');
const verified = require('../data/verified/shaanxi-xian.json');
const { importVerified } = require('../scripts/import-verified.cjs');

const LIST_URL = 'https://sndrc.shaanxi.gov.cn/zjww/jgcs/csxx/jgc/index_186.html';
const CURRENT_URL = 'https://sndrc.shaanxi.gov.cn/zjww/jgcs/csxx/jgc/202609/t20260924_3698846.html';
const CURRENT_IMAGE = 'https://sndrc.shaanxi.gov.cn/zjww/jgcs/csxx/jgc/202609/W020260924591852927577.png';
const PRIOR_URL = 'https://sndrc.shaanxi.gov.cn/zjww/jgcs/csxx/jgc/202609/t20260911_3689503.html';
const PRIOR_IMAGE = 'https://sndrc.shaanxi.gov.cn/zjww/jgcs/csxx/jgc/202609/W020260911627679042497.png';
const NEWS_URL = 'https://sndrc.shaanxi.gov.cn/zjww/jgcs/csxx/jgc/202608/t20260814_3666736.html';
const ANNOUNCEMENT = '陕西省成品油价格调整通告';

function row(url, title, date) {
  return `<li><a href="${url}">${title}</a><span>${date}</span></li>`;
}

function list(first = row(CURRENT_URL, ANNOUNCEMENT, '2026-09-24')) {
  return `<ul class="rightList">${first}${row(PRIOR_URL, ANNOUNCEMENT, '2026-09-11')}</ul>`;
}

function article({ title = ANNOUNCEMENT, date = '2026-09-24', image = CURRENT_IMAGE,
  source = '价格处' } = {}) {
  const [year, month, day] = date.split('-');
  return `<div class="title">${title}</div><div class="fTitile"><span>来源：${source}</span>
    <span>发布时间：${date}</span></div><div class="tyxlContent">
    <p>自${year}年${Number(month)}月${Number(day)}日24时起执行。</p>
    ${image ? `<img src="${image}" alt="陕西价格表">` : ''}</div>`;
}

const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(2500)]);

function reader(listHtml = list(), articleHtml = article(), image = png) {
  return {
    getText: async url => {
      if (url === LIST_URL) return listHtml;
      assert.equal(url, CURRENT_URL);
      return articleHtml;
    },
    getBuffer: async url => {
      assert.equal(url, CURRENT_IMAGE);
      return { buffer: image };
    },
  };
}

test('detects the latest official table image and leaves liter-price reading to human review', async () => {
  const latest = await monitor.collect({ ...reader(), today: '2026-09-28' });
  assert.deepEqual(latest, { title: ANNOUNCEMENT, publishedDate: '2026-09-24',
    effectiveDate: '2026-09-25', url: CURRENT_URL, imageUrl: CURRENT_IMAGE,
    requiresManualLiterReview: true });
  assert.equal('prices' in latest, false);
});

test('uses the previous table until a newly published 24:00 adjustment takes effect', async () => {
  const latest = await monitor.collect({
    getText: async url => url === LIST_URL ? list() :
      (assert.equal(url, PRIOR_URL), article({ date: '2026-09-11', image: PRIOR_IMAGE })),
    getBuffer: async url => (assert.equal(url, PRIOR_IMAGE), { buffer: png }),
    today: '2026-09-24',
  });
  assert.equal(latest.url, PRIOR_URL);
  assert.equal(latest.effectiveDate, '2026-09-12');
});

test('alerts on a newer adjustment news item without a complete 95-grade price table', async () => {
  const title = '我省汽、柴油价格下调';
  const latest = await monitor.collect({
    getText: async url => url === LIST_URL ?
      `<ul class="rightList">${row(NEWS_URL, title, '2026-08-14')}</ul>` :
      (assert.equal(url, NEWS_URL), article({ title, date: '2026-08-14', image: null })),
    getBuffer: async () => { throw new Error('No price image should be downloaded'); },
    today: '2026-08-15',
  });
  assert.equal(latest.url, NEWS_URL);
  assert.equal(latest.missingOfficialPriceTable, true);
  assert.equal(latest.requiresManualLiterReview, true);
  assert.equal('prices' in latest, false);
});

test('rejects changed host, dates, publisher and image content', async () => {
  for (const [input, pattern] of [
    [reader(list(row(CURRENT_URL.replace('sndrc.shaanxi.gov.cn/', 'sndrc.shaanxi.gov.cn.evil.example/'), ANNOUNCEMENT, '2026-09-24'))), /不是预期的官网地址/],
    [reader(list(row(CURRENT_URL, ANNOUNCEMENT, '2026-09-23'))), /公告地址日期与列表不符/],
    [reader(list(), article({ source: '未知来源' })), /公告标题、日期或发布单位不符/],
    [reader(list(), article({ image: 'https://evil.example/W020260924591852927577.png' })), /不是预期的官网地址/],
    [reader(list(), article(), Buffer.alloc(2508)), /图片内容异常/],
  ]) {
    await assert.rejects(monitor.collect({ ...input, today: '2026-09-28' }), pattern);
  }
});

test('verified images retain 23 dated Xi’an price tables and flag the two missing 95-grade tables', () => {
  assert.equal(verified.notices.length, 23);
  assert.deepEqual(verified.historyGaps.map(gap => gap.publishedDate),
    ['2026-05-21', '2026-08-14']);
  assert.match(verified.priceScope, /西安市区/);
  assert.deepEqual(verified.notices.at(-1).prices, { '92': 8.49, '95': 8.97, diesel: 8.19 });
  for (let index = 0; index < verified.notices.length; index += 1) {
    const notice = verified.notices[index];
    const date = notice.publishedDate.replaceAll('-', '');
    assert.match(notice.url, new RegExp(`^https://sndrc\\.shaanxi\\.gov\\.cn/zjww/jgcs/csxx/jgc/${date.slice(0, 6)}/t${date}_\\d+\\.html$`));
    assert.match(notice.imageUrl, new RegExp(`^https://sndrc\\.shaanxi\\.gov\\.cn/zjww/jgcs/csxx/jgc/${date.slice(0, 6)}/W020${date.slice(2)}\\d{12}(?:_ORIGIN)?\\.(?:png|jpg)$`));
    assert.equal(notice.effectiveDate,
      new Date(Date.parse(`${notice.publishedDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10));
    if (index) assert.ok(notice.effectiveDate > verified.notices[index - 1].effectiveDate);
    for (const grade of ['92', '95', 'diesel']) {
      assert.ok(Number.isFinite(notice.prices[grade]) && notice.prices[grade] > 6 && notice.prices[grade] < 10);
    }
  }
  const imported = importVerified(require('../data/prices.json'), verified);
  assert.equal(imported.regions['shaanxi-xian'].grades.diesel.price, 8.19);
});
