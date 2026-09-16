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

/** 应用自带技术面评分，作为基准因子（真实线上逻辑） */
function technicalScoreSeries(candles, ind) {
    const out = new Array(candles.length).fill(NaN);
    for (let i = 200; i < candles.length; i++) {
        const r = TA.calculateTechnicalScore({
            rsi: ind.rsi[i],
            macd: {
                macd: ind.macd.macd.slice(0, i + 1),
                signal: ind.macd.signal.slice(0, i + 1),
            },
            ma3: ind.ma3.slice(0, i + 1),
            ma7: ind.ma7.slice(0, i + 1),
            ma25: ind.ma25.slice(0, i + 1),
            ma200: ind.ma200.slice(0, i + 1),
            currentPrice: candles[i].c,
            bollingerBands: {
                upper: ind.boll.upper.slice(0, i + 1),
                lower: ind.boll.lower.slice(0, i + 1),
                middle: ind.boll.middle.slice(0, i + 1),
            },
            vwap: NaN, obv: NaN, stochRSI: null, kdj: null, ahr999: null, roc: null,
        });
        out[i] = r.score;
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
    return { value: series[n - 1], scale, series };
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
            if (roc > rocScale) score += W.momentum;
            else if (roc < -rocScale) score -= W.momentum;
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
    for (let it = 0; it < iterations; it++) {
        const idx = [];
        for (let i = 0; i < n; i++) idx.push(i);
        for (let i = n - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
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
    const techScore = technicalScoreSeries(candles, ind);
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
        for (const sym of syms) {
            const rep = appMarkerReport(sym, tfSec, tfName);
            if (!rep) continue;
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
