'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const source = require('../scripts/sources/fujian.cjs');

const host = 'https://fgw.fujian.gov.cn';
const oilList = `${host}/ztzl/fjswjj/cpygg/`;
const generalList = `${host}/zwgk/gsgg/`;
const title = '福建省发展和改革委员会关于成品油价格调整的通告';
const urls = {
  latest: `${host}/zfxxgkzl/zfxxgkml/yzdgkdqtxx/202609/t20260924_7218113.htm`,
  prior: `${host}/zfxxgkzl/zfxxgkml/yzdgkdqtxx/202609/t20260911_7212495.htm`,
  omitted: `${host}/zwgk/gsgg/202608/t20260828_7206353.htm`,
  older: `${host}/zfxxgkzl/zfxxgkml/yzdgkdqtxx/202608/t20260814_7199969.htm`,
  mirror: `${host}/ztzl/fjswjj/cpygg/202609/t20260911_9999999.htm`,
};

function item(url, day, heading = title) {
  return `<li><a href="${url}" target="_blank" title="${heading}">${heading}</a>` +
    `<span>${day}</span></li>`;
}

function listing(items) {
  return `<div ms-visible='showStatic'><div class="list_base mar_t_small " ms-visible="$showStatic(1)">` +
    `<ul>${items.slice(0, 2).join('')}</ul><div class="border_b_dashed"></div>` +
    `<ul>${items.slice(2).join('')}</ul></div></div><div ms-visible="!showStatic"></div>`;
}

function table([p92, p95, diesel], perLitreHeader = '元/升', includeDiesel = true) {
  return '<p>福建省汽、柴油最高零售价格和最高批发价格表</p><table><tbody>' +
    '<tr><td>油品</td><td colspan="2">最高零售价格</td><td>最高批发价格</td></tr>' +
    `<tr><td>元/吨</td><td>${perLitreHeader}</td><td>元/吨</td></tr>` +
    `<tr><td>车用92号汽油（<span>ⅥB</span>）</td><td>11411</td><td>${p92}</td><td>11076</td></tr>` +
    `<tr><td>车用95号汽油（ⅥB）</td><td>12057</td><td>${p95}</td><td>11722</td></tr>` +
    (includeDiesel ? `<tr><td>车用0号柴油（Ⅵ）</td><td>9685</td><td>${diesel}</td><td>9350</td></tr>` : '') +
    '</tbody></table>';
}

function article(day, prices, options = {}) {
  const [year, month, date] = day.split('-');
  const when = options.announcedDay || `${year}年${Number(month)}月${Number(date)}日`;
  const content = `<p>根据国家发展改革委门户网站发布的成品油价格调价信息，` +
    `现将我省汽、柴油最高零售价格公布如下，自${when}24时起执行。</p>` +
    table(prices, options.header, options.includeDiesel) +
    (options.duplicate ? table(options.duplicate) : '');
  return `<meta name="ArticleTitle" content="${title}">` +
    `<meta name="PubDate" content="${day} 17:37">` +
    '<meta name="ContentSource" content="福建省发展和改革委员会网站">' + content;
}

function fixture(options = {}) {
  const pages = new Map([
    [oilList, listing([
      item(options.latestUrl || urls.latest, '2026-09-24', options.latestTitle),
      item(urls.prior, '2026-09-11'),
      item(urls.older, '2026-08-14'),
    ])],
    [generalList, listing([
      item(urls.latest, '2026-09-24'),
      item(options.mirror ? urls.mirror : urls.prior, '2026-09-11'),
      item(urls.omitted, '2026-08-28'),
      item(urls.older, '2026-08-14'),
    ])],
    [urls.latest, article('2026-09-24', ['8.57', '9.15', '8.29'], {
      header: options.latestHeader,
      includeDiesel: options.includeDiesel,
      announcedDay: options.announcedDay,
      duplicate: options.conflictingTable ? ['8.56', '9.15', '8.29'] : ['8.57', '9.15', '8.29'],
    })],
    [urls.prior, article('2026-09-11', ['8.25', '8.81', '7.96'])],
    [urls.omitted, article('2026-08-28', ['8.05', '8.59', '7.75'])],
    [urls.older, article('2026-08-14', ['7.75', '8.27', '7.44'])],
    [urls.mirror, article('2026-09-11', options.conflictingMirror ?
      ['8.26', '8.81', '7.96'] : ['8.25', '8.81', '7.96'])],
  ]);
  return async (url) => {
    assert.ok(pages.has(url), `unexpected URL ${url}`);
    return pages.get(url);
  };
}

test('福建合并两处官网列表，补入专栏漏列公告并读取元/升历史', async () => {
  const notices = await source.collect({ getText: fixture(), today: '2026-09-28' });
  assert.deepEqual(notices.map((notice) => notice.effectiveDate), [
    '2026-08-15', '2026-08-29', '2026-09-12', '2026-09-25',
  ]);
  assert.equal(notices[1].url, urls.omitted);
  assert.deepEqual(notices.at(-1).prices, { '92': 8.57, '95': 9.15, diesel: 8.29 });
  assert.equal((await source.collect({ getText: fixture(), today: '2026-09-24' })).at(-1).publishedDate,
    '2026-09-11');
});

test('福建同日官网镜像价格一致时去重，冲突时保留旧数据', async () => {
  const notices = await source.collect({ getText: fixture({ mirror: true }), today: '2026-09-28' });
  assert.equal(notices.length, 4);
  assert.equal(notices[2].url, urls.prior);
  await assert.rejects(
    source.collect({ getText: fixture({ mirror: true, conflictingMirror: true }), today: '2026-09-28' }),
    /同日官方公告价格冲突/,
  );
});

test('福建价格表须有元/升列及三个指定油号，重复表也须一致', async () => {
  for (const [options, error] of [
    [{ latestHeader: '元/吨' }, /元\/升列标题异常/],
    [{ includeDiesel: false }, /diesel价格行缺失或重复/],
    [{ conflictingTable: true }, /重复价格表内容冲突/],
  ]) {
    await assert.rejects(source.collect({ getText: fixture(options), today: '2026-09-28' }), error);
  }
});

test('福建拒绝非官网链接、未知油价标题及不符的执行日期', async () => {
  await assert.rejects(source.collect({
    getText: fixture({ latestUrl: 'https://example.com/202609/t20260924_7218113.htm' }),
    today: '2026-09-28',
  }), /不是预期的官方日期地址/);
  await assert.rejects(source.collect({
    getText: fixture({ latestTitle: '福建省成品油价格快讯' }), today: '2026-09-28',
  }), /未知的成品油价格公告标题/);
  await assert.rejects(source.collect({
    getText: fixture({ announcedDay: '2026年9月23日' }), today: '2026-09-28',
  }), /24时执行日期与列表不符/);
});
