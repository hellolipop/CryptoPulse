'use strict';
// 整体包在 async IIFE 里，以便使用顶层 await（文件仍是 CommonJS）
(async () => {

const fs = require('fs');
/**
 * 币安美股（TradFi 合约）客户端 —— 单元测试
 *
 * 运行：node tests/stocks.test.js
 *
 * 重点覆盖那些「错了会悄悄给出假数据或假结论」的地方：
 *   - 标的识别是否只看字段（不能退化成硬编码名单）
 *   - 计价币过滤：实测存在 USD1 计价的同名标的，混进来会让请求 404
 *   - K线/行情字段映射与单位换算
 *   - 历史深度不足时必须给出提示，而不是让均线静默算错
 *   - 缓存与错误语义
 *
 * 测试里的行情数字取自本机对 fapi 的真实探测结果，不是编的。
 */

const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'js', 'stocks.js');

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
        console, URL, Date, Math, JSON, Object, Array, String, Number,
        Boolean, Error, RegExp, isFinite, isNaN, parseFloat, parseInt, Promise,
        setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent,
        fetch: async () => { throw new Error('fetch 未打桩'); },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(
        fs.readFileSync(SRC, 'utf8') + '\n;globalThis.__ST = Stocks;',
        sandbox, { filename: 'stocks.js' }
    );
    const ST = sandbox.__ST;
    return { ST, sandbox };
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

// 真实探测到的字段，原样搬进来当夹具
function eqSym(sym, extra) {
    return Object.assign({
        symbol: sym,
        status: 'TRADING',
        baseAsset: sym.replace(/USDT$/, ''),
        quoteAsset: 'USDT',
        contractType: 'TRADIFI_PERPETUAL',
        underlyingType: 'EQUITY',
        underlyingSubType: ['TradFi'],
        onboardDate: 1775483400000,
        pricePrecision: 5,
        quantityPrecision: 2,
        filters: [
            { filterType: 'PRICE_FILTER', tickSize: '0.01000', minPrice: '0.01000', maxPrice: '20000' },
            { filterType: 'LOT_SIZE', maxQty: '20000', stepSize: '0.01', minQty: '0.01' },
            { filterType: 'MIN_NOTIONAL', notional: '5' },
        ],
    }, extra || {});
}

// ============================================================
section('1. 标的识别：只看字段，不靠硬编码名单');

{
    const { ST } = makeEnv();

    ok(ST.isStockContract(eqSym('AAPLUSDT')), 'underlyingType=EQUITY 认成股票');
    ok(!ST.isStockContract({ underlyingType: 'COIN', contractType: 'PERPETUAL' }), '加密永续不算股票');
    ok(!ST.isStockContract({ underlyingType: 'COMMODITY' }), '商品合约不算股票（同属 TradFi 但不能混进来）');
    ok(!ST.isStockContract(null), 'null 安全返回 false');
    ok(!ST.isStockContract({}), '缺字段安全返回 false');

    // 币安上新时不需要改代码：新造一个之前没出现过的代码
    ok(ST.isStockContract(eqSym('ZZZZUSDT')), '没见过的代码只要字段对就认 —— 不需要维护白名单');
}

// ============================================================
section('2. 目录归一化：过滤条件与字段映射');

{
    const { ST } = makeEnv();

    const catalog = ST.normalizeCatalog({
        symbols: [
            eqSym('AAPLUSDT'),
            eqSym('TSLAUSDT'),
            eqSym('NVDAUSDT', { filters: undefined }),          // 过滤规则字段缺失
            eqSym('OLDUSDT', { status: 'BREAK' }),              // 已下线
            eqSym('SPCXUSD1', { quoteAsset: 'USD1' }),          // USD1 计价，实测存在
            { symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT',
              contractType: 'PERPETUAL', underlyingType: 'COIN', filters: [] },
            { symbol: 'XAUUSDT', status: 'TRADING', baseAsset: 'XAU', quoteAsset: 'USDT',
              contractType: 'TRADIFI_PERPETUAL', underlyingType: 'COMMODITY', filters: [] },
            eqSym('HK0700USDT', { underlyingType: 'HK_EQUITY' }), // 港股，本次不纳入
            eqSym('AAPLUSDT'),                                    // 重复
        ],
    });

    const syms = catalog.map(c => c.symbol);
    eq(syms.length, 3, '只留下 3 个美股标的（下线/USD1/加密/商品/港股/重复都被剔除）');
    ok(syms.indexOf('AAPL') >= 0 && syms.indexOf('TSLA') >= 0 && syms.indexOf('NVDA') >= 0,
        '留下的正是 AAPL / TSLA / NVDA');
    ok(syms.indexOf('SPCX') < 0, 'USD1 计价的同名标的不进目录 —— 否则按 XXXUSDT 拼请求会 404');
    ok(syms.indexOf('BTC') < 0, '加密永续不进目录');
    ok(syms.indexOf('XAU') < 0, '商品合约不进目录');
    ok(syms.indexOf('HK0700') < 0, '港股不在本次范围内');

    const aapl = catalog.find(c => c.symbol === 'AAPL');
    eq(aapl.coinId, 'aapl', 'coinId 转小写');
    eq(aapl.binanceSymbol, 'AAPLUSDT', '交易对保留原名');
    eq(aapl.name, '苹果', '中文名从映射表取到');
    eq(aapl.market, 'futures', '标记为合约市场');
    eq(aapl.marketLabel, '美股', '市场标签为美股');
    eq(aapl.underlyingType, 'EQUITY', '保留 underlyingType 以便后续扩展');
    eq(aapl.onboardDate, 1775483400000, '保留上线时间（用来解释历史深度）');
    eq(aapl.tickSize, '0.01000', 'tickSize 从 PRICE_FILTER 取出');
    eq(aapl.stepSize, '0.01', 'stepSize 从 LOT_SIZE 取出');
    eq(aapl.minNotional, 5, 'MIN_NOTIONAL 的 notional 取出为数字');
    eq(aapl.pricePrecision, 5, '价格精度保留');

    const nvda = catalog.find(c => c.symbol === 'NVDA');
    eq(nvda.tickSize, undefined, '缺 filters 时 tickSize 为 undefined，不抛错');
    eq(nvda.minNotional, 0, '缺 filters 时 minNotional 归 0 而不是 NaN');
    eq(nvda.name, '英伟达', 'NVDA 中文名正确');

    eq(ST.normalizeCatalog(null).length, 0, '空输入返回空数组');
    eq(ST.normalizeCatalog({}).length, 0, '无 symbols 字段返回空数组');
}

// ============================================================
section('3. 显示名：不认识的代码必须回落到代码，不能瞎猜');

{
    const { ST } = makeEnv();
    eq(ST.displayName('AAPL'), '苹果', '认识的走中文名');
    eq(ST.displayName('aapl'), '苹果', '小写输入也认');
    eq(ST.displayName('BOT'), 'BOT', '不认识的回落成代码本身');
    eq(ST.displayName(''), '', '空值安全');
    eq(ST.displayName(undefined), '', 'undefined 安全');
    eq(ST.displayName('SPCX'), 'SPCX', '拿不准的绝不音译');
}

// ============================================================
section('4. K线映射：结构与单位');

{
    const { ST } = makeEnv();

    // 真实 fapi kline 是 12 列
    const raw = [
        [1775483400000, '335.92', '339.24', '332.90', '335.34', '160691.39', 0, '0', 0, '0', '0', '0'],
        [1775487000000, '335.34', '336.00', '334.00', '335.90', '50000.10', 0, '0', 0, '0', '0', '0'],
    ];
    const cs = ST.toCandles(raw);
    eq(cs.length, 2, '两根都被映射');
    eq(cs[0].time, 1775483400, '毫秒转秒（图表要求秒）');
    near(cs[0].open, 335.92, 1e-9, '开盘价');
    near(cs[0].high, 339.24, 1e-9, '最高价');
    near(cs[0].low, 332.90, 1e-9, '最低价');
    near(cs[0].close, 335.34, 1e-9, '收盘价');
    near(cs[0].volume, 160691.39, 1e-6, '成交量来自第 6 列');
    ok(cs[0].t === undefined, '不带多余的 t 字段 —— 应用内统一用 time');

    eq(ST.toCandles([]).length, 0, '空数组');
    eq(ST.toCandles(null).length, 0, 'null 安全');
    eq(ST.toCandles([[1, 1, 1, 1, 'abc']]).length, 0, '收盘价不是数字的蜡烛被丢弃，不产生 NaN 蜡烛');
}

// ============================================================
section('5. 行情映射：字段名与现货一致，空值不糊弄');

{
    const { ST } = makeEnv();

    // 真实 fapi ticker 字段（实测键名与现货相同）
    const info = ST.toPriceInfo({
        lastPrice: '335.34000', priceChange: '-0.58000', priceChangePercent: '-0.173',
        highPrice: '339.24000', lowPrice: '332.90000', openPrice: '335.92000',
        weightedAvgPrice: '336.64792', volume: '160691.39', quoteVolume: '54096421.98900',
        count: 129019,
    });

    near(info.current_price, 335.34, 1e-9, '现价');
    near(info.price_change_percentage_24h, -0.173, 1e-9, '24h 涨跌幅');
    near(info.high_24h, 339.24, 1e-9, '24h 最高');
    near(info.low_24h, 332.90, 1e-9, '24h 最低');
    near(info.quote_volume, 54096421.989, 1e-6, '成交额（USDT）');
    eq(info.trade_count, 129019, '成交笔数');
    eq(info.market_cap, 0, '美股没有市值字段，明确给 0 而不是编一个数');

    eq(ST.toPriceInfo(null), null, 'null 返回 null');
    eq(ST.toPriceInfo({}), null, '缺 lastPrice 返回 null —— 不能让下游拿到 NaN 价格');
}

// ============================================================
section('6. 历史深度：不够时必须报警，而不是静默算错均线');

{
    const { ST } = makeEnv();

    // 实测：AAPLUSDT 日线 166 根、周线 24 根
    const d = ST.depthWarning('24', 166);
    ok(!!d, '日线 166 根要给出提示');
    ok(d.indexOf('166') >= 0, '提示里带上实际根数');
    ok(d.indexOf('均线') >= 0, '提示里说明后果是长期均线不可用');

    const w = ST.depthWarning('168', 24);
    ok(!!w, '周线 24 根要给出提示');
    ok(w.indexOf('周线') >= 0, '提示里点名是周线');

    eq(ST.depthWarning('24', 500), null, '日线 500 根够用，不提示');
    eq(ST.depthWarning('168', 60), null, '周线正好 60 根算够用');
    eq(ST.depthWarning('1', 200), null, '小时线不做深度要求');
    eq(ST.depthWarning('24', NaN), null, '根数未知时不误报');
}

// ============================================================
section('7. 现货代币化股票：配对识别不能误伤真实币种');

{
    const { ST } = makeEnv();

    const set = ST.tokenizedBaseSet(['AAPL', 'NVDA', 'TSLA', 'SPY']);
    ok(set.has('AAPLB'), 'AAPL → AAPLB');
    ok(set.has('NVDAB'), 'NVDA → NVDAB');
    eq(set.size, 4, '四个标的一共推四个代币化代码');
    ok(!set.has('BNB'), 'BNB 不在集合里 —— 它没有对应的「BN」美股，所以不会把 BNB 误判成代币化股票');
    ok(!set.has('SHIB'), 'SHIB 同理不被误伤');
    ok(!set.has('AAPL'), '集合里只有带 B 的形式，原代码不在内');

    eq(ST.tokenizedBaseSet([]).size, 0, '空输入返回空集合');
    eq(ST.tokenizedBaseSet(null).size, 0, 'null 安全');
    eq(ST.tokenizedBaseSet(['aapl']).has('AAPLB'), true, '小写输入也能推出大写配对');
    eq(ST.tokenizedBaseSet(['']).size, 0, '空字符串被跳过，不产生一个只有 B 的垃圾键');

    // 这套配对是「美股名单 + B 后缀」反查，不是「以 B 结尾就算」：
    // 用真实币种跑一遍，确认没有一个被推成股票代码
    const realish = ['BNB', 'SHIB', 'ARB', 'CKB', 'TRB', 'DGB', 'MOB', 'PHB', 'VIB', 'AMB', 'BB'];
    const s2 = ST.tokenizedBaseSet(realish);
    ok(realish.every(b => !s2.has(b)), '真实币种本身都不在代币化集合里');
}

// ============================================================
section('8. 网络层：缓存、URL、错误语义');

{
    const { ST, sandbox } = makeEnv();
    const urls = [];
    sandbox.fetch = async (url) => {
        urls.push(url);
        if (url.indexOf('/exchangeInfo') >= 0) return jsonRes(200, { symbols: [eqSym('AAPLUSDT')] });
        if (url.indexOf('/ticker/24hr') >= 0) {
            const arr = [
                { symbol: 'AAPLUSDT', lastPrice: '335.34', priceChange: '0', priceChangePercent: '-0.173',
                  highPrice: '339', lowPrice: '332', openPrice: '335', weightedAvgPrice: '336',
                  volume: '160691', quoteVolume: '54096421', count: 129019 },
                { symbol: 'BTCUSDT', lastPrice: '80613.9', priceChange: '0', priceChangePercent: '1',
                  highPrice: '1', lowPrice: '1', openPrice: '1', weightedAvgPrice: '1',
                  volume: '1', quoteVolume: '1', count: 1 },
                null,
            ];
            // 单数 symbol 参数返回对象，复数 symbols 参数返回全量数组 —— 与实测一致
            if (url.indexOf('symbol=AAPLUSDT') >= 0) return jsonRes(200, arr[0]);
            if (url.indexOf('symbols=') >= 0) return jsonRes(200, arr);
            return jsonRes(200, arr);
        }
        if (url.indexOf('/klines') >= 0) {
            return jsonRes(200, [[1775483400000, '1', '2', '0.5', '1.5', '10', 0, '0', 0, '0', '0', '0']]);
        }
        if (url.indexOf('/fundingRate') >= 0) {
            return jsonRes(200, [
                { fundingTime: 1775487000000, fundingRate: '0.00018795' },
                { fundingTime: 1775483400000, fundingRate: '0.00000000' },
                { fundingTime: 1775490600000, fundingRate: 'oops' },   // 脏数据
            ]);
        }
        return jsonRes(404, {});
    };

    const cat = await ST.loadCatalog();
    eq(cat.length, 1, '目录能取到');

    await ST.loadCatalog();
    eq(urls.filter(u => u.indexOf('/exchangeInfo') >= 0).length, 1, '目录第二次走缓存，不重复请求');

    const tickers = await ST.allTickers();
    ok(!!tickers.AAPLUSDT, '全量行情里能筛到 AAPLUSDT');
    eq(tickers.AAPLUSDT.current_price, 335.34, '首页行情映射正确');
    ok(!tickers.null, 'null 条目被跳过，不产生垃圾键');
    eq(Object.keys(tickers).length, 2, '只映射有效条目');

    const t = await ST.ticker('AAPLUSDT');
    eq(t.quote_volume, 54096421, '单标的行情能取到');

    const cs = await ST.klines('AAPLUSDT', '1h', 200);
    eq(cs.length, 1, 'K线能取到');
    ok(urls.some(u => u.indexOf('/fapi/v1/klines') >= 0 && u.indexOf('symbol=AAPLUSDT') >= 0 && u.indexOf('interval=1h') >= 0),
        'K线请求带上 symbol 与 interval');

    const fh = await ST.fundingHistory('AAPLUSDT', 500);
    eq(fh.length, 2, '脏费率记录被过滤，剩下 2 条');
    eq(fh[0].rate, 0, '按时间升序排列 —— 第 1 条是更早的那期');
    eq(fh[1].rate, 0.00018795, '第 2 条是更晚的那期');
    ok(urls.some(u => u.indexOf('limit=500') >= 0), 'limit 透传');

    // 错误语义
    sandbox.fetch = async () => jsonRes(451, {});
    ST.clearCache();
    let err = null;
    try { await ST.klines('AAPLUSDT', '1h', 10); } catch (e) { err = e; }
    ok(!!err, 'HTTP 451 会抛错而不是返回空数组');
    eq(err.status, 451, '错误里带上状态码，便于区分地区限制与限频');

    eq(ST.isAvailable(), true, 'fetch 存在时可用');

    // 持仓量失败不能连累其它数据
    const oi = await ST.openInterest('AAPLUSDT');
    eq(oi, null, '持仓量取不到时返回 null，不抛错');
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
