/**
 * 本地存储：自选、币种元数据、设置、目录缓存。
 *
 * 小程序的 wx.setStorageSync 有 10MB 总量上限，所以币安全量目录只存
 * 必要的四个字段（3705 条约 400KB），中文名在读取时用内置映射补，
 * 不要把 name 一起写进去。
 */

const KEY = {
    watchlist: 'cp_watchlist',
    coinMeta: 'cp_coinmeta',
    settings: 'cp_settings',
    cache: 'cp_cache',
};

// 内置热门币种（同时给出币安交易对），默认自选用的就是这几个
const POPULAR_COINS = [
    { coinId: 'bitcoin', symbol: 'BTC', name: '比特币' },
    { coinId: 'ethereum', symbol: 'ETH', name: '以太坊' },
    { coinId: 'binancecoin', symbol: 'BNB', name: '币安币' },
    { coinId: 'solana', symbol: 'SOL', name: 'Solana' },
    { coinId: 'ripple', symbol: 'XRP', name: '瑞波币' },
    { coinId: 'cardano', symbol: 'ADA', name: '艾达币' },
    { coinId: 'dogecoin', symbol: 'DOGE', name: '狗狗币' },
    { coinId: 'polkadot', symbol: 'DOT', name: '波卡币' },
];

const DEFAULT_WATCH = ['bitcoin', 'ethereum', 'binancecoin', 'solana', 'ripple'];

// 常见币种中文名（与网页端 coinNameMap 同源，这里只保留常用的）
const COIN_NAMES = {
    BTC: '比特币', ETH: '以太坊', BNB: '币安币', SOL: 'Solana', XRP: '瑞波币',
    ADA: '艾达币', DOGE: '狗狗币', DOT: '波卡币', AVAX: '雪崩币', LINK: 'Chainlink',
    MATIC: 'Polygon', LTC: '莱特币', UNI: 'Uniswap', ATOM: 'Cosmos', XLM: '恒星币',
    TRX: '波场', TON: 'Toncoin', SHIB: '柴犬币', PEPE: '佩佩蛙', SUI: 'Sui',
    APT: 'Aptos', ARB: 'Arbitrum', OP: 'Optimism', NEAR: 'NEAR', FIL: 'Filecoin',
    ETC: '以太经典', BCH: '比特现金', HBAR: 'Hedera', ICP: '互联网计算机',
    AAVE: 'Aave', MKR: 'Maker', GRT: 'The Graph', INJ: 'Injective', SEI: 'Sei',
    TIA: 'Celestia', WIF: 'dogwifhat', BONK: 'Bonk', JUP: 'Jupiter', PYTH: 'Pyth',
    STRK: 'Starknet', SNX: 'Synthetix', CRV: 'Curve', COMP: 'Compound',
    ZEC: 'Zcash', XMR: '门罗币', LDO: 'Lido', RENDER: 'Render', IMX: 'Immutable',
    STX: 'Stacks', AR: 'Arweave', ORDI: 'Ordinals', WLD: 'Worldcoin',
};

const DEFAULT_SETTINGS = {
    // 信号灵敏度档位：与网页端 sensitivityPresets 的阈值一致
    sensitivity: 'balanced',
    // 详情页默认周期：'1' 1小时 | '4' 4小时 | '24' 日线 | '168' 周线
    timeframe: '24',
};

function readJson(key, fallback) {
    try {
        const v = wx.getStorageSync(key);
        if (v === '' || v === null || v === undefined) return fallback;
        return v;
    } catch (e) {
        // 存储损坏时回退，不让它把整个页面拖崩
        return fallback;
    }
}

function writeJson(key, value) {
    try {
        wx.setStorageSync(key, value);
    } catch (e) {
        console.warn('[存储] 写入失败', key, e);
    }
}

// ---------------- 自选 ----------------

function getWatchlist() {
    const list = readJson(KEY.watchlist, null);
    if (!Array.isArray(list) || !list.length) return DEFAULT_WATCH.slice();
    return list;
}

function setWatchlist(ids) {
    writeJson(KEY.watchlist, ids);
}

function isWatched(coinId) {
    return getWatchlist().indexOf(coinId) >= 0;
}

function addWatch(coinId) {
    const list = getWatchlist();
    if (list.indexOf(coinId) >= 0) return { ok: true, unchanged: true };
    if (list.length >= 30) {
        return { ok: false, message: '自选最多 30 个' };
    }
    list.push(coinId);
    setWatchlist(list);
    return { ok: true };
}

function removeWatch(coinId) {
    const list = getWatchlist();
    if (list.length <= 1) {
        return { ok: false, message: '至少保留一个自选' };
    }
    setWatchlist(list.filter(id => id !== coinId));
    return { ok: true };
}

// ---------------- 币种元数据 ----------------
// 详情页需要知道一个币种走现货还是合约、交易对是什么。

function getCoinMetaMap() {
    const m = readJson(KEY.coinMeta, null);
    return (m && typeof m === 'object') ? m : {};
}

function getCoinMeta(coinId) {
    const popular = POPULAR_COINS.filter(c => c.coinId === coinId)[0];
    if (popular) {
        return { coinId: popular.coinId, symbol: popular.symbol, name: popular.name, binanceSymbol: popular.symbol + 'USDT', market: 'spot' };
    }
    const meta = getCoinMetaMap()[coinId];
    return meta || null;
}

/**
 * 登记币种元数据。source 为 futures 的走币安 USDT-M 合约（美股），
 * 其余走现货 —— 这个字段决定了详情页去哪个接口取数。
 */
function setCoinMeta(entry) {
    if (!entry || !entry.coinId) return null;
    const m = getCoinMetaMap();
    m[entry.coinId] = {
        coinId: entry.coinId,
        symbol: entry.symbol,
        name: entry.name || entry.symbol,
        binanceSymbol: entry.binanceSymbol,
        market: entry.market || 'spot',
    };
    writeJson(KEY.coinMeta, m);
    return m[entry.coinId];
}

function displayName(symbol, fallback) {
    const s = String(symbol || '').toUpperCase();
    return COIN_NAMES[s] || fallback || s;
}

// ---------------- 设置 ----------------

function getSettings() {
    const s = readJson(KEY.settings, null);
    return Object.assign({}, DEFAULT_SETTINGS, s && typeof s === 'object' ? s : {});
}

function setSettings(patch) {
    const next = Object.assign({}, getSettings(), patch || {});
    writeJson(KEY.settings, next);
    return next;
}

// ---------------- 目录缓存 ----------------

function getCache(name, ttlMs) {
    const all = readJson(KEY.cache, null);
    if (!all || !all[name]) return null;
    const item = all[name];
    if (!item.ts || Date.now() - item.ts > ttlMs) return null;
    return item.data;
}

function setCache(name, data) {
    const all = readJson(KEY.cache, null) || {};
    all[name] = { ts: Date.now(), data: data };
    writeJson(KEY.cache, all);
}

function clearCache() {
    try { wx.removeStorageSync(KEY.cache); } catch (e) { /* 忽略 */ }
}

module.exports = {
    KEY, POPULAR_COINS, COIN_NAMES, DEFAULT_SETTINGS,
    getWatchlist, setWatchlist, isWatched, addWatch, removeWatch,
    getCoinMeta, setCoinMeta, displayName,
    getSettings, setSettings,
    getCache, setCache, clearCache,
};
