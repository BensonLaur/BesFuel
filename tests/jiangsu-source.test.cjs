'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const source = require('../scripts/sources/jiangsu.cjs');

const host = 'https://fzggw.jiangsu.gov.cn';
const listUrl = `${host}/col/col91435/index.html`;
const notices = [
  { day: '2026-09-24', number: 18, url: `${host}/art/2026/9/24/art_91435_11834861.html`, prices: ['8.58', '9.12', '8.26'] },
  { day: '2026-09-11', number: 17, url: `${host}/art/2026/9/11/art_91435_11828543.html`, prices: ['8.26', '8.79', '7.93'] },
  { day: '2026-08-28', number: 16, url: `${host}/art/2026/8/28/art_91435_11821966.html`, prices: ['8.06', '8.60', '7.75'] },
  { day: '2025-10-13', number: 14, url: `${host}/art/2025/10/13/art_91435_11600000.html`, prices: ['7.02', '7.50', '6.69'] },
  { day: '2025-08-26', number: 13, url: `${host}/art/2025/8/26/art_91435_11500000.html`, prices: ['7.00', '7.48', '6.67'] },
];

function title(notice) {
  return `江苏省成品油价格调整公告（${notice.day.slice(0, 4)}年第${notice.number}号）`;
}

function record(notice, url = notice.url) {
  return `<record><![CDATA[<li class="clearfix bt-list-new"><a title='${title(notice)}' ` +
    `target="_blank" href="${url.replace(host, '')}">${title(notice)}</a>` +
    `<span class="bt-list-time">${notice.day}</span></li>]]></record>`;
}

function table(prices, header = '升价', includeDiesel = true) {
  return '<p>江苏省汽、柴油最高零售批发价格表</p>' +
    '<p>单位：元/吨，元/升</p><table><tbody>' +
    '<tr><td>项&nbsp;目</td><td colspan="2">最高零售价格</td><td>最高批发价格</td></tr>' +
    `<tr><td>吨价</td><td>${header}</td><td>吨价</td></tr>` +
    `<tr><td>92#国VI B汽油</td><td>11390</td><td>${prices[0]}</td><td>11090</td></tr>` +
    `<tr><td>95#国VIB汽油</td><td>12034</td><td>${prices[1]}</td><td>11734</td></tr>` +
    (includeDiesel ? `<tr><td>0#国VI柴油</td><td>9660</td><td>${prices[2]}</td><td>9360</td></tr>` : '') +
    '</tbody></table>';
}

function article(notice, options = {}) {
  const [year, month, day] = notice.day.split('-');
  const when = options.announcedDay || `${year}年${Number(month)}月${Number(day)}日`;
  const body = `<p>现将我省汽、柴油最高零售、批发价格公布如下，自${when}24时起执行。</p>` +
    `<p>（${year}年${Number(month)}月${Number(day)}日24时起执行）</p>` +
    table(notice.prices, options.header, options.includeDiesel);
  return `<meta name="ArticleTitle" content="${title(notice)}">` +
    `<meta name="PubDate" content="${notice.day} 16:08">` +
    '<meta name="ContentSource" content="价格管理和成本监审处">' +
    `<!--ZJEG_RSS.content.begin-->${body}<!--ZJEG_RSS.content.end-->`;
}

function fixture(options = {}) {
  const list = options.entries || notices;
  const pages = new Map([[listUrl, `<datastore><recordset>${list.map((notice) =>
    record(notice, notice === notices[0] && options.latestUrl || notice.url)).join('')}${list.map((notice) =>
    record(notice)).join('')}</recordset></datastore>`]]);
  for (const notice of notices) {
    pages.set(notice.url, article(notice, notice === notices[0] ? options.latestArticle : undefined));
  }
  return async (url) => {
    assert.ok(pages.has(url), `unexpected URL ${url}`);
    return pages.get(url);
  };
}

test('江苏专栏动态发现最新公告，按升价列读取近一年历史', async () => {
  const history = await source.collect({ getText: fixture(), today: '2026-09-28' });
  assert.deepEqual(history.map((notice) => notice.effectiveDate), [
    '2025-10-14', '2026-08-29', '2026-09-12', '2026-09-25',
  ]);
  assert.equal(history.at(-1).url, notices[0].url);
  assert.deepEqual(history.at(-1).prices, { '92': 8.58, '95': 9.12, diesel: 8.26 });
  assert.equal((await source.collect({ getText: fixture(), today: '2026-09-24' })).at(-1).publishedDate,
    '2026-09-11');
});

test('江苏拒绝非官网地址与期号缺漏', async () => {
  await assert.rejects(source.collect({
    getText: fixture({ latestUrl: 'https://example.com/art/2026/9/24/art_91435_11834861.html' }),
    today: '2026-09-28',
  }), /不是预期的官网日期地址/);
  await assert.rejects(source.collect({
    getText: fixture({ entries: [notices[0], notices[2], ...notices.slice(3)] }),
    today: '2026-09-28',
  }), /期号不连续/);
});

test('江苏升价表头和92、95、0号行必须完整', async () => {
  await assert.rejects(source.collect({
    getText: fixture({ latestArticle: { header: '吨价' } }), today: '2026-09-28',
  }), /表头不能证明升价列/);
  await assert.rejects(source.collect({
    getText: fixture({ latestArticle: { includeDiesel: false } }), today: '2026-09-28',
  }), /diesel价格行缺失或重复/);
});

test('江苏公告正文日期或表格执行日期冲突时拒绝覆盖', async () => {
  await assert.rejects(source.collect({
    getText: fixture({ latestArticle: { announcedDay: '2026年9月23日' } }), today: '2026-09-28',
  }), /24时执行日期不一致/);
});
