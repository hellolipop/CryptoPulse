'use strict';
// 整体包在 async IIFE 里，以便使用顶层 await（文件仍是 CommonJS）
(async () => {

const fs = require('fs');
/**
 * CoinGecko 客户端 —— 单元测试
 *
 * 运行：node tests/coingecko.test.js
 *
 * 重点验证那些「错了会悄悄给出假数据」的地方：
 *   - 成交量按时间窗对齐是否算对（OHLC 端点本身没有成交量，全靠这一步近似）
 *   - 单位换算（CoinGecko 给毫秒，图表要秒）
 *   - 拿不到成交量时是否老实留空，而不是编一个数
 *   - 限频/不存在 的语义区分
 *   - 缓存与并发队列的行为
 */

const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'js', 'coingecko.js');

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

function makeEnv() {
    const sandbox = {
        console, TextEncoder, URL, Date, Math, JSON, Object, Array, String, Number,
        Boolean, Error, RegExp, isFinite, isNaN, parseFloat, parseInt, Promise,
        setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent,
        AbortController, Response: undefined,
        fetch: async () => { throw new Error('fetch 未打桩'); },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(
        fs.readFileSync(SRC, 'utf8') + '\n;globalThis.__CG = CoinGecko;',
        sandbox, { filename: 'coingecko.js' }
    );
    const CG = sandbox.__CG;
    CG._minIntervalMs = 0;   // 测试里不需要真等
    return { CG, sandbox };
}

function jsonRes(status, body) {
    const text = JSON.stringify(body);
    return {
        status,
        ok: status >= 200 && status < 300,
        text: async () => text,
        json: async () => JSON.parse(text),
    };
}

// ============================================================
section('1. 搜索：字段映射');

{
    const { CG, sandbox } = makeEnv();
    let calledUrl = '';
    sandbox.fetch = async (url) => {
        calledUrl = url;
        return jsonRes(200, {
            coins: [
                { id: 'ethgas-2', name: 'ETHGas', symbol: 'GWEI', market_cap_rank: 533, thumb: 't.png' },
                { id: 'bitcoin', name: 'Bitcoin', symbol: 'btc', market_cap_rank: 1 },
                { id: 'noid', name: 'No Symbol' },
            ],
        });
    };

    const out = await CG.search('gwei');
    ok(calledUrl.indexOf('/search') >= 0 && calledUrl.indexOf('query=gwei') >= 0, '请求打到了 /search 且带上关键词');
    eq(out.length, 3, '三条结果都被映射');
    eq(out[0].id, 'ethgas-2', 'id 正确');
    eq(out[0].symbol, 'GWEI', 'symbol 被转成大写');
    eq(out[1].symbol, 'BTC', '小写 symbol 也转成大写');
    eq(out[0].rank, 533, '市值排名正确');
    eq(out[1].rank, 1, '排名 1 保留（不能被当成 falsy 丢掉）');
    eq(out[2].symbol, '', '缺失 symbol 映射为空串而不是 undefined');

    const none = await CG.search('');
    eq(none.length, 0, '空关键词直接返回空数组、不发请求');
}

// ============================================================
section('2. 蜡烛组装：毫秒转秒 + 成交量按时间窗对齐');

{
    const { CG, sandbox } = makeEnv();

    // days=7 → 4 小时一根；时间戳是「收盘时间」
    const BAR = 4 * 3600 * 1000;
    const T1 = 1700000000000;          // 不能整除也没关系，桶按 T-BAR 划
    const ohlc = [
        [T1,     100, 110, 90, 105],
        [T1 + BAR, 105, 120, 100, 118],
    ];
    // 第 1 根蜡烛覆盖 (T1-BAR, T1]：T1-1h、T1-3h 在内，T1-5h 在外
    const vols = [
        [T1 - 1 * 3600 * 1000, 10],
        [T1 - 3 * 3600 * 1000, 5],
        [T1 - 5 * 3600 * 1000, 999],   // 属于上一根，不能算进来
        [T1 + 1 * 3600 * 1000, 7],     // 属于第 2 根
        [T1 + BAR, 3],                 // 边界：等于收盘时间，算第 2 根
    ];

    sandbox.fetch = async (url) => {
        if (url.indexOf('/ohlc') >= 0) return jsonRes(200, ohlc);
        if (url.indexOf('/market_chart') >= 0) return jsonRes(200, { prices: [], market_caps: [], total_volumes: vols });
        return jsonRes(404, {});
    };

    const built = await CG.buildCandles('ethgas-2', 7);
    eq(built.candles.length, 2, '两根蜡烛都保留');
    eq(built.granularity, '4小时', '粒度标注为 4 小时');
    eq(built.volumeApprox, true, '标记成交量是估算的');

    eq(built.candles[0].open, 100, '开盘价映射正确');
    eq(built.candles[0].high, 110, '最高价映射正确');
    eq(built.candles[0].low, 90, '最低价映射正确');
    eq(built.candles[0].close, 105, '收盘价映射正确');

    near(built.candles[0].volume, 15, 1e-9, '第 1 根成交量 = 10 + 5（不含窗口外的 999）');
    near(built.candles[1].volume, 10, 1e-9, '第 2 根成交量 = 7 + 3（含等于收盘时间的边界点）');

    eq(built.candles[0].time, Math.floor(T1 / 1000), '时间戳从毫秒换成秒');
}

// ============================================================
section('3. 成交量拿不到时必须老实留空，不能编');

{
    const { CG, sandbox } = makeEnv();
    sandbox.fetch = async (url) => {
        if (url.indexOf('/ohlc') >= 0) return jsonRes(200, [[1700000000000, 1, 2, 0.5, 1.5]]);
        return jsonRes(500, { error: 'boom' });   // market_chart 挂掉
    };

    const built = await CG.buildCandles('x', 7);
    eq(built.candles.length, 1, 'OHLC 仍然可用');
    eq(built.volumeApprox, false, '成交量标记为「非估算/缺失」而不是假装有');
    eq(built.candles[0].volume, 0, '成交量留 0，不填随机数');
}

// ============================================================
section('4. 异常蜡烛要被剔除');

{
    const { CG, sandbox } = makeEnv();
    sandbox.fetch = async (url) => {
        if (url.indexOf('/ohlc') >= 0) {
            return jsonRes(200, [
                [1700000000000, 100, 110, 90, 105],   // 正常
                [1700003600000, 0, 0, 0, 0],          // 全 0，无效
                [1700007200000, null, 1, 1, 1],       // null
                [1700010800000, 1, 2, 0.5, 1.5],      // 正常
            ]);
        }
        return jsonRes(200, { total_volumes: [] });
    };

    const built = await CG.buildCandles('x', 7);
    eq(built.candles.length, 2, '无效蜡烛被剔除，剩下 2 根');
}

{
    // 单独开一个环境：同一个实例上重复请求会命中缓存，
    // 那测的就不是「空返回」而是缓存了。
    const { CG, sandbox } = makeEnv();
    sandbox.fetch = async (url) => url.indexOf('/ohlc') >= 0
        ? jsonRes(200, [])
        : jsonRes(200, { total_volumes: [] });
    let threw = false;
    try { await CG.buildCandles('x', 7); } catch (e) { threw = /没有返回/.test(e.message); }
    ok(threw, 'OHLC 为空时抛出明确错误');
}

// ============================================================
section('5. 缓存：TTL 内不重复打接口，失效后重取');

{
    const { CG, sandbox } = makeEnv();
    let hits = 0;
    sandbox.fetch = async () => { hits++; return jsonRes(200, { coins: [{ id: 'a', symbol: 'A', name: 'A' }] }); };

    await CG.search('abc');
    await CG.search('abc');
    eq(hits, 1, '同一个查询第二次走缓存，没有重复请求');

    await CG.search('other');
    eq(hits, 2, '不同查询各请求一次');

    CG.clearCache();
    await CG.search('abc');
    eq(hits, 3, 'clearCache 后会重新请求');
}

{
    const { CG, sandbox } = makeEnv();
    let hits = 0;
    sandbox.fetch = async () => {
        hits++;
        return jsonRes(200, [{ id: 'ethgas-2', symbol: 'gwei', name: 'ETHGas', current_price: hits }]);
    };

    await CG.market('ethgas-2');
    await CG.market('ethgas-2');
    eq(hits, 1, '行情在 TTL 内命中缓存');

    CG.invalidateMarkets('ethgas-2');
    await CG.market('ethgas-2');
    eq(hits, 2, 'invalidateMarkets 后强制重取（自动刷新需要有新价）');
}

// ============================================================
section('6. 错误语义：限频 / 不存在 / 其它');

{
    const { CG, sandbox } = makeEnv();
    sandbox.fetch = async () => jsonRes(429, { status: { error_message: 'rate limited' } });
    let e1 = null;
    try { await CG.market('x'); } catch (e) { e1 = e; }
    ok(e1 && e1.rateLimited === true, '429 标记为 rateLimited');
    ok(/频繁/.test(e1.message), '429 给出可读提示', e1 && e1.message);

    sandbox.fetch = async () => jsonRes(404, {});
    let e2 = null;
    try { await CG.market('nope'); } catch (e) { e2 = e; }
    ok(e2 && e2.notFound === true, '404 标记为 notFound');

    sandbox.fetch = async () => jsonRes(500, {});
    let e3 = null;
    try { await CG.market('x'); } catch (e) { e3 = e; }
    ok(e3 && /HTTP 500/.test(e3.message), '其它错误带状态码', e3 && e3.message);

    sandbox.fetch = async () => { throw new Error('offline'); };
    let e4 = null;
    try { await CG.market('x'); } catch (e) { e4 = e; }
    ok(e4 && e4.network === true, '网络失败标记为 network');
}

// ============================================================
section('7. 并发队列：单次失败不能卡死后续请求');

{
    const { CG, sandbox } = makeEnv();
    let n = 0;
    sandbox.fetch = async (url) => {
        n++;
        if (n === 1) throw new Error('第一次失败');
        return jsonRes(200, { coins: [{ id: 'a', symbol: 'A', name: 'A' }] });
    };

    let firstFailed = false;
    try { await CG.search('one'); } catch (e) { firstFailed = true; }
    ok(firstFailed, '第一次请求按预期失败');

    const second = await CG.search('two');
    eq(second.length, 1, '失败之后的请求仍能正常返回（队列没被打断）');
}

// ============================================================
section('8. 周期档位与粒度标注');

{
    const { CG } = makeEnv();
    eq(CG.TIMEFRAMES.length, 4, '提供 4 个档位');
    const g = CG.TIMEFRAMES.map(t => t.granularity);
    eq(g[0], '30分钟', '1 天档位标注 30 分钟');
    eq(g[1], '4小时', '7 天档位标注 4 小时');
    eq(g[2], '4小时', '30 天档位标注 4 小时');
    eq(g[3], '4天', '365 天档位标注 4 天');
    ok(CG.TIMEFRAMES.every(t => t.days <= 365), '所有档位都在免费版的 365 天上限内');
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
