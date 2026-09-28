'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const monitor = require('../scripts/monitors/jilin.cjs');
const verified = require('../data/verified/jilin.json');

const listUrl = 'https://jldrc.jl.gov.cn/ztzl/nyzyjg/index.html';
const oldPath = './202609/t20260924_3672674.html';
const newPath = './202610/t20261015_9999999.html';
const title = date => {
  const [year, month, day] = date.split('-');
  return `吉林省成品油最高零售价格表（${year}年${Number(month)}月${Number(day)}日24时起执行）`;
};

function item(path, date) {
  const name = title(date);
  return `<li><a href="${path}" target="_blank" title="${name}">${name}</a><span class="pubTime">${date}</span></li>`;
}

function listing(items) {
  return `<div class="right_content"><ul class="newsList">${items}</ul><div class="pageszly" id="page"></div></div>`;
}

function article(date, pdfPath, options = {}) {
  const name = title(options.titleDate || date);
  const body = title(options.bodyDate || date);
  const published = options.published || date;
  return `<meta name="ArticleTitle" content="${name}"/>
    <meta name="PubDate" content="${published} 15:38:41"/>
    <div class="biaoti_title">${name}</div>
    <div class="time4"><span class="ly">发布日期：</span>${published} 15:38:41</div>
    <div class="trs_editor_view TRS_UEDITOR trs_paper_default trs_web"><p>${body}</p></div>
    <script>var file_appendix='<a href="${pdfPath}">2026.10.15.pdf</a>';</script>
    <span class="fj-fj"><tr><td><a href="${pdfPath}">2026.10.15.pdf</a></td></tr></span >`;
}

function reader(pages) {
  return async url => {
    assert.ok(Object.hasOwn(pages, url), `unexpected URL: ${url}`);
    return pages[url];
  };
}

test('discovers the newest effective official PDF and requires human price review', async () => {
  // List, article and PDF attachment markup follow the Jilin DRC pages checked on 2026-09-28.
  const newUrl = new URL(newPath, listUrl).href;
  const result = await monitor.collect({
    getText: reader({
      [listUrl]: listing(item(newPath, '2026-10-15') + item(oldPath, '2026-09-24')),
      [newUrl]: article('2026-10-15', './P020261015123456789012.pdf'),
    }),
    today: '2026-10-16',
  });
  assert.deepEqual(result, {
    url: newUrl,
    publishedDate: '2026-10-15',
    effectiveDate: '2026-10-16',
    pdfUrl: 'https://jldrc.jl.gov.cn/ztzl/nyzyjg/202610/P020261015123456789012.pdf',
    requiresManualLiterReview: true,
  });
  assert.equal('prices' in result, false);
});

test('uses the previous announcement until the 24:00 change takes effect', async () => {
  const oldUrl = new URL(oldPath, listUrl).href;
  const result = await monitor.collect({
    getText: reader({
      [listUrl]: listing(item(newPath, '2026-10-15') + item(oldPath, '2026-09-24')),
      [oldUrl]: article('2026-09-24', './P020260924563212373946.pdf'),
    }),
    today: '2026-10-15',
  });
  assert.equal(result.url, oldUrl);
  assert.equal(result.effectiveDate, '2026-09-25');
});

test('rejects untrusted URLs, inconsistent dates and changed PDF structure', async () => {
  for (const [entry, page, message] of [
    [item('https://jldrc.jl.gov.cn.evil.example/ztzl/nyzyjg/202610/t20261015_9999999.html', '2026-10-15'), null, /不是预期的官网地址/],
    [item(newPath, '2026-10-15'), article('2026-10-15', './P020261015123456789012.pdf', { published: '2026-10-14' }), /发布日期与列表不一致/],
    [item(newPath, '2026-10-15'), article('2026-10-15', './P020261015123456789012.pdf', { bodyDate: '2026-10-14' }), /正文生效日期/],
    [item(newPath, '2026-10-15'), article('2026-10-15', 'https://example.com/prices.pdf'), /不是预期的官网地址/],
  ]) {
    const newUrl = new URL(newPath, listUrl).href;
    await assert.rejects(monitor.collect({
      getText: reader({ [listUrl]: listing(entry), [newUrl]: page }),
      today: '2026-10-16',
    }), message);
  }
});

test('verified history records the four visually checked official PDF tables', () => {
  assert.deepEqual(verified.notices.map(({ effectiveDate, prices }) => ({ effectiveDate, prices })), [
    { effectiveDate: '2026-08-15', prices: { '92': 7.75, '95': 8.36, diesel: 7.36 } },
    { effectiveDate: '2026-08-29', prices: { '92': 8.05, '95': 8.68, diesel: 7.67 } },
    { effectiveDate: '2026-09-12', prices: { '92': 8.26, '95': 8.91, diesel: 7.88 } },
    { effectiveDate: '2026-09-25', prices: { '92': 8.57, '95': 9.25, diesel: 8.21 } },
  ]);
  for (const notice of verified.notices) {
    assert.equal(new URL(notice.url).hostname, 'jldrc.jl.gov.cn');
    assert.equal(new URL(notice.pdfUrl).hostname, 'jldrc.jl.gov.cn');
    assert.equal(new URL(notice.pdfUrl).pathname.replace(/P\d+\.pdf$/, ''),
      new URL(notice.url).pathname.replace(/t\d+_\d+\.html$/, ''));
  }
});
