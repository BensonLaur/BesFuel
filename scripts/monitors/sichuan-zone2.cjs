'use strict';

const LIST_URL = 'https://fgw.sc.gov.cn/sfgw/tzgg/list.shtml';
const HOSTNAME = 'fgw.sc.gov.cn';

function validDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`四川二价区公告：${label}无效：${value}`);
  }
  return value;
}

function officialUrl(reference, base, pattern, label) {
  const url = new URL(reference, base);
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME || url.port ||
      url.username || url.password || url.search || url.hash || !pattern.test(url.pathname)) {
    throw new Error(`四川二价区公告：${label}不是预期的官网地址：${url.href}`);
  }
  return url.href;
}

function newestEntry(html) {
  const list = html.match(/<ul\s+class="list-li mt30"[^>]*>([\s\S]*?)<\/ul>/i);
  if (!list) throw new Error('四川二价区公告：缺少省发改委通知公告列表');
  const entries = [];
  for (const item of list[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    if (!item[1].includes('成品油价格')) continue;
    const anchor = item[1].match(/<a\s+href="([^"]+)"[^>]*\btitle='([^']+)'/i);
    const date = item[1].match(/<span\s+class="list-time f-20 fr">\s*(\d{4}-\d{2}-\d{2})\s*<\/span>/i);
    if (!anchor || !date) throw new Error('四川二价区公告：油价列表条目结构变化');
    const title = anchor[2].trim();
    if (!/^关于(?:调整|降低)成品油价格的通知[（(]川发改价格〔\d{4}〕\d+号[）)]$/.test(title)) {
      throw new Error(`四川二价区公告：未知油价公告标题：${title}`);
    }
    const publishedDate = validDate(date[1], '列表发布日期');
    const url = officialUrl(anchor[1], LIST_URL,
      /^\/sfgw\/tzgg\/\d{4}\/\d{1,2}\/\d{1,2}\/[0-9a-f]{32}\.shtml$/, '公告');
    const match = new URL(url).pathname.match(/^\/sfgw\/tzgg\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//);
    if (validDate(`${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`, '网址日期') !== publishedDate) {
      throw new Error(`四川二价区公告：列表与网址日期不符：${url}`);
    }
    entries.push({ title, publishedDate, url });
  }
  if (!entries.length) throw new Error('四川二价区公告：列表中未找到成品油价格公告');
  entries.sort((a, b) => b.publishedDate.localeCompare(a.publishedDate));
  if (entries.length > 1 && entries[0].publishedDate === entries[1].publishedDate) {
    throw new Error(`四川二价区公告：同日公告不唯一：${entries[0].publishedDate}`);
  }
  return entries[0];
}

function parseArticle(html, entry) {
  const site = html.match(/<meta\s+name="SiteName"\s+content="([^"]+)"/i);
  const title = html.match(/<meta\s+name="ArticleTitle"\s+content="([^"]+)"/i);
  const heading = html.match(/<h1\s+class="data-title">\s*([^<]+)\s*<\/h1>/i);
  const date = html.match(/<meta\s+name="PubDate"\s+content="(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}"/i);
  if (!site || site[1] !== '四川省发展和改革委员会' ||
      !title || title[1] !== entry.title || !heading || heading[1].trim() !== entry.title ||
      !date || validDate(date[1], '正文发布日期') !== entry.publishedDate) {
    throw new Error(`四川二价区公告：官网、标题或日期与列表不符：${entry.url}`);
  }
  const text = html.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/gi, '').replace(/[\s\u3000]/g, '');
  const times = [...text.matchAll(/价格自(\d{4})年(\d{1,2})月(\d{1,2})日24时起执行/g)];
  if (times.length !== 1 || !text.includes('我省三个价区')) {
    throw new Error(`四川二价区公告：生效时间或分价区说明缺失：${entry.url}`);
  }
  const announced = validDate(`${times[0][1]}-${times[0][2].padStart(2, '0')}-${times[0][3].padStart(2, '0')}`, '生效公告日期');
  if (announced !== entry.publishedDate) {
    throw new Error(`四川二价区公告：生效日期与列表不符：${entry.url}`);
  }
  const attachments = [...html.matchAll(/<a\s+href="([^"]+\.(?:doc|docx))"[^>]*>\s*四川省汽、柴油最高批发零售价格表\s*<\/a>/gi)];
  if (attachments.length !== 1) throw new Error(`四川二价区公告：价格附表数量异常：${attachments.length}`);
  const directory = new URL(entry.url.replace(/\.shtml$/, '/files/')).pathname;
  const attachmentPattern = new RegExp(`^${directory}[^/]+\\.(?:doc|docx)$`, 'i');
  const attachmentUrl = officialUrl(attachments[0][1], entry.url, attachmentPattern, '价格附表');
  return {
    url: entry.url,
    publishedDate: entry.publishedDate,
    attachmentUrl,
    // 附表中的二价区元/升价格必须逐项核对，公告 HTML 本身不提供这些价格。
    requiresManualPriceReview: true,
  };
}

module.exports = {
  id: 'sichuan-zone2',
  name: '四川·二价区',
  sourceName: '四川省发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText }) {
    if (typeof getText !== 'function') throw new TypeError('四川二价区公告：getText 必须为函数');
    const entry = newestEntry(await getText(LIST_URL));
    return parseArticle(await getText(entry.url), entry);
  },
};
