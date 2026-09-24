'use strict';
/**
 * 预测复盘模块 —— 单元测试（重点覆盖「一份K线只能复盘它自己的标的与周期」）
 *
 * 运行：node tests/prediction.test.js
 *
 * 背景：evaluate(candleData) 原先只收一份K线，却把它套用到所有到期记录上，
 * 不核对标的与周期。于是显示 ETH 时，BTC 的记录被拿 ETH 的收盘价复盘，
 * 显示 BTC 时反过来 —— 一条 2700 的 ETH 记录，复盘价写成了 86200。
 *
 * 危害不止于判错一条：correct 一旦写入就永久生效（此后每次都跳过它），错误判定
 * 会落盘、同步到后端、写进 CSV，事后单看数字也认不出哪条是错的。
 *
 * 注意本测试不能靠「传 BTC 的K线却声明是 ETH」来构造场景 —— 那种「调用方撒谎」
 * 函数无法识别。真实场景是：调用方诚实地传来自已手上那份（当前显示的标的），
 * 而记录里混着别的标的。所以要断言的是「别的标的的记录不许被碰到」。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 默认测当前代码。可通过 PREDICTION_SRC 指向旧版本，用来验证「这套断言确实
// 抓得住修复前的行为」——否则测试全绿只能说明它没报错，不能说明它管用。
const SRC = process.env.PREDICTION_SRC || path.join(__dirname, '..', 'js', 'prediction.js');

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
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

// 本地存储垫片：prediction.js 用 localStorage 存记录，用真货会污染真实浏览器
const memory = new Map();
const localStorage = {
    getItem: k => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => { memory.set(k, String(v)); },
    removeItem: k => { memory.delete(k); },
};

const sandbox = {
    console, Date, Math, JSON, Object, Array, String, Number,
    Boolean, Error, RegExp, isFinite, isNaN, parseFloat, parseInt,
    Set, Map, localStorage, setTimeout, clearTimeout,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(
    fs.readFileSync(SRC, 'utf8') + '\n;globalThis.__PT = PredictionTracker;',
    sandbox, { filename: 'prediction.js' }
);
const PT = sandbox.__PT;

// ---------------- 测试用数据 ----------------
//
// 两组K线刻意用完全不同的量级：ETH 在 2700 附近，BTC 在 86000 附近。
// 一旦复盘串了标的，涨跌幅会大出三个数量级，一眼可辨。

const INTERVAL_SECONDS = 4 * 3600;                 // 4 小时周期
const BAR_SEC = INTERVAL_SECONDS;
const RESOLVE_AT = Date.now() - 3600 * 1000;       // 1 小时前到期，保证「已到期」
const TARGET_SEC = Math.floor(RESOLVE_AT / 1000);

/** 造 5 根K线：下标 2 那根正好压在 resolveAt 上，就是复盘要取的那一根 */
function makeCandles(baseClose, step) {
    return [0, 1, 2, 3, 4].map(i => ({
        time: TARGET_SEC - 2 * BAR_SEC + i * BAR_SEC,
        open: baseClose, high: baseClose, low: baseClose,
        close: baseClose + i * step,
        volume: 1,
    }));
}
const ETH_CANDLES = makeCandles(2700, 10);    // 复盘价 2720（+0.74%，高于 0.3% 判定阈值）
const BTC_CANDLES = makeCandles(86000, 200);  // 复盘价 86400（+0.47%，同样高于阈值）

const ETH_RESOLVED_CLOSE = 2720;
const BTC_RESOLVED_CLOSE = 86400;

function resetStore() { memory.clear(); }

/** 直接写入一条到期且未复盘的记录（id 显式给出，避免去重逻辑干扰） */
function seed(over) {
    const list = PT.load();
    list.push(Object.assign({
        id: 'seed-' + list.length,
        coinId: 'ethereum',
        coinSymbol: 'ETH',
        timeframe: 4,
        signalType: 'buy',
        signalText: '买入',
        score: 60,
        price: 2700,
        predictedAt: RESOLVE_AT - INTERVAL_SECONDS * 5000,
        resolveAt: RESOLVE_AT,
        algoVersion: null, factors: null, criteria: null,
        evalPrice: null, changePct: null, correct: null,
    }, over));
    localStorage.setItem(PT.storageKey, JSON.stringify(list));
}

function byId(id) { return PT.load().find(r => r.id === id); }

// ============================================================
section('1. 一份K线只能复盘它自己的标的');

resetStore();
seed({ id: 'eth-1', coinId: 'ethereum', timeframe: 4, price: 2700 });
seed({ id: 'btc-1', coinId: 'bitcoin', coinSymbol: 'BTC', timeframe: 4, price: 86000 });

// 场景：用户正在看 BTC，于是传进来的是 BTC 的K线。库里同时躺着 ETH 的记录。
eq(PT.evaluate(BTC_CANDLES, 'bitcoin', 4), true, '传 BTC 的K线 → 有记录被复盘');
eq(byId('btc-1').evalPrice, BTC_RESOLVED_CLOSE, 'BTC 记录的复盘价 = BTC 自己的收盘价');
eq(byId('btc-1').correct, true, 'BTC 记录判定正确');

// 这条就是用户报的问题：ETH 的 2700 被写成了 86200
eq(byId('eth-1').evalPrice, null, 'ETH 的记录没有被 BTC 的K线碰过（原缺陷的现场）');
eq(byId('eth-1').correct, null, 'ETH 记录仍保持未复盘');

// 反过来，看 ETH 时也不能碰 BTC 的记录
eq(PT.evaluate(ETH_CANDLES, 'ethereum', 4), true, '传 ETH 的K线 → ETH 的记录此时才被复盘');
eq(byId('eth-1').evalPrice, ETH_RESOLVED_CLOSE, 'ETH 记录的复盘价 = ETH 自己的收盘价');
eq(byId('btc-1').evalPrice, BTC_RESOLVED_CLOSE, 'BTC 已复盘的结论没有被 ETH 的K线改写');

// ============================================================
section('2. 周期也必须一致');

resetStore();
seed({ id: 'eth-4h', coinId: 'ethereum', timeframe: 4, price: 2700 });
seed({ id: 'eth-1h', coinId: 'ethereum', timeframe: 1, price: 2700 });

eq(PT.evaluate(ETH_CANDLES, 'ethereum', 4), true, '传 4h 的K线 → 有记录被复盘');
eq(byId('eth-4h').evalPrice, ETH_RESOLVED_CLOSE, '4h 的记录被复盘');
eq(byId('eth-1h').evalPrice, null, '1h 的记录没有被 4h 的K线复盘');
eq(byId('eth-1h').correct, null, '1h 记录仍保持未复盘');

// ============================================================
section('3. 信息不足时宁可不复盘（fail closed）');

resetStore();
seed({ id: 'eth-5', coinId: 'ethereum', timeframe: 4, price: 2700 });

eq(PT.evaluate(ETH_CANDLES), false, '不传 coinId → 返回 false，一条都不复盘');
eq(PT.evaluate(ETH_CANDLES, ''), false, 'coinId 为空字符串 → 返回 false');
eq(PT.evaluate(ETH_CANDLES, null, 4), false, 'coinId 为 null → 返回 false');
eq(byId('eth-5').correct, null, '以上三种情况都没有写坏这条记录');
eq(byId('eth-5').evalPrice, null, 'evalPrice 也仍为 null');

eq(PT.evaluate([], 'ethereum', 4), false, 'K线为空 → 返回 false');
eq(PT.evaluate([ETH_CANDLES[0]], 'ethereum', 4), false, '只有一根K线 → 返回 false');

// ============================================================
section('4. 已复盘的记录不许被改写');

resetStore();
seed({ id: 'eth-6', coinId: 'ethereum', timeframe: 4, price: 2700 });
PT.evaluate(ETH_CANDLES, 'ethereum', 4);
const firstEval = byId('eth-6').evalPrice;

// 再跑一次，这次换成 BTC 的K线，也不能覆盖已有结论
PT.evaluate(BTC_CANDLES, 'bitcoin', 4);
eq(byId('eth-6').evalPrice, firstEval, '已写入的复盘价不会被后续复盘改写');
eq(byId('eth-6').correct, true, '已复盘的结论保持不变');

// ============================================================
section('5. 判定规则回归（这次改动不该影响口径）');

resetStore();
seed({ id: 'r-buy-up', signalType: 'buy', price: 2700 });
PT.evaluate(ETH_CANDLES, 'ethereum', 4);
eq(byId('r-buy-up').correct, true, '买入 + 涨 0.74%（> 0.3%）→ 正确');

resetStore();
seed({ id: 'r-buy-down', signalType: 'buy', price: 2800 });
PT.evaluate(ETH_CANDLES, 'ethereum', 4);
eq(byId('r-buy-down').correct, false, '买入 + 跌 2.86% → 错误');

resetStore();
seed({ id: 'r-sell-down', signalType: 'sell', price: 2800 });
PT.evaluate(ETH_CANDLES, 'ethereum', 4);
eq(byId('r-sell-down').correct, true, '卖出 + 跌 2.86% → 正确');

resetStore();
seed({ id: 'r-hold-flat', signalType: 'hold', price: 2710 });
PT.evaluate(ETH_CANDLES, 'ethereum', 4);
eq(byId('r-hold-flat').correct, true, '观望 + 涨 0.37%（|涨跌| ≤ 2%）→ 正确');

resetStore();
seed({ id: 'r-hold-move', signalType: 'hold', price: 2500 });
PT.evaluate(ETH_CANDLES, 'ethereum', 4);
eq(byId('r-hold-move').correct, false, '观望 + 涨 8.8%（> 2%）→ 错误');

resetStore();
seed({ id: 'r-notdue', resolveAt: Date.now() + 3600 * 1000 });
eq(PT.evaluate(ETH_CANDLES, 'ethereum', 4), false, '未到期 → 不复盘');
eq(byId('r-notdue').correct, null, '未到期的 correct 仍为 null');

// ============================================================
section('6. record() 写出的字段仍是复盘所依赖的那些');

resetStore();
const added = PT.record({
    coinId: 'ethereum', coinSymbol: 'ETH', timeframe: 4,
    signalType: 'buy', signalText: '买入', score: 60,
    price: 2700, intervalSeconds: INTERVAL_SECONDS,
    algoVersion: '1.0.1', factors: { a: 1 }, criteria: { b: 2 },
});
eq(added, true, 'record() 新增成功');

const rec = PT.load()[PT.load().length - 1];
eq(rec.coinId, 'ethereum', 'record() 写入了 coinId（复盘靠它核对标的）');
eq(rec.timeframe, 4, 'record() 写入了 timeframe（复盘靠它核对周期）');
eq(typeof rec.resolveAt, 'number', 'record() 写入了 resolveAt');
eq(rec.resolveAt - rec.predictedAt, PT.getHorizonMs(INTERVAL_SECONDS),
    '复盘窗口 = 周期 5 根K线（4h → 20 小时）');
eq(rec.correct, null, '新记录初始为未复盘');

// 把这条记录拉回「已到期」，验证 record() 造出来的形状确实能被复盘流程处理
const list = PT.load();
list[list.length - 1].resolveAt = Date.now() - 1000;
localStorage.setItem(PT.storageKey, JSON.stringify(list));

const dueSec = Math.floor((Date.now() - 1000) / 1000);
const tailor = [0, 1, 2].map(i => ({
    time: dueSec + i * BAR_SEC,
    open: 2700, high: 2700, low: 2700, close: 2710, volume: 1,
}));
eq(PT.evaluate(tailor, 'ethereum', 4), true, 'record() 造出的记录能被复盘流程正常处理');
eq(byId(rec.id).correct, true, '并且判定结果正确（涨 0.37% → 买入算对）');

// ============================================================
section('7. 核对记号：批量复核不该为同一批老记录反复取K线');

// 核对一致的记录要打上记号，否则每一轮批量复核都会为它重新取一次K线，永远跑不完
resetStore();
seed({ id: 'ck-1', coinId: 'ethereum', timeframe: 4, price: 2700 });
PT.evaluate(ETH_CANDLES, 'ethereum', 4);
eq(byId('ck-1').evalPrice, ETH_RESOLVED_CLOSE, '先正常完成一次复盘');
eq(byId('ck-1').reviewCheckedAt, undefined, '此时还没有核对记号');

eq(PT.verifyResolved(ETH_CANDLES, 'ethereum', 4), 0, '存值与实际一致 → 不产生修正');
ok(typeof byId('ck-1').reviewCheckedAt === 'number', '核对通过后留下记号');
eq(PT.getReviewGroups().length, 0, '已核对且无待复盘的组，不再出现在工作量里');

// 被修正的记录同样要打记号
resetStore();
seed({ id: 'ck-2', coinId: 'ethereum', timeframe: 4, price: 2700, evalPrice: 9999, changePct: 2.7, correct: true });
eq(PT.verifyResolved(ETH_CANDLES, 'ethereum', 4), 1, '存值与实际不符 → 修正 1 条');
ok(typeof byId('ck-2').reviewCheckedAt === 'number', '被修正的记录同样留下记号');
eq(PT.getReviewGroups().length, 0, '修正过的组也不再出现');

// 核不到的（K线覆盖不到那个时点）不打记号，留给以后重试
resetStore();
seed({
    id: 'ck-3', coinId: 'ethereum', timeframe: 4, price: 2700,
    evalPrice: 2700, changePct: 0, correct: true,
    resolveAt: Date.now() + 11 * 24 * 3600 * 1000,
});
eq(PT.verifyResolved(ETH_CANDLES, 'ethereum', 4), 0, 'K线覆盖不到 → 不动它');
eq(byId('ck-3').reviewCheckedAt, undefined, '核不到就不打记号，留给以后再试');

// 有待复盘的组始终要列出，且计数正确
resetStore();
seed({ id: 'ck-4', coinId: 'ethereum', timeframe: 4, price: 2700 });
const grp = PT.getReviewGroups();
eq(grp.length, 1, '有待复盘的组会被列出');
eq(grp[0].pending, 1, 'pending 计数正确');
eq(grp[0].verify, 0, '这一组没有待核对的记录');
eq(grp[0].coinId, 'ethereum', '组信息带上了币种');

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
