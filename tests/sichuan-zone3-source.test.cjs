'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { deflateRawSync } = require('node:zlib');
const source = require('../scripts/sources/sichuan-zone3.cjs');

const date = '2026-10-15';
const title = '关于调整成品油价格的通知（川发改价格〔2026〕450号）';
const articleUrl = 'https://fgw.sc.gov.cn/sfgw/tzgg/2026/10/15/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.shtml';
const attachment = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/files/四川省汽、柴油最高批发零售价格表.docx';

function zip(xml) {
  const name = Buffer.from('word/document.xml');
  const content = Buffer.from(xml);
  const compressed = deflateRawSync(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + compressed.length, 16);
  return Buffer.concat([local, name, compressed, central, name, end]);
}

function xml({ scope = true, unit = '元/升' } = {}) {
  const cell = (value) => `<w:tc><w:p><w:r><w:t>${value}</w:t></w:r></w:p></w:tc>`;
  const row = (values) => `<w:tr>${values.map(cell).join('')}</w:tr>`;
  const paragraph = (value) => `<w:p><w:r><w:t>${value}</w:t></w:r></w:p>`;
  const rows = [
    ['品名', '一价区', '二价区', '三价区'],
    ['', '最高批发价格', '最高零售价格', '最高批发价格', '最高零售价格', '最高批发价格', '最高零售价格'],
    ['', '元/吨', '元/吨', '元/升', '元/吨', '元/吨', '元/升', '元/吨', '元/吨', unit],
    ['89﹟汽油（国Ⅵ）', '10610', '10910', '8.08', '10710', '11010', '8.15', '10810', '11110', '8.22'],
    ['92﹟汽油（国Ⅵ）', '11265', '11565', '8.70', '11365', '11665', '8.78', '11465', '11765', '8.85'],
    ['95﹟汽油（国Ⅵ）', '11919', '12219', '9.30', '12019', '12319', '9.38', '12119', '12419', '9.45'],
    ['0﹟车用柴油（国Ⅵ）', '9555', '9855', '8.34', '9655', '9955', '8.42', '9755', '10055', '8.51'],
    ['﹣10﹟车用柴油（国Ⅵ）', '10146', '10446', '8.84', '10246', '10546', '8.92', '10346', '10646', '9.01'],
    ['﹣20﹟车用柴油（国Ⅵ）', '10639', '10939', '9.16', '10739', '11039', '9.25', '10839', '11139', '9.33'],
  ];
  return `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    ${paragraph('四川省汽、柴油最高批发零售价格表')}
    ${paragraph('（2026年10月15日）')}
    <w:tbl>${rows.map(row).join('')}</w:tbl>
    ${paragraph(scope ? '阿坝州除汶川县、理县、茂县以外的其余10个县以及甘孜州行政区域为三价区' : '价区范围待核实')}
    ${paragraph('二三价区以外的其他市行政区域为一价区')}
    </w:body></w:document>`;
}

function readers(buffer = zip(xml())) {
  return {
    async getText(url) {
      if (url.endsWith('/olist.shtml')) {
        return `<li><span>${date}</span><a href="/sfgw/tzgg/2026/10/15/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.shtml">${title}</a></li>`;
      }
      if (/\/olist_[234]\.shtml$/.test(url)) return '<li>其他公告</li>';
      if (url === articleUrl) {
        return `<meta name="ArticleTitle" content="${title}"/>
          <meta name="PubDate" content="2026-10-15 17:41:44"/>
          <p>我省三个价区汽、柴油最高零售价格相应调整</p>
          <p>调整后的价格自2026年10月15日24时起执行</p>
          <p>四川省发展和改革委员会2026年10月15日</p>
          <a href="${attachment}">四川省汽、柴油最高批发零售价格表</a>`;
      }
      throw new Error(`unexpected HTML URL: ${url}`);
    },
    async getBuffer(url) {
      assert.ok(url.startsWith('https://fgw.sc.gov.cn/sfgw/tzgg/2026/10/15/'));
      return { buffer };
    },
  };
}

test('reads third-zone yuan-per-litre values rather than adjacent zone columns', () => {
  assert.deepEqual(source.parseDocx(zip(xml()), date), { 92: 8.85, 95: 9.45, diesel: 8.51 });
});

test('rejects an unknown third-zone scope or a non-litre column', () => {
  assert.throws(() => source.parseDocx(zip(xml({ scope: false })), date), /第三价区范围缺失/);
  assert.throws(() => source.parseDocx(zip(xml({ unit: '元/吨' })), date), /价区列或单位异常/);
});

test('discovers latest official notice and reports independent third-zone prices', async () => {
  const notices = await source.collect({ ...readers(), today: '2026-10-16' });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].effectiveDate, '2026-10-16');
  assert.equal(notices[0].url, articleUrl);
  assert.deepEqual(notices[0].prices, { 92: 8.85, 95: 9.45, diesel: 8.51 });
});
