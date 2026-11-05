/* =====================================================================
 * 许愿算法 1.0 · 取数小助手
 * ---------------------------------------------------------------------
 * 用途：从官方公开开奖接口拉取最近 N 期真实数据，归一化后写出
 *       许愿算法1.0.data.json，供 许愿算法1.0.html 用「导入数据文件」读取。
 *
 * 为什么要用这个助手：
 *   浏览器里的页面是本地文件，直接联网会被 CORS 拦（官方接口不带
 *   Access-Control-Allow-Origin），且 file:// 页面无法读取同目录文件。
 *   所以「取数」这一步放到 Node 里做，页面保持 100% 离线可用。
 *
 * 数据源：
 *   双色球  cwl.gov.cn 官方开奖公告接口
 *   大乐透  webapi.sporttery.cn 官方历史开奖接口
 *
 * 声明：本工具仅用于随机数生成演示，纯娱乐，不存在任何预测功能。
 * ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

/* 输出位置：默认写到本脚本同目录、名为「许愿算法1.0.data.*」。
   服务器/CI（如 GitHub Actions）里可用环境变量改写：
     XY_OUT_DIR   输出目录（默认 __dirname）
     XY_OUT_BASE  文件名主干（默认 许愿算法1.0.data）
   网页发布版就是靠它把文件写成 data.js / data.json。 */
const OUT_DIR = process.env.XY_OUT_DIR ? path.resolve(process.env.XY_OUT_DIR) : __dirname;
const OUT_BASE = process.env.XY_OUT_BASE || '许愿算法1.0.data';
const OUT_FILE = path.join(OUT_DIR, OUT_BASE + '.json');
const HALF_LIFE_DAYS = 730;          // 热号 2 年衰减（与页面 P3 一致）
const ISSUES = Number(process.env.XY_ISSUES || 200);
const ONLY = (process.env.XY_GAME || '').toLowerCase();   // ssq / dlt / 空=两个都要

/* ---------------- 工具 ---------------- */
function log(s) { process.stdout.write(s + '\n'); }
function pad(n) { return String(n).padStart(2, '0'); }
function sortNum(a, b) { return a - b; }

/** 官方接口取 JSON（带超时与一次重试） */
async function getJson(url, label, tries, headers) {
  const max = tries || 2;
  let lastErr = null;
  for (let i = 1; i <= max; i++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: headers || { 'Accept': 'application/json,*/*' },
        signal: AbortSignal.timeout(30000)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      if (i < max) log('    ' + label + ' 第 ' + i + ' 次失败（' + e.message + '），重试…');
    }
  }
  throw new Error(label + ' 取数失败：' + lastErr.message);
}

/** 体彩接口必须带 Referer，否则 WAF 返回 567（已实测） */
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SPORTTERY_HEADERS = {
  'User-Agent': UA_BROWSER,
  'Referer': 'https://www.sporttery.cn/',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9'
};

/**
 * 计算热号池：按「每号最近出现日期」做 2 年半衰加权
 * w = 0.5 ^ (距今天数 / 730)
 */
function computeHot(draws, refDate, pick, maxN) {
  const w = {}, last = {}, cnt = {};
  const refT = new Date(refDate + 'T00:00:00').getTime();
  for (const d of draws) {
    const ageDays = Math.max(0, (refT - new Date(d.date + 'T00:00:00').getTime()) / 86400000);
    const decay = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    for (const x of d.red) {
      w[x] = (w[x] || 0) + decay;
      cnt[x] = (cnt[x] || 0) + 1;
      if (!last[x] || d.date > last[x]) last[x] = d.date;
    }
  }
  return Object.keys(w).map(function (k) {
    const n = Number(k);
    return { n: n, weighted: Number(w[k].toFixed(3)), count: cnt[k], last: last[k] };
  }).sort(function (a, b) { return b.weighted - a.weighted; }).slice(0, maxN || 12);
}

/* ---------------- 双色球 ---------------- */
async function fetchSSQ() {
  const url = 'https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice?name=ssq&issueCount=' + ISSUES;
  log('  请求福彩官方接口…');
  const json = await getJson(url, '双色球');
  if (!json || !Array.isArray(json.result)) throw new Error('双色球返回结构异常（可能被拦截）');
  const draws = [];
  for (const r of json.result) {
    const red = String(r.red || '').split(',').map(Number).filter(function (x) { return x > 0; }).sort(sortNum);
    const blue = String(r.blue || '').split(',').map(Number).filter(function (x) { return x > 0; }).sort(sortNum);
    const date = String(r.date || '').slice(0, 10);
    if (red.length !== 6 || red.some(function (x) { return x < 1 || x > 33; })) continue;
    if (blue.length !== 1 || blue[0] < 1 || blue[0] > 16) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    draws.push({
      period: String(r.code || ''), date: date, red: red, blue: blue,
      pool: Number(r.poolmoney) || 0,
      sales: Number(r.sales) || 0,
      winners: String(r.content || '').replace(/\s+/g, '')
    });
  }
  if (draws.length < 30) throw new Error('双色球有效期数不足（' + draws.length + ' 期）');
  draws.sort(function (a, b) { return b.period.localeCompare(a.period); });
  const latest = draws[0];
  return {
    game: 'ssq',
    name: '双色球',
    source: 'cwl.gov.cn 福彩官方开奖公告接口',
    count: draws.length,
    latest: latest,
    poolYi: Number((latest.pool / 1e8).toFixed(2)),
    winners: latest.winners,
    hotRed: computeHot(draws, latest.date, 6, 12),
    draws: draws
  };
}

/* ---------------- 大乐透 ---------------- */
/**
 * 体彩接口单页上限 100 期，所以按页抓取直到凑够 ISSUES 期。
 * 注意：该接口必须带 Referer，否则 WAF 返回 567（已实测）；页间留间隔以免被限流。
 */
async function fetchDLT() {
  const PER_PAGE = 100;
  const pages = Math.max(1, Math.ceil(ISSUES / PER_PAGE));
  log('  请求体彩官方接口…' + (pages > 1 ? '（单页上限 ' + PER_PAGE + ' 期，需翻 ' + pages + ' 页）' : ''));

  const raw = [];
  for (let page = 1; page <= pages; page++) {
    const url = 'https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry' +
      '?gameNo=85&provinceId=0&pageSize=' + PER_PAGE + '&isVerify=1&pageNo=' + page;
    const json = await getJson(url, '大乐透 第 ' + page + ' 页', 3, SPORTTERY_HEADERS);
    const list = json && json.value && Array.isArray(json.value.list) ? json.value.list : null;
    if (!list || list.length === 0) {
      if (page === 1) throw new Error('大乐透返回结构异常（可能被拦截）');
      log('    第 ' + page + ' 页为空，停止翻页');
      break;
    }
    raw.push.apply(raw, list);
    if (pages > 1) log('    第 ' + page + '/' + pages + ' 页 ✓ 累计 ' + raw.length + ' 条');
    if (list.length < PER_PAGE) break;              // 已到最后一页
    if (page < pages) await new Promise(function (r) { setTimeout(r, 1200); });
  }

  const draws = [];
  const seen = {};
  for (const r of raw) {
    const nums = String(r.lotteryDrawResult || '').trim().split(/\s+/).map(Number).filter(function (x) { return x > 0; });
    if (nums.length < 7) continue;
    const red = nums.slice(0, 5).sort(sortNum);
    const blue = nums.slice(5, 7).sort(sortNum);
    const date = String(r.lotteryDrawTime || '').slice(0, 10);
    if (red.some(function (x) { return x < 1 || x > 35; })) continue;
    if (blue.some(function (x) { return x < 1 || x > 12; })) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const period = String(r.lotteryDrawNum || '');
    if (!period || seen[period]) continue;          // 翻页可能重叠，去重
    seen[period] = 1;
    const pool = Number(String(r.poolBalanceAfterdraw || '0').replace(/,/g, '')) || 0;
    // 一等奖中出地：接口未直接给出，用一等奖注数概括
    let firstPrize = 0;
    (r.prizeLevelList || []).forEach(function (p) {
      if (p.prizeLevel === '一等奖') firstPrize = Number(p.stakeCount) || 0;
    });
    draws.push({
      period: period, date: date, red: red, blue: blue,
      pool: pool,
      sales: Number(r.totalSaleAmount) || 0,
      winners: firstPrize > 0 ? ('一等奖 ' + firstPrize + ' 注') : ''
    });
  }
  if (draws.length < 30) throw new Error('大乐透有效期数不足（' + draws.length + ' 期）');
  draws.sort(function (a, b) { return b.period.localeCompare(a.period); });
  draws.length = Math.min(draws.length, ISSUES);     // 截到目标期数
  const latest = draws[0];
  return {
    game: 'dlt',
    name: '大乐透',
    source: 'webapi.sporttery.cn 体彩官方历史开奖接口（分页抓取，单页上限 ' + PER_PAGE + ' 期）',
    count: draws.length,
    latest: latest,
    poolYi: Number((latest.pool / 1e8).toFixed(2)),
    winners: latest.winners,
    hotRed: computeHot(draws, latest.date, 5, 12),
    draws: draws
  };
}

/* ---------------- 主流程 ---------------- */
(async function main() {
  log('==================================================');
  log(' 许愿算法 1.0 · 取数小助手');
  log(' 仅用于随机数生成演示，纯娱乐，不存在任何预测功能');
  log('==================================================');
  log('目标期数：' + ISSUES + '　输出：' + path.basename(OUT_FILE));
  log('');

  const bundle = { generatedAt: new Date().toISOString(), halfLifeDays: HALF_LIFE_DAYS, games: {} };
  const failures = [];

  const wantSSQ = !ONLY || ONLY === 'ssq';
  const wantDLT = !ONLY || ONLY === 'dlt';

  if (wantSSQ) {
    log('[1/2] 双色球');
    try {
      const d = await fetchSSQ();
      bundle.games.ssq = d;
      log('  ✓ ' + d.count + ' 期（' + d.draws[d.draws.length - 1].period + ' ~ ' + d.latest.period + '）');
      log('    最新：' + d.latest.period + '  ' + d.latest.red.map(pad).join(' ') + ' + ' + d.latest.blue.map(pad).join(' ') +
        '  (' + d.latest.date + ')');
      log('    奖池：' + d.poolYi + ' 亿　中出：' + (d.winners || '—'));
      log('    热号TOP6：' + d.hotRed.slice(0, 6).map(function (h) { return pad(h.n) + '(' + h.weighted.toFixed(1) + ')'; }).join(' '));
    } catch (e) {
      failures.push('双色球：' + e.message);
      log('  ✗ ' + e.message);
    }
    log('');
  }

  if (wantDLT) {
    log('[2/2] 大乐透');
    try {
      const d = await fetchDLT();
      bundle.games.dlt = d;
      log('  ✓ ' + d.count + ' 期（' + d.draws[d.draws.length - 1].period + ' ~ ' + d.latest.period + '）');
      log('    最新：' + d.latest.period + '  ' + d.latest.red.map(pad).join(' ') + ' + ' + d.latest.blue.map(pad).join(' ') +
        '  (' + d.latest.date + ')');
      log('    奖池：' + d.poolYi + ' 亿　' + (d.winners || ''));
      log('    热号TOP6：' + d.hotRed.slice(0, 6).map(function (h) { return pad(h.n) + '(' + h.weighted.toFixed(1) + ')'; }).join(' '));
    } catch (e) {
      failures.push('大乐透：' + e.message);
      log('  ✗ ' + e.message);
    }
    log('');
  }

  const got = Object.keys(bundle.games);
  if (got.length === 0) {
    log('--------------------------------------------------');
    log('两个彩种都没取到数据。可能原因：');
    log('  1) 当前网络无法访问 cwl.gov.cn / webapi.sporttery.cn');
    log('  2) 接口临时变动或被限流（可稍后重试）');
    log('  3) 需要代理：设置环境变量后重试，例如');
    log('     set HTTPS_PROXY=http://127.0.0.1:7890');
    log('');
    log('也可以直接在页面里手工粘贴开奖号码，功能不受影响。');
    log('--------------------------------------------------');
    log(failures.join('\n'));
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(bundle, null, 2), 'utf8');
  const kb = (fs.statSync(OUT_FILE).size / 1024).toFixed(1);

  // 同时输出一份「可直接被网页加载」的 JS 版本：
  // 网页里用 <script src> 引入它，打开页面就自动带上最新数据，不用手动导入。
  // 这样"定期更新"只需双击一次取数小助手，然后刷新网页。
  const JS_FILE = path.join(OUT_DIR, OUT_BASE + '.js');
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
  fs.writeFileSync(JS_FILE,
    '/* 由「取数小助手」自动生成，请勿手工编辑。生成时间：' + stamp + ' */\n' +
    '/* 网页通过 <script src> 自动加载本文件；缺失时网页仍可手工导入 .json */\n' +
    'window.__XY_BUNDLE__ = ' + JSON.stringify(bundle) + ';\n', 'utf8');
  const jsKb = (fs.statSync(JS_FILE).size / 1024).toFixed(1);

  log('--------------------------------------------------');
  log('✓ 已写出 ' + path.basename(OUT_FILE) + '（' + kb + ' KB，含 ' + got.join(' + ') + '）');
  log('✓ 已写出 ' + path.basename(JS_FILE) + '（' + jsKb + ' KB，网页自动加载用）');
  log('');
  log('下一步：直接刷新（或打开）许愿算法1.0.html —— 数据会自动载入，无需手动导入');
  log('（若网页没自动带上，再用「导入数据文件」选择 .json）');
  if (failures.length) {
    log('');
    log('未取到的彩种：' + failures.join('；'));
  }
  log('--------------------------------------------------');
})().catch(function (e) {
  log('意外错误：' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
