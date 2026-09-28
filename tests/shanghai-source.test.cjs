'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const source = require('../scripts/sources/shanghai.cjs');

const base = 'https://fgw.sh.gov.cn/fgw_jggl/';
const latest = `${base}20260924/9346a0fd85d74075a9431f83f365cef8.html`;
const earlier = `${base}20260911/9aaae46f75e24072bfc5ac52742d2642.html`;

function title(day) {
  const [year, month, date] = day.split('-');
  return `上海市发展和改革委员会关于车用汽、柴油价格的通知（${year}年${Number(month)}月${Number(date)}日）`;
}

function listed(url, day) {
  return `<li><a href="${url.replace('https:', 'http:')}" title="${title(day)}">${title(day)}</a>` +
    `<p><span>发布日期：${day} </span></p></li>`;
}

function listing(overrides = {}) {
  return `<ul class="zzwj-list trout-region-list">
    ${listed(latest, '2026-09-24')}
    ${listed(earlier, '2026-09-11')}
    <li><a href="http://fgw.sh.gov.cn/fgw_gfxwj/20260909/c3c96f13d4a240cd89d7d82d3cd46705.html"
      title="居民瓶装液化石油气价格">居民瓶装液化石油气价格</a>
      <p><span>发布日期：2026-09-09 </span></p></li>
    </ul><script>totalPage: 1</script>`.replace(overrides.from ?? 'never-such-text', overrides.to ?? '');
}

function article(day, prices, { wrongTon = false, unit = '元/升' } = {}) {
  const [year, month, date] = day.split('-');
  const row = (label, tonne, litre) => `<tr><td rowspan="2">${label}</td><td>元/吨</td><td>${tonne}</td></tr>` +
    `<tr><td>${label === '92号汽油' ? unit : '元/升'}</td><td>${litre}</td></tr>`;
  return `<meta name="ArticleTitle" content="${title(day)}">
    <meta name="PubDate" content="${day} 05:09:22">
    <meta name="ContentSource" content="上海市发展和改革委员会">
    <div id="ivs_content">
      <p>一、89号汽油和0号柴油最高零售价格每吨分别为10705元和9625元。</p>
      <p>三、上述调整后的价格自${year}年${Number(month)}月${Number(date)}日24时起执行。</p>
      <table><tr><td>标 号</td><td>单 位</td><td>最高零售价</td></tr>
        ${row('89号汽油', wrongTon ? 10706 : 10705, '8.00')}
        ${row('92号汽油', 11347, prices['92'])}
        ${row('95号汽油', 11990, prices['95'])}
        ${row('0号柴油', 9625, prices.diesel)}
        ${row('-10号柴油', 10203, '8.78')}
      </table>
    </div>`;
}

function reader(latestOverrides = {}) {
  const pages = {
    [base]: listing(),
    [latest]: article('2026-09-24', { '92': '8.57', '95': '9.12', diesel: '8.28' }, latestOverrides),
    [earlier]: article('2026-09-11', { '92': '8.24', '95': '8.77', diesel: '7.94' }),
  };
  return async (url) => {
    assert.ok(url in pages, `unexpected request: ${url}`);
    return pages[url];
  };
}

test('collects Shanghai official yuan-per-litre prices and effective dates', async () => {
  const notices = await source.collect({ getText: reader(), today: '2026-09-28' });
  assert.deepEqual(notices.map(({ effectiveDate, prices }) => ({ effectiveDate, prices })), [
    { effectiveDate: '2026-09-12', prices: { '92': 8.24, '95': 8.77, diesel: 7.94 } },
    { effectiveDate: '2026-09-25', prices: { '92': 8.57, '95': 9.12, diesel: 8.28 } },
  ]);
  assert.equal(notices.at(-1).url, latest);
});

test('rejects a table that labels prices with the wrong unit', async () => {
  await assert.rejects(
    source.collect({ getText: reader({ unit: '元/吨' }), today: '2026-09-28' }),
    /元\/升价格格式异常/,
  );
});

test('rejects a notice whose body and table disagree on the reference tonne price', async () => {
  await assert.rejects(
    source.collect({ getText: reader({ wrongTon: true }), today: '2026-09-28' }),
    /正文与表格吨价不符/,
  );
});

test('rejects an off-domain link even if it appears in the official list', async () => {
  const getText = reader();
  await assert.rejects(
    source.collect({
      getText: async (url) => url === base
        ? listing({ from: 'http://fgw.sh.gov.cn/fgw_jggl/20260924/', to: 'https://evil.example/fgw_jggl/20260924/' })
        : getText(url),
      today: '2026-09-28',
    }),
    /公告链接异常/,
  );
});
