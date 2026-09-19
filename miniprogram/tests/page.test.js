'use strict';
// 整体包在 async IIFE 里，以便使用顶层 await（文件仍是 CommonJS）
(async () => {

/**
 * 页面端到端测试（在 Node 里跑完整生命周期）
 *
 * 运行：node miniprogram/tests/page.test.js
 *
 * 这里验证的是「onLoad → 取数 → 分析 → setData」这条链路真的走通了 ——
 * 上一版测试只覆盖到纯逻辑，而字段名写错、异步没等、早退分支漏了
 * 这类问题只有把页面跑起来才看得出来。
 */

const path = require('path');
const harness = require('./harness.js');

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

const INDEX = path.join(__dirname, '..', 'pages', 'index', 'index.js');
const DETAIL = path.join(__dirname, '..', 'pages', 'detail', 'detail.js');

function tick(ms) {
    return new Promise(function (r) { setTimeout(r, ms || 30); });
}

// ============================================================
section('1. 详情页 · 美股（AAPLUSDT）');

{
    const env = harness.makeEnv();
    env.setFetch(harness.fakeBinance({ dailyBars: 166 }));
    const page = env.makePage(DETAIL);

    page.onLoad({ coinId: 'aapl', market: 'futures', symbol: 'AAPLUSDT' });
    await tick(60);

    const d = page.data;
    eq(d.error, '', '没有进入错误状态');
    eq(d.error, '', '没有进入错误状态');
    ok(!d.loading, '加载结束，不再显示加载中');
    ok(d.price !== '--' && d.price !== undefined, '价格已填充：' + d.price);
    eq(d.price, '335.00', '价格按合约行情渲染');
    eq(d.changePercent, '+1.52%', '24h 涨跌幅带正号');
    eq(d.dirClass, 'up', '上涨用 up 类名');
    ok(d.amountText !== '--', '成交额已格式化：' + d.amountText);

    eq(d.isStock, true, '识别为美股');
    eq(d.bars, 166, '日线拿到 166 根');

    // 这是本次最关键的断言：MA200 不可得时必须降级并如实标注
    eq(d.longMALabel, 'MA150 牛熊线', '长期均线降级到 MA150 并写进标题');
    ok(d.longMAValue !== '不可用' && d.longMAValue !== '--', '长期均线有实际数值：' + d.longMAValue);
    ok(d.longMANote.indexOf('不足 200') >= 0, '注明为什么不是 MA200');
    ok(d.longMANote.indexOf('MA150') >= 0, '注明实际用的是 MA150');
    ok(d.depthNote && d.depthNote.indexOf('MA150') >= 0, '顶部提示条也说明改用 MA150');

    // 个股只应有技术面与量能参与
    const byLabel = {};
    d.factors.forEach(function (f) { byLabel[f.label] = f; });
    ok(byLabel['技术面'].value !== '—', '技术面参与评分：' + byLabel['技术面'].value);
    ok(byLabel['量能'].value !== '—', '量能参与评分：' + byLabel['量能'].value);
    eq(byLabel['情绪面'].value, '—', '情绪面对个股显示不适用');
    eq(byLabel['消息面'].value, '—', '消息面显示不适用');
    eq(byLabel['衍生品'].value, '—', '衍生品对个股显示不适用');
    ok(byLabel['情绪面'].naReason.indexOf('个股') >= 0, '情绪面给出了原因');
    ok(byLabel['衍生品'].naReason.indexOf('费率') >= 0, '衍生品给出了原因');

    ok(typeof d.signal.totalScore === 'number' && d.signal.totalScore > 0 && d.signal.totalScore <= 100,
        '综合评分是 0~100 的数字：' + d.signal.totalScore);
    ok(d.signal.text && d.signal.text.length > 0, '信号文案已生成：' + d.signal.text);
    ok(d.excludedNote.indexOf('消息面') >= 0, '如实列出未参与的因子');
    ok(d.indicators.length >= 6, '技术指标面板有内容');
    ok(d.levels.length === 4, '给出四个关键价位');
    ok(Array.isArray(d.tips) && d.tips.length > 0, '给出了操作建议 ' + d.tips.length + ' 条');
    ok(!!d.advice && d.advice.buyZones.length === 2, '给出加仓区间');

    // 画布确实画了东西
    ok(env.state.canvasCtx.calls.clearRect === 1, '画布被清空一次');
    ok(env.state.canvasCtx.calls.fillRect > 100, '画布画出了蜡烛与成交量：' + env.state.canvasCtx.calls.fillRect + ' 个填充块');
}

// ============================================================
section('2. 详情页 · 加密币（BTCUSDT）');

{
    const env = harness.makeEnv();
    env.setFetch(harness.fakeBinance({ dailyBars: 250 }));
    const page = env.makePage(DETAIL);

    page.onLoad({ coinId: 'bitcoin', market: 'spot', symbol: 'BTCUSDT' });
    await tick(120);

    const d = page.data;
    eq(d.isStock, false, '识别为加密币');
    eq(d.bars, 250, '日线 250 根');
    eq(d.longMALabel, 'MA200 牛熊线', '历史够长时用原始 MA200，不降级');
    eq(d.longMANote, '', '未降级时不显示降级说明');
    eq(d.depthNote, '', '未降级时没有深度提示');

    const byLabel = {};
    d.factors.forEach(function (f) { byLabel[f.label] = f; });
    ok(byLabel['情绪面'].value !== '—', '加密币的情绪面参与评分：' + byLabel['情绪面'].value);
    ok(byLabel['衍生品'].value !== '—', '加密币的衍生品参与评分：' + byLabel['衍生品'].value);
    eq(byLabel['消息面'].value, '—', '消息面仍显示不适用（本版未接入资讯源）');
    ok(d.excludedNote.indexOf('消息面') >= 0, '如实说明消息面未接入');
    ok(d.excludedNote.indexOf('情绪面') < 0, '不应把情绪面误报为未参与');
}

// ============================================================
section('3. 详情页 · 美股周线（K线不够，连最短窗口都撐不住）');

{
    const env = harness.makeEnv();
    env.setFetch(harness.fakeBinance());
    const page = env.makePage(DETAIL);

    // 先把周期设成周线
    env.storage.cp_settings = { sensitivity: 'balanced', timeframe: '168' };
    page.onLoad({ coinId: 'aapl', market: 'futures', symbol: 'AAPLUSDT' });
    await tick(60);

    const d = page.data;
    eq(d.bars, 24, '周线 24 根');
    eq(d.longMAValue, '不可用', '连 MA60 都不够时显示不可用');
    ok(d.longMANote.indexOf('不足 60') >= 0, '说明是根数不足 60');
    ok(d.longMANote.indexOf('未参与评分') >= 0, '说明这一项没参与评分');
    ok(typeof d.signal.totalScore === 'number', '即便如此评分仍是有效数字');
}

// ============================================================
section('4. 详情页 · 周期切换与灵敏度切换');

{
    const env = harness.makeEnv();
    env.setFetch(harness.fakeBinance({ dailyBars: 250 }));
    const page = env.makePage(DETAIL);

    page.onLoad({ coinId: 'bitcoin', market: 'spot', symbol: 'BTCUSDT' });
    await tick(80);
    const before = page.data.signal.totalScore;

    await page.switchTimeframe({ currentTarget: { dataset: { key: '1' } } });
    await tick(80);
    eq(page.data.timeframe, '1', '周期切到 1 小时');
    eq(page.data.timeframeLabel, '1小时', '标题同步更新');
    eq(env.storage.cp_settings.timeframe, '1', '周期选择被记住');

    await page.switchSensitivity({ currentTarget: { dataset: { key: 'sensitive' } } });
    await tick(20);
    eq(page.data.sensitivity, 'sensitive', '灵敏度切到灵敏档');
    eq(env.storage.cp_settings.sensitivity, 'sensitive', '灵敏度被记住');
    ok(page.data.factors.length === 5, '切换后因子面板仍然完整');
    void before;

    // 同一个币种重复点同一个档位不应触发重算
    const calls = page._setDataCalls;
    await page.switchSensitivity({ currentTarget: { dataset: { key: 'sensitive' } } });
    eq(page._setDataCalls, calls, '重复点同一档位不做多余渲染');
}

// ============================================================
section('5. 详情页 · 自选开关');

{
    const env = harness.makeEnv();
    env.setFetch(harness.fakeBinance());
    const page = env.makePage(DETAIL);

    page.onLoad({ coinId: 'nvda', market: 'futures', symbol: 'NVDAUSDT' });
    await tick(60);

    eq(page.data.watched, false, '默认不在自选里');
    page.toggleWatch();
    eq(page.data.watched, true, '加入后状态变为已自选');
    ok(Array.isArray(env.storage.cp_watchlist), '自选列表已写入存储');
    ok(env.storage.cp_watchlist.indexOf('nvda') >= 0, 'nvda 进入了自选列表');

    page.toggleWatch();
    eq(page.data.watched, false, '再次点击移出自选');
    ok(env.storage.cp_watchlist.indexOf('nvda') < 0, 'nvda 从自选列表移除');
}

// ============================================================
section('6. 列表页 · 自选分类');

{
    const env = harness.makeEnv();
    env.setFetch(harness.fakeBinance());
    const page = env.makePage(INDEX);

    page.onLoad();
    await tick(100);

    const d = page.data;
    eq(d.error, '', '没有进入错误状态');
    ok(d.list.length === 5, '默认自选 5 个：' + d.list.length);
    eq(d.list[0].symbol, 'BTC', '第一个是 BTC');
    eq(d.list[0].market, 'spot', '自选里的加密币走现货');
    ok(d.list[0].price !== null && d.list[0].price !== undefined, '行情已填充：' + d.list[0].price);
    ok(d.list[0].changePercent.indexOf('%') >= 0, '涨跌幅带百分号');
    eq(d.list[0].watched, true, '自选里的标的星标为已选中');
}

// ============================================================
section('7. 列表页 · 美股分类');

{
    const env = harness.makeEnv();
    env.setFetch(harness.fakeBinance({ equitySymbols: ['AAPLUSDT', 'TSLAUSDT', 'NVDAUSDT'] }));
    const page = env.makePage(INDEX);

    page.onLoad();
    await tick(60);

    await page.switchCat({ currentTarget: { dataset: { key: 'stock' } } });
    await tick(120);

    const d = page.data;
    eq(d.cat, 'stock', '分类切到美股');
    eq(d.list.length, 3, '美股目录拿到 3 个标的');
    eq(d.list[0].market, 'futures', '美股标的标记为合约');
    eq(d.list[0].symbol, 'AAPL', '代码正确');
    eq(d.list[0].name, '苹果', '中文名从映射表取到');
    ok(d.list[0].price !== null && d.list[0].price !== '--', '美股行情已填充：' + d.list[0].price);
}

// ============================================================
section('8. 列表页 · 搜索（跨分类）');

{
    const env = harness.makeEnv();
    env.setFetch(harness.fakeBinance({ equitySymbols: ['AAPLUSDT', 'TSLAUSDT'] }));
    const page = env.makePage(INDEX);

    page.onLoad();
    await tick(60);

    // 关键点：当前停在「自选」分类，也应能搜到美股与现货
    await page.runSearch('aapl');
    await tick(150);

    const d = page.data;
    ok(d.results.length >= 1, '搜到结果：' + d.results.length + ' 个');
    eq(d.results[0].symbol, 'AAPL', 'AAPL 能搜到');
    eq(d.results[0].market, 'futures', '并且标记为合约 —— 不会与现货混淆');

    await page.runSearch('btc');
    await tick(150);
    const btc = page.data.results.filter(r => r.symbol === 'BTC');
    ok(btc.length >= 1, '现货也能搜到（BTC）');
    eq(btc[0].market, 'spot', '现货标的标记为 spot');

    await page.runSearch('zzzzzz');
    await tick(150);
    eq(page.data.results.length, 0, '搜不到时返回空数组而不是报错');
    eq(page.data.error, '', '搜不到不算错误');

    page.clearKeyword();
    eq(page.data.keyword, '', '清空关键词');
    eq(page.data.results.length, 0, '清空后结果一起清掉');
}

// ============================================================
section('9. 列表页 · 加入自选后出现在自选分类');

{
    const env = harness.makeEnv();
    env.setFetch(harness.fakeBinance({ equitySymbols: ['AAPLUSDT'] }));
    const page = env.makePage(INDEX);

    page.onLoad();
    await tick(60);

    await page.switchCat({ currentTarget: { dataset: { key: 'stock' } } });
    await tick(120);
    eq(page.data.list[0].watched, false, '美股标的默认不在自选');

    page.toggleWatch({
        currentTarget: {
            dataset: {
                coinid: 'aapl', symbol: 'AAPL', market: 'futures', binancesymbol: 'AAPLUSDT',
            },
        },
    });
    await tick(60);
    eq(page.data.list[0].watched, true, '点星号后变为已自选');

    await page.switchCat({ currentTarget: { dataset: { key: 'watch' } } });
    await tick(150);
    const aapl = page.data.list.filter(c => c.coinId === 'aapl');
    eq(aapl.length, 1, '加入到自选后出现在自选分类里');
    eq(aapl[0].market, 'futures', '元数据保留了合约身份 —— 详情页据此决定去哪个接口');
}

// ============================================================
section('10. 错误处理：域名校验失败要给出可操作的提示');

{
    const env = harness.makeEnv();
    env.setFetch(function () {
        const e = new Error('request:fail url not in domain list');
        e.isNetwork = true;
        return Promise.reject(e);
    });
    const page = env.makePage(INDEX);

    page.onLoad();
    await tick(60);

    const msg = page.data.error;
    ok(msg.length > 0, '错误状态被置上');
    ok(msg.indexOf('不校验合法域名') >= 0, '提示里直接给出开发者工具的勾选项');
    ok(msg.indexOf('本地设置') >= 0, '指出在哪个面板设置');

    // 详情页同样要给出可操作的提示
    const env2 = harness.makeEnv();
    env2.setFetch(function () {
        return Promise.reject(new Error('request:fail url not in domain list'));
    });
    const p2 = env2.makePage(DETAIL);
    p2.onLoad({ coinId: 'bitcoin', market: 'spot', symbol: 'BTCUSDT' });
    await tick(60);
    ok(p2.data.error.indexOf('不校验合法域名') >= 0, '详情页也有同样的提示');
    ok(!p2.data.loading, '错误后不再卡在加载中');
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
