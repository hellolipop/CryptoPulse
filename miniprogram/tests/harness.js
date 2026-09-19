'use strict';
/**
 * 小程序测试用的运行环境。
 *
 * 小程序页面本身没法在 Node 里"跑起来"，但页面的 JS 逻辑可以：
 * 只要把 Page / wx / fetch 三样桩好，再给一个 setData 的替身，
 * onLoad → 取数 → 分析 → setData 这条链路就能完整走一遍。
 * 出问题的往往正是这条链路（字段名写错、异步没等、早退分支漏了），
 * 而不是视图层，所以这么测是划算的。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** 生成 n 根K线；价格按固定步长走，保证可复现 */
function genCandles(n, startPrice, step) {
    const out = [];
    let price = startPrice === undefined ? 100 : startPrice;
    const s = step === undefined ? 0.5 : step;
    const t0 = 1700000000;
    for (let i = 0; i < n; i++) {
        price = price + s;
        const open = price;
        const close = price + s;
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

/** 币安 K线的原始数组形态（12 列），用于测映射 */
function toRawKlines(candles) {
    return candles.map(function (c) {
        return [
            c.time * 1000,
            String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume),
            0, '0', 0, '0', '0', '0',
        ];
    });
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

/** 一个记账用的 Canvas 2D 上下文替身 */
function mockCanvasCtx() {
    const c = {
        calls: { clearRect: 0, fillRect: 0, stroke: 0, fillText: 0, moveTo: 0, lineTo: 0 },
        clearRect() { c.calls.clearRect++; },
        fillRect() { c.calls.fillRect++; },
        beginPath() {}, closePath() {}, save() {}, restore() {}, scale() {}, arc() {}, fill() {},
        moveTo() { c.calls.moveTo++; },
        lineTo() { c.calls.lineTo++; },
        stroke() { c.calls.stroke++; },
        fillText() { c.calls.fillText++; },
        measureText(t) { return { width: String(t).length * 5 }; },
        set font(v) {}, set fillStyle(v) {}, set strokeStyle(v) {},
        set lineWidth(v) {}, set textAlign(v) {}, set textBaseline(v) {},
    };
    return c;
}

function makeEnv() {
    const storage = {};
    const state = {
        fetchImpl: function () { return Promise.reject(new Error('测试未设置 fetch')); },
        canvasCtx: mockCanvasCtx(),
        lastUrl: '',
    };

    const wxStub = {
        getStorageSync: (k) => (storage[k] === undefined ? '' : storage[k]),
        setStorageSync: (k, v) => { storage[k] = v; },
        removeStorageSync: (k) => { delete storage[k]; },
        showToast: () => {},
        setNavigationBarTitle: () => {},
        navigateTo: () => {},
        stopPullDownRefresh: () => {},
        setClipboardData: () => {},
        getWindowInfo: () => ({ pixelRatio: 2 }),
        getSystemInfoSync: () => ({ pixelRatio: 2 }),
        request: () => { throw new Error('不该走 wx.request：fetch 垫片之外没有别的出口'); },
        createSelectorQuery: () => ({
            in: function () { return this; },
            select: function () { return this; },
            fields: function () { return this; },
            exec: function (cb) {
                cb([{
                    width: 340,
                    height: 280,
                    node: {
                        width: 0,
                        height: 0,
                        getContext: () => state.canvasCtx,
                    },
                }]);
            },
        }),
    };

    const pageConfigs = {};

    function makeRequire(fromDir) {
        return function (p) {
            let resolved = path.resolve(fromDir, p);
            if (!path.extname(resolved)) resolved += '.js';
            const code = fs.readFileSync(resolved, 'utf8');
            const mod = { exports: {} };
            const inner = Object.assign({}, base, {
                module: mod,
                exports: mod.exports,
                require: makeRequire(path.dirname(resolved)),
            });
            inner.globalThis = inner;
            vm.createContext(inner);
            vm.runInContext(code, inner, { filename: resolved });
            return mod.exports;
        };
    }

    const base = {
        console, Date, Math, JSON, Object, Array, String, Number, Boolean,
        Error, RegExp, isFinite, isNaN, parseFloat, parseInt, Promise,
        setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent,
        Set, Map,
        wx: wxStub,
        fetch: function (url, opts) { state.lastUrl = url; return state.fetchImpl(url, opts); },
        getApp: () => ({ globalData: {} }),
        Page: function (cfg) { pageConfigs.__last = cfg; },
    };
    base.globalThis = base;

    /** 加载页面并返回一个可直接调用生命周期方法的实例 */
    function makePage(jsPath) {
        const abs = path.resolve(jsPath);
        const sandbox = Object.assign({}, base, { require: makeRequire(path.dirname(abs)) });
        sandbox.globalThis = sandbox;
        vm.createContext(sandbox);
        vm.runInContext(fs.readFileSync(abs, 'utf8'), sandbox, { filename: abs });

        const cfg = pageConfigs.__last;
        pageConfigs.__last = null;
        if (!cfg) throw new Error('页面没有调用 Page()：' + jsPath);

        const page = Object.assign({}, cfg);
        page.data = JSON.parse(JSON.stringify(cfg.data || {}));
        page.setData = function (patch, cb) {
            if (patch) Object.assign(this.data, patch);
            if (typeof cb === 'function') cb();
        };
        page._setDataCalls = 0;
        const origSetData = page.setData;
        page.setData = function (patch, cb) { this._setDataCalls++; return origSetData.call(this, patch, cb); };
        return page;
    }

    return {
        setFetch(fn) { state.fetchImpl = fn; },
        storage,
        state,
        makePage,
        get lastUrl() { return state.lastUrl; },
    };
}

/**
 * 一个「像真的」币安接口替身：
 * 现货目录、现货/合约K线、行情、资金费率、恐慌贪婪指数都按真实字段名返回。
 */
function fakeBinance(opts) {
    const o = opts || {};
    const dailyBars = o.dailyBars || 166;
    const hourBars = o.hourBars || 300;
    const equitySymbols = o.equitySymbols || ['AAPLUSDT', 'TSLAUSDT', 'NVDAUSDT'];
    const spotSymbols = o.spotSymbols || [
        ['BTCUSDT', 'BTC'], ['ETHUSDT', 'ETH'], ['BNBUSDT', 'BNB'],
        ['SOLUSDT', 'SOL'], ['XRPUSDT', 'XRP'], ['DOGEUSDT', 'DOGE'],
    ];

    return function (url) {
        if (url.indexOf('fapi.binance.com/fapi/v1/exchangeInfo') >= 0) {
            return Promise.resolve(jsonRes({
                symbols: equitySymbols.map(function (s) {
                    return {
                        symbol: s,
                        status: 'TRADING',
                        baseAsset: s.replace(/USDT$/, ''),
                        quoteAsset: 'USDT',
                        contractType: 'TRADIFI_PERPETUAL',
                        underlyingType: 'EQUITY',
                        underlyingSubType: ['TradFi'],
                        onboardDate: 1775483400000,
                        pricePrecision: 5,
                        quantityPrecision: 2,
                        filters: [
                            { filterType: 'PRICE_FILTER', tickSize: '0.01000' },
                            { filterType: 'LOT_SIZE', stepSize: '0.01' },
                            { filterType: 'MIN_NOTIONAL', notional: '5' },
                        ],
                    };
                }),
            }));
        }

        if (url.indexOf('/fapi/v1/klines') >= 0 || url.indexOf('/api/v3/klines') >= 0) {
            const isWeekly = url.indexOf('interval=1w') >= 0;
            const isHour = url.indexOf('interval=1h') >= 0;
            const n = isWeekly ? 24 : (isHour ? hourBars : dailyBars);
            const start = url.indexOf('/fapi/v1') >= 0 ? 300 : 100;
            return Promise.resolve(jsonRes(toRawKlines(genCandles(n, start, 0.2))));
        }

        if (url.indexOf('/fapi/v1/ticker/24hr') >= 0) {
            // 单数 symbol 返回对象；不带 symbol 返回全量数组（与实测一致）
            if (url.indexOf('symbol=') >= 0) {
                const sym = url.split('symbol=')[1].split('&')[0];
                return Promise.resolve(jsonRes(makeTicker(sym, url)));
            }
            return Promise.resolve(jsonRes(equitySymbols.map(function (s) { return makeTicker(s, url); })));
        }

        if (url.indexOf('/api/v3/ticker/24hr') >= 0) {
            if (url.indexOf('symbols=') >= 0) {
                return Promise.resolve(jsonRes(spotSymbols.map(function (p) { return makeTicker(p[0], url); })));
            }
            if (url.indexOf('symbol=') >= 0) {
                const sym = url.split('symbol=')[1].split('&')[0];
                return Promise.resolve(jsonRes(makeTicker(sym, url)));
            }
            return Promise.resolve(jsonRes(spotSymbols.map(function (p) { return makeTicker(p[0], url); })));
        }

        if (url.indexOf('/premiumIndex') >= 0) {
            return Promise.resolve(jsonRes({ lastFundingRate: '0.00012000', markPrice: '335.5', nextFundingTime: 1789776000000 }));
        }
        if (url.indexOf('/openInterest') >= 0) {
            return Promise.resolve(jsonRes({ openInterest: '69855.89' }));
        }
        if (url.indexOf('alternative.me') >= 0) {
            return Promise.resolve(jsonRes({ data: [{ value: '45', value_classification: 'Fear' }] }));
        }
        if (url.indexOf('/api/v3/exchangeInfo') >= 0) {
            const syms = spotSymbols.map(function (p) {
                return { symbol: p[0], status: 'TRADING', baseAsset: p[1], quoteAsset: 'USDT' };
            });
            syms.push({ symbol: 'ETHBTC', status: 'TRADING', baseAsset: 'ETH', quoteAsset: 'BTC' });
            return Promise.resolve(jsonRes({ symbols: syms }));
        }

        return Promise.resolve(jsonRes({}, 404));
    };
}

function makeTicker(symbol, url) {
    const base = url.indexOf('fapi') >= 0 ? 335 : 100;
    return {
        symbol: symbol,
        lastPrice: String(base),
        priceChange: '1.5',
        priceChangePercent: '1.52',
        highPrice: String(base * 1.03),
        lowPrice: String(base * 0.97),
        openPrice: String(base * 0.99),
        weightedAvgPrice: String(base),
        volume: '160691.39',
        quoteVolume: '54096421.99',
        count: 129019,
    };
}

module.exports = { makeEnv, fakeBinance, genCandles, toRawKlines, jsonRes, mockCanvasCtx, makeTicker };
