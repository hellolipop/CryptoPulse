'use strict';
/**
 * 因子回归测试框架
 *
 * 目标：检验「具备提前性」的候选因子，是否真的能在信号发出后赚钱，
 *       而不是只在事后把已经发生的涨跌标出来。
 *
 * 三条硬性纪律（避免自欺欺人）：
 *   1. 无未来函数：第 i 根K线的因子只用 [0, i] 的数据，滚动窗口统计量不得用全样本。
 *   2. 与控制组对比：任何命中率都必须对照「无条件基准命中率」，否则 50% 毫无意义。
 *   3. 成本后算账：同时报毛收益与扣费后收益，手续费按双边计。
 *
 * 提前性定义（带符号，这是本框架的核心）：
 *   对第 i 根K线的买入信号，在 [i-H, i+H] 窗口内找最低点位置 extIdx。
 *   lead = extIdx - i
 *     lead > 0  → 信号早于最低点，属于「提前」（好事）
 *     lead < 0  → 信号晚于最低点，属于「滞后」（坏事，说明在追已发生的行情）
 *   卖出信号对称地用最高点。滞后统计沿用本项目既有口径，便于与历史数据对齐。
 */

const fs = require('fs');
const path = require('path');

// 应用源码目录（默认取上一级，即仓库根）
const APP_DIR = process.env.APP_DIR || path.join(__dirname, '..');
// 历史数据目录，由 fetch-data.sh 生成
const DATA_DIR = process.env.BT_DATA || path.join(__dirname, 'data');

// 复用应用真实的技术指标实现，避免回测与线上逻辑脱节
function loadModule(file, exportName) {
    const src = fs.readFileSync(path.join(APP_DIR, file), 'utf8');
    return new Function(src + '\n;return ' + exportName + ';')();
}
const TA = loadModule('js/technical.js', 'TechnicalAnalysis');

// ==================== 基础工具 ====================

const readLines = f => fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim());
const isNumeric = s => /^-?\d/.test(s);
const filesWithPrefix = (dir, prefix) =>
    fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.csv')).sort();

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const median = a => {
    if (!a.length) return NaN;
    const s = a.slice().sort((x, y) => x - y);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const stdev = a => {
    if (a.length < 2) return NaN;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
};
const quantile = (sorted, q) => {
    if (!sorted.length) return NaN;
    const pos = (sorted.length - 1) * q;
    const b = Math.floor(pos);
    const rest = pos - b;
    return sorted[b + 1] !== undefined ? sorted[b] + rest * (sorted[b + 1] - sorted[b]) : sorted[b];
};

// 时间戳统一到秒：不同归档文件的精度不一致（微秒/毫秒）
function toSec(raw) {
    const v = Number(raw);
    if (!isFinite(v)) return NaN;
    if (v > 1e14) return Math.floor(v / 1e6);
    if (v > 1e11) return Math.floor(v / 1e3);
    return Math.floor(v);
}

function dedupeByTime(arr) {
    const seen = new Set();
    return arr.filter(x => {
        if (seen.has(x.t)) return false;
        seen.add(x.t);
        return true;
    });
}

// ==================== 数据读取 ====================

function loadKlines(sym, tf) {
    const out = [];
    for (const f of filesWithPrefix(DATA_DIR, `${sym}-${tf}-`)) {
        for (const line of readLines(path.join(DATA_DIR, f))) {
            const p = line.split(',');
            if (p.length < 6 || !isNumeric(p[0])) continue;
            out.push({
                t: toSec(p[0]),
                o: +p[1], h: +p[2], l: +p[3], c: +p[4], v: +p[5],
                takerBuyV: p[10] !== undefined ? +p[10] : NaN,
            });
        }
    }
    out.sort((a, b) => a.t - b.t);
    return dedupeByTime(out);
}

function loadFunding(sym) {
    const out = [];
    for (const f of filesWithPrefix(DATA_DIR, `${sym}-fund-`)) {
        for (const line of readLines(path.join(DATA_DIR, f))) {
            const p = line.split(',');
            if (p.length < 3 || !isNumeric(p[0])) continue;
            // 新格式: calc_time, funding_interval_hours, last_funding_rate
            out.push({ t: toSec(p[0]), rate: +p[2] });
        }
    }
    out.sort((a, b) => a.t - b.t);
    return dedupeByTime(out);
}

function loadPremium(sym) {
    const out = [];
    for (const f of filesWithPrefix(DATA_DIR, `${sym}-prem-`)) {
        for (const line of readLines(path.join(DATA_DIR, f))) {
            const p = line.split(',');
            if (p.length < 6 || !isNumeric(p[0])) continue;
            out.push({ t: toSec(p[0]), c: +p[4] });
        }
    }
    out.sort((a, b) => a.t - b.t);
    return dedupeByTime(out);
}

// 衍生品指标（持仓量/多空比/主动买卖比），日度归档、5 分钟粒度
function loadMetrics(sym) {
    const out = [];
    for (const f of filesWithPrefix(DATA_DIR, `${sym}-met-`)) {
        for (const line of readLines(path.join(DATA_DIR, f))) {
            const p = line.split(',');
            if (!/^\d{4}-\d{2}-\d{2}/.test(p[0])) continue;
            const t = Math.floor(Date.parse(p[0].replace(' ', 'T') + 'Z') / 1000);
            if (!isFinite(t)) continue;
            out.push({
                t,
                oiValue: +p[3],
                topLs: +p[4],
                acctLs: +p[6],
                takerLs: +p[7],
            });
        }
    }
    out.sort((a, b) => a.t - b.t);
    return dedupeByTime(out);
}

// ==================== 对齐 ====================

/** 把低频序列（如 8 小时结算的资金费率）对齐到K线：取 t <= 该K线开盘时间 的最后一个值 */
function alignAsOf(series, candles) {
    const res = new Array(candles.length).fill(NaN);
    let j = 0;
    for (let i = 0; i < candles.length; i++) {
        while (j + 1 < series.length && series[j + 1].t <= candles[i].t) j++;
        if (series[j] && series[j].t <= candles[i].t) res[i] = series[j];
    }
    return res;
}

/**
 * 把多个标的的同一口径结果合并成一组。
 *
 * 三条都不能省，否则合并值会是错的：
 *   1. 命中率与扣费收益按**样本数加权**，不是两个比例取平均 ——
 *      两个标的样本数不同时（例如 BTC 日线 159 条、ETH 156 条），
 *      直接平均会给出错误的整体命中率。
 *   2. 中位滞后必须由**两边的原始 lead 序列重新求中位数** ——
 *      中位数不是可加统计量，把两个中位数平均没有统计含义。
 *   3. 零假设同样加权，否则 edge（超额）会连锁出错。
 */
function poolByHorizon(ds) {
    const n = ds.reduce((s, d) => s + d.n, 0);
    const hits = ds.reduce((s, d) => s + d.hits, 0);
    const netSum = ds.reduce((s, d) => s + d.netSum, 0);
    const useful = ds.reduce((s, d) => s + d.useful, 0);
    const nullSum = ds.reduce((s, d) => s + d.n * d.nullRate, 0);
    const leads = [].concat.apply([], ds.map(d => d.leads || []));
    const hitRate = n ? hits / n : NaN;
    const nullRate = n ? nullSum / n : NaN;
    return {
        n,
        hitRate,
        nullRate,
        edge: hitRate - nullRate,
        avgNet: n ? netSum / n : NaN,
        medianLead: median(leads),
        usefulShare: n ? useful / n : NaN,
    };
}

/** 高频序列对齐到K线：取最后一根落在该K线区间内的样本 */
function alignLastIn(candles, series, tfSec) {
    const res = new Array(candles.length).fill(null);
    let j = 0;
    for (let i = 0; i < candles.length; i++) {
        const end = candles[i].t + tfSec;
        let last = null;
        while (j < series.length && series[j].t < end) {
            if (series[j].t >= candles[i].t) last = series[j];
            j++;
        }
        if (last) res[i] = last;
    }
    return res;
}

// ==================== 评估 ====================

/**
 * 计算因子表现
 * @param {Array} candles
 * @param {Array} signals - [{ i, side }] side: 'buy'|'sell'
 * @param {Object} opt - { horizons:[...], costBp, delay }
 */
function evaluate(candles, signals, opt) {
    const H = opt.horizons || [6, 24];
    const cost = (opt.costBp || 10) / 10000;
    const delay = opt.delay || 0; // 延迟成交的K线数，用于稳健性检验
    const iMin = opt.iMin !== undefined ? opt.iMin : 0;
    const iMax = opt.iMax !== undefined ? opt.iMax : candles.length - 1;
    const inRange = s => s.i >= iMin && s.i <= iMax;
    const sig = signals.filter(inRange);
    const res = { n: sig.length, byHorizon: {} };

    // 无条件基准：全样本随机进场的方向命中率
    // 注意：不能直接拿「上涨频率」当基准。买卖信号混合时，
    // 瞎猜方向的期望命中率 = w_buy * P(涨) + w_sell * P(跌)，
    // 用 P(涨) 当基准会系统性低估多空均衡的信号。
    const pUp = {};
    for (const h of H) {
        let up = 0, tot = 0;
        for (let i = iMin; i + h <= iMax; i++) {
            tot++;
            if (candles[i + h].c > candles[i].c) up++;
        }
        pUp[h] = tot ? up / tot : NaN;
    }
    const nBuy = sig.filter(s => s.side === 'buy').length;
    const nSell = sig.length - nBuy;

    for (const h of H) {
        let hit = 0, tot = 0, grossSum = 0, netSum = 0;
        let useful = 0;
        const leads = [], positions = [];
        for (const s of sig) {
            const e = s.i + delay;
            if (e + h >= candles.length) continue;
            const entry = candles[e].c;
            const exit = candles[e + h].c;
            if (!entry || !exit) continue;
            const fwd = exit / entry - 1;
            const dir = s.side === 'buy' ? 1 : -1;
            tot++;
            const ok = dir * fwd > 0;
            if (ok) hit++;
            grossSum += dir * fwd;
            netSum += dir * fwd - cost * 2;

            // 提前性：在 [i-H, i+H] 内找该方向的目标极值
            const w = h;
            const lo = Math.max(0, s.i - w), hi = Math.min(candles.length - 1, s.i + w);
            let extIdx = s.i, extVal = s.side === 'buy' ? Infinity : -Infinity;
            for (let k = lo; k <= hi; k++) {
                const v = s.side === 'buy' ? candles[k].l : candles[k].h;
                if (s.side === 'buy' ? v < extVal : v > extVal) { extVal = v; extIdx = k; }
            }
            const lead = extIdx - s.i;
            leads.push(lead);
            // 有效提前：既早于极值、方向又做对了，才算真的抓到
            if (lead >= 0 && ok) useful++;
            const range = candles[hi].h - candles[lo].l;
            positions.push(range > 0 ? (candles[s.i].c - candles[lo].l) / range : NaN);
        }
        const nullRate = tot ? (nBuy * pUp[h] + nSell * (1 - pUp[h])) / sig.length : NaN;
        res.byHorizon[h] = {
            n: tot,
            // 原始量一并返回：合并多个标的时，比例与中位数都不能直接平均
            // （中位数不是可加统计量），必须用这些原始量重算，见 poolByHorizon
            hits: hit,
            netSum,
            useful,
            leads,
            hitRate: tot ? hit / tot : NaN,
            baseRate: pUp[h],
            nullRate,
            edge: tot ? hit / tot - nullRate : NaN,
            avgGross: tot ? grossSum / tot : NaN,
            avgNet: tot ? netSum / tot : NaN,
            medianLead: median(leads),
            avgLead: leads.length ? mean(leads) : NaN,
            leadShare: leads.length ? leads.filter(x => x > 0).length / leads.length : NaN,
            usefulShare: tot ? useful / tot : NaN,
            medianPos: median(positions.filter(x => !isNaN(x))),
        };
    }
    return res;
}

// ==================== 因子构造 ====================

/** 滚动分位：只用 [i-lookback, i] 的数据，无未来函数 */
function rollingPercentile(series, i, lookback) {
    const lo = Math.max(0, i - lookback);
    const win = [];
    for (let k = lo; k <= i; k++) if (isFinite(series[k])) win.push(series[k]);
    if (win.length < Math.max(20, lookback * 0.3)) return NaN;
    const cur = series[i];
    if (!isFinite(cur)) return NaN;
    win.sort((a, b) => a - b);
    let below = 0;
    for (const v of win) if (v <= cur) below++;
    return below / win.length;
}

/** 滚动 z 分 */
function rollingZ(series, i, lookback) {
    const lo = Math.max(0, i - lookback);
    const win = [];
    for (let k = lo; k <= i; k++) if (isFinite(series[k])) win.push(series[k]);
    if (win.length < Math.max(20, lookback * 0.3)) return NaN;
    const sd = stdev(win);
    if (!sd) return NaN;
    return (series[i] - mean(win)) / sd;
}

/** 生成事件：分位越界即触发，方向由 contrarian 决定 */
function thresholdEvents(series, lo, hi, contrarian) {
    const ev = [];
    for (let i = 0; i < series.length; i++) {
        const p = series[i];
        if (!isFinite(p)) continue;
        if (p <= lo) ev.push({ i, side: contrarian ? 'buy' : 'sell' });
        else if (p >= hi) ev.push({ i, side: contrarian ? 'sell' : 'buy' });
    }
    return ev;
}

/** 只保留方向翻转的事件，避免连续同向重复计数 */
function dedupeSide(events) {
    const out = [];
    let last = null;
    for (const e of events) {
        if (e.side === last) continue;
        last = e.side;
        out.push(e);
    }
    return out;
}

// ==================== 主流程 ====================

function buildIndicators(candles) {
    const closes = candles.map(x => x.c);
    const highs = candles.map(x => x.h);
    const lows = candles.map(x => x.l);
    const vols = candles.map(x => x.v);
    return {
        closes, highs, lows, vols,
        ma3: TA.calculateSMA(closes, 3),
        ma7: TA.calculateSMA(closes, 7),
        ma25: TA.calculateSMA(closes, 25),
        ma200: TA.calculateSMA(closes, 200),
        rsi: TA.calculateRSI(closes, 14),
        macd: TA.calculateMACD(closes),
        boll: TA.calculateBollingerBands(closes, 20),
        stochRSI: TA.calculateStochasticRSI(closes),
        kdj: TA.calculateKDJ(highs, lows, closes),
    };
}

/**
 * 应用自带技术面评分，作为基准因子。
 *
 * 这里刻意做成「逐根只用最后 200 根K线重算全部指标」，为的是与线上逐字一致：
 * 线上 getBinanceInterval 固定 limit=200，K线与全部指标都是在 200 根上算出来的。
 * 这个 200 不是随手取的，它是线上口径的一部分 ——
 *   - MACD 是 EMA 递推、RSI 是 Wilder 平滑、KDJ 的 D 从 50 起递推、
 *     VWAP 是窗口内累积量价比：窗口长度会改变它们的取值；
 *   - 用全历史去算，得到的分数与用户屏幕上看到的不是同一个东西。
 *
 * 同时必须把线上传入的全部因子喂进去。此前这里只传了 rsi/macd/均线/布林带，
 * 其余（vwap / obv / stochRSI / kdj / ahr999 / roc / longMA）全被传成 null，
 * 那些评分块合计摆幅可达 ±43 分，等于基准因子测的是另一个模型。
 */
const SCORE_WINDOW = 200;

function technicalScoreSeries(candles) {
    const out = new Array(candles.length).fill(NaN);
    for (let i = SCORE_WINDOW - 1; i < candles.length; i++) {
        // 只看 [i-199, i]：与浏览器加载 200 根K线后所见的完全一致
        const win = candles.slice(i - SCORE_WINDOW + 1, i + 1);
        const closes = win.map(x => x.c);
        const highs = win.map(x => x.h);
        const lows = win.map(x => x.l);
        const vols = win.map(x => x.v);

        const ma3 = TA.calculateSMA(closes, 3);
        const ma7 = TA.calculateSMA(closes, 7);
        const ma25 = TA.calculateSMA(closes, 25);
        const ma200 = TA.calculateSMA(closes, 200);
        const rsi = TA.calculateRSI(closes, 14);
        const macd = TA.calculateMACD(closes);
        const boll = TA.calculateBollingerBands(closes, 20);
        const stochRSI = TA.calculateStochasticRSI(closes);
        const kdj = TA.calculateKDJ(highs, lows, closes);
        const vwap = TA.calculateVWAP(highs, lows, closes, vols);
        const obv = TA.calculateOBV(closes, vols);
        const currentPrice = closes[closes.length - 1];

        // 长期均线的降级窗口，与 app.js 的 pickLongMAWindow 一致
        const longWindow = TA.pickLongMAWindow(win.length);
        const longMA = {
            window: longWindow,
            series: longWindow === null ? null
                : longWindow === 200 ? ma200
                    : TA.calculateSMA(closes, longWindow),
            substituted: longWindow !== null && longWindow !== 200,
            bars: win.length,
        };

        // roc 用同一个 200 根窗口算：buildROC 的自适应死区只取窗口末尾 50 根的平均
        // 波动，在窗口内取值天然因果，不含未来数据。
        const roc = buildROC(closes, 3, 50, 0.6);

        out[i] = TA.calculateTechnicalScore({
            rsi: rsi[rsi.length - 1],
            macd,
            ma3,
            ma7,
            ma25,
            ma200,
            longMA,
            currentPrice,
            bollingerBands: boll,
            vwap,
            obv,
            stochRSI,
            kdj,
            ahr999: TA.calculateAHR999(currentPrice, ma200[ma200.length - 1]),
            roc,
        }).score;
    }
    return out;
}

// ==================== 移植应用内的买卖点算法 ====================
// 线上 app.js 与 DOM 耦合无法直接 require，这里逐行等价移植 buildROC / buildSignalSeries，
// 目的是验证「界面上真正画出来、并被模拟盘执行的买卖点」到底有没有命中率与提前性。
// 任何改动若与 app.js 不一致，结论就失去意义，故这里严格照抄。

function buildROC(closes, period = 3, window = 50, factor = 0.6) {
    const n = closes.length;
    const series = new Array(n).fill(null);
    for (let i = period; i < n; i++) series[i] = closes[i] / closes[i - period] - 1;
    let sum = 0, count = 0;
    for (let i = Math.max(period, n - 1 - window); i < n; i++) {
        if (series[i] !== null) { sum += Math.abs(series[i]); count++; }
    }
    const scale = count ? (sum / count) * factor : 0.005;

    // 逐根死区：与 app.js:buildROC 保持一致（第 i 根只吃 [i-window, i]）。
    // 加上它之前，历史买卖点会用到「末尾 50 根」算出的常数，属未来函数。
    const scaleSeries = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
        let s = 0, c = 0;
        for (let k = Math.max(period, i - window); k <= i; k++) {
            if (series[k] !== null) { s += Math.abs(series[k]); c++; }
        }
        scaleSeries[i] = c ? (s / c) * factor : 0.005;
    }

    return { value: series[n - 1], scale, series, scaleSeries };
}

const SENSITIVITY = {
    conservative: {
        label: '保守', minGap: 6,
        thresholds: { strongBuy: 74, buy: 63, sell: 37, strongSell: 26 },
        weights: { macdPos: 6, macdHist: 5, maCross: 6, priceMa25: 5, maFast: 4, momentum: 5, kdj: 6, stoch: 3, rsiScale: 0.9, boll: 5, volume: 6 },
    },
    balanced: {
        label: '均衡', minGap: 2,
        thresholds: { strongBuy: 70, buy: 58, sell: 42, strongSell: 30 },
        weights: { macdPos: 5, macdHist: 5, maCross: 4, priceMa25: 3, maFast: 7, momentum: 8, kdj: 6, stoch: 5, rsiScale: 0.8, boll: 4, volume: 6 },
    },
    sensitive: {
        label: '灵敏', minGap: 1,
        thresholds: { strongBuy: 66, buy: 54, sell: 46, strongSell: 34 },
        weights: { macdPos: 4, macdHist: 5, maCross: 3, priceMa25: 2, maFast: 9, momentum: 10, kdj: 7, stoch: 7, rsiScale: 0.7, boll: 3, volume: 6 },
    },
};

function buildSignalSeries(data, ind, preset) {
    const series = [];
    if (!data || data.length < 30 || !ind) return series;
    const W = preset.weights, TH = preset.thresholds, MIN_GAP = preset.minGap;
    const len = data.length;
    const closes = data.map(d => d.close);
    const volumes = data.map(d => d.volume);
    const macdLine = (ind.macd && ind.macd.macd) || [];
    const signalLine = (ind.macd && ind.macd.signal) || [];
    const histLine = (ind.macd && ind.macd.histogram) || [];
    const kLine = (ind.kdj && ind.kdj.k) || [];
    const dLine = (ind.kdj && ind.kdj.d) || [];
    const ma3 = ind.ma3 || [], ma7 = ind.ma7 || [], ma25 = ind.ma25 || [];
    const stochK = (ind.stochRSI && ind.stochRSI.k) || [];
    const stochD = (ind.stochRSI && ind.stochRSI.d) || [];
    const upper = (ind.bollingerBands && ind.bollingerBands.upper) || [];
    const lower = (ind.bollingerBands && ind.bollingerBands.lower) || [];
    const rocSeries = (ind.roc && ind.roc.series) || [];
    const rocScale = (ind.roc && ind.roc.scale) || 0.005;
    const rocScaleSeries = (ind.roc && ind.roc.scaleSeries) || null;
    const rsiLine = TA.calculateRSI(closes, 14);

    const classify = v => {
        if (v >= TH.strongBuy) return '强烈买入';
        if (v >= TH.buy) return '买入';
        if (v <= TH.strongSell) return '强烈卖出';
        if (v <= TH.sell) return '卖出';
        return null;
    };

    let prevSide = null, lastIdx = -99;
    for (let i = 1; i < len; i++) {
        if (macdLine[i] == null || signalLine[i] == null) { prevSide = null; continue; }
        let score = 50;
        score += macdLine[i] > signalLine[i] ? W.macdPos : -W.macdPos;
        if (histLine[i] != null && histLine[i - 1] != null) {
            score += histLine[i] > histLine[i - 1] ? W.macdHist : -W.macdHist;
        }
        if (ma7[i] != null && ma25[i] != null) score += ma7[i] > ma25[i] ? W.maCross : -W.maCross;
        if (ma25[i] != null) score += closes[i] > ma25[i] ? W.priceMa25 : -W.priceMa25;
        if (ma3[i] != null && ma7[i] != null) score += ma3[i] > ma7[i] ? W.maFast : -W.maFast;
        const roc = rocSeries[i];
        if (roc != null) {
            const sc = (rocScaleSeries && rocScaleSeries[i] != null) ? rocScaleSeries[i] : rocScale;
            if (roc > sc) score += W.momentum;
            else if (roc < -sc) score -= W.momentum;
        }
        if (stochK[i] != null && stochD[i] != null) score += stochK[i] > stochD[i] ? W.stoch : -W.stoch;
        if (kLine[i] != null && dLine[i] != null) score += kLine[i] > dLine[i] ? W.kdj : -W.kdj;
        const r = rsiLine[i];
        if (r != null) {
            if (r < 30) score += 10 * W.rsiScale;
            else if (r < 45) score += 3 * W.rsiScale;
            else if (r > 70) score -= 10 * W.rsiScale;
            else if (r > 55) score -= 3 * W.rsiScale;
        }
        if (upper[i] != null && lower[i] != null) {
            if (closes[i] < lower[i]) score += W.boll;
            else if (closes[i] > upper[i]) score -= W.boll;
        }
        const priceUp = closes[i] > closes[i - 1];
        const volUp = volumes[i] > volumes[i - 1];
        if (priceUp && volUp) score += W.volume;
        else if (!priceUp && volUp) score -= W.volume;
        score = Math.max(0, Math.min(100, score));

        const label = classify(score);
        const side = label ? (label.indexOf('买入') > -1 ? 'buy' : 'sell') : null;
        if (!side) continue;
        if (side === prevSide) continue;
        if (i - lastIdx < MIN_GAP) continue;
        prevSide = side;
        series.push({ i, time: data[i].time, price: closes[i], label, side, score });
        lastIdx = i;
    }
    return series;
}

/** 对应用真实买卖点算法做同一套评估 */
function appMarkerReport(sym, tfSec, tfName) {
    const candles = resample(loadKlines(sym, '1h'), tfSec);
    if (candles.length < 500) return null;
    const ind = buildIndicators(candles);
    const closes = candles.map(c => c.c);
    ind.roc = buildROC(closes, 3, 50, 0.6);
    ind.bollingerBands = ind.boll;

    const out = {};
    for (const [key, preset] of Object.entries(SENSITIVITY)) {
        const series = buildSignalSeries(
            candles.map(c => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v })),
            ind, preset
        );
        // 用已收盘K线，与线上模拟盘口径一致
        const closed = series.filter(s => s.i < candles.length - 1);
        const r = evaluate(candles, closed.map(s => ({ i: s.i, side: s.side })), { horizons: [6], costBp: 10 });
        out[preset.label] = { n: closed.length, d: r.byHorizon[6] };
    }
    return out;
}


// ==================== 方案二：买卖点当触发器，独立因子当闸门 ====================
// 思路：买卖点自己没有优势（实测命中率约 48%、扣费为负），那就不让它独自决定是否开仓，
// 只在「独立因子显示拥挤度合理」时才允许成交。
//
// 关键风险：筛出子集后成绩变好，可能只是因为样本变少（幸存者式的错觉）。
// 所以每个闸门都必须和一个「保留同样多买卖点、但随机挑选」的对照比。
// 打不过随机子集的闸门，就没有信息量，不值得上线。

const TRIP_COST = 0.002; // 双边 20bp

/** 按闸门规则把买卖点走一遍，返回每轮往返的净收益 */
function simulateTrips(candles, markers, allow) {
    const trips = [];
    let entry = null;
    for (const m of markers) {
        if (!allow(m)) continue;
        const px = candles[m.i].c;
        if (!px) continue;
        if (m.side === 'buy') {
            if (entry !== null) continue;   // 已持仓，忽略重复买入
            entry = { i: m.i, px };
        } else {
            if (entry === null) continue;   // 空仓，忽略卖出
            trips.push({ i: entry.i, j: m.i, ret: px / entry.px - 1 - TRIP_COST });
            entry = null;
        }
    }
    return trips;
}

function tripStats(trips) {
    if (!trips.length) return { n: 0, winRate: NaN, avgRet: NaN, totalRet: NaN };
    const rets = trips.map(t => t.ret);
    const wins = rets.filter(r => r > 0).length;
    let total = 1;
    for (const r of rets) total *= (1 + r);   // 按复利累计
    return { n: trips.length, winRate: wins / rets.length, avgRet: mean(rets), totalRet: total - 1 };
}

/**
 * 确定性伪随机数（mulberry32）。
 *
 * 为什么不能用 Math.random：闸门的「分位」是对「随机保留同样多买卖点」做蒙特卡洛
 * 得到的统计量，未播种的 Math.random 会让同一份代码每次跑出不同数字。
 * 后果有两个，都很要命：
 *   1. 无法回答「这次改动到底改变了什么」—— 改动前后的差异里混着随机抖动；
 *   2. 与「可复现回测」的承诺不符，历史结论无法重新验证。
 * 固定种子后，同输入必然同输出。
 */
function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
// 改动闸门逻辑时刻意不动这个种子：只有同一随机序列下的对比才有意义
const GATE_SEED = 20260923;

/**
 * 闸门筛选能力的检验
 *
 * 返回：真实闸门保留 k 个买卖点时的成绩，在「随机保留 k 个」的成绩分布中的分位。
 * 分位若只有 60% 上下，说明这个闸门和随便挑没区别。
 */
function gateSignificance(candles, markers, allow, iterations) {
    const trips = simulateTrips(candles, markers, allow);
    const st = tripStats(trips);
    if (!st.n) return { st, percentile: NaN, randomMean: NaN, iterations: 0 };

    // 真实闸门「放行」的买卖点个数（用于确定随机对照的规模）
    const passed = markers.filter(allow).length;
    const rand = [];
    const n = markers.length;
    const rng = makeRng(GATE_SEED);
    for (let it = 0; it < iterations; it++) {
        const idx = [];
        for (let i = 0; i < n; i++) idx.push(i);
        for (let i = n - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp;
        }
        const keep = new Set(idx.slice(0, passed));
        const sub = markers.filter((_, k) => keep.has(k));
        const rs = tripStats(simulateTrips(candles, sub, () => true));
        if (rs.n) rand.push(rs.avgRet);
    }
    if (!rand.length) return { st, percentile: NaN, randomMean: NaN, iterations: 0 };
    const below = rand.filter(r => r < st.avgRet).length;
    return {
        st,
        percentile: below / rand.length,
        randomMean: mean(rand),
        iterations: rand.length,
    };
}

function gateHalf(candles, markers, allow, iMin, iMax) {
    const sub = markers.filter(m => m.i >= iMin && m.i <= iMax);
    return tripStats(simulateTrips(candles, sub, allow));
}

function filterReport(sym, tfSec, tfName) {
    const candles = resample(loadKlines(sym, '1h'), tfSec);
    if (candles.length < 500) return null;
    const ind = buildIndicators(candles);
    const closes = candles.map(c => c.c);
    ind.roc = buildROC(closes, 3, 50, 0.6);
    ind.bollingerBands = ind.boll;

    const fund = alignAsOf(loadFunding(sym), candles).map(x => (x ? x.rate : NaN));
    const prem = alignAsOf(loadPremium(sym), candles).map(x => (x ? x.c : NaN));
    const BARS_PER_DAY = 86400 / tfSec;
    const LB = Math.max(60, Math.round(BARS_PER_DAY * 90));
    const fundPct = candles.map((_, i) => rollingPercentile(fund, i, LB));
    const premPct = candles.map((_, i) => rollingPercentile(prem, i, LB));
    const ma200 = ind.ma200;

    const markers = buildSignalSeries(
        candles.map(c => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v })),
        ind, SENSITIVITY.balanced
    ).filter(s => s.i < candles.length - 1);

    // 闸门规则：全部事先定好，不做参数扫描（扫描本身会制造「发现」）
    const filters = {
        '不过滤（现状）': () => true,
        '费率不拥挤': m => m.side === 'buy'
            ? (isFinite(fundPct[m.i]) && fundPct[m.i] <= 0.5)
            : (isFinite(fundPct[m.i]) && fundPct[m.i] >= 0.5),
        '费率极值': m => m.side === 'buy'
            ? (isFinite(fundPct[m.i]) && fundPct[m.i] <= 0.33)
            : (isFinite(fundPct[m.i]) && fundPct[m.i] >= 0.67),
        '费率强拥挤': m => m.side === 'buy'
            ? (isFinite(fundPct[m.i]) && fundPct[m.i] <= 0.2)
            : (isFinite(fundPct[m.i]) && fundPct[m.i] >= 0.8),
        '基差风险': m => m.side === 'buy'
            ? (isFinite(premPct[m.i]) && premPct[m.i] <= 0.5)
            : (isFinite(premPct[m.i]) && premPct[m.i] >= 0.5),
        '费率+基差双确认': m => m.side === 'buy'
            ? (isFinite(fundPct[m.i]) && fundPct[m.i] <= 0.33 && isFinite(premPct[m.i]) && premPct[m.i] <= 0.5)
            : (isFinite(fundPct[m.i]) && fundPct[m.i] >= 0.67 && isFinite(premPct[m.i]) && premPct[m.i] >= 0.5),
        '顺势环境': m => m.side === 'buy'
            ? (ma200[m.i] == null || closes[m.i] > ma200[m.i])
            : (ma200[m.i] == null || closes[m.i] < ma200[m.i]),
    };

    const rows = {};
    const mid = Math.floor(candles.length / 2);
    for (const [name, allow] of Object.entries(filters)) {
        const g = gateSignificance(candles, markers, allow, 300);
        // 小时级样本最多，额外做前后半段对比，检验闸门是不是只在某一段有效
        if (tfSec === 3600) {
            g.half1 = gateHalf(candles, markers, allow, 0, mid - 1);
            g.half2 = gateHalf(candles, markers, allow, mid, candles.length - 1);
        }
        rows[name] = g;
    }
    return { markers, rows, tfName, sym };
}


// ==================== 第三部分：用波动率风险溢价给买卖点做闸门 ====================
// DVOL 由 Deribit 发布，只有 BTC 与 ETH，所以这一节只跑这两个标的，
// 且区间受 DVOL 起点（2021-03）限制。
//
// 前置判断：VRP 已被验证是「波动率预测器」而非方向信号
// （见 research/vrp.js：VRP→未来30天RV 的样本外 R² 明显提升，
//   但 VRP→未来收益的回归 t 值约 −1.0，不显著）。
// 所以这里不再问「VRP 能不能预测涨跌」，只问「它能不能当波动率状态的闸门」。

const VRP_DVOL_DIR = process.env.VRP_DVOL_DIR || null;

function loadDvolDaily(sym) {
    if (!VRP_DVOL_DIR) return null;
    const f = path.join(VRP_DVOL_DIR, `dvol_${sym.replace('USDT', '')}.csv`);
    if (!fs.existsSync(f)) return null;
    const map = new Map();
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        const p = line.split(',');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(p[0])) continue;
        const iv = parseFloat(p[4]);
        if (isFinite(iv)) map.set(p[0], iv / 100);
    }
    return map;
}

function vrpGateReport(sym, tfSec) {
    const dvolMap = loadDvolDaily(sym);
    if (!dvolMap) return null;

    const candles = resample(loadKlines(sym, '1h'), tfSec);
    if (candles.length < 3000) return null;

    const ind = buildIndicators(candles);
    ind.roc = buildROC(candles.map(c => c.c), 3, 50, 0.6);
    ind.bollingerBands = ind.boll;

    const markers = buildSignalSeries(
        candles.map(c => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v })),
        ind, SENSITIVITY.balanced
    ).filter(s => s.i < candles.length - 1);

    const BARS_PER_DAY = 86400 / tfSec;

    // 逐根K线对齐 DVOL（同日内前向填充）
    const ivArr = candles.map(c => {
        const d = new Date(c.t * 1000).toISOString().slice(0, 10);
        return dvolMap.has(d) ? dvolMap.get(d) : NaN;
    });
    let lastIv = NaN;
    for (let i = 0; i < ivArr.length; i++) {
        if (isFinite(ivArr[i])) lastIv = ivArr[i];
        else ivArr[i] = lastIv;
    }

    // 逐根K线的 trailing 30 天已实现方差（365 年化），与 DVOL 的 30 天口径对齐
    const win = BARS_PER_DAY * 30;
    const rvArr = new Array(candles.length).fill(NaN);
    for (let i = win; i < candles.length; i++) {
        let s = 0, n = 0;
        for (let k = i - win + 1; k <= i; k++) {
            if (candles[k - 1].c > 0 && candles[k].c > 0) {
                const r = Math.log(candles[k].c / candles[k - 1].c);
                s += r * r; n++;
            }
        }
        if (n) rvArr[i] = 365 * (s / n);
    }
    const vrpArr = candles.map((_, i) =>
        (isFinite(ivArr[i]) && isFinite(rvArr[i])) ? ivArr[i] * ivArr[i] - rvArr[i] : NaN);

    const LB = Math.round(BARS_PER_DAY * 180);
    const ivPct = candles.map((_, i) => rollingPercentile(ivArr, i, LB));
    const vrpPct = candles.map((_, i) => rollingPercentile(vrpArr, i, LB));

    const filters = {
        '不过滤（现状）': () => true,
        '低波动时段': m => isFinite(ivPct[m.i]) && ivPct[m.i] <= 0.33,
        '高波动时段': m => isFinite(ivPct[m.i]) && ivPct[m.i] >= 0.67,
        'VRP低(期权便宜)': m => isFinite(vrpPct[m.i]) && vrpPct[m.i] <= 0.33,
        'VRP高(期权昂贵)': m => isFinite(vrpPct[m.i]) && vrpPct[m.i] >= 0.67,
    };

    const rows = {};
    const mid = Math.floor(candles.length / 2);
    for (const [name, allow] of Object.entries(filters)) {
        const g = gateSignificance(candles, markers, allow, 300);
        g.half1 = gateHalf(candles, markers, allow, 0, mid - 1);
        g.half2 = gateHalf(candles, markers, allow, mid, candles.length - 1);
        rows[name] = g;
    }
    return { rows, span: [candles[0].t, candles[candles.length - 1].t] };
}


// ==================== 第四部分：用 VRP 预测波动率，动态调整仓位 ====================
// 前面已验证：VRP 预测「波动率」有效（样本外 R² 明显提升），预测「方向」无效。
// 所以这里只做一件事：用预测出来的波动率决定仓位大小，不去猜涨跌。
//
// 最大的陷阱：波动率目标化会天然降低平均仓位，
// 回撤变小、波动变小都可能只是「买得少」，而不是「择时准」。
// 因此必须加一个「同等平均仓位」的固定仓位对照组；
// 只有跑赢这个对照，才说明波动率信息本身有价值。

/** 普通最小二乘（这里只需要系数，不报显著性；显著性见 research/vrp.js） */
function olsPlain(y, cols) {
    const n = y.length;
    const k = cols.length + 1;
    const X = y.map((_, i) => [1, ...cols.map(c => c[i])]);
    const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let i = 0; i < n; i++) for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];

    // 高斯消元解 (X'X)β = X'y
    const A = XtX.map((r, i) => [...r, y.reduce((s, v, j) => s + X[j][i] * v, 0)]);
    for (let c = 0; c < k; c++) {
        let p = c;
        for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
        if (Math.abs(A[p][c]) < 1e-12) return null;
        [A[c], A[p]] = [A[p], A[c]];
        const pv = A[c][c];
        for (let j = c; j <= k; j++) A[c][j] /= pv;
        for (let r = 0; r < k; r++) {
            if (r === c) continue;
            const f = A[r][c];
            if (f === 0) continue;
            for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j];
        }
    }
    return { beta: A.map(r => r[k]) };
}

function rollingMeanAt(arr, i, w) {
    let s = 0, n = 0;
    for (let k = Math.max(0, i - w + 1); k <= i; k++) {
        if (isFinite(arr[k])) { s += arr[k]; n++; }
    }
    return n ? s / n : NaN;
}

/**
 * 构造逐日面板 + 走查式波动率预测
 *
 * 严格无未来函数：
 *   预测目标 fwd30(s) 用到 s 之后 30 天的数据，
 *   所以第 t 天的模型只能用 s ≤ t−30 的样本拟合（purge）。
 */
function volTargetPanel(sym) {
    const dvolMap = loadDvolDaily(sym);
    if (!dvolMap) return null;

    const daily = resample(loadKlines(sym, '1h'), 86400);
    if (daily.length < 500) return null;

    const ret = daily.map((c, i) => (i ? c.c / daily[i - 1].c - 1 : 0));
    const rv1 = daily.map((c, i) => {
        if (!i || daily[i - 1].c <= 0) return NaN;
        const r = Math.log(daily[i].c / daily[i - 1].c);
        return 365 * r * r;
    });
    const rv7 = daily.map((_, i) => rollingMeanAt(rv1, i, 7));
    const rv30 = daily.map((_, i) => rollingMeanAt(rv1, i, 30));

    const iv = daily.map(c => {
        const d = new Date(c.t * 1000).toISOString().slice(0, 10);
        return dvolMap.has(d) ? dvolMap.get(d) : NaN;
    });
    let lastIv = NaN;
    for (let i = 0; i < iv.length; i++) {
        if (isFinite(iv[i])) lastIv = iv[i];
        else iv[i] = lastIv;
    }
    const vrp = daily.map((_, i) =>
        (isFinite(iv[i]) && isFinite(rv30[i])) ? iv[i] * iv[i] - rv30[i] : NaN);

    const fwd30 = daily.map((_, i) => {
        let s = 0, n = 0;
        for (let k = i + 1; k <= Math.min(i + 30, daily.length - 1); k++) {
            if (isFinite(rv1[k])) { s += rv1[k]; n++; }
        }
        return n >= 25 ? s / n : NaN;
    });

    const REFIT = 30, PURGE = 30, MIN_TRAIN = 150;
    const predHAR = new Array(daily.length).fill(NaN);
    const predVRP = new Array(daily.length).fill(NaN);

    for (let start = MIN_TRAIN + PURGE; start < daily.length; start += REFIT) {
        const trainEnd = start - PURGE;
        const ys = [], c1 = [], c7 = [], c30 = [], cv = [];
        for (let s = 60; s <= trainEnd; s++) {
            if (!isFinite(fwd30[s]) || fwd30[s] <= 0) continue;
            if (!isFinite(rv1[s]) || rv1[s] <= 0) continue;
            if (!isFinite(rv7[s]) || rv7[s] <= 0) continue;
            if (!isFinite(rv30[s]) || rv30[s] <= 0) continue;
            ys.push(Math.log(fwd30[s]));
            c1.push(Math.log(rv1[s]));
            c7.push(Math.log(rv7[s]));
            c30.push(Math.log(rv30[s]));
            cv.push(isFinite(vrp[s]) ? Math.log(Math.max(vrp[s], 1e-8)) : 0);
        }
        if (ys.length < 80) continue;

        const mA = olsPlain(ys, [c1, c7, c30]);
        const mB = olsPlain(ys, [c1, c7, c30, cv]);

        const apply = (m, t, withVrp) => {
            if (!m) return NaN;
            if (!isFinite(rv1[t]) || rv1[t] <= 0) return NaN;
            if (!isFinite(rv7[t]) || rv7[t] <= 0) return NaN;
            if (!isFinite(rv30[t]) || rv30[t] <= 0) return NaN;
            let y = m.beta[0]
                + m.beta[1] * Math.log(rv1[t])
                + m.beta[2] * Math.log(rv7[t])
                + m.beta[3] * Math.log(rv30[t]);
            if (withVrp && m.beta.length > 4) {
                y += m.beta[4] * (isFinite(vrp[t]) ? Math.log(Math.max(vrp[t], 1e-8)) : 0);
            }
            const v = Math.exp(y);
            return v > 0 && isFinite(v) ? Math.sqrt(v) : NaN;
        };

        for (let t = start; t < Math.min(start + REFIT, daily.length); t++) {
            predHAR[t] = apply(mA, t, false);
            predVRP[t] = apply(mB, t, true);
        }
    }

    return { daily, ret, predHAR, predVRP, iv };
}

/** 由权益曲线算绩效 */
function equityMetrics(eq, turnover) {
    const n = eq.length - 1;
    if (n < 30) return null;
    const rets = [];
    for (let i = 1; i < eq.length; i++) rets.push(eq[i] / eq[i - 1] - 1);
    const m = mean(rets);
    const s = stdev(rets);
    const years = n / 365;
    const total = eq[eq.length - 1] - 1;
    const cagr = years > 0 ? Math.pow(eq[eq.length - 1], 1 / years) - 1 : NaN;
    let peak = eq[0], mdd = 0;
    for (const v of eq) { if (v > peak) peak = v; const dd = peak > 0 ? (peak - v) / peak : 0; if (dd > mdd) mdd = dd; }
    return {
        days: n,
        totalRet: total,
        cagr,
        vol: s * Math.sqrt(365),
        sharpe: s > 0 ? (m * 365) / (s * Math.sqrt(365)) : NaN,
        maxDd: mdd,
        calmar: mdd > 0 ? cagr / mdd : NaN,
        turnover,
        avgW: NaN,
    };
}

/**
 * 按目标权重序列跑权益曲线
 * w 数组即「风险资产占比」，0 表示空仓
 */
function runWeightStrategy(ret, w, costRate, band) {
    let equity = 1, cur = 0, turnover = 0, wSum = 0, wCnt = 0;
    const eq = [1];
    for (let i = 0; i < ret.length - 1; i++) {
        const target = w[i];
        const needOut = target === 0 && cur > 0;
        if (needOut || Math.abs(target - cur) >= band) {
            const dw = Math.abs(target - cur);
            equity -= dw * equity * costRate;
            turnover += dw;
            cur = target;
        }
        equity *= (1 + cur * ret[i + 1]);
        eq.push(equity);
        wSum += cur; wCnt++;
    }
    const m = equityMetrics(eq, turnover);
    if (m) m.avgW = wCnt ? wSum / wCnt : NaN;
    return m;
}

function volTargetReport(sym) {
    const panel = volTargetPanel(sym);
    if (!panel) return null;
    const { daily, ret, predHAR, predVRP } = panel;

    // 只在波动率预测可用之后评估，保证四个变体样本一致
    let start = 0;
    while (start < daily.length && !(isFinite(predVRP[start]) && isFinite(predHAR[start]))) start++;
    if (daily.length - start < 200) return null;

    const candles = daily.slice(start);
    const ind = buildIndicators(candles);
    ind.roc = buildROC(candles.map(c => c.c), 3, 50, 0.6);
    ind.bollingerBands = ind.boll;

    const markers = buildSignalSeries(
        candles.map(c => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v })),
        ind, SENSITIVITY.balanced
    ).filter(s => s.i < candles.length - 1);

    // 持仓状态数组（买信号进、卖信号出）
    const sideAt = new Map(markers.map(m => [m.i, m.side]));
    const inPos = new Array(candles.length).fill(false);
    let state = false;
    for (let i = 0; i < candles.length; i++) {
        const sd = sideAt.get(i);
        if (sd === 'buy') state = true;
        else if (sd === 'sell') state = false;
        inPos[i] = state;
    }

    const retS = ret.slice(start);

    const weigh = (pred, targetVol) => inPos.map((v, i) => {
        if (!v) return 0;
        const pv = pred[start + i];
        return isFinite(pv) && pv > 0 ? Math.min(1, targetVol / pv) : 0;
    });

    const COST = 0.001, BAND = 0.10;
    const rows = [];

    // 基准：满仓 + 买入持有
    rows.push(['满仓（现状）', null, runWeightStrategy(retS, inPos.map(v => (v ? 1 : 0)), COST, BAND)]);
    rows.push(['买入持有', null, runWeightStrategy(retS, retS.map(() => 1), COST, 1)]);

    // 对每个目标波动，同时给出「波动率目标」与「同等平均仓位的固定仓位」对照
    for (const tv of [0.25, 0.40, 0.60]) {
        for (const [label, pred] of [['HAR', predHAR], ['HAR+VRP', predVRP]]) {
            const w = weigh(pred, tv);
            const avg = mean(w.filter((_, i) => inPos[i]));
            rows.push([`波动率目标·${label}`, tv, runWeightStrategy(retS, w, COST, BAND)]);
            // 对照：把仓位恒定在这个平均水平，不做任何波动率择时
            rows.push([`固定仓位对照·${label}`, tv,
                runWeightStrategy(retS, inPos.map(v => (v ? avg : 0)), COST, BAND)]);
        }
    }

    return {
        span: [candles[0].t, candles[candles.length - 1].t],
        nMarkers: markers.length,
        rows,
    };
}


function pct(x) { return isFinite(x) ? (x * 100).toFixed(2) + '%' : '--'; }
function f3(x) { return isFinite(x) ? x.toFixed(3) : '--'; }
function bp(x) { return isFinite(x) ? (x * 10000).toFixed(1) + 'bp' : '--'; }

/** 把 1 小时K线聚合到更大周期，避免重复下载 */
function resample(candles, tfSec) {
    if (tfSec === 3600) return candles;
    const buckets = new Map();
    for (const c of candles) {
        const key = Math.floor(c.t / tfSec) * tfSec;
        let b = buckets.get(key);
        if (!b) { b = { t: key, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, n: 0 }; buckets.set(key, b); }
        b.h = Math.max(b.h, c.h);
        b.l = Math.min(b.l, c.l);
        b.c = c.c;
        b.v += c.v;
        b.n++;
    }
    // 只保留完整的桶，最后一段不完整会污染回测
    const full = tfSec / 3600;
    return [...buckets.values()].filter(b => b.n === full).sort((a, b2) => a.t - b2.t);
}

/**
 * 单尾事件研究：直接看「信号出现后的平均收益」，用于复现已发表结论
 * 这一节不看方向命中率，而是看绝对收益，才能与论文里的「+0.5%」对照。
 */
function eventStudy(candles, events, horizons, costBp) {
    const cost = (costBp || 0) / 10000;
    const out = {};
    for (const h of horizons) {
        const rets = [];
        for (const e of events) {
            if (e.i + h >= candles.length) continue;
            rets.push(candles[e.i + h].c / candles[e.i].c - 1);
        }
        if (!rets.length) continue;
        const pos = rets.filter(r => r > 0).length;
        out[h] = {
            n: rets.length,
            avg: mean(rets),
            netAvg: mean(rets) - cost * 2,
            positiveShare: pos / rets.length,
            median: median(rets),
        };
    }
    return out;
}

/** 取出处于某分位区间的「连续段起点」，避免同一段行情被重复计数 */
function tailStarts(pctSeries, low, high) {
    const lowStarts = [], highStarts = [];
    let inLow = false, inHigh = false;
    for (let i = 0; i < pctSeries.length; i++) {
        const p = pctSeries[i];
        if (!isFinite(p)) { continue; }
        if (p <= low) { if (!inLow) { lowStarts.push({ i }); inLow = true; } }
        else inLow = false;
        if (p >= high) { if (!inHigh) { highStarts.push({ i }); inHigh = true; } }
        else inHigh = false;
    }
    return { lowStarts, highStarts };
}

function runSymbol(sym, tfSec, label) {
    const raw = loadKlines(sym, '1h');
    const candles = resample(raw, tfSec);
    if (candles.length < 500) return null;

    const funding = loadFunding(sym);
    const premium = loadPremium(sym);
    const metrics = loadMetrics(sym);

    const fund = alignAsOf(funding, candles);
    const prem = alignAsOf(premium, candles);
    const met = alignLastIn(candles, metrics, tfSec);
    const ind = buildIndicators(candles);

    // 滚动窗口按因子自身的信息频率设定：
    // 资金费率 8 小时一结算，用「K线根数」当窗口会让样本太少，故按结算次数折算。
    const BARS_PER_DAY = 86400 / tfSec;
    const LB_FAST = Math.max(30, Math.round(BARS_PER_DAY * 14));   // 两周
    const LB_SLOW = Math.max(60, Math.round(BARS_PER_DAY * 90));   // 三个月
    const factors = {};

    const fundRate = fund.map(x => (x ? x.rate : NaN));
    const premClose = prem.map(x => (x ? x.c : NaN));

    // ---- 资金费率：拥挤度，极端负值代表空头拥挤 ----
    const fundPct = candles.map((_, i) => rollingPercentile(fundRate, i, LB_SLOW));
    factors['资金费率分位(反向)'] = dedupeSide(thresholdEvents(fundPct, 0.10, 0.90, true));
    factors['资金费率分位(顺势)'] = dedupeSide(thresholdEvents(fundPct, 0.10, 0.90, false));
    const fundZ = candles.map((_, i) => rollingZ(fundRate, i, LB_SLOW));
    factors['资金费率z分(反向)'] = dedupeSide(thresholdEvents(fundZ, -1.5, 1.5, true));

    // ---- 基差 / 溢价：高 carry 预示崩盘 ----
    const premPct = candles.map((_, i) => rollingPercentile(premClose, i, LB_SLOW));
    factors['基差分位(反向)'] = dedupeSide(thresholdEvents(premPct, 0.10, 0.90, true));
    factors['基差分位(顺势)'] = dedupeSide(thresholdEvents(premPct, 0.10, 0.90, false));

    // ---- 衍生品 metrics（仅近几个月有数据，窗口放短）----
    const oiSeries = candles.map((_, i) => (met[i] ? met[i].oiValue : NaN));
    const oiChg = new Array(candles.length).fill(NaN);
    for (let i = BARS_PER_DAY; i < candles.length; i++) {
        if (isFinite(oiSeries[i]) && isFinite(oiSeries[i - BARS_PER_DAY]) && oiSeries[i - BARS_PER_DAY] > 0) {
            oiChg[i] = oiSeries[i] / oiSeries[i - BARS_PER_DAY] - 1;
        }
    }
    const oiZ = candles.map((_, i) => rollingZ(oiChg, i, LB_FAST));
    factors['持仓量变化z分(反向)'] = dedupeSide(thresholdEvents(oiZ, -1.5, 1.5, true));

    const taker = candles.map((_, i) => (met[i] ? met[i].takerLs : NaN));
    const takerPct = candles.map((_, i) => rollingPercentile(taker, i, LB_FAST));
    factors['主动买卖比分位(反向)'] = dedupeSide(thresholdEvents(takerPct, 0.10, 0.90, true));

    const topLs = candles.map((_, i) => (met[i] ? met[i].topLs : NaN));
    const topPct = candles.map((_, i) => rollingPercentile(topLs, i, LB_FAST));
    factors['大户多空比分位(反向)'] = dedupeSide(thresholdEvents(topPct, 0.10, 0.90, true));

    const acctLs = candles.map((_, i) => (met[i] ? met[i].acctLs : NaN));
    const acctPct = candles.map((_, i) => rollingPercentile(acctLs, i, LB_FAST));
    factors['账户多空比分位(反向)'] = dedupeSide(thresholdEvents(acctPct, 0.10, 0.90, true));

    // ---- 基准：应用自带技术面评分 ----
    // 注意：这里不再接收外部 ind —— 该函数内部按线上口径（200 根窗口）自算全部指标，
    // 见其函数注释。传入全历史 ind 会与线上口径不一致。
    const techScore = technicalScoreSeries(candles);
    factors['【基准】技术面评分'] = dedupeSide(thresholdEvents(techScore.map(s => s / 100), 0.30, 0.70, true));

    // ---- 对照：随机信号 ----
    const rnd = [];
    for (let i = 200; i < candles.length; i++) rnd.push({ i, side: i % 2 ? 'buy' : 'sell' });
    factors['【对照】随机'] = rnd;

    const avail = {
        candle: candles.length,
        funding: fundRate.filter(isFinite).length,
        premium: premClose.filter(isFinite).length,
        metrics: met.filter(Boolean).length,
    };

    const report = {};
    for (const [name, ev] of Object.entries(factors)) {
        report[name] = evaluate(candles, ev, { horizons: [6, 24], costBp: 10, delay: 0 });
    }

    // ---- 复现已发表结论：资金费率单尾事件研究 ----
    // 论文口径是「结算后 24 小时」，所以这里把预测窗口按小时折算成K线根数，
    // 否则日线上会把「24 根日线」当成 24 小时，结论无法对照。
    const hoursToBars = hrs => Math.max(1, Math.round(hrs * 3600 / tfSec));
    const tails = tailStarts(fundPct, 0.10, 0.90);
    const repHorizons = [...new Set([hoursToBars(8), hoursToBars(24)])];
    const reps = {
        '资金费率下十分位(极端负)': eventStudy(candles, tails.lowStarts, repHorizons, 10),
        '资金费率上十分位(极端正)': eventStudy(candles, tails.highStarts, repHorizons, 10),
    };
    const repHours = {};
    repHorizons.forEach(h => { repHours[h] = h * tfSec / 3600; });

    // ---- 样本内外对比：用前半段选因子、后半段验证 ----
    // 这是区分「真规律」和「过拟合」最关键的一步。
    const mid = Math.floor(candles.length / 2);
    const oos = {};
    for (const [name, ev] of Object.entries(factors)) {
        if (name === '【对照】随机') continue;
        const a = evaluate(candles, ev, { horizons: [6], costBp: 10, iMin: 0, iMax: mid - 1 });
        const b = evaluate(candles, ev, { horizons: [6], costBp: 10, iMin: mid, iMax: candles.length - 1 });
        oos[name] = { is: a.byHorizon[6], oos: b.byHorizon[6] };
    }

    return { candles, report, avail, reps, repHours, oos, label, span: [candles[0].t, candles[candles.length - 1].t] };
}

function fmtDate(t) {
    return new Date(t * 1000).toISOString().slice(0, 10);
}

function main() {
    const tfs = [
        [3600, '1小时'],
        [14400, '4小时'],
        [86400, '日线'],
    ];
    const syms = ['BTCUSDT', 'ETHUSDT'];

    // ============ 第一部分：界面真实买卖点的命中率与提前性 ============
    console.log('\n' + '#'.repeat(104));
    console.log('# 一、应用内置买卖点信号（界面上真正画出来、并被模拟盘执行的那套算法）');
    console.log('#    命中率对照「零假设」：混合买卖信号下瞎猜方向的期望命中率，即 50%');
    console.log('#'.repeat(104));
    console.log('\n标的/周期      档位     信号数    H=6命中率   零假设    超额      H=6扣费后   中位提前  有效提前');
    console.log('-'.repeat(104));
    for (const [tfSec, tfName] of tfs) {
        const collected = [];
        for (const sym of syms) {
            const rep = appMarkerReport(sym, tfSec, tfName);
            if (!rep) continue;
            collected.push(rep);
            for (const [label, v] of Object.entries(rep)) {
                const d = v.d;
                if (!d || !d.n) continue;
                console.log(
                    `${sym.replace('USDT', '')}/${tfName}`.padEnd(15) +
                    label.padEnd(8) +
                    String(d.n).padStart(6) + '  ' +
                    pct(d.hitRate).padStart(9) + '  ' +
                    pct(d.nullRate).padStart(7) + '  ' +
                    pct(d.edge).padStart(7) + '  ' +
                    bp(d.avgNet).padStart(10) + '  ' +
                    String(d.medianLead).padStart(7) + '   ' +
                    pct(d.usefulShare).padStart(6)
                );
            }
        }

        // 合并 BTC+ETH 的一行：界面上显示的就是这一行。
        // 合并的理由是单标的样本量只有一半；但两个标的的表现差异不小
        // （日线尤其：BTC 扣费后 −3.7bp、ETH −20.7bp），
        // 所以界面上会同时保留单标的数字，避免合并值把差异藏起来。
        if (collected.length < 2) continue;
        for (const label of Object.keys(collected[0])) {
            const ds = collected.map(rep => rep[label] && rep[label].d).filter(d => d && d.n);
            if (ds.length < 2) continue;
            const p = poolByHorizon(ds);
            console.log(
                `BTC+ETH/${tfName}`.padEnd(15) +
                label.padEnd(8) +
                String(p.n).padStart(6) + '  ' +
                pct(p.hitRate).padStart(9) + '  ' +
                pct(p.nullRate).padStart(7) + '  ' +
                pct(p.edge).padStart(7) + '  ' +
                bp(p.avgNet).padStart(10) + '  ' +
                String(p.medianLead).padStart(7) + '   ' +
                pct(p.usefulShare).padStart(6)
            );
        }
    }

    // ============ 第二部分：买卖点做触发器 + 独立因子做闸门 ============
    console.log('\n' + '#'.repeat(104));
    console.log('# 二、方案二：买卖点当触发器，独立因子当闸门（只在因子允许时才成交）');
    console.log('#    判据＝每轮往返净收益（已扣双边 20bp）；分位＝真实闸门落在「随机保留同样多买卖点」分布中的位置');
    console.log('#    分位接近 50% 说明该闸门与随便挑没区别；要显著才有信息量');
    console.log('#'.repeat(104));
    console.log('\n标的/周期      闸门规则             往返次数   胜率    单笔净收益    累计净收益   随机对照    分位');
    console.log('-'.repeat(104));
    for (const [tfSec, tfName] of tfs) {
        for (const sym of syms) {
            const fr = filterReport(sym, tfSec, tfName);
            if (!fr) continue;
            for (const [name, g] of Object.entries(fr.rows)) {
                const st = g.st;
                if (!st.n) continue;
                console.log(
                    `${sym.replace('USDT', '')}/${tfName}`.padEnd(15) +
                    name.padEnd(22) +
                    String(st.n).padStart(6) + '  ' +
                    pct(st.winRate).padStart(7) + '  ' +
                    bp(st.avgRet).padStart(11) + '  ' +
                    pct(st.totalRet).padStart(11) + '  ' +
                    bp(g.randomMean).padStart(9) + '  ' +
                    pct(g.percentile).padStart(6)
                );
            }
        }
    }

    console.log('\n  —— 小时级前后半段对比（闸门是不是只在某一段行情里有效）——');
    console.log('  标的     闸门规则              前半段n  前半段单笔   前半段胜率   后半段n  后半段单笔   后半段胜率   同向');
    console.log('  ' + '-'.repeat(102));
    for (const sym of syms) {
        const fr = filterReport(sym, 3600, '1小时');
        if (!fr) continue;
        for (const [name, g] of Object.entries(fr.rows)) {
            const a = g.half1, b = g.half2;
            if (!a || !b || !a.n || !b.n) continue;
            const same = (a.avgRet > 0) === (b.avgRet > 0);
            console.log(
                '  ' + sym.replace('USDT', '').padEnd(8) + name.padEnd(22) +
                String(a.n).padStart(6) + '  ' + bp(a.avgRet).padStart(10) + '  ' + pct(a.winRate).padStart(9) + '  ' +
                String(b.n).padStart(7) + '  ' + bp(b.avgRet).padStart(10) + '  ' + pct(b.winRate).padStart(9) + '   ' +
                (same ? '是' : '否')
            );
        }
    }

    // ============ 第三部分：DVOL / VRP 做闸门（仅 BTC/ETH）============
    if (VRP_DVOL_DIR) {
        console.log('\n' + '#'.repeat(104));
        console.log('# 三、用 DVOL / VRP 给买卖点做闸门（Deribit 只发布 BTC/ETH 的 DVOL，故仅这两个标的）');
        console.log('#    判据同第二部分：每轮往返净收益（扣双边 20bp），分位＝相对「随机保留同样多买卖点」的位置');
        console.log('#'.repeat(104));
        console.log('\n标的/周期      闸门规则             往返次数   胜率    单笔净收益    累计净收益   随机对照    分位   前半段    后半段');
        console.log('-'.repeat(104));
        for (const [tfSec, tfName] of [[3600, '1小时']]) {
            for (const sym of syms) {
                const fr = vrpGateReport(sym, tfSec);
                if (!fr) continue;
                for (const [name, g] of Object.entries(fr.rows)) {
                    const st = g.st;
                    if (!st.n) continue;
                    console.log(
                        `${sym.replace('USDT', '')}/${tfName}`.padEnd(15) +
                        name.padEnd(22) +
                        String(st.n).padStart(6) + '  ' +
                        pct(st.winRate).padStart(7) + '  ' +
                        bp(st.avgRet).padStart(11) + '  ' +
                        pct(st.totalRet).padStart(11) + '  ' +
                        bp(g.randomMean).padStart(9) + '  ' +
                        pct(g.percentile).padStart(6) + '  ' +
                        bp(g.half1 ? g.half1.avgRet : NaN).padStart(9) + '  ' +
                        bp(g.half2 ? g.half2.avgRet : NaN).padStart(9)
                    );
                }
            }
        }
    }

    // ============ 第四部分：用预测波动率动态调整仓位 ============
    if (VRP_DVOL_DIR) {
        console.log('\n' + '#'.repeat(104));
        console.log('# 四、用波动率预测动态调整仓位（日线；DVOL 只有 BTC/ETH）');
        console.log('#    目标波动扫描 25%/40%/60%，无交易带 0.10，成本 10bp/边');
        console.log('#    关键对照＝「同等平均仓位的固定仓位」：只有跑赢它，才说明波动率择时本身有价值');
        console.log('#'.repeat(104));
        for (const sym of syms) {
            const vr = volTargetReport(sym);
            if (!vr) continue;
            console.log(`\n${sym}  区间 ${fmtDate(vr.span[0])} ~ ${fmtDate(vr.span[1])}　信号数 ${vr.nMarkers}`);
            console.log('  变体                      目标   天数    总收益     年化    年化波动   Sharpe   最大回撤   Calmar   平均仓位   换手');
            for (const [name, tv, m] of vr.rows) {
                if (!m) continue;
                console.log(
                    '  ' + name.padEnd(24) +
                    (tv ? pct(tv, 0) : '--').padStart(5) + '  ' +
                    String(m.days).padStart(5) + '  ' +
                    pct(m.totalRet).padStart(9) + '  ' +
                    pct(m.cagr).padStart(8) + '  ' +
                    pct(m.vol).padStart(9) + '  ' +
                    f3(m.sharpe).padStart(7) + '  ' +
                    pct(m.maxDd).padStart(9) + '  ' +
                    f3(m.calmar).padStart(7) + '  ' +
                    pct(m.avgW).padStart(8) + '  ' +
                    m.turnover.toFixed(1).padStart(6)
                );
            }
            // 关键对比：波动率目标 vs 同平均仓位的固定仓位
            console.log('  —— 关键对比：Sharpe 之差（波动率目标 − 固定仓位对照）——');
            for (const tv of [0.25, 0.40, 0.60]) {
                const parts = [];
                for (const label of ['HAR', 'HAR+VRP']) {
                    const vt = vr.rows.find(r => r[0] === `波动率目标·${label}` && r[1] === tv);
                    const fx = vr.rows.find(r => r[0] === `固定仓位对照·${label}` && r[1] === tv);
                    if (vt && fx && vt[2] && fx[2]) {
                        const d = vt[2].sharpe - fx[2].sharpe;
                        parts.push(`${label} ${d >= 0 ? '+' : ''}${d.toFixed(3)}`);
                    }
                }
                console.log(`    目标波动 ${pct(tv, 0)}：${parts.join('　')}`);
            }
        }
        console.log('\n  读法：只有当「波动率目标」明显优于「固定仓位」时，才说明波动率择时本身有价值；');
        console.log('        否则改善只是来自「买得少」。两者都优于满仓时，说明降杠杆就够了。');
    }

    for (const [tfSec, tfName] of tfs) {
        for (const sym of syms) {
            const r = runSymbol(sym, tfSec, tfName);
            if (!r) { console.log(`${sym} ${tfName}: 数据不足`); continue; }
            console.log('\n' + '='.repeat(104));
            console.log(`${sym} ${tfName}   区间 ${fmtDate(r.span[0])} ~ ${fmtDate(r.span[1])}   共 ${r.candles.length} 根K线`);
            console.log(`数据可得性: 资金费率 ${r.avail.funding} · 溢价 ${r.avail.premium} · 衍生品样本 ${r.avail.metrics}`);
            console.log('='.repeat(104));
            console.log('因子                        信号数   H    命中率   零假设    超额     毛收益    扣费后   中位提前  有效提前');
            console.log('-'.repeat(104));
            for (const [name, rep] of Object.entries(r.report)) {
                for (const h of [6, 24]) {
                    const d = rep.byHorizon[h];
                    if (!d || !d.n) continue;
                    console.log(
                        name.padEnd(26) +
                        String(d.n).padStart(6) + '  ' +
                        String(h).padStart(3) + '  ' +
                        pct(d.hitRate).padStart(7) + ' ' +
                        pct(d.nullRate).padStart(7) + ' ' +
                        pct(d.edge).padStart(7) + '  ' +
                        bp(d.avgGross).padStart(8) + ' ' +
                        bp(d.avgNet).padStart(8) + '  ' +
                        String(d.medianLead).padStart(7) + '   ' +
                        pct(d.usefulShare).padStart(6)
                    );
                }
            }
            console.log('  —— 样本内外对比（H=6，前半段 vs 后半段，扣费后）——');
            console.log('  因子                        前半段n  前半段命中  前半段扣费后   后半段n  后半段命中  后半段扣费后   是否同向');
            for (const [name, d] of Object.entries(r.oos)) {
                const a = d.is, b = d.oos;
                if (!a || !b || !a.n || !b.n) continue;
                const sameSign = (a.avgNet > 0) === (b.avgNet > 0);
                console.log(
                    '  ' + name.padEnd(26) +
                    String(a.n).padStart(6) + '  ' +
                    pct(a.hitRate).padStart(9) + '  ' +
                    bp(a.avgNet).padStart(11) + '  ' +
                    String(b.n).padStart(8) + '  ' +
                    pct(b.hitRate).padStart(9) + '  ' +
                    bp(b.avgNet).padStart(11) + '   ' +
                    (sameSign ? '是' : '否')
                );
            }
            console.log('  —— 资金费率单尾事件研究（对照 AIJMR 2026 公布的 24 小时 +0.506% / 上涨 55.13%）——');
            for (const [name, byH] of Object.entries(r.reps)) {
                for (const h of Object.keys(byH)) {
                    const d = byH[h];
                    if (!d) continue;
                    console.log(
                        '  ' + name.padEnd(24) +
                        String(d.n).padStart(6) + ' 个样本  ' +
                        `${r.repHours[h]}小时`.padEnd(8) + '  ' +
                        '平均 ' + bp(d.avg).padStart(9) + '  ' +
                        '扣费后 ' + bp(d.netAvg).padStart(9) + '  ' +
                        '上涨占比 ' + pct(d.positiveShare).padStart(7)
                    );
                }
            }
        }
    }
}

main();
