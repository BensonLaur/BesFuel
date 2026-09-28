'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const monitor = require('../scripts/monitors/liaoning.cjs');

const listUrl = 'https://fgw.ln.gov.cn/fgw/index/tzgg/index.shtml';
const pdfPath = '/fgw/articleFileDir/2026-10/15/0123456789abcdef0123456789abcdef/2026101512345678901.pdf';

function item(date, title, pdf) {
  return `<li><a href="/uiFramework/js/pdfjs/web/viewer.html?file=${pdf}" ` +
    `onclick="recordLinkArticleHits('id','site','${title}',this)" target="_blank" ` +
    `title="${title}" istitle="true">${title}</a><span class="datetime">${date}</span></li>`;
}

function reader(html) {
  return async url => {
    assert.equal(url, listUrl);
    return `<div class="cont_main"><ul>${html}</ul></div>`;
  };
}

test('discovers a new official PDF and leaves liter prices for manual review', async () => {
  const title = '辽宁省成品油价格调整公告（2026年10月15日24时起执行）';
  const result = await monitor.collect({ getText: reader(item('2026-10-15', title, pdfPath)), today: '2026-10-16' });
  assert.deepEqual(result, {
    publishedDate: '2026-10-15',
    effectiveDate: '2026-10-16',
    url: `https://fgw.ln.gov.cn${pdfPath}`,
    requiresManualLiterReview: true,
  });
  assert.equal('prices' in result, false);
});

test('does not report a future effective date as current', async () => {
  const title = '辽宁省成品油价格调整公告（2026年10月15日24时起执行）';
  await assert.rejects(monitor.collect({
    getText: reader(item('2026-10-15', title, pdfPath)), today: '2026-10-15',
  }), /未找到已生效/);
});

test('rejects mismatched dates and PDFs outside the official dated directory', async () => {
  const title = '辽宁省成品油价格调整公告（2026年10月15日24时起执行）';
  await assert.rejects(monitor.collect({
    getText: reader(item('2026-10-16', title, pdfPath)), today: '2026-10-17',
  }), /标题与列表日期不一致/);
  await assert.rejects(monitor.collect({
    getText: reader(item('2026-10-15', title, 'https://example.com/fake.pdf')),
    today: '2026-10-16',
  }), /PDF 不是预期的官网地址/);
  await assert.rejects(monitor.collect({
    getText: reader(item('2026-10-15', title, pdfPath)
      .replace('/uiFramework/js/pdfjs/web/viewer.html', 'https://example.com/viewer.html')),
    today: '2026-10-16',
  }), /PDF 阅读器不是预期的官网地址/);
  await assert.rejects(monitor.collect({
    getText: reader(item('2026-10-15', title, pdfPath.replace('/15/', '/14/'))),
    today: '2026-10-16',
  }), /PDF 不是预期的官网地址/);
});

test('verified history remains explicitly per tonne, with no invented liter prices', () => {
  const verified = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/verified/liaoning.json'), 'utf8'));
  assert.equal(verified.unit, '元/吨');
  assert.equal(verified.notices.length, 4);
  assert.deepEqual(verified.notices.at(-1).retailPerTonne, { '92': 11331, '95': 11973, diesel: 9620 });
  for (const notice of verified.notices) {
    assert.equal(notice.requiresManualLiterReview, true);
    assert.equal('prices' in notice, false);
    assert.match(notice.url, /^https:\/\/fgw\.ln\.gov\.cn\/fgw\/articleFileDir\//);
  }
});
