'use strict';
// 整体包在 async IIFE 里，以便使用顶层 await（文件仍是 CommonJS）
(async () => {

/**
 * 小程序分析链路 —— 单元测试
 *
 * 运行：node miniprogram/tests/analyze.test.js
 *
 * 为什么要在 Node 里测：小程序的 UI 没法在这里跑，但真正会算错的是下面这些东西 ——
 * 指标口径、长期均线降级、因子权重归一、K线字段映射、画布绘制。这些全是纯逻辑，
 * 可以在 Node 里用假的 wx / fetch 完整跑一遍。真机上再出问题就只剩 UI 层了。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, '..', 'js');

let passed = 0, failed = 0;
const failures = [];

function ok(cond, name, extra) {
    if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
    else {
        failed++;
        failures.push(name + (extra ? ' — ' + extra : ''));
        console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  → ' + extra : ''));
    }
}
function eq(a, b, name) {
    ok(a === b, name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
function near(a, b, eps, name) {
    ok(Math.abs(a - b) < eps, name, `期望约 ${b}，实际 ${a}`);
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

// ============================================================
// 造一个「小程序运行环境」：wx + fetch
// ============================================================

function makeWx(storage) {
    return {
        getStorageSync: (k) => (storage[k] === undefined ? '' : storage[k]),
        setStorageSync: (k, v) => { storage[k] = v; },
        removeStorageSync: (k) => { delete storage[k]; },
        showToast: () => {},
        request: () => { throw new Error('测试里不应该走到 wx.request'); },
    };
}

/** 生成 n 根K线；价格按给定函数走，保证可复现 */
function genCandles(n, startPrice, step) {
    const out = [];
    let price = startPrice;
    const t0 = 1700000000;
    for (let i = 0; i < n; i++) {
        price = price + step;
        const open = price;
        const close = price + step;
        out.push({
            time: t0 + i * 86400,
            open: open,
            high: Math.max(open, close) * 1.004,
            low: Math.min(open, close) * 0.996,
            close: close,
            volume: 1000 + i * 7,
        });
    }
    return out;
}

function jsonRes(body, status) {
    const code = status || 200;
    return {
        ok: code >= 200 && code < 300,
        status: code,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
    };
}

/** 加载小程序的一个模块（CommonJS），共享同一份 wx / fetch */
function loadModule(relPath, ctx) {
    const full = path.join(ROOT, relPath);
    const code = fs.readFileSync(full, 'utf8');
    const module = { exports: {} };
    const sandbox = {
        console, Date, Math, JSON, Object, Array, String, Number, Boolean,
        Error, RegExp, isFinite, isNaN, parseFloat, parseInt, Promise,
        setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent,
        Set, Map, module, exports: module.exports, require: ctx.require,
        wx: ctx.wx, fetch: ctx.fetch,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: relPath });
    return module.exports;
}

/** 建一个可以 require 小程序模块的环境 */
function makeEnv(fetchImpl) {
    const storage = {};
    const cacheMap = {};
    const ctx = {
        wx: makeWx(storage),
        fetch: fetchImpl,
        require: null,
    };
    ctx.require = function (p) {
        // 归一化相对路径，映射回小程序目录
        const resolved = path.normalize(path.join(ROOT, 'utils', p)).replace(/\\/g, '/');
        const rel = resolved.slice(ROOT.length + 1);
        if (cacheMap[rel]) return cacheMap[rel];
        // libs/ 与 utils/ 都从 ROOT 出发解析
        const target = rel.indexOf('libs/') === 0 ? rel : rel;
        const mod = loadModule(target, ctx);
        cacheMap[rel] = mod;
        return mod;
    };
    return { ctx, storage };
}

// ============================================================
section('1. 小程序的库是从网页端同步来的，不能走样');

{
    const PAIRS = [
        ['technical.js', 'TechnicalAnalysis'],
        ['signals.js', 'SignalGenerator'],
        ['stocks.js', 'Stocks'],
    ];
    PAIRS.forEach(function (pair) {
        const web = fs.readFileSync(path.join(SRC_DIR, pair[0]), 'utf8');
        const mp = fs.readFileSync(path.join(ROOT, 'libs', pair[0]), 'utf8');
        ok(mp.indexOf(pair[0]) >= 0, `${pair[0]} 的小程序副本带来源说明`);
        ok(mp.indexOf('module.exports = ' + pair[1]) >= 0, `${pair[0]} 导出了 ${pair[1]}`);
        // 去掉头部注释与尾部导出后，内容必须与网页端逐字一致
        const body = mp.split('// 重新生成：node miniprogram/sync-libs.js\n')[1] || mp;
        const stripped = body.replace(new RegExp('\\nmodule\\.exports = ' + pair[1] + ';\\n?$'), '');
        eq(stripped.length, web.length, `${pair[0]} 与网页端长度一致（没有偷偷改过）`);
        ok(stripped === web, `${pair[0]} 与网页端内容逐字一致`);
    });
}

// ============================================================
section('2. K线映射：字段与单位');

{
    const calls = [];
    const env = makeEnv(function (url) {
        calls.push(url);
        if (url.indexOf('/exchangeInfo') >= 0) {
            return Promise.resolve(jsonRes({
                symbols: [
                    { symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT' },
                    { symbol: 'ETHBTC', status: 'TRADING', baseAsset: 'ETH', quoteAsset: 'BTC' },
                    { symbol: 'OLDUSDT', status: 'BREAK', baseAsset: 'OLD', quoteAsset: 'USDT' },
                ],
            }));
        }
        if (url.indexOf('/klines') >= 0) {
            return Promise.resolve(jsonRes([
                [1775483400000, '335.92', '339.24', '332.90', '335.34', '160691.39', 0, '0', 0, '0', '0', '0'],
                [1775487000000, '335.34', '336.00', '334.00', '335.90', '50000.10', 0, '0', 0, '0', '0', '0'],
            ]));
        }
        return Promise.resolve(jsonRes({}, 404));
    });
    const api = loadModule('utils/api.js', env.ctx);

    const cs = await api.klines('spot', 'BTCUSDT', '1h', 200);
    eq(cs.length, 2, '两根蜡烛都被映射');
    eq(cs[0].time, 1775483400, '毫秒转秒（图表要秒）');
    near(cs[0].close, 335.34, 1e-9, '收盘价');
    near(cs[0].volume, 160691.39, 1e-6, '成交量来自第 6 列');
    ok(calls[calls.length - 1].indexOf('data-api.binance.vision') >= 0, '现货走现货域名');
    ok(calls[calls.length - 1].indexOf('interval=1h') >= 0, '周期参数透传');

    await api.klines('futures', 'AAPLUSDT', '1d', 300);
    const lastUrl = calls[calls.length - 1];
    ok(lastUrl.indexOf('fapi.binance.com') >= 0, '合约走 fapi 域名 —— 走错域名会整批请求失败');
    ok(lastUrl.indexOf('limit=300') >= 0, 'limit 透传');

    const cat = await api.spotCatalog();
    eq(cat.length, 1, '目录只留 USDT 计价且 TRADING 的交易对');
    eq(cat[0].coinId, 'btc', 'coinId 转小写');
    eq(cat[0].market, 'spot', '标记为现货');
    ok(cat[0].name === undefined, '目录里不存中文名（省存储空间，展示时再补）');

    // 第二次读目录应命中缓存，不再打接口
    const before = calls.length;
    await api.spotCatalog();
    eq(calls.length, before, '目录第二次走缓存');
}

// ============================================================
section('3. 长期均线降级：与网页端同一条规则');

{
    const env = makeEnv(function () { return Promise.resolve(jsonRes({})); });
    const analyzeMod = loadModule('utils/analyze.js', env.ctx);

    // 实测的美股情形：日线 166 根
    const s166 = analyzeMod.analyze({
        candles: genCandles(166, 300, 0.2),
        market: 'futures',
        timeframe: '24',
        sensitivity: 'balanced',
        fng: null,
        deriv: null,
    });
    eq(s166.indicators.longMA.window, 150, '166 根 → 降到 MA150');
    eq(s166.indicators.longMA.substituted, true, '标记为已降级');
    eq(s166.indicators.longMA.bars, 166, '记录实际根数');
    ok(s166.depthNote && s166.depthNote.indexOf('MA150') >= 0, '提示里点名实际的 MA150');
    ok(s166.depthNote && s166.depthNote.indexOf('200') >= 0, '提示里说明 200 根这个门槛');

    const longSignals = s166.signal.techSignals.filter(s => /大趋势/.test(s.text));
    eq(longSignals.length, 1, '大趋势信号在降级后仍然产出（没有被静默丢掉）');
    ok(longSignals[0].text.indexOf('MA150') >= 0, '大趋势信号点名 MA150');
    ok(longSignals[0].text.indexOf('MA200') >= 0, '大趋势信号说明为什么不是 MA200');

    // 加密币情形：日线 250 根，走原始 MA200
    const s250 = analyzeMod.analyze({
        candles: genCandles(250, 100, 0.1),
        market: 'spot',
        timeframe: '24',
        sensitivity: 'balanced',
        fng: { value: 55, label: 'Neutral' },
        deriv: { fundingRate: 0.01, openInterest: 12345 },
    });
    eq(s250.indicators.longMA.window, 200, '250 根 → MA200');
    eq(s250.indicators.longMA.substituted, false, '未降级');
    eq(s250.depthNote, null, '深度够用时不产生提示');
    ok(s250.signal.techSignals.filter(s => /大趋势/.test(s.text))[0].text.indexOf('不足') < 0,
        '未降级时大趋势文案里不出现「不足」');

    // 美股周线情形：连最短窗口都不够
    const s24 = analyzeMod.analyze({
        candles: genCandles(24, 300, 0.2),
        market: 'futures',
        timeframe: '168',
        sensitivity: 'balanced',
        fng: null,
        deriv: null,
    });
    eq(s24.indicators.longMA.window, null, '24 根 → 没有可用窗口');
    eq(s24.indicators.longMA.series, null, '序列为 null');
    ok(s24.depthNote && s24.depthNote.indexOf('不参与') >= 0, '提示里说明大趋势项没参与评分');
    eq(s24.signal.techSignals.filter(s => /大趋势/.test(s.text)).length, 0, '不再产出大趋势信号');
    ok(!isNaN(s24.totalScore), '分数仍是有效数字，不是 NaN');
}

// ============================================================
section('4. 因子权重：缺失的因子不能拿 50 分顶替');

{
    const env = makeEnv(function () { return Promise.resolve(jsonRes({})); });
    const analyzeMod = loadModule('utils/analyze.js', env.ctx);

    // 个股：只应有技术面 + 量能参与，权重 40/20
    const stock = analyzeMod.analyze({
        candles: genCandles(166, 300, 0.2),
        market: 'futures', timeframe: '24', sensitivity: 'balanced',
        fng: { value: 10, label: 'Extreme Fear' },   // 就算给了也不该用
        deriv: { fundingRate: 0, openInterest: 1 },
    });
    eq(stock.weights.technical, 40, '个股：技术面权重 40');
    eq(stock.weights.volume, 20, '个股：量能权重 20');
    eq(stock.weights.sentiment, 0, '个股：情绪面权重归零 —— 加密指标与个股无关');
    eq(stock.weights.derivatives, 0, '个股：衍生品权重归零 —— 美股费率恒贴近 0');
    eq(stock.weights.news, 0, '个股：消息面权重 0');
    eq(stock.signal.breakdown.sentiment, null, '个股：情绪面在 breakdown 里是 null，界面显示「不适用」');
    eq(stock.signal.breakdown.derivatives, null, '个股：衍生品同理');

    const expectStock = Math.round((stock.scores.technical * 40 + stock.scores.volume * 20) / 60);
    eq(stock.totalScore, expectStock, '个股评分 = 技术面与量能按 2:1 归一');

    // 加密币：四个因子参与（消息面本版未接入，权重 0），除数 88
    const coin = analyzeMod.analyze({
        candles: genCandles(250, 100, 0.1),
        market: 'spot', timeframe: '24', sensitivity: 'balanced',
        fng: { value: 55, label: 'Neutral' },
        deriv: { fundingRate: 0.01, openInterest: 1 },
    });
    eq(coin.weights.sentiment, 16, '加密币：情绪面权重 16');
    eq(coin.weights.derivatives, 12, '加密币：衍生品权重 12');
    eq(coin.weights.news, 0, '消息面权重 0（本版未接入资讯源）');
    const expectCoin = Math.round((
        coin.scores.technical * 40 + coin.scores.volume * 20 +
        coin.scores.sentiment * 16 + coin.scores.derivatives * 12
    ) / 88);
    eq(coin.totalScore, expectCoin, '加密币评分按 88 归一');
    ok(coin.signal.breakdown.sentiment !== null, '加密币的情绪面有实际分值');

    // 情绪数据取不到时，权重必须一起撤掉，而不是当 50 分算进去
    const noFng = analyzeMod.analyze({
        candles: genCandles(250, 100, 0.1),
        market: 'spot', timeframe: '24', sensitivity: 'balanced',
        fng: null, deriv: null,
    });
    eq(noFng.weights.sentiment, 0, '取不到恐慌指数时情绪面权重归零');
    eq(noFng.weights.derivatives, 0, '取不到费率时衍生品权重归零');
    eq(noFng.totalScore, Math.round((noFng.scores.technical * 40 + noFng.scores.volume * 20) / 60),
        '此时与个股同样是 2:1 归一 —— 而不是把缺失项当 50 分算');

    // 评分必须落在参与因子的区间内（加权平均的基本性质）
    ok(coin.totalScore <= Math.max(coin.scores.technical, coin.scores.volume, coin.scores.sentiment, coin.scores.derivatives) &&
        coin.totalScore >= Math.min(coin.scores.technical, coin.scores.volume, coin.scores.sentiment, coin.scores.derivatives),
        '综合评分落在各因子分值之间');

    // 排除项要如实列出
    ok(stock.excluded.join('|').indexOf('情绪面') >= 0, '个股把情绪面列为未参与');
    ok(stock.excluded.join('|').indexOf('消息面') >= 0, '消息面在任何情况下都列为未参与');
    ok(coin.excluded.join('|').indexOf('消息面') >= 0, '加密币也如实说明消息面未接入');
    ok(coin.excluded.join('|').indexOf('情绪面') < 0, '加密币不应把情绪面列为未参与');
}

// ============================================================
section('5. 评分换算：与网页端同口径');

{
    const env = makeEnv(function () { return Promise.resolve(jsonRes({})); });
    const analyzeMod = loadModule('utils/analyze.js', env.ctx);

    // 恐慌贪婪：逆势映射，与网页端 calculateSentimentScore 一致
    eq(analyzeMod.sentimentScoreFromFng(10), 75, '极度恐惧 → 75（逆势偏多）');
    eq(analyzeMod.sentimentScoreFromFng(30), 65, '恐惧 → 65');
    eq(analyzeMod.sentimentScoreFromFng(45), 55, '偏恐惧 → 55');
    eq(analyzeMod.sentimentScoreFromFng(55), 45, '偏贪婪 → 45');
    eq(analyzeMod.sentimentScoreFromFng(70), 35, '贪婪 → 35');
    eq(analyzeMod.sentimentScoreFromFng(90), 25, '极度贪婪 → 25');
    eq(analyzeMod.sentimentScoreFromFng(null), null, '无数据 → null（而不是 50）');

    // 资金费率：与网页端 calculateDerivativesScore 一致
    eq(analyzeMod.derivativesScoreFromFunding(0) , 50, '费率为 0 → 50');
    eq(analyzeMod.derivativesScoreFromFunding(0.2), 30, '费率 > 0.1 → 减 20');
    eq(analyzeMod.derivativesScoreFromFunding(0.08), 40, '费率 > 0.05 → 减 10');
    eq(analyzeMod.derivativesScoreFromFunding(-0.08), 65, '费率 < -0.05 → 加 15');
    eq(analyzeMod.derivativesScoreFromFunding(-0.01), 55, '费率 < 0 → 加 5');
    eq(analyzeMod.derivativesScoreFromFunding(null), null, '无数据 → null');

    // 灵敏度档位阈值与网页端一致
    eq(analyzeMod.SENSITIVITY.balanced.thresholds.buy, 58, '均衡档买入阈值 58');
    eq(analyzeMod.SENSITIVITY.conservative.thresholds.buy, 63, '保守档买入阈值 63');
    eq(analyzeMod.SENSITIVITY.sensitive.thresholds.buy, 54, '灵敏档买入阈值 54');
    eq(analyzeMod.getSensitivity('不存在').label, '均衡', '未知档位回落到均衡');

    // 周期映射
    eq(analyzeMod.getTimeframe('24').interval, '1d', '日线 → 1d');
    eq(analyzeMod.getTimeframe('1').interval, '1h', '1小时 → 1h');
    eq(analyzeMod.getTimeframe('168').seconds, 604800, '周线秒数');
}

// ============================================================
section('6. 画布绘制：不能抛错，且要真的画出东西');

{
    const env = makeEnv(function () { return Promise.resolve(jsonRes({})); });
    const chartMod = loadModule('utils/chart.js', env.ctx);

    function mockCtx() {
        const c = {
            calls: { fillRect: 0, stroke: 0, fillText: 0, moveTo: 0, lineTo: 0, clearRect: 0 },
            clearRect: function () { c.calls.clearRect++; },
            fillRect: function () { c.calls.fillRect++; },
            beginPath: function () {}, closePath: function () {},
            moveTo: function () { c.calls.moveTo++; },
            lineTo: function () { c.calls.lineTo++; },
            stroke: function () { c.calls.stroke++; },
            fillText: function () { c.calls.fillText++; },
            measureText: function (t) { return { width: String(t).length * 5 }; },
            scale: function () {}, save: function () {}, restore: function () {},
            arc: function () {}, fill: function () {},
            set font(v) {}, set fillStyle(v) {}, set strokeStyle(v) {},
            set lineWidth(v) {}, set textAlign(v) {}, set textBaseline(v) {},
        };
        return c;
    }

    const candles = genCandles(166, 300, 0.2);
    const env2 = makeEnv(function () { return Promise.resolve(jsonRes({})); });
    const analyzeMod = loadModule('utils/analyze.js', env2.ctx);
    const a = analyzeMod.analyze({
        candles: candles, market: 'futures', timeframe: '24', sensitivity: 'balanced',
        fng: null, deriv: null,
    });

    const ctx = mockCtx();
    let threw = null;
    try {
        chartMod.draw(ctx, 340, 280, candles, {
            ma7: a.indicators.ma7,
            ma25: a.indicators.ma25,
            longMA: a.indicators.longMA,
            longMAWindow: a.indicators.longMA.window,
            timeframe: '24',
            maxBars: 110,
        });
    } catch (e) { threw = e; }
    ok(!threw, '166 根 + 降级均线：绘制不抛错', threw && threw.message);
    eq(ctx.calls.clearRect, 1, '先清空画布');
    ok(ctx.calls.fillRect > 110, '蜡烛与成交量都被画出来了（填充块数 > 可见根数）');
    ok(ctx.calls.stroke > 0, '均线被描边');
    ok(ctx.calls.fillText > 0, '价格刻度与时间刻度有文字');

    // 空数据必须给出提示而不是崩掉
    const ctx2 = mockCtx();
    let threw2 = null;
    try { chartMod.draw(ctx2, 340, 280, [], {}); } catch (e) { threw2 = e; }
    ok(!threw2, '空K线不抛错', threw2 && threw2.message);
    eq(ctx2.calls.fillText, 1, '空K线时画一行提示文字');

    // 全 null 的均线（例如周期太短）也不能崩
    const ctx3 = mockCtx();
    let threw3 = null;
    try {
        chartMod.draw(ctx3, 340, 280, genCandles(10, 10, 0.1), {
            ma7: new Array(10).fill(null),
            ma25: new Array(10).fill(null),
            longMA: { window: null, series: null },
            timeframe: '168',
            maxBars: 110,
        });
    } catch (e) { threw3 = e; }
    ok(!threw3, '均线全 null 时不抛错', threw3 && threw3.message);
}

// ============================================================
section('7. 本地存储：自选与设置的边界');

{
    const env = makeEnv(function () { return Promise.resolve(jsonRes({})); });
    const store = loadModule('utils/store.js', env.ctx);

    const def = store.getWatchlist();
    eq(def.length, 5, '默认自选 5 个');
    eq(def[0], 'bitcoin', '默认第一个是比特币');

    ok(store.addWatch('aapl').ok, '可以加入自选');
    eq(store.isWatched('aapl'), true, '加入后状态为已自选');
    const dup = store.addWatch('aapl');
    eq(dup.unchanged, true, '重复加入视为成功且不改动');
    eq(store.getWatchlist().filter(x => x === 'aapl').length, 1, '不会出现重复项');

    ok(store.removeWatch('aapl').ok, '可以移出自选');
    eq(store.isWatched('aapl'), false, '移出后状态为未自选');

    // 至少保留一个
    const ids = store.getWatchlist();
    ids.slice(1).forEach(id => store.removeWatch(id));
    const last = store.removeWatch(store.getWatchlist()[0]);
    eq(last.ok, false, '最后一个不能被移出');
    ok(last.message.indexOf('至少') >= 0, '给出可读的原因');

    // 元数据要能区分现货与合约 —— 详情页靠它决定去哪个接口
    store.setCoinMeta({ coinId: 'aapl', symbol: 'AAPL', name: '苹果', binanceSymbol: 'AAPLUSDT', market: 'futures' });
    const meta = store.getCoinMeta('aapl');
    eq(meta.market, 'futures', '合约标的的 market 被保留');
    eq(meta.binanceSymbol, 'AAPLUSDT', '交易对被保留');
    eq(store.getCoinMeta('bitcoin').market, 'spot', '内置热门币种默认是现货');

    // 设置
    eq(store.getSettings().sensitivity, 'balanced', '默认灵敏度为均衡');
    store.setSettings({ sensitivity: 'sensitive' });
    eq(store.getSettings().sensitivity, 'sensitive', '设置可写入');
    eq(store.getSettings().timeframe, '24', '未指定的字段保持默认值');

    // 缓存
    store.setCache('x', [1, 2, 3]);
    ok(store.getCache('x', 10000) !== null, '缓存可读');
    eq(store.getCache('x', -1), null, '过期缓存返回 null');
}

// ============================================================
section('8. 格式化：不依赖 Intl');

{
    const env = makeEnv(function () { return Promise.resolve(jsonRes({})); });
    const format = loadModule('utils/format.js', env.ctx);

    eq(format.price(335.34), '335.34', '常规价格');
    eq(format.price(80613.9), '80,613.90', '大数带千分位');
    eq(format.price(0.0004712), '0.000471', '小额币按 6 位小数');
    eq(format.price(1.23456), '1.23', '大于 1 按 2 位小数');
    eq(format.price(0.0201), '0.0201', '0.01~1 按 4 位小数');
    eq(format.price(null), '--', '空值给占位符');
    eq(format.price('abc'), '--', '非数字给占位符');
    eq(format.price(undefined), '--', 'undefined 给占位符');
    eq(format.price(''), '--', '空串给占位符（Number("") 是 0，不能当成 0 显示）');
    eq(format.price(false), '--', '布尔值给占位符');
    // 真正的 0 走小额币分支（6 位小数），与网页端 formatPrice 的分档一致；
    // 关键是它不再与「缺数据」混淆 —— 缺数据显示 --，0 显示数字
    eq(format.price(0), '0.000000', '真正的 0 正常显示（沿用网页端的小额档）');
    ok(format.price(0) !== format.price(null), '0 与缺数据必须显示成不同的东西');
    ok(isNaN(format.toNum(null)), 'toNum(null) 是 NaN，不是 0');
    ok(isNaN(format.toNum('')), 'toNum("") 是 NaN，不是 0');
    eq(format.pct(null), '--', '空涨跌幅给占位符');
    eq(format.amount(''), '--', '空成交额给占位符');
    eq(format.large(null), '--', '空持仓量给占位符');
    eq(format.dirClass(null), 'flat', '空涨跌幅的颜色为中性，不能误判成上涨');

    eq(format.pct(1.2), '+1.20%', '涨带正号');
    eq(format.pct(-1.2), '-1.20%', '跌带负号');
    eq(format.pct(0), '+0.00%', '零按正号处理');

    eq(format.amount(54096421.99), '5409.64万', '成交额用万');
    eq(format.amount(203000000), '2.03亿', '过亿用亿');
    eq(format.amount(0), '--', '零值给占位符');

    eq(format.dirClass(1), 'up', '涨为 up');
    eq(format.dirClass(-1), 'down', '跌为 down');
    eq(format.dirClass(0), 'flat', '零为 flat');
}

// ============================================================
console.log('\n' + '─'.repeat(56));
console.log(`通过 ${passed}　失败 ${failed}`);
if (failed) {
    console.log('\n失败项：');
    failures.forEach(f => console.log('  · ' + f));
    process.exit(1);
} else {
    console.log('全部通过');
}

})();
