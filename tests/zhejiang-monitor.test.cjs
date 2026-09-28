'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const monitor = require('../scripts/monitors/zhejiang.cjs');

const LIST_URL = 'https://fzggw.zj.gov.cn/api-gateway/jpaas-publish-server/front/page/build/unit';
const TITLE = '浙江省成品油价格调整';
const PATH = '/col/col1229629046/art/2026/art_7c2b4abc9fbe46d8b9a8a9a9d09b7af3.html';
const ARTICLE_URL = `https://fzggw.zj.gov.cn${PATH}`;

function listing(date = '2026-09-24', path = PATH, title = TITLE) {
  const html = `<label class="label-className">重要公告</label><ul class="ajax-ul">
    <li class="cf border-line"><a class="fl" href="/col/col1229629046/art/2026/art_e807122fb31d42429299399c8e897490.html" title="其他公告">其他公告</a><span class="fr">2026-09-28</span></li>
    <li class="cf border-line"><a class="fl" href="${path}" title="${title}">${title}</a><span class="fr">${date}</span></li></ul>`;
  return JSON.stringify({ success: true, data: { html } });
}

function article(date = '2026-09-24', options = {}) {
  const [year, month, day] = date.split('-');
  return `<meta name="ColumnName" content="重要公告">
    <meta name="ArticleTitle" content="${options.title || TITLE}">
    <meta name="PubDate" content="${options.metaDate || date} 16:42">
    <span>发布日期：${options.displayDate || date} 16:42</span>
    <p>自${Number(month)}月${Number(day)}日24时起执行。</p>
    <p>浙江省发展和改革委员会 ${year}年${Number(month)}月${Number(day)}日</p>
    <table><tr><td>品种</td><td>型号</td><td>零售价</td><td>批发价</td></tr>
    <tr><td>元/吨</td><td>元/升</td><td>元/吨</td></tr>
    <tr><td>汽油</td><td>92号（VIB）</td><td>11331</td><td>8.58</td><td>11031</td></tr>
    <tr><td>汽油</td><td>95号（VIB）</td><td>11973</td><td>${options.price95 || '9.12'}</td><td>11673</td></tr>
    <tr><td>柴油</td><td>0号（Ⅵ）</td><td>9620</td><td>8.28</td><td>9320</td></tr></table>`;
}

function reader(list, page = article()) {
  return async url => {
    if (url.startsWith(LIST_URL)) return list;
    assert.equal(url, ARTICLE_URL);
    return page;
  };
}

test('discovers an official dated notice but holds its liter prices for manual review', async () => {
  const latest = await monitor.collect({ getText: reader(listing()), today: '2026-09-28' });
  assert.deepEqual(latest, {
    title: TITLE, publishedDate: '2026-09-24', effectiveDate: '2026-09-25',
    url: ARTICLE_URL, requiresManualLiterReview: true,
  });
  assert.equal('prices' in latest, false);
});

test('refuses stale official listing instead of offering an outdated price', async () => {
  await assert.rejects(monitor.collect({
    getText: reader(listing('2026-03-23')),
    today: '2026-09-28',
  }), /最新油价公告仅到 2026-03-23/);
});

test('rejects altered official host, nonofficial URL and changed data structure', async () => {
  for (const [list, page, message] of [
    [listing('2026-09-24', 'https://fzggw.zj.gov.cn.evil.example/art/2026/9/24/x.html'), null, /非预期官方公告地址/],
    [listing('2026-09-24', '/col/col1229629046/art/2025/art_7c2b4abc9fbe46d8b9a8a9a9d09b7af3.html'), null, /非预期官方公告地址/],
    [listing('2026-09-24', PATH, '浙江省成品油价格预测'), null, /未知的油价公告标题/],
    [listing(), article('2026-09-24', { metaDate: '2026-09-23' }), /正文标题、栏目或日期/],
    [listing(), article('2026-09-24', { price95: '9120' }), /95 元\/升价格/],
    [JSON.stringify({ success: false, data: { html: '' } }), null, /列表结构异常/],
  ]) {
    await assert.rejects(monitor.collect({
      getText: reader(list, page), today: '2026-09-28',
    }), message);
  }
});
