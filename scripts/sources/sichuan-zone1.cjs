'use strict';

const { inflateRawSync } = require('node:zlib');

const HOSTNAME = 'fgw.sc.gov.cn';
const LIST_URLS = [
  'https://fgw.sc.gov.cn/sfgw/tzgg/olist.shtml',
  'https://fgw.sc.gov.cn/sfgw/tzgg/olist_2.shtml',
  'https://fgw.sc.gov.cn/sfgw/tzgg/olist_3.shtml',
  'https://fgw.sc.gov.cn/sfgw/tzgg/olist_4.shtml',
];
const ARTICLE_PATH = /^\/sfgw\/tzgg\/(\d{4})\/(\d{1,2})\/(\d{1,2})\/([a-f0-9]{32})\.shtml$/;
const TITLE = /^关于(?:调整|降低|提高)成品油价格的通知[（(]川发改价格〔(\d{4})〕\d+号[）)]$/;
const ATTACHMENT_NAME = '四川省汽、柴油最高批发零售价格表';
const GRADES = { '92': /^92[﹟#＃]汽油/, '95': /^95[﹟#＃]汽油/, diesel: /^0[﹟#＃]车用柴油/ };

function chinaDate() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function validDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`四川第一价区：${label}无效：${value}`);
  }
  return value;
}

function nextDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function chineseDate(day) {
  const [year, month, date] = day.split('-').map(Number);
  return `${year}年${month}月${date}日`;
}

function officialUrl(reference, base, pattern, label) {
  const url = new URL(reference, base);
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME || url.username || url.password ||
      url.search || url.hash || !pattern.test(url.pathname)) {
    throw new Error(`四川第一价区：${label}不是预期的省发改委地址：${url.href}`);
  }
  return url.href;
}

function listing(html) {
  const entries = [];
  for (const item of html.matchAll(/<li>\s*<span>(\d{4}-\d{2}-\d{2})<\/span>\s*<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>\s*<\/li>/gi)) {
    const title = item[3].trim();
    if (!title.includes('成品油价格')) continue;
    const match = title.match(TITLE);
    if (!match) throw new Error(`四川第一价区：未知油价公告标题：${title}`);
    const day = validDate(item[1], '列表日期');
    if (match[1] !== day.slice(0, 4)) throw new Error(`四川第一价区：标题年份与列表不符：${title}`);
    const url = officialUrl(item[2], LIST_URLS[0], ARTICLE_PATH, '公告');
    const path = new URL(url).pathname.match(ARTICLE_PATH);
    if (`${path[1]}-${path[2].padStart(2, '0')}-${path[3].padStart(2, '0')}` !== day) {
      throw new Error(`四川第一价区：公告路径与日期不符：${url}`);
    }
    entries.push({ title, publishedDate: day, url });
  }
  return entries;
}

function article(html, entry) {
  const title = html.match(/<meta\s+name="ArticleTitle"\s+content="([^"]+)"/i)?.[1];
  if (title !== entry.title) throw new Error(`四川第一价区：正文标题与列表不符：${entry.url}`);
  const pagePublishedDate = html.match(/<meta\s+name="PubDate"\s+content="(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}:\d{2}"/i)?.[1];
  if (!pagePublishedDate || validDate(pagePublishedDate, '网页发布日期') < entry.publishedDate ||
      Date.parse(`${pagePublishedDate}T00:00:00Z`) - Date.parse(`${entry.publishedDate}T00:00:00Z`) > 7 * 86_400_000) {
    throw new Error(`四川第一价区：网页发布日期与文件日期冲突：${entry.url}`);
  }
  const text = html.replace(/<[^>]*>/g, '').replace(/&(?:ensp|nbsp);|\s|\u00a0/g, '');
  const dateText = chineseDate(entry.publishedDate);
  if (!text.includes(`调整后的价格自${dateText}24时起执行`) ||
      !text.includes(`四川省发展和改革委员会${dateText}`) ||
      !text.includes('我省三个价区汽、柴油最高零售价格相应调整')) {
    throw new Error(`四川第一价区：正文未确认调价生效日和价区：${entry.url}`);
  }
  const attachments = [...html.matchAll(/<a\s+href="([^"]+\/files\/[^"]+\.(?:docx|doc))"[^>]*>/gi)];
  if (attachments.length !== 1) {
    throw new Error(`四川第一价区：价格附件数量异常：${entry.url}`);
  }
  const path = new URL(entry.url).pathname.replace(/\.shtml$/, '');
  const attachmentUrl = officialUrl(attachments[0][1], entry.url,
    /^\/sfgw\/tzgg\/\d{4}\/\d{1,2}\/\d{1,2}\/[a-f0-9]{32}\/files\/[^/]+\.(?:docx|doc)$/, '附件');
  const attachment = new URL(attachmentUrl);
  if (!attachment.pathname.startsWith(`${path}/files/`) ||
      !decodeURIComponent(attachment.pathname).endsWith(`${ATTACHMENT_NAME}.${attachment.pathname.endsWith('.docx') ? 'docx' : 'doc'}`)) {
    throw new Error(`四川第一价区：价格附件名称或目录异常：${attachmentUrl}`);
  }
  // 2026-06-18 的官网网页在 06-22 上传；字段采用文件落款和生效公告日，另保留网页发布日期。
  return { ...entry, pagePublishedDate, attachmentUrl, effectiveDate: nextDate(entry.publishedDate) };
}

function docxXml(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > 5_000_000) {
    throw new Error('四川第一价区：DOCX 大小异常');
  }
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('四川第一价区：DOCX 缺少 ZIP 目录');
  const count = buffer.readUInt16LE(end + 10);
  const directoryEnd = buffer.readUInt32LE(end + 12) + buffer.readUInt32LE(end + 16);
  let offset = buffer.readUInt32LE(end + 16);
  if (count < 1 || count > 300 || directoryEnd > end) {
    throw new Error('四川第一价区：DOCX ZIP 目录异常');
  }
  for (let i = 0; i < count; i++) {
    if (offset + 46 > directoryEnd || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('四川第一价区：DOCX ZIP 目录损坏');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const originalSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (name !== 'word/document.xml') continue;
    if (flags & 1 || ![0, 8].includes(method) || compressedSize > 3_000_000 ||
        originalSize > 3_000_000 || localOffset + 30 > buffer.length ||
        buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('四川第一价区：DOCX 正文 ZIP 条目异常');
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    if (start + compressedSize > buffer.length) throw new Error('四川第一价区：DOCX 正文不完整');
    const packed = buffer.subarray(start, start + compressedSize);
    const xml = method === 8 ? inflateRawSync(packed, { maxOutputLength: 3_000_000 }) : packed;
    if (xml.length !== originalSize) throw new Error('四川第一价区：DOCX 正文长度不符');
    return xml.toString('utf8');
  }
  throw new Error('四川第一价区：DOCX 中没有 Word 正文');
}

function xmlText(fragment) {
  return [...fragment.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((match) => match[1].replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'"))
    .join('').replace(/\s|\u00a0/g, '');
}

function parseDocx(buffer, day) {
  const xml = docxXml(buffer);
  const allText = xmlText(xml);
  if (!allText.includes(ATTACHMENT_NAME) || !allText.includes(`（${chineseDate(day)}）`) ||
      !allText.includes('二三价区以外的其他市行政区域为一价区')) {
    throw new Error(`四川第一价区：DOCX 标题、日期或价区范围缺失：${day}`);
  }
  const tables = [...xml.matchAll(/<w:tbl(?:\s[^>]*)?>([\s\S]*?)<\/w:tbl>/g)];
  if (tables.length !== 1) throw new Error(`四川第一价区：DOCX 表格数量异常：${day}`);
  const rows = [...tables[0][1].matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)]
    .map((match) => [...match[1].matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)]
      .map((cell) => xmlText(cell[1])));
  if (rows.length !== 9 || rows[0].join('|') !== '品名|一价区|二价区|三价区' ||
      rows[2].length !== 10 || [3, 6, 9].some((i) => rows[2][i] !== '元/升')) {
    throw new Error(`四川第一价区：DOCX 价区列或单位异常：${day}`);
  }
  const prices = {};
  for (const [grade, pattern] of Object.entries(GRADES)) {
    const matches = rows.filter((row) => pattern.test(row[0]));
    if (matches.length !== 1 || matches[0].length !== 10) {
      throw new Error(`四川第一价区：DOCX 缺少 ${grade} 号完整价格行：${day}`);
    }
    const row = matches[0];
    const zones = [3, 6, 9].map((i) => {
      if (!/^\d{1,2}\.\d{2}$/.test(row[i])) {
        throw new Error(`四川第一价区：DOCX ${grade} 号元/升值异常：${day}`);
      }
      return Number(row[i]);
    });
    if (!(zones[0] >= 1 && zones[2] <= 30 && zones[0] < zones[1] && zones[1] < zones[2])) {
      throw new Error(`四川第一价区：DOCX ${grade} 号价区顺序异常：${day}`);
    }
    prices[grade] = zones[0];
  }
  return prices;
}

module.exports = {
  id: 'sichuan-zone1',
  name: '四川第一价区',
  sourceName: '四川省发展和改革委员会',
  priceScope: '四川省第一价区（二、三价区以外的其他地区）汽、柴油最高零售价格（元/升）；二价区含攀枝花、凉山和阿坝汶川、理县、茂县，三价区含甘孜及阿坝其余十县；加油站实付价可能不同。',
  allowedHostnames: [HOSTNAME],
  async collect({ getText, getBuffer, today = chinaDate() } = {}) {
    if (typeof getText !== 'function' || typeof getBuffer !== 'function') {
      throw new TypeError('四川第一价区：需要官方 HTML 与 DOCX 读取器');
    }
    const asOf = validDate(today, '核对日期');
    const pages = await Promise.all(LIST_URLS.map((url) => getText(url)));
    const byDate = new Map();
    for (const html of pages) {
      for (const entry of listing(html)) {
        const prior = byDate.get(entry.publishedDate);
        if (prior && prior.url !== entry.url) {
          throw new Error(`四川第一价区：同日公告不唯一：${entry.publishedDate}`);
        }
        byDate.set(entry.publishedDate, entry);
      }
    }
    const recent = [...byDate.values()].filter((entry) => nextDate(entry.publishedDate) <= asOf)
      .sort((a, b) => a.publishedDate.localeCompare(b.publishedDate)).slice(-12);
    if (!recent.length) throw new Error('四川第一价区：官网列表没有已生效调价公告');
    const notices = [];
    for (const entry of recent) {
      const notice = article(await getText(entry.url), entry);
      if (notice.attachmentUrl.endsWith('.doc')) {
        // 旧式 Word 文件不按 DOCX 解析；若最新一期如此，保留已发布的可信快照。
        if (entry === recent.at(-1)) throw new Error(`四川第一价区：最新公告附件为待人工核验 DOC：${entry.url}`);
        continue;
      }
      const response = await getBuffer(notice.attachmentUrl);
      const prices = parseDocx(response.buffer, entry.publishedDate);
      notices.push({ ...notice, prices });
    }
    if (!notices.length || notices.at(-1).publishedDate !== recent.at(-1).publishedDate) {
      throw new Error('四川第一价区：最新已生效公告未取得可信元/升价格');
    }
    return notices;
  },
  parseDocx,
};
