#!/usr/bin/env node
'use strict';
/**
 * 一次性维护脚本：修正「用错标的复盘」写坏的预测结论
 *
 * 背景：PredictionTracker.evaluate 原先不核对标的与周期，把「当前显示那个币」的
 * K线套用到了所有到期记录上。结果是 ETH 的记录被拿 BTC 的收盘价复盘（反之亦然），
 * 而 correct 一旦写入就永久生效 —— 光把代码修好，这批旧结论不会自己变对。
 *
 * 本脚本按与浏览器端**完全相同**的口径重算。做法不是重写一遍判定逻辑，而是把
 * PredictionTracker 的存储层挂到内存里的记录数组上，然后直接调用它自己的
 * evaluate / verifyResolved：
 *
 *     PT.load = () => 这一组记录;
 *     PT.save = () => {};           // 落盘由脚本统一负责
 *     PT.evaluate(candles, coinId, timeframe);
 *     PT.verifyResolved(candles, coinId, timeframe);
 *
 * 这样就不存在「脚本与线上两套口径」的问题 —— 判定阈值、复盘窗口、取价方式
 * 全部取自 js/prediction.js 这个真实模块。
 *
 * 为什么需要脚本而不是只靠浏览器：浏览器端本地只保留最近 150 条（maxRecords），
 * 窗口之外的老记录推不回后端，那部分错误结论只能从后端这一侧修。
 *
 * 用法：
 *   node server/repair-prediction-review.js                     # 只报告，不写盘
 *   node server/repair-prediction-review.js --apply             # 写回 store 与 CSV
 *   node server/repair-prediction-review.js --user=hellolipop --apply
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APPLY = process.argv.includes('--apply');
const STORE_ARG = (process.argv.find(a => a.startsWith('--store=')) || '').split('=')[1];
const USER_ARG = (process.argv.find(a => a.startsWith('--user=')) || '').split('=')[1];

const ROOT = path.join(__dirname, '..');
const STORE_FILE = STORE_ARG || path.join(__dirname, 'data', 'paper-state.json');
const CSV_FILE = path.join(path.dirname(STORE_FILE), 'predictions.csv');

// ---------------- 周期映射：从 app.js 现读，不抄一份 ----------------

function loadTimeframeMap() {
    const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
    const block = src.match(/timeframeConfig:\s*\{([\s\S]*?)\n\s*\},/);
    if (!block) throw new Error('没能从 js/app.js 里解析出 timeframeConfig');
    const map = new Map();
    const re = /'([\d.]+)':\s*\{\s*interval:\s*'([^']+)',\s*seconds:\s*(\d+)/g;
    let m;
    while ((m = re.exec(block[1])) !== null) {
        map.set(m[1], { interval: m[2], seconds: parseInt(m[3], 10) });
    }
    if (!map.size) throw new Error('timeframeConfig 解析结果为空');
    // app.js 的 getTimeframeConfig 认不出时回落到 '24'
    return { map, fallback: map.get('24') };
}

// ---------------- 复盘模块：加载真货 ----------------

function loadTracker() {
    const src = fs.readFileSync(path.join(ROOT, 'js', 'prediction.js'), 'utf8');
    const sandbox = {
        console, Date, Math, JSON, Set, Map, Array, Object, String, Number,
        Boolean, Error, isFinite, isNaN, parseFloat, parseInt,
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        setTimeout, clearTimeout,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src + '\n;globalThis.__PT = PredictionTracker;', sandbox, { filename: 'prediction.js' });
    return sandbox.__PT;
}

// ---------------- 取K线 ----------------

const { execFileSync } = require('child_process');

const SPOT = 'https://data-api.binance.vision/api/v3/klines';
const FUTURES = 'https://fapi.binance.com/fapi/v1/klines';

/**
 * 取K线。
 *
 * 这里用 curl 而不是 Node 的 fetch，原因是本机上 Node 的 TLS 栈建不出这条链的
 * 信任路径（报 UNABLE_TO_GET_ISSUER_CERT，而 curl 与浏览器都正常；把整条链塞进
 * NODE_EXTRA_CA_CERTS 也无效）。
 *
 * 不用 NODE_TLS_REJECT_UNAUTHORIZED=0 绕过：这个脚本存在的意义就是修正被污染的
 * 数据，若在取数环节关掉校验，等于放任行情可能被篡改 —— 那正是要防的事。
 * curl 走的是与系统一致的信任库，仍在校验。
 */
function curlJson(url, timeoutSec) {
    try {
        const out = execFileSync('curl',
            ['-sS', '--fail', '--max-time', String(timeoutSec), url],
            // stderr 必须自己收着：默认会直接漏到终端，而「现货 400 → 改试合约」
            // 是正常流程，不该在输出里刷一堆红字吓人
            { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        return { data: JSON.parse(out), error: '' };
    } catch (e) {
        const stderr = String(e.stderr || '').trim().split('\n').filter(Boolean).pop();
        return { data: null, error: stderr || e.message };
    }
}

/**
 * 先试现货、失败再试合约。
 * 加密货币走现货（与界面一致）；美股标的不在现货市场，只在合约里 —— 这样
 * 不必在脚本里再维护一份「哪些是股票」的名单。
 */
function fetchKlines(symbol, interval, limit) {
    let lastError = '';
    for (const base of [SPOT, FUTURES]) {
        const { data, error } = curlJson(`${base}?symbol=${symbol}&interval=${interval}&limit=${limit}`, 15);
        if (error) { lastError = error; continue; }
        if (!Array.isArray(data) || !data.length) { lastError = '返回为空'; continue; }
        return {
            candles: data.map(it => ({
                time: Math.floor(it[0] / 1000),
                open: parseFloat(it[1]), high: parseFloat(it[2]),
                low: parseFloat(it[3]), close: parseFloat(it[4]),
                volume: parseFloat(it[5]),
            })),
            error: '',
        };
    }
    return { candles: null, error: lastError || '取不到' };
}

function symbolOf(rec) {
    const s = String(rec.coinSymbol || rec.coinId || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return s ? s + 'USDT' : null;
}

// ---------------- 统计 ----------------

/** 用「复盘价是否属于该记录自己的标的」判定历史结论是否明显写坏 */
function looksCorrupt(rec) {
    if (rec.correct === null || !rec.evalPrice) return false;
    if (Math.abs(rec.changePct || 0) > 0.5) return true;
    const coinId = rec.coinId;
    if (coinId === 'bitcoin') return rec.evalPrice < 10000;
    return rec.evalPrice > 10000;
}

/**
 * 入场价是否也串了标的。
 *
 * 这是比「复盘价串标的」更早的一类污染，与复盘无关：记录时 coinInfo 还没更新到
 * 新选的币，于是把上一个币的价格当成了入场价（后来在 trackPrediction 里加了 id
 * 比对才堵住）。判据是价格量级：BTC 在八万量级，本数据集里其余标的都在万元以下。
 */
function entryPriceMismatch(rec) {
    if (!rec.price) return false;
    return rec.coinId === 'bitcoin' ? rec.price < 10000 : rec.price > 10000;
}

/**
 * 取「预测那一刻」的价格：最后一根 time <= predictedAt 的K线收盘价。
 *
 * 不能直接用 findCloseAt —— 那个是取「第一个 time >= 目标」的收盘价，用于复盘
 * 是对的，用来当入场价会晚一整根。
 */
function closeAtOrBefore(candles, ms) {
    const t = Math.floor(ms / 1000);
    let best = null;
    for (const c of candles) {
        if (c.time <= t) best = c; else break;
    }
    return best ? best.close : null;
}

function statsOf(recs) {
    const resolved = recs.filter(r => r.correct !== null);
    const ok = resolved.filter(r => !looksCorrupt(r)).length;
    return {
        total: recs.length,
        resolved: resolved.length,
        pending: recs.length - resolved.length,
        corrupt: resolved.filter(looksCorrupt).length,
        accuracy: resolved.length ? (resolved.filter(r => r.correct).length / resolved.length * 100) : null,
        cleanAccuracy: ok ? (resolved.filter(r => !looksCorrupt(r) && r.correct).length / ok * 100) : null,
    };
}

// ---------------- 主流程 ----------------

async function main() {
    if (!fs.existsSync(STORE_FILE)) {
        console.error('找不到存储文件：' + STORE_FILE);
        process.exit(1);
    }

    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const store = JSON.parse(raw);
    const { map: tfMap, fallback: tfFallback } = loadTimeframeMap();
    const PT = loadTracker();

    console.log('存储文件 ' + STORE_FILE);
    console.log('模式     ' + (APPLY ? '写入（--apply）' : '只报告（加 --apply 才写盘）'));
    console.log('周期映射 ' + Array.from(tfMap.entries()).map(([k, v]) => `${k}h→${v.interval}`).join('  '));

    const totals = { resolved: 0, fixed: 0, priceFixed: 0, unreachable: 0, groups: 0, groupsFailed: 0 };
    const changedUsers = [];

    for (const username of Object.keys(store.predictions || {})) {
        if (USER_ARG && username !== USER_ARG) continue;

        const all = store.predictions[username] || [];
        if (!all.length) continue;

        console.log('\n' + '='.repeat(80));
        console.log(`用户 ${username}：${all.length} 条记录`);
        const before = statsOf(all);
        console.log(`  修正前：已复盘 ${before.resolved}，其中带污染特征 ${before.corrupt} 条，`
            + `表面准确率 ${before.accuracy === null ? '—' : before.accuracy.toFixed(1) + '%'}`);

        // 让模块直接在内存数组上工作
        PT.load = () => all;
        PT.save = () => { };

        const groups = PT.getReviewGroups();
        console.log(`  需要复核 ${groups.length} 组（币种+周期）`);

        const rows = [];
        for (const g of groups) {
            totals.groups++;
            const tf = tfMap.get(String(g.timeframe)) || tfFallback;
            const recs = all.filter(r => r.coinId === g.coinId && r.timeframe === g.timeframe);
            const symbol = symbolOf(recs[0]);

            // 根数要覆盖到该组最老的复盘时点，否则老记录永远结不了。
            // 上限 1000 是币安单次请求的上限。
            const spanBars = Math.ceil((Date.now() - g.oldestResolveAt) / (tf.seconds * 1000)) + 10;
            const limit = Math.min(1000, Math.max(200, spanBars));

            const { candles, error } = symbol
                ? fetchKlines(symbol, tf.interval, limit)
                : { candles: null, error: '记录里没有可用的币种符号' };
            if (!candles) {
                totals.groupsFailed++;
                rows.push({
                    group: `${g.coinId}/${g.timeframe}h`, symbol: symbol || '—', bars: 0,
                    newly: 0, fixed: 0, unreachable: recs.length, note: error,
                });
                continue;
            }

            // 先修「入场价串了标的」那一类（与复盘无关，是更早的缺陷）。
            // 只在预测时点与复盘时点都被这份K线覆盖时才动：否则改了价却算不出结论，
            // 等于把一条本来有结论的记录变成悬空记录，那比不改更糟。
            let priceFixed = 0;
            recs.forEach(r => {
                if (!entryPriceMismatch(r)) return;
                if (PT.findCloseAt(candles, r.resolveAt) === null) return;
                const entry = closeAtOrBefore(candles, r.predictedAt);
                if (entry === null) return;

                r.prevPrice = r.price;
                r.price = entry;
                r.priceFixedAt = Date.now();
                // 清空结论，交给下面的 evaluate 用正确入场价重算 —— 不在这里自己算，
                // 免得又出现「两套口径」。prev* 留作审计。
                r.prevEvalPrice = r.evalPrice;
                r.prevCorrect = r.correct;
                r.evalPrice = null;
                r.changePct = null;
                r.correct = null;
                priceFixed++;
            });
            totals.priceFixed += priceFixed;

            PT.load = () => recs;
            // evaluate 返回的是「有没有发生复盘」，拿不到条数；直接数前后差值更直观
            const resolvedBefore = recs.filter(r => r.correct !== null).length;
            PT.evaluate(candles, g.coinId, g.timeframe);
            const fixed = PT.verifyResolved(candles, g.coinId, g.timeframe);
            const newly = recs.filter(r => r.correct !== null).length - resolvedBefore;
            PT.load = () => all;

            // 区分「还没到期」（正常，等着就行）与「K线覆盖不到」（真核不了，
            // 只能原样留着）。把两者混在一起会让人以为有一大批修不了。
            let notDue = 0;
            let unreachable = 0;
            recs.forEach(r => {
                if (r.correct === null && Date.now() < r.resolveAt) { notDue++; return; }
                if (PT.findCloseAt(candles, r.resolveAt) === null) unreachable++;
            });

            totals.resolved += newly;
            totals.fixed += fixed;
            totals.unreachable += unreachable;
            rows.push({ group: `${g.coinId}/${g.timeframe}h`, symbol, bars: candles.length, newly, fixed, priceFixed, unreachable, notDue, note: '' });
        }

        rows.forEach(r => {
            console.log(`    ${r.group.padEnd(20)} ${String(r.symbol).padEnd(12)} ${String(r.bars).padStart(4)}根  `
                + `新复盘 ${String(r.newly).padStart(3)} 条  修正结论 ${String(r.fixed).padStart(3)} 条  `
                + `修入场价 ${String(r.priceFixed).padStart(2)} 条  `
                + `未到期 ${String(r.notDue).padStart(3)}  覆盖不到 ${String(r.unreachable).padStart(3)}${r.note ? '  ' + r.note : ''}`);
        });

        const after = statsOf(all);
        console.log(`  修正后：已复盘 ${after.resolved}，其中带污染特征 ${after.corrupt} 条，`
            + `准确率 ${after.accuracy === null ? '—' : after.accuracy.toFixed(1) + '%'}`);

        // 修完还剩哪些看着不对的。留着它们不修（或修不动）都要有明确的理由，
        // 不能糊过去 —— 这批数字是要拿去做因子分析的。
        const leftover = all.filter(looksCorrupt);
        if (leftover.length) {
            console.log(`  仍未消除污染特征的 ${leftover.length} 条：`);
            leftover.slice(0, 12).forEach(r => {
                console.log(`    ${r.id}`.padEnd(34)
                    + `${r.coinId}/${r.timeframe}h`.padEnd(16)
                    + `入场 ${String(r.price).padEnd(12)} 复盘价 ${String(r.evalPrice).padEnd(12)} `
                    + `${((r.changePct || 0) * 100).toFixed(1)}%`);
            });
        }

        if (before.corrupt !== after.corrupt) changedUsers.push(username);
    }

    console.log('\n' + '='.repeat(80));
    console.log(`合计：${totals.groups} 组，其中失败 ${totals.groupsFailed} 组`);
    console.log(`      补上未复盘的 ${totals.resolved} 条；修正已复盘的 ${totals.fixed} 条；`
        + `修正入场价 ${totals.priceFixed} 条；`
        + `K线覆盖不到的 ${totals.unreachable} 条（原样保留，未破坏）`);

    if (!APPLY) {
        console.log('\n以上为试算结果，未写入任何文件。确认无误后加 --apply 执行。');
        return;
    }

    // ---- 落盘：先备份，再原子替换 ----
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${STORE_FILE}.pre-repair-${stamp}`;
    fs.copyFileSync(STORE_FILE, backup);

    const body = JSON.stringify(store, null, 2);
    const tmp = STORE_FILE + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
        fs.writeFileSync(fd, body);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, STORE_FILE);

    // 表格同步重写，否则 CSV 里还是旧结论
    const { writePredictionsCsv } = require('./predictions-csv');
    const rowCount = writePredictionsCsv(store, CSV_FILE);

    console.log(`\n已写入 ${STORE_FILE}`);
    console.log(`已备份 ${backup}`);
    console.log(`已重写 ${CSV_FILE}（${rowCount} 行）`);
    console.log('\n注意：浏览器本地还存着一份（最近 150 条），它的值也是错的。');
    console.log('      下次打开页面时，应用自己的核对逻辑会就地把本地的改对并推回后端；');
    console.log('      在此之前不要依赖本机界面上的准确率数字。');
}

main().catch(e => {
    console.error('执行失败：' + e.message);
    process.exit(1);
});
