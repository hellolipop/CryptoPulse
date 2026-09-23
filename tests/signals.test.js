'use strict';
/**
 * 信号生成模块 —— 单元测试（重点覆盖「仓位提示必须与信号标签一致」）
 *
 * 运行：node tests/signals.test.js
 *
 * 背景：仓位提示原来在 generateActionTips 里把 70/58/42/30 写死，不随灵敏度
 * 档位变化，而信号标签用的是档位阈值。于是保守档与灵敏档下两者会互相矛盾：
 *   保守档 61 分：标签「观望」，提示却说「仓位 30-50%」
 *   灵敏档 56 分：标签「买入」，提示却说「等待更明确的信号」
 * 1.0.1 改为按 signalType 分流。这里把「不一致」这件事本身做成断言：
 * 三档 × 0~100 全部分值，逐分比对提示与标签。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'js', 'signals.js');
const APP_SRC = path.join(__dirname, '..', 'js', 'app.js');

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
    Boolean, Error, RegExp, isFinite, isNaN, parseFloat, parseInt, Set, Map,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(
    fs.readFileSync(SRC, 'utf8') + '\n;globalThis.__SG = SignalGenerator;',
    sandbox, { filename: 'signals.js' }
);
const SG = sandbox.__SG;

// 灵敏度档位的阈值。这里的数字必须与 js/app.js 的 sensitivityPresets 一致，
// 下面第 1 节会用正则从 app.js 里读出来核对，避免测试数据悄悄过期。
const PRESETS = {
    保守: { strongBuy: 74, buy: 63, sell: 37, strongSell: 26 },
    均衡: { strongBuy: 70, buy: 58, sell: 42, strongSell: 30 },
    灵敏: { strongBuy: 66, buy: 54, sell: 46, strongSell: 34 },
};

// 每个信号类型唯一对应的仓位提示原文
const TIP_BY_TYPE = {
    strong_buy: '综合评分较高，可考虑分批建仓，仓位控制在60-80%',
    buy: '整体偏多，可轻仓试探，逢回调加仓，仓位30-50%',
    hold: '方向不明，建议观望，等待更明确的信号',
    sell: '整体偏空，降低仓位至30%以下，控制风险',
    strong_sell: '风险较高，建议减仓至20%以下，或离场观望',
};

function mk(score, thresholds) {
    return SG.generateSignal(
        { score: 50, signals: [], breakdown: {} },
        { score: 50, topNews: [], label: 'neutral', positiveCount: 0, negativeCount: 0 },
        {
            totalScore: score, thresholds,
            supportResistance: null, currentPrice: 100,
            sentimentScore: 50, derivativesScore: 50, volumeScore: 50, breakdown: {},
        }
    );
}

/** 从操作建议里找出「仓位类」那一句，返回它对应的信号类型；找不到或有歧义返回 null */
function posTipType(tips) {
    const texts = (tips || []).map(t => t.text);
    const hit = Object.keys(TIP_BY_TYPE).filter(k => texts.indexOf(TIP_BY_TYPE[k]) > -1);
    return hit.length === 1 ? hit[0] : null;
}

// ============================================================
section('1. 测试数据自检：档位阈值必须与 app.js 里的一致');

{
    const appText = fs.readFileSync(APP_SRC, 'utf8');
    const found = [...appText.matchAll(
        /thresholds:\s*\{\s*strongBuy:\s*(\d+),\s*buy:\s*(\d+),\s*sell:\s*(\d+),\s*strongSell:\s*(\d+)\s*\}/g
    )].map(m => ({
        strongBuy: +m[1], buy: +m[2], sell: +m[3], strongSell: +m[4],
    }));

    eq(found.length, 3, 'app.js 里能读到 3 组档位阈值（保守 / 均衡 / 灵敏）');
    const order = ['保守', '均衡', '灵敏'];
    order.forEach((label, i) => {
        const want = PRESETS[label];
        const got = found[i];
        ok(!!got && got.strongBuy === want.strongBuy && got.buy === want.buy
            && got.sell === want.sell && got.strongSell === want.strongSell,
            `${label}档阈值与 app.js 一致（${want.strongBuy}/${want.buy}/${want.sell}/${want.strongSell}）`,
            got ? `app.js 里是 ${got.strongBuy}/${got.buy}/${got.sell}/${got.strongSell}` : '读取失败');
    });
}

// ============================================================
section('2. 五个信号类型各自对应唯一一句仓位提示');

{
    const types = Object.keys(TIP_BY_TYPE);
    types.forEach(t => {
        const s = { strong_buy: 80, buy: 62, hold: 50, sell: 38, strong_sell: 20 }[t];
        const sig = mk(s, PRESETS.均衡);
        eq(sig.type, t, `均衡档 ${s} 分的信号类型是 ${t}`);
        eq(posTipType(sig.actionTips), t, `${t} 对应的仓位提示可被唯一识别`);
    });

    // 提示文案里的仓位数字（README「综合评分」表引用的就是这几句）
    const expect = {
        strong_buy: '60-80%',
        buy: '30-50%',
        sell: '30%',
        strong_sell: '20%',
    };
    Object.keys(expect).forEach(t => {
        ok(TIP_BY_TYPE[t].indexOf(expect[t]) > -1, `${t} 的提示含 ${expect[t]}`, TIP_BY_TYPE[t]);
    });
    ok(TIP_BY_TYPE.hold.indexOf('仓位') === -1 && TIP_BY_TYPE.hold.indexOf('减仓') === -1,
        '观望的提示里不给仓位数字');
}

// ============================================================
section('3. 核心不变量：三档 × 0~100 全部分值，提示与标签都必须一致');

{
    for (const label of Object.keys(PRESETS)) {
        const th = PRESETS[label];
        const bad = [];
        for (let s = 0; s <= 100; s++) {
            const sig = mk(s, th);
            const tip = posTipType(sig.actionTips);
            if (tip !== sig.type) {
                bad.push(`${s} 分：标签 ${sig.type}，提示 ${tip === null ? '（找不到）' : tip}`);
            }
        }
        ok(bad.length === 0, `${label}档 0~100 共 101 个分值全部一致`,
            bad.slice(0, 3).join('；') + (bad.length > 3 ? ` …共 ${bad.length} 处` : ''));
    }
}

// ============================================================
section('4. 回归：修复前会互相矛盾的那两个具体分值');

{
    // 保守档 61 分：标签是观望（< 63），旧代码因为 61 >= 58 给出「仓位30-50%」
    const a = mk(61, PRESETS.保守);
    eq(a.type, 'hold', '保守档 61 分的标签是观望');
    eq(posTipType(a.actionTips), 'hold', '保守档 61 分的提示也是观望，不再说「仓位30-50%」');

    // 灵敏档 56 分：标签是买入（>= 54），旧代码因为 56 < 58 给出「等待更明确的信号」
    const b = mk(56, PRESETS.灵敏);
    eq(b.type, 'buy', '灵敏档 56 分的标签是买入');
    eq(posTipType(b.actionTips), 'buy', '灵敏档 56 分的提示也是买入，不再说「等待更明确的信号」');

    // 档位边界处的仓位提示必须跟着档位走
    const cases = [
        ['保守', 63, 'buy'], ['保守', 62, 'hold'],
        ['灵敏', 54, 'buy'], ['灵敏', 53, 'hold'],
        ['保守', 26, 'strong_sell'], ['保守', 27, 'sell'],
        ['灵敏', 34, 'strong_sell'], ['灵敏', 35, 'sell'],
    ];
    cases.forEach(([label, s, want]) => {
        const sig = mk(s, PRESETS[label]);
        eq(sig.type, want, `${label}档 ${s} 分标签为 ${want}`);
        eq(posTipType(sig.actionTips), want, `${label}档 ${s} 分的仓位提示与标签一致`);
    });
}

// ============================================================
section('5. 算法版本号');

{
    ok(/^\d+\.\d+\.\d+$/.test(SG.ALGORITHM_VERSION),
        'ALGORITHM_VERSION 是 x.y.z 形式', String(SG.ALGORITHM_VERSION));
    ok(SG.ALGORITHM_VERSION !== '1.0.0',
        '仓位提示逻辑改动后版本号已离开 1.0.0 基线', String(SG.ALGORITHM_VERSION));
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
