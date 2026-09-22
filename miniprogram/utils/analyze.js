/**
 * 分析编排：把K线变成指标、评分与信号。
 *
 * 这里的口径与网页端 js/app.js 的 calculateIndicators + updateSignal 对齐，
 * 包括：
 *   - 长期均线按可用根数降级（200→150→120→99→60），并如实记录实际窗口
 *   - 因子缺失时把权重去掉再归一，而不是拿 50 分顶替
 *   - 美股只保留技术面与量能（加密情绪、加密新闻、近乎为 0 的费率都不适用）
 * 唯一的口径差异是**消息面**：小程序 v1 没有接入资讯源，所以权重固定为 0
 * 并在结果里明确标出来，不让它悄悄稀释分数。
 */

const TechnicalAnalysis = require('../libs/technical.js');
const SignalGenerator = require('../libs/signals.js');
const Stocks = require('../libs/stocks.js');
const format = require('./format.js');

// 与网页端一致：技术 40 / 量能 20 / 情绪 16 / 消息 12 / 衍生品 12
const BASE_WEIGHTS = { technical: 40, volume: 20, sentiment: 16, news: 12, derivatives: 12 };

// 周期 → 币安 interval / 单根K线秒数（与网页端 timeframeConfig 一致）
const TIMEFRAMES = [
    { key: '1', interval: '1h', seconds: 3600, label: '1小时' },
    { key: '4', interval: '4h', seconds: 14400, label: '4小时' },
    { key: '24', interval: '1d', seconds: 86400, label: '日线' },
    { key: '168', interval: '1w', seconds: 604800, label: '周线' },
];

// 与网页端 sensitivityPresets 的阈值一致
const SENSITIVITY = {
    conservative: { label: '保守', thresholds: { strongBuy: 74, buy: 63, sell: 37, strongSell: 26 } },
    balanced: { label: '均衡', thresholds: { strongBuy: 70, buy: 58, sell: 42, strongSell: 30 } },
    sensitive: { label: '灵敏', thresholds: { strongBuy: 66, buy: 54, sell: 46, strongSell: 34 } },
};

function getTimeframe(key) {
    return TIMEFRAMES.filter(t => t.key === String(key))[0] || TIMEFRAMES[2];
}

function getSensitivity(key) {
    return SENSITIVITY[key] || SENSITIVITY.balanced;
}

/**
 * 恐慌贪婪指数 → 情绪分。
 * 与网页端 calculateSentimentScore 完全一致（逆势：越恐慌越偏多）。
 */
function sentimentScoreFromFng(value) {
    if (value === null || value === undefined || !isFinite(value)) return null;
    if (value < 20) return 75;
    if (value < 40) return 65;
    if (value < 50) return 55;
    if (value < 60) return 45;
    if (value < 80) return 35;
    return 25;
}

/**
 * 资金费率 → 衍生品分。
 * 与网页端 calculateDerivativesScore 一致，阈值也一致（0.05% / 0.1%）。
 * 注意：美股合约费率实测长期贴近 0，会恒返回 50，所以调用方对美股不启用该因子。
 */
function derivativesScoreFromFunding(fundingRatePct) {
    if (fundingRatePct === null || fundingRatePct === undefined || !isFinite(fundingRatePct)) return null;
    let score = 50;
    const fr = fundingRatePct;
    if (fr > 0.1) score -= 20;
    else if (fr > 0.05) score -= 10;
    else if (fr < -0.05) score += 15;
    else if (fr < 0) score += 5;
    return Math.max(0, Math.min(100, score));
}

/**
 * N 周期动量及其自适应死区。
 *
 * 与网页端 app.js:buildROC 的区别：网页端还会返回一个逐根死区 scaleSeries，
 * 供「历史K线上的买卖点标注与模拟盘回放」使用（用末尾常数套历史K线是未来函数）。
 * 小程序这边只把 roc 交给 calculateTechnicalScore 判断**当前这一根**，
 * 而当前这一根的逐根死区与这里的 scale 数值相同，所以不需要那份序列。
 */
function buildROC(closes, period, window, factor) {
    const p = period || 3;
    const win = window || 50;
    const fac = factor === undefined ? 0.6 : factor;
    const n = closes.length;
    const series = new Array(n).fill(null);
    for (let i = p; i < n; i++) series[i] = closes[i] / closes[i - p] - 1;

    let sum = 0;
    let count = 0;
    for (let i = Math.max(p, n - 1 - win); i < n; i++) {
        if (series[i] !== null) { sum += Math.abs(series[i]); count++; }
    }
    return { value: n ? series[n - 1] : null, scale: count ? (sum / count) * fac : 0.005, series };
}

/** 计算全部技术指标（等价于网页端 calculateIndicators） */
function computeIndicators(candles) {
    const closes = candles.map(d => d.close);
    const highs = candles.map(d => d.high);
    const lows = candles.map(d => d.low);
    const volumes = candles.map(d => d.volume);
    const currentPrice = closes[closes.length - 1];

    const TA = TechnicalAnalysis;
    const ma3 = TA.calculateSMA(closes, 3);
    const ma7 = TA.calculateSMA(closes, 7);
    const ma25 = TA.calculateSMA(closes, 25);
    const ma99 = TA.calculateSMA(closes, 99);
    const ma200 = TA.calculateSMA(closes, 200);

    // 长期均线：标的比 200 根K线年轻时 MA200 不可得（币安美股合约就是这种情况），
    // 按可用根数降级到最长可用窗口，而不是把这一项丢掉
    const longWindow = TA.pickLongMAWindow(closes.length);
    const longMA = {
        window: longWindow,
        series: longWindow === null ? null
            : longWindow === 200 ? ma200
                : TA.calculateSMA(closes, longWindow),
        substituted: longWindow !== null && longWindow !== 200,
        bars: closes.length,
    };

    const macd = TA.calculateMACD(closes);
    const lastMA200 = ma200[ma200.length - 1];

    return {
        ma3, ma7, ma25, ma99, ma200, longMA,
        ema7: TA.calculateEMA(closes, 7),
        ema25: TA.calculateEMA(closes, 25),
        ema99: TA.calculateEMA(closes, 99),
        rsi: TA.calculateRSI(closes, 14),
        macd,
        bollingerBands: TA.calculateBollingerBands(closes, 20),
        vwap: TA.calculateVWAP(highs, lows, closes, volumes),
        obv: TA.calculateOBV(closes, volumes),
        stochRSI: TA.calculateStochasticRSI(closes),
        kdj: TA.calculateKDJ(highs, lows, closes),
        ahr999: TA.calculateAHR999(currentPrice, lastMA200),
        roc: buildROC(closes, 3, 50, 0.6),
        supportResistance: TA.calculateSupportResistance(highs, lows, closes, currentPrice),
        volMa5: TA.calculateSMA(volumes, 5),
        volMa10: TA.calculateSMA(volumes, 10),
        currentPrice,
    };
}

/**
 * 综合评分。
 * 只对「真正参与」的因子做加权，再按权重和归一。
 * 返回 weights 与 excluded，供界面如实说明哪几项没算。
 */
function compositeScore(scores, opts) {
    const w = {
        technical: BASE_WEIGHTS.technical,
        volume: BASE_WEIGHTS.volume,
        sentiment: opts.useSentiment ? BASE_WEIGHTS.sentiment : 0,
        derivatives: opts.useDerivatives ? BASE_WEIGHTS.derivatives : 0,
        // 消息面：小程序 v1 未接入资讯源，权重恒为 0
        news: 0,
    };
    const sum = w.technical + w.volume + w.sentiment + w.derivatives;
    const total = (
        scores.technical * w.technical +
        scores.volume * w.volume +
        (opts.useSentiment ? scores.sentiment * w.sentiment : 0) +
        (opts.useDerivatives ? scores.derivatives * w.derivatives : 0)
    ) / sum;

    return { total: Math.round(total), weights: w, divisor: sum };
}

/**
 * 一次性算出指标 + 评分 + 信号。
 *
 * @param {Object} p
 * @param {Array}  p.candles      K线（{time,open,high,low,close,volume}）
 * @param {string} p.market       'spot' | 'futures'
 * @param {string} p.timeframe    周期 key
 * @param {string} p.sensitivity  灵敏度档位
 * @param {Object} p.fng          恐慌贪婪指数 {value,label}，可为 null
 * @param {Object} p.deriv        衍生品 {fundingRate,openInterest}，可为 null
 */
function analyze(p) {
    const candles = p.candles || [];
    const isStock = p.market === 'futures';
    const tf = getTimeframe(p.timeframe);
    const sens = getSensitivity(p.sensitivity);

    const ind = computeIndicators(candles);

    const techResult = TechnicalAnalysis.calculateTechnicalScore({
        rsi: ind.rsi[ind.rsi.length - 1],
        macd: {
            macd: ind.macd.macd,
            signal: ind.macd.signal,
            histogram: ind.macd.histogram,
        },
        ma3: ind.ma3,
        ma7: ind.ma7,
        ma25: ind.ma25,
        ma200: ind.ma200,
        longMA: ind.longMA,
        currentPrice: ind.currentPrice,
        bollingerBands: ind.bollingerBands,
        vwap: ind.vwap,
        obv: ind.obv,
        stochRSI: ind.stochRSI,
        kdj: ind.kdj,
        // AHR999 是比特币专用估值带；ma200 取不到时它自然为空，
        // 个股上不会误参与评分
        ahr999: ind.ahr999,
        roc: ind.roc,
    });

    const volumeResult = TechnicalAnalysis.analyzeVolume(candles, tf.seconds);

    // 情绪面与衍生品：个股一律不启用
    //   - 恐慌贪婪指数是加密市场指标，与个股无关
    //   - 美股合约资金费率实测长期贴近 0，恒为 50 分，留着等于塞一个常数项
    const useSentiment = !isStock && !!p.fng;
    const sentiment = useSentiment ? sentimentScoreFromFng(p.fng.value) : null;
    const useDerivatives = !isStock && !!(p.deriv && p.deriv.fundingRate !== null);
    const derivatives = useDerivatives ? derivativesScoreFromFunding(p.deriv.fundingRate) : null;

    const scores = {
        technical: techResult.score,
        volume: volumeResult.score,
        sentiment: sentiment === null ? 0 : sentiment,
        derivatives: derivatives === null ? 0 : derivatives,
    };

    const comp = compositeScore(scores, { useSentiment: useSentiment && sentiment !== null, useDerivatives: useDerivatives && derivatives !== null });

    const excluded = [];
    if (!useSentiment || sentiment === null) excluded.push(isStock ? '情绪面（加密指标，个股不适用）' : '情绪面（数据未取到）');
    if (!useDerivatives || derivatives === null) excluded.push(isStock ? '衍生品（美股费率恒贴近 0）' : '衍生品（数据未取到）');
    excluded.push('消息面（本版未接入资讯源）');

    const signal = SignalGenerator.generateSignal(
        Object.assign({}, techResult, { score: techResult.score }),
        { score: null, topNews: [], label: 'na', positiveCount: 0, negativeCount: 0 },
        {
            supportResistance: ind.supportResistance,
            currentPrice: ind.currentPrice,
            totalScore: comp.total,
            thresholds: sens.thresholds,
            volumeMetrics: volumeResult.metrics,
            breakdown: {
                technical: techResult.score,
                volume: volumeResult.score,
                // 不参与评分的因子显式给 null，界面据此显示「不适用」，
                // 而不是显示一个看似有意义的 50 分
                sentiment: sentiment,
                derivatives: derivatives,
                news: null,
            },
        }
    );

    // 长期均线的展示文案
    const depthNote = Stocks.depthWarning(String(p.timeframe), candles.length, ind.longMA.window);

    return {
        isStock,
        timeframe: tf,
        sensitivity: sens,
        bars: candles.length,
        indicators: ind,
        scores: scores,
        weights: comp.weights,
        totalScore: comp.total,
        excluded: excluded,
        signal: signal,
        volumeMetrics: volumeResult.metrics,
        volumeSignals: volumeResult.signals,
        depthNote: depthNote,
    };
}

module.exports = {
    TIMEFRAMES, SENSITIVITY, BASE_WEIGHTS,
    getTimeframe, getSensitivity,
    sentimentScoreFromFng, derivativesScoreFromFunding, buildROC,
    computeIndicators, compositeScore, analyze,
    format: format,
};
