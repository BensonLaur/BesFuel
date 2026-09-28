'use strict';

const { inflateRawSync } = require('node:zlib');
const provincial = require('./sichuan-zone1.cjs');

const GRADES = { '92': /^92[﹟#＃]汽油/, '95': /^95[﹟#＃]汽油/, diesel: /^0[﹟#＃]车用柴油/ };
const ATTACHMENT_NAME = '四川省汽、柴油最高批发零售价格表';
const ZONE_RULE = '阿坝州除汶川县、理县、茂县以外的其余10个县以及甘孜州行政区域为三价区';

function chineseDate(day) {
  const [year, month, date] = day.split('-').map(Number);
  return `${year}年${month}月${date}日`;
}

function documentXml(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > 5_000_000) {
    throw new Error('四川第三价区：DOCX 大小异常');
  }
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('四川第三价区：DOCX 缺少 ZIP 目录');
  const count = buffer.readUInt16LE(end + 10);
  const size = buffer.readUInt32LE(end + 12);
  const start = buffer.readUInt32LE(end + 16);
  if (count < 1 || count > 300 || start + size > end) {
    throw new Error('四川第三价区：DOCX ZIP 目录异常');
  }
  let offset = start;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > start + size || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('四川第三价区：DOCX ZIP 目录损坏');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const packedSize = buffer.readUInt32LE(offset + 20);
    const xmlSize = buffer.readUInt32LE(offset + 24);
    const nameSize = buffer.readUInt16LE(offset + 28);
    const extraSize = buffer.readUInt16LE(offset + 30);
    const commentSize = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameSize);
    offset += 46 + nameSize + extraSize + commentSize;
    if (name !== 'word/document.xml') continue;
    if (flags & 1 || ![0, 8].includes(method) || packedSize > 3_000_000 ||
        xmlSize > 3_000_000 || localOffset + 30 > buffer.length ||
        buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('四川第三价区：DOCX 正文 ZIP 条目异常');
    }
    const localNameSize = buffer.readUInt16LE(localOffset + 26);
    const localExtraSize = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameSize + localExtraSize;
    if (dataStart + packedSize > buffer.length) throw new Error('四川第三价区：DOCX 正文不完整');
    const packed = buffer.subarray(dataStart, dataStart + packedSize);
    const xml = method === 8 ? inflateRawSync(packed, { maxOutputLength: 3_000_000 }) : packed;
    if (xml.length !== xmlSize) throw new Error('四川第三价区：DOCX 正文长度不符');
    return xml.toString('utf8');
  }
  throw new Error('四川第三价区：DOCX 中没有 Word 正文');
}

function text(fragment) {
  return [...fragment.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((match) => match[1].replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'"))
    .join('').replace(/\s|\u00a0/g, '');
}

function parseDocx(buffer, day) {
  const xml = documentXml(buffer);
  const allText = text(xml);
  if (!allText.includes(ATTACHMENT_NAME) || !allText.includes(`（${chineseDate(day)}）`) ||
      !allText.includes(ZONE_RULE)) {
    throw new Error(`四川第三价区：DOCX 标题、日期或第三价区范围缺失：${day}`);
  }
  const tables = [...xml.matchAll(/<w:tbl(?:\s[^>]*)?>([\s\S]*?)<\/w:tbl>/g)];
  if (tables.length !== 1) throw new Error(`四川第三价区：DOCX 表格数量异常：${day}`);
  const rows = [...tables[0][1].matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)]
    .map((match) => [...match[1].matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)]
      .map((cell) => text(cell[1])));
  if (rows.length !== 9 || rows[0].join('|') !== '品名|一价区|二价区|三价区' ||
      rows[2].length !== 10 || [3, 6, 9].some((i) => rows[2][i] !== '元/升')) {
    throw new Error(`四川第三价区：DOCX 价区列或单位异常：${day}`);
  }
  const prices = {};
  for (const [grade, pattern] of Object.entries(GRADES)) {
    const matches = rows.filter((row) => pattern.test(row[0]));
    if (matches.length !== 1 || matches[0].length !== 10) {
      throw new Error(`四川第三价区：DOCX 缺少 ${grade} 号完整价格行：${day}`);
    }
    const zones = [3, 6, 9].map((i) => {
      if (!/^\d{1,2}\.\d{2}$/.test(matches[0][i])) {
        throw new Error(`四川第三价区：DOCX ${grade} 号元/升值异常：${day}`);
      }
      return Number(matches[0][i]);
    });
    if (!(zones[0] >= 1 && zones[2] <= 30 && zones[0] < zones[1] && zones[1] < zones[2])) {
      throw new Error(`四川第三价区：DOCX ${grade} 号价区顺序异常：${day}`);
    }
    prices[grade] = zones[2];
  }
  return prices;
}

module.exports = {
  id: 'sichuan-zone3',
  name: '四川第三价区',
  sourceName: provincial.sourceName,
  priceScope: '四川省第三价区（甘孜州，以及阿坝州除汶川县、理县、茂县以外的其他地区）汽、柴油最高零售价格（元/升）；加油站实付价可能不同。',
  allowedHostnames: provincial.allowedHostnames,
  async collect(options = {}) {
    if (typeof options.getBuffer !== 'function') {
      throw new TypeError('四川第三价区：需要官方 DOCX 读取器');
    }
    // 同一官方通知发布三价区价格；先复用通知日期、附件地址及一价区表格结构核验。
    const notices = await provincial.collect(options);
    const results = [];
    for (const notice of notices) {
      const response = await options.getBuffer(notice.attachmentUrl);
      results.push({ ...notice, prices: parseDocx(response.buffer, notice.publishedDate) });
    }
    return results;
  },
  parseDocx,
};
