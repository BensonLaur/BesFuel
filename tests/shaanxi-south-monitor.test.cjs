'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const monitor = require('../scripts/monitors/shaanxi-south.cjs');
const verified = require('../data/verified/shaanxi-south.json');
const { importVerified } = require('../scripts/import-verified.cjs');
const snapshot = require('../data/prices.json');

const HOST = 'https://sndrc.shaanxi.gov.cn';
const LIST_URL = `${HOST}/sy/xwxx/gggg/`;
const CURRENT_PATH = '/sy/xwxx/gggg/202609/t20260924_3698846.html';
const PREVIOUS_PATH = '/sy/xwxx/gggg/202609/t20260911_3689503.html';
const IMAGE_PATH = '/sy/xwxx/gggg/202609/W020260924591852927577.png';
const PREVIOUS_IMAGE_PATH = '/sy/xwxx/gggg/202609/W020260911627679042497.png';
const TITLE = '陕西省成品油价格调整通告';

function item(path, date, title = TITLE) {
  return `<li><a href="${path}">${title}</a><span>${date}</span></li>`;
}

function list(first = item(CURRENT_PATH, '2026-09-24')) {
  return `<ul>${item('/other.html', '2026-09-28', '其他公告')}
    ${first}${item(PREVIOUS_PATH, '2026-09-11')}</ul>`;
}

function article({ date = '2026-09-24', title = TITLE, source = '价格处',
  time = '2026年9月24日24时起执行', imagePath = `.${IMAGE_PATH.split('/').at(-1)}` } = {}) {
  const image = imagePath.startsWith('.') && !imagePath.startsWith('./') ?
    `./${imagePath.slice(1)}` : imagePath;
  return `<div class="title">${title}</div><div class="fTitile">
    <span>来源：${source}</span><span>发布时间：${date}</span></div>
    <div class="tyxlContent"><p>现将我省汽、柴油最高零售价格公布如下，自${time}。</p>
    <img src="${image}" /></div>`;
}

function png() {
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(5500)]);
}

function reader(listHtml = list(), articleHtml = article(), imageBody = png()) {
  return {
    getText: async url => {
      if (url === LIST_URL) return listHtml;
      assert.equal(url, `${HOST}${CURRENT_PATH}`);
      return articleHtml;
    },
    getBuffer: async url => {
      assert.equal(url, `${HOST}${IMAGE_PATH}`);
      return { buffer: imageBody };
    },
  };
}

test('finds the latest official notice image without inferring its prices', async () => {
  const result = await monitor.collect({ ...reader(), today: '2026-09-28' });
  assert.deepEqual(result, {
    publishedDate: '2026-09-24', effectiveDate: '2026-09-25',
    url: `${HOST}${CURRENT_PATH}`, imageUrl: `${HOST}${IMAGE_PATH}`,
    requiresManualPriceReview: true,
  });
  assert.equal('prices' in result, false);
});

test('uses the preceding announcement before the next one takes effect', async () => {
  const previousUrl = `${HOST}${PREVIOUS_PATH}`;
  const result = await monitor.collect({
    getText: async url => url === LIST_URL ? list() :
      (assert.equal(url, previousUrl), article({ date: '2026-09-11',
        time: '2026年9月11日24时起执行', imagePath: `./${PREVIOUS_IMAGE_PATH.split('/').at(-1)}` })),
    getBuffer: async url => (assert.equal(url, `${HOST}${PREVIOUS_IMAGE_PATH}`), { buffer: png() }),
    today: '2026-09-24',
  });
  assert.equal(result.url, previousUrl);
  assert.equal(result.effectiveDate, '2026-09-12');
});

test('rejects altered URL, publication details, execution date and image bytes', async () => {
  for (const [input, pattern] of [
    [reader(list(item('https://sndrc.shaanxi.gov.cn.evil.example/sy/xwxx/gggg/202609/t20260924_3698846.html', '2026-09-24'))), /不是预期的官网地址/],
    [reader(list(item(CURRENT_PATH, '2026-09-23'))), /不是预期的官网地址/],
    [reader(list(), article({ title: '成品油价格预测' })), /标题、来源或日期异常/],
    [reader(list(), article({ source: '其他单位' })), /标题、来源或日期异常/],
    [reader(list(), article({ time: '2026年9月25日24时起执行' })), /24 时执行时间/],
    [reader(list(), article({ imagePath: 'https://example.com/table.png' })), /价格表图片缺失或重复/],
    [reader(list(), article(), Buffer.alloc(5508)), /PNG 内容异常/],
  ]) {
    await assert.rejects(monitor.collect({ ...input, today: '2026-09-28' }), pattern);
  }
});

test('12 consecutively checked price tables preserve the Shaanxi south and other-diesel rows', () => {
  const expected = [
    [8.42, 8.89, 8.20], [8.67, 9.16, 8.46], [8.73, 9.22, 8.52],
    [8.31, 8.78, 8.09], [7.90, 8.35, 7.67], [7.15, 7.55, 6.89],
    [7.39, 7.80, 7.14], [7.93, 8.38, 7.70], [7.75, 8.19, 7.51],
    [8.05, 8.50, 7.82], [8.25, 8.72, 8.03], [8.57, 9.05, 8.36],
  ];
  assert.equal(verified.notices.length, expected.length);
  assert.equal(verified.unit, '元/升');
  assert.match(verified.priceScope, /汉中、安康、商洛/);
  assert.match(verified.priceScope, /其他价区/);
  for (let index = 0; index < verified.notices.length; index += 1) {
    const notice = verified.notices[index];
    const stamp = notice.publishedDate.replaceAll('-', '');
    assert.deepEqual(['92', '95', 'diesel'].map(grade => notice.prices[grade]), expected[index]);
    assert.match(notice.url, new RegExp(`^${HOST}/sy/xwxx/gggg/${stamp.slice(0, 6)}/t${stamp}_\\d+\\.html$`));
    assert.match(notice.imageUrl, new RegExp(`^${HOST}/sy/xwxx/gggg/${stamp.slice(0, 6)}/W020${stamp.slice(2)}\\d+(?:_ORIGIN)?\\.png$`));
    assert.equal(notice.effectiveDate,
      new Date(Date.parse(`${notice.publishedDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10));
    if (index) assert.ok(notice.effectiveDate > verified.notices[index - 1].effectiveDate);
  }
  const imported = importVerified(snapshot, verified).regions[verified.id];
  assert.equal(imported.grades['92'].price, 8.57);
  assert.equal(imported.grades['95'].price, 9.05);
  assert.equal(imported.grades.diesel.price, 8.36);
  assert.equal(imported.grades['92'].history.length, 12);
});
