'use strict';
// 整体包在 async IIFE 里，以便使用顶层 await（文件仍是 CommonJS）
(async () => {

const fs = require('fs');
/**
 * 币安测试网连接器 —— 单元测试
 *
 * 运行：node tests/binance.test.js
 *
 * 测试重点是「安全约束是否真的生效」，而不只是功能能跑：
 * 域名白名单、密钥不落地、防误触双阈值、限速、503 状态未知、紧急停止。
 * 这些一旦失效，后果是真实资金风险，所以必须有自动化测试守住。
 */

const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

const SRC = path.join(__dirname, '..', 'js', 'binance.js');

// ---------- 极简测试框架 ----------
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
function eq(actual, expected, name) {
    ok(actual === expected, name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

// ---------- 装载被测模块（模拟浏览器环境）----------
function makeEnv() {
    const store = {};
    const localStorage = {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; },
        get length() { return Object.keys(store).length; },
    };
    const wc = nodeCrypto.webcrypto;
    const sandbox = {
        console, TextEncoder, URL, Date, Math, JSON, Object, Array, String, Number,
        Boolean, Error, RegExp, isFinite, isNaN, parseFloat, parseInt, Promise,
        setTimeout, localStorage,
        crypto: wc,
        window: { crypto: wc },
        fetch: async () => { throw new Error('fetch 未打桩'); },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(
        fs.readFileSync(SRC, 'utf8') + '\n;globalThis.__BN = BinanceTestnet;',
        sandbox, { filename: 'binance.js' }
    );
    return { BN: sandbox.__BN, sandbox, store };
}

/** 构造一个假的 fetch 响应 */
function fakeResponse(status, body, headers) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: k => (headers && headers[k]) || null },
        text: async () => text,
        json: async () => JSON.parse(text),
    };
}

const RULES = {
    symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT',
    minQty: 0.00001, stepSize: 0.00001, minNotional: 10, tickSize: 0.01, status: 'TRADING',
};

// ============================================================
section('1. 域名白名单：绝不能把密钥签给非测试网域名');

{
    const { BN, sandbox } = makeEnv();
    eq(new URL(BN.BASE).host, 'testnet.binance.vision', '默认 base URL 是测试网');

    let blocked = false;
    BN.BASE = 'https://api.binance.com';          // 模拟被篡改成主网
    try { await BN.request('GET', '/api/v3/time'); }
    catch (e) { blocked = /白名单/.test(e.message); }
    ok(blocked, '篡改成主网域名后被阻断');

    let blocked2 = false;
    BN.BASE = 'https://evil.example.com';
    try { await BN.request('GET', '/api/v3/time'); }
    catch (e) { blocked2 = /白名单/.test(e.message); }
    ok(blocked2, '篡改成第三方域名后被阻断');

    // 即使 fetch 被替换成「永远成功」，白名单也必须先拦下来
    sandbox.fetch = async () => fakeResponse(200, { serverTime: Date.now() });
    BN.BASE = 'https://api.binance.com';
    let blocked3 = false;
    try { await BN.request('GET', '/api/v3/time'); } catch (e) { blocked3 = true; }
    ok(blocked3, '即使网络层放行，白名单仍先阻断');
}

// ============================================================
section('2. 凭据生命周期：只在内存、可彻底清除');

{
    const { BN, store } = makeEnv();
    eq(BN.isConnected(), false, '初始未连接');

    ok(BN.setCredentials('', '').ok === false, '空凭据被拒绝');
    ok(BN.setCredentials('k', 's').ok === true, '正常凭据可设置');
    eq(BN.isConnected(), true, '设置后为已连接');

    // 关键：凭据不得写入 localStorage
    eq(Object.keys(store).filter(k => /key|secret|cred/i.test(k)).length, 0,
        '凭据没有写入 localStorage');

    BN.clearCredentials();
    eq(BN.isConnected(), false, 'clearCredentials 后为未连接');
}

// ============================================================
section('3. 签名实现：必须与 HMAC-SHA256 标准结果一致');

{
    const { BN } = makeEnv();
    BN.setCredentials('testkey', 'testsecret');

    const query = 'symbol=BTCUSDT&side=BUY&type=LIMIT&quantity=1&price=100&timestamp=1700000000000';
    const got = await BN._sign(query);
    const want = nodeCrypto.createHmac('sha256', 'testsecret').update(query).digest('hex');

    eq(got, want, '签名结果与 Node crypto 的 HMAC-SHA256 一致');
    eq(got.length, 64, '签名是 64 位 hex');
    ok(/^[0-9a-f]+$/.test(got), '签名只含小写十六进制字符');
}

// ============================================================
section('4. 参数编码');

{
    const { BN } = makeEnv();
    eq(BN._encode({ a: 1, b: 'BTCUSDT' }), 'a=1&b=BTCUSDT', '普通参数编码正确');
    eq(BN._encode({ a: undefined, b: 2 }), 'b=2', 'undefined 被剔除');
    eq(BN._encode({ a: null, b: 2 }), 'b=2', 'null 被剔除');
    eq(BN._encode({ a: '' }), '', '空字符串被剔除');
    eq(BN._encode({ k: 'a b&c=d' }), 'k=a%20b%26c%3Dd', '特殊字符被百分号编码');
}

// ============================================================
section('5. 数量步长归一化');

{
    const { BN } = makeEnv();
    eq(BN.floorToStep(1.234567, 0.00001), 1.23456, '按 stepSize 向下取整');
    eq(BN.floorToStep(0.000019, 0.00001), 0.00001, '极小值不越界');
    eq(BN.floorToStep(5, 0), 5, 'stepSize 为 0 时原样返回');
    eq(BN.floorToStep(3.999, 1), 3, '整数步长向下取整');
}

// ============================================================
section('6. 客户端限速');

{
    const { BN } = makeEnv();
    BN.LIMITS.maxOrdersPerMinute = 3;
    let hit = 0;
    for (let i = 0; i < 5; i++) {
        try { BN._rateLimit(); } catch (e) { hit++; }
    }
    eq(hit, 2, '超过每分钟上限后被拒绝 2 次');
}

// ============================================================
section('7. 下单前校验：防误触双阈值与交易所规则');

{
    const { BN } = makeEnv();
    BN._rulesCache['BTCUSDT'] = Object.assign({}, RULES);

    // 7.1 数量低于最小下单量
    let v = await BN.validateOrder({
        symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT',
        price: 60000, quantity: 0.000001, refPrice: 60000,
    });
    ok(v.blocked, '数量低于 minQty 被拦截');

    // 7.2 名义金额低于最小额
    v = await BN.validateOrder({
        symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT',
        price: 60000, quantity: 0.0001, refPrice: 60000,
    });
    ok(v.blocked && /最小额/.test(v.errors.join('')), '名义金额低于 minNotional 被拦截');

    // 7.3 正常订单通过
    v = await BN.validateOrder({
        symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT',
        price: 60000, quantity: 0.001, refPrice: 60000,
    });
    ok(v.ok && !v.blocked, '正常订单通过校验');
    ok(Math.abs(v.notional - 60) < 1e-6, '名义金额算对（0.001 × 60000 = 60）', String(v.notional));

    // 7.4 超过单笔上限 → 硬拦截
    v = await BN.validateOrder({
        symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT',
        price: 60000, quantity: 0.01, refPrice: 60000,
    });
    ok(v.blocked && /上限/.test(v.errors.join('')), '名义金额超上限被硬拦截');

    // 7.5 限价偏离现价超 5% → 需要二次确认
    v = await BN.validateOrder({
        symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT',
        price: 60000 * 1.08, quantity: 0.001, refPrice: 60000,
    });
    ok(v.ok && v.needsConfirm, '限价偏离 8% 时要求二次确认');
    ok(/偏离/.test(v.warnings.join('')), '给出了偏离警告文案');

    // 7.6 限价偏离超 20% → 硬拦截（防多打一个零）
    v = await BN.validateOrder({
        symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT',
        price: 60000 * 30, quantity: 0.001, refPrice: 60000,
    });
    ok(v.blocked, '限价偏离 2900% 被硬拦截（防手滑多打零）');

    // 7.7 余额不足
    v = await BN.validateOrder({
        symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT',
        price: 60000, quantity: 0.001, refPrice: 60000, availableQuote: 5,
    });
    ok(v.blocked && /不足/.test(v.errors.join('')), '可用余额不足被拦截');

    // 7.8 卖出数量超过持仓
    v = await BN.validateOrder({
        symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT',
        price: 60000, quantity: 0.001, refPrice: 60000, availableBase: 0.0001,
    });
    ok(v.blocked, '卖出数量超过可用持仓被拦截');
}

// ============================================================
section('8. 网络异常处理：429 / 503 语义必须区分');

{
    const { BN, sandbox } = makeEnv();
    BN.setCredentials('k', 's');

    // 429 限频
    sandbox.fetch = async () => fakeResponse(429, { msg: 'too many requests' }, { 'Retry-After': '30' });
    let msg = '';
    try { await BN.request('GET', '/api/v3/time'); } catch (e) { msg = e.message; }
    ok(/限频/.test(msg), '429 被识别为限频并停止重试', msg);

    // 503 状态未知：必须带 unknownState 标记，绝不能当失败重试
    sandbox.fetch = async () => fakeResponse(503, { msg: 'Unknown error' });
    let unknown = false, m2 = '';
    try { await BN.request('POST', '/api/v3/order', {}, { signed: true, trading: true }); }
    catch (e) { unknown = e.unknownState === true; m2 = e.message; }
    ok(unknown, '503 标记为 unknownState（不可重试）');
    ok(/未知/.test(m2), '503 的提示文案说明状态未知', m2);

    // 业务错误：把交易所返回的 msg 透出来
    sandbox.fetch = async () => fakeResponse(400, { code: -2010, msg: 'Account has insufficient balance' });
    let m3 = '';
    try { await BN.request('POST', '/api/v3/order', {}, { signed: true, trading: true }); }
    catch (e) { m3 = e.message; }
    ok(/insufficient balance/.test(m3), '业务错误透出交易所原文', m3);
}

// ============================================================
section('9. 紧急停止');

{
    const { BN, sandbox } = makeEnv();
    BN.setCredentials('k', 's');

    sandbox.fetch = async () => fakeResponse(200, [{ orderId: 1 }, { orderId: 2 }]);
    const r = await BN.killSwitch('BTCUSDT');
    eq(r.cancelled, 2, '紧急停止撤销了 2 笔挂单');
    eq(BN.isHalted(), true, '进入停止状态');

    // 停止后不得再下单
    let rejected = false;
    try {
        await BN.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 1 });
    } catch (e) { rejected = /紧急停止/.test(e.message); }
    ok(rejected, '停止状态下拒绝新的下单请求');

    BN.resume();
    eq(BN.isHalted(), false, 'resume 后恢复可交易');
}

// ============================================================
section('10. 本地订单记账（不含任何密钥）');

{
    const { BN, store } = makeEnv();
    BN.journal({ orderId: 11, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '60000', origQty: '0.001', executedQty: '0', status: 'NEW' });
    BN.journal({ orderId: 12, symbol: 'ETHUSDT', side: 'SELL', type: 'MARKET', price: '3000', origQty: '1', executedQty: '1', status: 'FILLED' });

    let list = BN.getJournal();
    eq(list.length, 2, '记了两笔订单');
    eq(list[0].orderId, 12, '最新一笔排在最前');
    eq(list[0].env, 'testnet', '标记为测试网环境');

    // 同一订单重复记账应更新而非新增
    BN.journal({ orderId: 11, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '60000', origQty: '0.001', executedQty: '0.001', status: 'FILLED' });
    list = BN.getJournal();
    eq(list.length, 2, '重复记账不产生重复行');
    const o11 = list.find(x => x.orderId === 11);
    eq(o11.status, 'FILLED', '同订单状态被更新');

    // 记账里绝不能出现密钥
    const raw = JSON.stringify(store);
    ok(!/secret|apiKey|apikey/i.test(raw), '本地记账未包含密钥字段');

    // 上限
    for (let i = 0; i < 250; i++) {
        BN.journal({ orderId: 1000 + i, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', status: 'NEW' });
    }
    eq(BN.getJournal().length, BN.LIMITS.journalMax, '记账条数被限制在上限内');

    BN.clearJournal();
    eq(BN.getJournal().length, 0, 'clearJournal 清空');
}

// ============================================================
section('11. 未连接时的保护');

{
    const { BN, sandbox } = makeEnv();
    let called = false;
    sandbox.fetch = async () => { called = true; return fakeResponse(200, {}); };

    let msg = '';
    try { await BN.getAccount(); } catch (e) { msg = e.message; }
    ok(/未连接/.test(msg), '未连接时拒绝签名请求');
    eq(called, false, '未连接时根本没有发出网络请求');

    let signMsg = '';
    try { await BN._sign('a=1'); } catch (e) { signMsg = e.message; }
    ok(/未连接/.test(signMsg), '未连接时拒绝签名');
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
