/**
 * 数据层。
 *
 * 三条数据来源：
 *   现货  data-api.binance.vision   加密货币的价格与K线
 *   合约  fapi.binance.com          美股标的（TradFi）的价格与K线、资金费率
 *   FNG   api.alternative.me        加密市场恐慌贪婪指数
 *
 * 复用 libs/stocks.js 的原因：美股合约的目录归一化、K线/行情字段映射、
 * 历史深度提示都写在那里，且带单测。小程序没必要也不可能写出更对的版本。
 */

const store = require('./store.js');
const Stocks = require('../libs/stocks.js');

const SPOT = 'https://data-api.binance.vision/api/v3';
const FAPI = 'https://fapi.binance.com/fapi/v1';
const FNG = 'https://api.alternative.me/fng/?limit=1';

const CATALOG_TTL = 24 * 3600 * 1000;

async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) {
        const err = new Error('HTTP ' + res.status);
        err.status = res.status;
        throw err;
    }
    return res.json();
}

// ---------------- 目录 ----------------

/** 币安现货 USDT 交易对全量目录（搜索用） */
async function spotCatalog() {
    const cached = store.getCache('spotCatalog', CATALOG_TTL);
    if (cached && cached.length) return cached;

    const data = await getJson(SPOT + '/exchangeInfo');
    const seen = {};
    const list = [];
    (data.symbols || []).forEach(function (s) {
        if (s.status !== 'TRADING' || s.quoteAsset !== 'USDT') return;
        const base = String(s.baseAsset || '').toUpperCase();
        const coinId = base.toLowerCase();
        if (!base || seen[coinId]) return;
        seen[coinId] = true;
        // 不存 name：中文名用内置映射在展示时补，省存储空间
        list.push({ coinId: coinId, symbol: base, binanceSymbol: s.symbol, market: 'spot' });
    });

    store.setCache('spotCatalog', list);
    return list;
}

/** 币安合约里的美股目录（TradFi） */
async function stockCatalog() {
    const cached = store.getCache('stockCatalog', CATALOG_TTL);
    if (cached && cached.length) return cached;

    const list = await Stocks.loadCatalog();
    // 只留展示与取数需要的字段
    const slim = list.map(function (c) {
        return {
            coinId: c.coinId,
            symbol: c.symbol,
            name: c.name,
            binanceSymbol: c.binanceSymbol,
            market: 'futures',
        };
    });
    store.setCache('stockCatalog', slim);
    return slim;
}

// ---------------- 行情 ----------------

function normalizeSpotTicker(t) {
    return {
        price: parseFloat(t.lastPrice),
        changePercent: parseFloat(t.priceChangePercent),
        high24h: parseFloat(t.highPrice),
        low24h: parseFloat(t.lowPrice),
        open24h: parseFloat(t.openPrice),
        volume: parseFloat(t.volume),
        quoteVolume: parseFloat(t.quoteVolume),
        tradeCount: parseInt(t.count, 10),
    };
}

/** 现货批量行情，返回 { symbol: {...} } */
async function spotTickers(symbols) {
    const out = {};
    if (!symbols || !symbols.length) return out;

    // 接口一次能吃很多个，但URL会很长，按 100 个一组切
    for (let i = 0; i < symbols.length; i += 100) {
        const chunk = symbols.slice(i, i + 100);
        const query = encodeURIComponent(JSON.stringify(chunk));
        const data = await getJson(SPOT + '/ticker/24hr?symbols=' + query);
        const arr = Array.isArray(data) ? data : [data];
        arr.forEach(function (t) {
            if (t && t.symbol) out[t.symbol] = normalizeSpotTicker(t);
        });
    }
    return out;
}

/**
 * 美股合约全量行情快照。
 * 复用 Stocks.allTickers()：实测 fapi 的 ticker/24hr 带 symbols 参数时
 * 会忽略过滤直接返回全量，所以拿全量在本地筛反而更可靠。
 */
async function stockTickers() {
    const map = await Stocks.allTickers();
    const out = {};
    Object.keys(map).forEach(function (sym) {
        const t = map[sym];
        out[sym] = {
            price: t.current_price,
            changePercent: t.price_change_percentage_24h,
            high24h: t.high_24h,
            low24h: t.low_24h,
            open24h: t.open_24h,
            volume: t.total_volume,
            quoteVolume: t.quote_volume,
            tradeCount: t.trade_count,
        };
    });
    return out;
}

/** 单个标的的 24h 行情 */
async function ticker(market, symbol) {
    if (market === 'futures') {
        const t = await Stocks.ticker(symbol);
        if (!t) throw new Error('合约行情为空');
        return {
            price: t.current_price,
            changePercent: t.price_change_percentage_24h,
            high24h: t.high_24h,
            low24h: t.low_24h,
            open24h: t.open_24h,
            volume: t.total_volume,
            quoteVolume: t.quote_volume,
            tradeCount: t.trade_count,
        };
    }
    const data = await getJson(SPOT + '/ticker/24hr?symbol=' + encodeURIComponent(symbol));
    return normalizeSpotTicker(data);
}

// ---------------- K线 ----------------

/**
 * K线。
 * 两个市场返回的都是 12 列数组（结构一致），统一映射成 {time,open,high,low,close,volume}。
 */
async function klines(market, symbol, interval, limit) {
    const url = market === 'futures'
        ? FAPI + '/klines?symbol=' + encodeURIComponent(symbol) +
          '&interval=' + encodeURIComponent(interval) + '&limit=' + limit
        : SPOT + '/klines?symbol=' + encodeURIComponent(symbol) +
          '&interval=' + encodeURIComponent(interval) + '&limit=' + limit;

    const raw = await getJson(url);
    if (!Array.isArray(raw)) return [];

    const out = [];
    raw.forEach(function (k) {
        const c = {
            time: Math.floor(k[0] / 1000),
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
        };
        if (isFinite(c.time) && isFinite(c.close)) out.push(c);
    });
    return out;
}

// ---------------- 衍生品 / 情绪 ----------------

/** 资金费率与持仓量。取不到时返回 null，不编数。 */
async function derivatives(symbol) {
    const out = { fundingRate: null, openInterest: null };
    try {
        const d = await getJson(FAPI + '/premiumIndex?symbol=' + encodeURIComponent(symbol));
        out.fundingRate = parseFloat(d.lastFundingRate) * 100; // 换算成百分数，与网页端口径一致
    } catch (e) {
        return null;
    }
    try {
        const oi = await getJson(FAPI + '/openInterest?symbol=' + encodeURIComponent(symbol));
        out.openInterest = parseFloat(oi.openInterest);
    } catch (e) {
        // 持仓量取不到不影响资金费率，保持 null
    }
    return out;
}

/** 恐慌贪婪指数。个股不适用，调用方自行判断。 */
async function fearGreed() {
    try {
        const d = await getJson(FNG);
        const item = (d.data || [])[0];
        if (!item) return null;
        return { value: parseInt(item.value, 10), label: item.value_classification };
    } catch (e) {
        return null;
    }
}

module.exports = {
    SPOT, FAPI,
    spotCatalog, stockCatalog,
    spotTickers, stockTickers, ticker,
    klines, derivatives, fearGreed,
};
