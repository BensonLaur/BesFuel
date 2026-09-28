'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const monitor = require('../scripts/monitors/hebei.cjs');

const base = 'https://hbdrc.hebei.gov.cn/gggs_980/';
const latestPath = './202609/t20260924_139750.html';
const nextPath = './202610/t20261015_140001.html';

function listItem(path, title, date) {
  return `<li>\n<a href="${path}" target="_blank" title="${title}">${title}</a><span class="date">${date}</span></li>`;
}

function article(title, date, image) {
  return `<div class="my_conbox"><h1>${title}</h1>
    <p class="sjly13s"><span class="real">来源：能源价格处</span><span> 时间：${date} 15:46</span></p>
    <div class="my_conboxzw songti" id="zoom"><div class=TRS_Editor><img src="${image}" /></div></div>
    <div class="rgtbar_erji_link">相关链接：</div></div>`;
}

function getText(list, articles) {
  const pages = { [base]: list, ...articles };
  return async (url) => {
    assert.ok(url in pages, `unexpected URL: ${url}`);
    return pages[url];
  };
}

test('discovers a new official announcement and returns its image for manual review', async () => {
  // The list item and article markup are excerpts of the Hebei DRC pages checked on 2026-09-28.
  const oldTitle = '关于调整成品油价格的公告（2026年第18号）';
  const newTitle = '关于调整成品油价格的公告（2026年第19号）';
  const list = listItem(nextPath, newTitle, '2026-10-15') +
    listItem(latestPath, oldTitle, '2026-09-24');
  const nextUrl = new URL(nextPath, base).href;
  const result = await monitor.collect({ getText: getText(list, {
    [nextUrl]: article(newTitle, '2026-10-15', './W020261015123456789012.png'),
  }) });
  assert.deepEqual(result, {
    url: nextUrl,
    publishedDate: '2026-10-15',
    imageUrl: 'https://hbdrc.hebei.gov.cn/gggs_980/202610/W020261015123456789012.png',
    requiresManualPriceReview: true,
  });
  assert.equal('prices' in result, false);
});

test('rejects an image outside the official announcement directory', async () => {
  const title = '关于调整成品油价格的公告（2026年第18号）';
  const url = new URL(latestPath, base).href;
  await assert.rejects(
    monitor.collect({ getText: getText(listItem(latestPath, title, '2026-09-24'), {
      [url]: article(title, '2026-09-24', 'https://example.com/price.png'),
    }) }),
    /公告图片不是预期的官网地址/,
  );
});
