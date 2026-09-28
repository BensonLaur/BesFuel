'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const source = require('../scripts/sources/inner-mongolia-east.cjs');

const day = '2026-09-24';
const url = 'https://fgw.nmg.gov.cn/ywgz/jfgz/cpyjg/202609/t20260924_2958605.html';
const listUrl = 'https://fgw.nmg.gov.cn/ywgz/jfgz/cpyjg/index.html';
const dateText = '2026年9月24日';

function list(href = './202609/t20260924_2958605.html', title = '我区成品油价格调整') {
  return `<li><a href="${href}" target="_blank" title="${title}">${title}</a><span>${day}</span></li>`;
}

function table(prices, unit = '元/升', dieselGrade = '0号（Ⅵ）') {
  const row = (cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;
  return `<table>${[
    ['品种', '型号', '最高零售价', '最高批发价（元/吨）'],
    ['元/吨', unit, '配送制', '非配送制'],
    ['汽油', '89号（ⅥA）', '10705', ''],
    ['汽油', '89号（ⅥA）', '10705', ''],
    ['汽油', '92号（ⅥA）', '11347', prices['92'], '11029', '10969'],
    ['汽油', '95号（ⅥA）', '11990', prices['95'], '11654', '11594'],
    ['柴油', dieselGrade, '9635', prices.diesel, '9335', '9275'],
    ['柴油', '-10号（Ⅵ）', '10213', '8.67'],
    ['柴油', '-20号（Ⅵ）', '10695', '9.04'],
  ].map(row).join('')}</table>`;
}

function article({ eastUnit = '元/升', eastDiesel = '0号（Ⅵ）',
  scope = '东部价区包括呼伦贝尔市、兴安盟、通辽市、赤峰市和锡林郭勒盟',
  eastHeading = '内蒙古自治区东部价区汽、柴油最高批发、零售价格表' } = {}) {
  const west = table({ 92: '8.62', 95: '9.15', diesel: '8.14' });
  const east = table({ 92: '8.68', 95: '9.24', diesel: '8.16' }, eastUnit, eastDiesel);
  return `<meta name="ArticleTitle" content='我区成品油价格调整' />
    <meta name="PubDate" content="2026年09月24日 15:30" />
    <p>自${dateText}24时起调整价格。</p>
    <p>内蒙古自治区西部价区汽、柴油最高批发、零售价格表（自${dateText}24时起执行）</p>
    ${west}
    <p>${eastHeading}（自${dateText}24时起执行）</p>
    ${east}<p>${scope}。</p>`;
}

function readers(options = {}) {
  return { async getText(requestedUrl) {
    if (requestedUrl === listUrl) return list(options.href, options.title);
    if (requestedUrl === url) return article(options);
    throw new Error(`unexpected URL: ${requestedUrl}`);
  } };
}

test('reads yuan-per-litre prices from the eastern table and its official five-area scope', async () => {
  const notices = await source.collect({ ...readers(), today: '2026-09-28' });
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0].prices, { 92: 8.68, 95: 9.24, diesel: 8.16 });
  assert.equal(notices[0].effectiveDate, '2026-09-25');
  assert.equal(notices[0].url, url);
  assert.match(source.priceScope, /锡林郭勒盟/);
});

test('rejects a non-official link or unrecognized new oil-price title', async () => {
  await assert.rejects(source.collect({ ...readers({ href: 'https://example.org/notice.html' }), today: '2026-09-28' }),
    /不是预期/);
  await assert.rejects(source.collect({ ...readers({ title: '我区成品油价格预测' }), today: '2026-09-28' }),
    /未知油价公告标题/);
});

test('rejects changed listing markup before it can silently miss a newer announcement', async () => {
  await assert.rejects(source.collect({
    async getText(requestedUrl) {
      if (requestedUrl === listUrl) return list().replace(`<span>${day}</span>`, '');
      throw new Error(`unexpected URL: ${requestedUrl}`);
    },
    today: '2026-09-28',
  }), /列表结构变化/);
});

test('rejects a misplaced zone heading, missing scope, missing diesel, or changed unit', async () => {
  for (const options of [
    { eastHeading: '内蒙古自治区西部价区汽、柴油最高批发、零售价格表' },
    { scope: '东部价区包括其他地区' },
    { eastDiesel: '1号（Ⅵ）' },
    { eastUnit: '元/吨' },
  ]) {
    await assert.rejects(source.collect({ ...readers(options), today: '2026-09-28' }),
      /价区|价格行|表头|单位/);
  }
});

test('keeps the future notice unpublished until it is effective', async () => {
  await assert.rejects(source.collect({ ...readers(), today: '2026-09-24' }), /没有已生效/);
});
