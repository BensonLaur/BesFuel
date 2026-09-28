'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const monitor = require('../scripts/monitors/sichuan-zone2.cjs');
const verified = require('../data/verified/sichuan-zone2.json');

const base = 'https://fgw.sc.gov.cn/sfgw/tzgg/';
const oldUrl = `${base}2026/9/24/cf670f9f0e5f454b9ca534012c091993.shtml`;
const newUrl = `${base}2026/10/15/a123456789abcdef0123456789abcdef.shtml`;
const newTitle = '关于调整成品油价格的通知（川发改价格〔2026〕444号）';
const attachment = '四川省汽、柴油最高批发零售价格表.docx';

function list({ title = newTitle, href = newUrl } = {}) {
  return `<ul class="list-li mt30">
    <li><div class="List-T fl"><a href="${oldUrl}" title='关于调整成品油价格的通知（川发改价格〔2026〕410号）'>旧公告</a></div><span class="list-time f-20 fr">2026-09-24</span></li>
    <li><div class="List-T fl"><a href="${href}" title='${title}'>新公告</a></div><span class="list-time f-20 fr">2026-10-15</span></li>
  </ul>`;
}

function article({ source = '四川省发展和改革委员会', file = `a123456789abcdef0123456789abcdef/files/${attachment}`,
  effective = '2026年10月15日' } = {}) {
  return `<meta name="SiteName" content="${source}"/>
    <meta name="ArticleTitle" content="${newTitle}"/>
    <meta name="PubDate" content="2026-10-15 17:41:44"/>
    <h1 class="data-title">${newTitle}</h1>
    <p class="content">我省三个价区汽柴油价格，调整后的价格自${effective}24时起执行。</p>
    <a href="${file}" target="_blank">${attachment.replace(/\.docx$/, '')}</a>`;
}

function getText(listHtml, articleHtml) {
  return async url => {
    if (url === `${base}list.shtml`) return listHtml;
    assert.equal(url, newUrl);
    return articleHtml;
  };
}

test('finds the newest official notice and flags its attachment for human price review', async () => {
  const result = await monitor.collect({ getText: getText(list(), article()) });
  assert.deepEqual(result, {
    url: newUrl,
    publishedDate: '2026-10-15',
    attachmentUrl: `${base}2026/10/15/a123456789abcdef0123456789abcdef/files/${encodeURIComponent(attachment)}`,
    requiresManualPriceReview: true,
  });
  assert.equal('prices' in result, false);
});

test('rejects unexpected government identity and mismatched effective date', async () => {
  await assert.rejects(monitor.collect({
    getText: getText(list(), article({ source: '其他网站' })),
  }), /官网、标题或日期与列表不符/);
  await assert.rejects(monitor.collect({
    getText: getText(list(), article({ effective: '2026年10月14日' })),
  }), /生效日期与列表不符/);
});

test('rejects a price attachment outside the article directory or a missing attachment', async () => {
  await assert.rejects(monitor.collect({
    getText: getText(list(), article({ file: 'https://example.com/prices.docx' })),
  }), /价格附表不是预期的官网地址/);
  await assert.rejects(monitor.collect({
    getText: getText(list(), article().replace(/<a href="[^"]+"[^>]*>[^<]+<\/a>/, '')),
  }), /价格附表数量异常/);
});

test('rejects unknown oil price titles and URL dates that differ from the listing', async () => {
  await assert.rejects(monitor.collect({
    getText: getText(list({ title: '成品油价格预测' }), article()),
  }), /未知油价公告标题/);
  await assert.rejects(monitor.collect({
    getText: getText(list({ href: `${base}2026/10/14/a123456789abcdef0123456789abcdef.shtml` }), article()),
  }), /列表与网址日期不符/);
});

test('three reviewed second-zone prices and their official attachments retain separate provenance', () => {
  assert.equal(verified.id, monitor.id);
  assert.match(verified.priceScope, /汶川县、理县、茂县以及凉山州、攀枝花市/);
  assert.deepEqual(verified.notices.map(notice => notice.prices), [
    { '92': 8.25, '95': 8.82, diesel: 7.88 },
    { '92': 8.46, '95': 9.04, diesel: 8.10 },
    { '92': 8.78, '95': 9.38, diesel: 8.42 },
  ]);
  for (const notice of verified.notices) {
    assert.equal(notice.effectiveDate > notice.publishedDate, true);
    assert.match(notice.url, /^https:\/\/fgw\.sc\.gov\.cn\/sfgw\/tzgg\/\d{4}\/\d{1,2}\/\d{1,2}\/[0-9a-f]{32}\.shtml$/);
    assert.equal(notice.attachmentUrl.startsWith(notice.url.replace(/\.shtml$/, '/files/')), true);
    assert.match(notice.attachmentUrl, /\.docx$/);
  }
});
