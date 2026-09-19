'use strict';
/**
 * 技术分析模块 —— 单元测试（重点覆盖长期均线的窗口降级）
 *
 * 运行：node tests/technical.test.js
 *
 * 背景：MA200 需要 200 根K线，但标的可能比 200 根还年轻。实测币安美股合约
 * 2026-04-06 才上线，日线只有 166 根、周线只有 24 根；带 startTime 回溯和换
 * indexPriceKlines / markPriceKlines 都取不到更早的数据 —— 这是标的年龄的限制。
 *
 * 所以这里的重点是验证降级行为「可预测且不撒谎」：
 *   - 挑窗口的规则稳定（挑最长可用）
 *   - 降级后信号文案必须点明实际窗口，不能让用户以为看的是 MA200
 *   - 连最短窗口都不够时必须显式记录「这项没参与」，而不是静默消失
 *   - 老调用方式（只传 ma200 数组）不能被破坏
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'js', 'technical.js');

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

const sandbox = {
    console, Date, Math, JSON, Object, Array, String, Number,
    Boolean, Error, RegExp, isFinite, isNaN, parseFloat, parseInt,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(
    fs.readFileSync(SRC, 'utf8') + '\n;globalThis.__TA = TechnicalAnalysis;',
    sandbox, { filename: 'technical.js' }
);
const TA = sandbox.__TA;

/** 构造一个「只喂长期均线相关输入」的最小指标对象 */
function scoreWith(longMA) {
    const flat = (n, v) => new Array(n).fill(v);
    return TA.calculateTechnicalScore({
        ma7: flat(4, 100),
        ma25: flat(4, 100),
        currentPrice: 120,
        longMA,
    });
}

// ============================================================
section('1. 挑窗口：必须挑最长可用的那个');

{
    eq(TA.pickLongMAWindow(500), 200, '500 根 → MA200');
    eq(TA.pickLongMAWindow(200), 200, '正好 200 根 → MA200');
    eq(TA.pickLongMAWindow(199), 150, '199 根 → 降一档到 MA150');
    eq(TA.pickLongMAWindow(166), 150, '实测美股日线 166 根 → MA150');
    eq(TA.pickLongMAWindow(150), 150, '正好 150 根 → MA150');
    eq(TA.pickLongMAWindow(149), 120, '149 根 → MA120');
    eq(TA.pickLongMAWindow(120), 120, '正好 120 根 → MA120');
    eq(TA.pickLongMAWindow(99), 99, '99 根 → MA99');
    eq(TA.pickLongMAWindow(60), 60, '正好 60 根 → MA60');
    eq(TA.pickLongMAWindow(59), null, '59 根连 MA60 都不够 → 没有可用窗口');
    eq(TA.pickLongMAWindow(24), null, '实测美股周线 24 根 → 没有可用窗口');
    eq(TA.pickLongMAWindow(0), null, '0 根 → null');
    eq(TA.pickLongMAWindow(-5), null, '负数 → null');
    eq(TA.pickLongMAWindow(NaN), null, 'NaN → null');
    eq(TA.pickLongMAWindow(undefined), null, 'undefined → null');

    // 阶梯必须从长到短，否则会挑到一个比可用长度还长的窗口，算出全 null
    const ladder = TA.LONG_MA_LADDER;
    ok(ladder.every((v, i) => i === 0 || ladder[i - 1] > v), '阶梯严格递减');
    eq(ladder[0], 200, '阶梯最长档是 200（名义基准不能改）');
}

// ============================================================
section('2. resolveLongMA：两种输入形式都要能取到值');

{
    const withSeries = TA.resolveLongMA({ window: 150, series: [1, 2, 388], substituted: true }, null);
    eq(withSeries.window, 150, '新形式：窗口透传');
    eq(withSeries.substituted, true, '新形式：降级标记透传');
    eq(withSeries.value, 388, '新形式：取最后一点');

    const legacy = TA.resolveLongMA(undefined, [1, 2, 300]);
    eq(legacy.window, 200, '老形式（只传 ma200 数组）：按窗口 200 处理');
    eq(legacy.substituted, false, '老形式：不算降级');
    eq(legacy.value, 300, '老形式：取最后一点');

    eq(TA.resolveLongMA(null, null), null, '两种都缺 → null');
    eq(TA.resolveLongMA({ window: 150, series: [] }, null), null, '空序列 → null');
    eq(TA.resolveLongMA({ window: 150, series: [null, null] }, null), null, '窗口还没算出来的全 null 序列 → null');
    eq(TA.resolveLongMA(undefined, [null, null]), null, '老形式全 null → null');
    eq(TA.resolveLongMA(undefined, []), null, '空数组 → null');
}

// ============================================================
section('3. 大趋势项：窗口降级后必须说清楚用的是什么');

{
    const longSeries = [100, 100, 100];

    // 未降级
    const normal = scoreWith({ window: 200, series: longSeries, substituted: false });
    const sig200 = normal.signals.filter(s => s.indicator === 'MA200');
    eq(sig200.length, 1, 'MA200 可用时给出 1 条大趋势信号');
    eq(sig200[0].type, 'buy', '价格 120 高于均线 100 → 偏多');
    ok(sig200[0].text.indexOf('MA200') >= 0, '文案里是 MA200');
    ok(sig200[0].text.indexOf('不足') < 0, '未降级时不应出现「不足」字样');
    eq(normal.breakdown.longMA.window, 200, 'breakdown 记录窗口 200');
    eq(normal.breakdown.longMA.substituted, false, 'breakdown 记录未降级');

    // 降级到 150（实测美股日线的情形）
    const sub = scoreWith({ window: 150, series: longSeries, substituted: true });
    const sig150 = sub.signals.filter(s => s.indicator === 'MA150');
    eq(sig150.length, 1, '降级后给出 1 条大趋势信号');
    ok(sig150[0].text.indexOf('MA150') >= 0, '文案里点名 MA150');
    ok(sig150[0].text.indexOf('不足 MA200') >= 0, '文案里说明为什么不是 MA200');
    eq(sub.signals.filter(s => s.indicator === 'MA200').length, 0,
        '降级后不能再出现 MA200 字样的信号 —— 否则用户以为用的是 MA200');
    eq(sub.breakdown.longMA.window, 150, 'breakdown 记录实际窗口 150');
    eq(sub.breakdown.longMA.substituted, true, 'breakdown 记录已降级');

    // 这一项确实影响了分数：价格在均线上下应差 6 分
    const below = scoreWith({ window: 150, series: [200, 200, 200], substituted: true });
    eq(normal.score - below.score, 6, '价格从均线上方翻到下方，分数正好差 6 分（+3/-3）');

    // 老调用方式必须还能用
    const legacy = TA.calculateTechnicalScore({
        ma7: new Array(4).fill(100), ma25: new Array(4).fill(100),
        currentPrice: 120, ma200: [100, 100, 100],
    });
    eq(legacy.signals.filter(s => s.indicator === 'MA200').length, 1, '只传 ma200 数组的老调用仍然生效');
    eq(legacy.breakdown.longMA.window, 200, '老调用在 breakdown 里也记为窗口 200');
}

// ============================================================
section('4. 完全取不到时：必须显式留痕，不能静默消失');

{
    const none = scoreWith({ window: null, series: null, substituted: false, bars: 24 });

    eq(none.breakdown.longMA.window, null, 'breakdown 明确记为 null');
    eq(none.breakdown.longMA.value, null, 'breakdown 里没有值');
    eq(none.signals.filter(s => s.indicator === 'MA60').length, 0, '不产生任何长期均线信号');
    eq(none.signals.filter(s => s.indicator === 'MA200').length, 0, '也不冒充 MA200');
    ok(!isNaN(none.score), '分数仍是有效数字，不是 NaN');

    // 与「有长期均线」相比，分数确实少了这一项的影响
    const withMA = scoreWith({ window: 200, series: [100, 100, 100], substituted: false });
    eq(withMA.score - none.score, 3, '缺失这一项时，分数少了 +3 的大趋势确认');
}

// ============================================================
section('5. 降级用的 SMA 本身要算对');

{
    const closes = new Array(166).fill(10);
    const ma150 = TA.calculateSMA(closes, 150);
    eq(ma150.length, 166, 'SMA 长度与输入一致（前面补 null）');
    eq(ma150[148], null, '第 149 个位置还不足 150 个样本 → null');
    eq(ma150[149], 10, '第 150 个位置开始有值');
    eq(ma150[165], 10, '最后一点有值');
    eq(ma150.filter(v => v !== null).length, 166 - 149, '有效值个数 = 长度 - (窗口 - 1)');

    // 166 根时用 MA150，能取到 17 个有效点；若错用 MA200 则一个都没有
    eq(TA.pickLongMAWindow(166), 150, '166 根会选 MA150');
    const ma200 = TA.calculateSMA(closes, 200);
    eq(ma200.filter(v => v !== null).length, 0, '同样数据用 MA200 则完全取不到值 —— 这正是要降级的原因');
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
