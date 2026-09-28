'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const monitor = require('../scripts/monitors/hunan.cjs');
const { checkMonitors } = require('../scripts/check-monitors.cjs');

const LIST = 'https://fgw.hunan.gov.cn/fgw/xxgk_70899/gzdtf/gzdt/newxxgklist.html';
const NOTICE = 'https://fgw.hunan.gov.cn/fgw/xxgk_70899/gzdtf/gzdt/202609/t20260924_34071920.html';
const XLS = 'https://fgw.hunan.gov.cn/fgw/xxgk_70899/gzdtf/gzdt/202609/34071920/files/5fdb67cd78114f4c9200bd30218a600a.xls';
const FUTURE = 'https://fgw.hunan.gov.cn/fgw/xxgk_70899/gzdtf/gzdt/202610/t20261015_99999999.html';

function list(...links) {
  return links.map(([url, date]) => `<li><a href="${url}">关于调整成品油价格的通知(${date})</a></li>`).join('');
}

function article({ date = '2026年9月24日', published = '2026-09-24', xls = XLS,
  attachment = true, priceKind = '最高价格管理' } = {}) {
  return `<h1>关于调整成品油价格的通知(${date})</h1>
    <p>发布日期：${published} 15:29</p>
    <p>一、汽、柴油零售仍实行${priceKind}，我省调整后的汽、柴油最高零售价格见附件。</p>
    <p>三、调整后的汽、柴油价格自${date}24时起执行。</p>
    <p>附件：湖南省成品油销售价格表</p>
    <p>湖南省发展和改革委员会</p>
    ${attachment ? `<a href="${xls}">销售价格表.xls</a>` : ''}`;
}

function reader({ latest = NOTICE, body = article(), includeFuture = false } = {}) {
  return { async getText(url) {
    if (url === LIST) return includeFuture ?
      list([FUTURE, '2026年10月15日'], [latest, '2026年9月24日']) :
      list([latest, '2026年9月24日']);
    if (url === latest) return body;
    throw new Error(`unexpected URL: ${url}`);
  } };
}

test('discovers the official XLS notice, but does not invent yuan-per-litre prices', async () => {
  assert.deepEqual(await monitor.collect({ ...reader(), today: '2026-09-25' }), {
    url: NOTICE, publishedDate: '2026-09-24', effectiveDate: '2026-09-25',
    attachmentUrl: XLS, requiresManualLiterReview: true,
  });
  assert.equal('prices' in await monitor.collect({ ...reader(), today: '2026-09-25' }), false);
});

test('waits for the official 24:00 start and keeps the prior effective notice', async () => {
  const prior = await monitor.collect({ ...reader({ includeFuture: true }), today: '2026-10-15' });
  assert.equal(prior.url, NOTICE);
  await assert.rejects(monitor.collect({ ...reader(), today: '2026-09-24' }), /没有已生效/);
});

test('rejects outside links, conflicting dates, bad attachment URLs, and missing XLS', async () => {
  for (const [input, pattern] of [
    [reader({ latest: NOTICE.replace('fgw.hunan.gov.cn/', 'fgw.hunan.gov.cn.evil.example/') }), /非预期官方公告/],
    [reader({ latest: NOTICE.replace('t20260924_', 't20260923_') }), /标题与路径日期/],
    [reader({ body: article({ published: '2026-09-23' }) }), /标题、日期/],
    [reader({ body: article({ date: '2026年9月23日' }) }), /标题、日期/],
    [reader({ body: article({ xls: XLS.replace('/34071920/', '/34071921/') }) }), /XLS 附件不是/],
    [reader({ body: article({ xls: XLS.replace('fgw.hunan.gov.cn/', 'evil.example/') }) }), /XLS 附件不是/],
    [reader({ body: article({ attachment: false }) }), /XLS 价格表链接缺失/],
    [reader({ body: article({ priceKind: '自由定价' }) }), /标题、日期/],
  ]) {
    await assert.rejects(monitor.collect({ ...input, today: '2026-09-25' }), pattern);
  }
});

test('unverified Hunan remains manual review instead of replacing a trusted snapshot', async () => {
  const results = await checkMonitors({ modules: [monitor], data: { regions: {} }, reader: () => reader() });
  assert.equal(results[0].ok, true);
  assert.equal(results[0].stored, false);
  assert.equal(results[0].needsReview, true);
  assert.equal(results[0].latest.requiresManualLiterReview, true);
});
