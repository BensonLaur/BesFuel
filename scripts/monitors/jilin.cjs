'use strict';

const LIST_URL = 'https://jldrc.jl.gov.cn/ztzl/nyzyjg/index.html';
const HOSTNAME = 'jldrc.jl.gov.cn';
const TITLE = /^吉林省成品油最高零售价格表（(\d{4})年(\d{1,2})月(\d{1,2})日24时起执行[）)]$/;

function validDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`吉林油价公告：${label}无效：${value}`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`吉林油价公告：${label}无效：${value}`);
  }
  return value;
}

function nextDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function officialUrl(reference, baseUrl, pathname, label) {
  const url = new URL(reference, baseUrl);
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME || url.username ||
      url.password || url.search || url.hash || !pathname.test(url.pathname)) {
    throw new Error(`吉林油价公告：${label}不是预期的官网地址：${url.href}`);
  }
  return url.href;
}

function currentChinaDate() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function latestEntry(html, today) {
  const body = html.match(/<div class="right_content">([\s\S]*?)<div class="pageszly"/);
  if (!body) throw new Error('吉林油价公告：缺少能源资源价格公告列表');
  const lists = [...body[1].matchAll(/<ul class="newsList">([\s\S]*?)<\/ul>/g)];
  if (!lists.length) throw new Error('吉林油价公告：公告列表为空');
  const entries = [];
  for (const list of lists) {
    for (const item of list[1].matchAll(/<li>\s*<a\b([^>]+)>([^<]*)<\/a>\s*<span class="pubTime">([^<]+)<\/span>\s*<\/li>/g)) {
      const title = /\btitle="([^"]+)"/.exec(item[1])?.[1];
      if (!title?.startsWith('吉林省成品油最高零售价格表')) continue;
      if (item[2].trim() !== title) throw new Error(`吉林油价公告：列表标题不一致：${title}`);
      const match = TITLE.exec(title);
      if (!match) throw new Error(`吉林油价公告：未知的公告标题：${title}`);
      const publishedDate = validDate(item[3].trim(), '列表发布日期');
      const announcedDate = validDate(`${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`, '标题调价日期');
      if (announcedDate > publishedDate) {
        throw new Error(`吉林油价公告：调价日期晚于发布日期：${title}`);
      }
      const reference = /\bhref="([^"]+)"/.exec(item[1])?.[1];
      if (!reference) throw new Error(`吉林油价公告：缺少公告地址：${title}`);
      entries.push({
        title, publishedDate, announcedDate, effectiveDate: nextDate(announcedDate),
        url: officialUrl(reference, LIST_URL,
          /^\/ztzl\/nyzyjg\/\d{6}\/t\d{8}_\d+\.html$/, '公告'),
      });
    }
  }
  if (!entries.length) throw new Error('吉林油价公告：官网列表中未找到成品油公告');
  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i].publishedDate > entries[i - 1].publishedDate) {
      throw new Error('吉林油价公告：列表日期顺序异常');
    }
  }
  const active = entries.filter(entry => entry.publishedDate <= today && entry.effectiveDate <= today)
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
  if (!active.length) throw new Error('吉林油价公告：未找到已生效的官网公告');
  if (active.length > 1 && active[0].effectiveDate === active[1].effectiveDate) {
    throw new Error(`吉林油价公告：同日生效公告不唯一：${active[0].effectiveDate}`);
  }
  return active[0];
}

function parseArticle(html, entry) {
  const metaTitle = /<meta name="ArticleTitle" content="([^"]+)"\s*\/>/.exec(html)?.[1];
  const displayTitle = /<div class="biaoti_title">([^<]+)<\/div>/.exec(html)?.[1];
  if (metaTitle !== entry.title || displayTitle !== entry.title) {
    throw new Error(`吉林油价公告：正文标题与列表不一致：${entry.url}`);
  }
  const metaDate = /<meta name="PubDate" content="(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}"\s*\/>/.exec(html)?.[1];
  const displayDate = /<div class="time4"><span class="ly">发布日期：<\/span>(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}<\/div>/.exec(html)?.[1];
  if (!metaDate || !displayDate || validDate(metaDate, '元数据发布日期') !== entry.publishedDate ||
      validDate(displayDate, '正文发布日期') !== entry.publishedDate) {
    throw new Error(`吉林油价公告：发布日期与列表不一致：${entry.url}`);
  }
  const editor = /<div class="trs_editor_view[^\"]*">\s*<p>\s*([^<]+)\s*<\/p>\s*<\/div>/.exec(html)?.[1];
  if (editor?.trim() !== entry.title) throw new Error(`吉林油价公告：正文生效日期与标题不一致：${entry.url}`);
  const appendix = /var file_appendix='<a href="([^"]+\.pdf)">[^<]+<\/a>'/.exec(html)?.[1];
  const rendered = /<span class="fj-fj">[\s\S]*?<a href="([^"]+\.pdf)">/.exec(html)?.[1];
  if (!appendix || rendered !== appendix) throw new Error(`吉林油价公告：PDF 附件缺失或不一致：${entry.url}`);
  const directory = new URL('.', entry.url).pathname;
  const pdfUrl = officialUrl(appendix, entry.url,
    new RegExp(`^${directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}P\\d+\\.pdf$`), '价格表 PDF');
  return {
    url: entry.url,
    publishedDate: entry.publishedDate,
    effectiveDate: entry.effectiveDate,
    pdfUrl,
    requiresManualLiterReview: true,
  };
}

module.exports = {
  id: 'jilin',
  name: '吉林',
  sourceName: '吉林省发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText, today } = {}) {
    if (typeof getText !== 'function') throw new TypeError('吉林油价公告：getText 必须为函数');
    const currentDay = validDate(today instanceof Date ? today.toISOString().slice(0, 10) : today ?? currentChinaDate(), '今天');
    const entry = latestEntry(await getText(LIST_URL), currentDay);
    return parseArticle(await getText(entry.url), entry);
  },
};
