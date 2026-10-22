'use strict';

function unchangedTitle(title) {
  return /^\d{4}年\d{1,2}月\d{1,2}日国内成品油价格不作调整$/.test(title);
}
function parseUnchanged(html, entry) {
  const [year, month, day] = entry.publishedDate.split('-').map(Number);
  const expected = `${year}年${month}月${day}日国内成品油价格不作调整`;
  const title = html.match(/<meta\s+name=["']ArticleTitle["']\s+content=["']([^"']+)["']/i)?.[1];
  const source = html.match(/<meta\s+name=["']ContentSource["']\s+content=["']([^"']+)["']/i)?.[1];
  const text = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>|\s|&nbsp;/g, '');
  if (entry.title !== expected || title !== expected || source !== '内蒙古自治区发展和改革委员会' ||
      !text.includes(`发布时间：${entry.publishedDate}`) || !text.includes('本次汽、柴油价格不作调整') ||
      /(?:本次|此次)汽、柴油价格(?:上调|下调|调整为)/.test(text)) {
    throw new Error(`内蒙古：不调整公告的标题、日期、来源或结论不符：${entry.url}`);
  }
  return { date: entry.publishedDate, kind: 'unchanged', title: entry.title, sourceUrl: entry.url };
}
module.exports = { unchangedTitle, parseUnchanged };
