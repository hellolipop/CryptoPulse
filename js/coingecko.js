'use strict';
/**
 * CoinGecko 数据源 —— 用于覆盖币安未上线的币种
 *
 * 为什么需要：原先全站只覆盖币安现货 USDT 交易对，像 GWEI(ETHGas) 这种
 * 只在 HTX / BitMart / Upbit 上线的币种搜都搜不到。
 *
 * ============ 能力边界（均为官方文档或本机实测确认，不是推测）============
 *
 * 能做到：
 *   - 全市场搜索（官方称覆盖 18000+ 币种）
 *   - 价格 / 市值 / 排名 / 24h、7d、30d 涨跌 / ATH、ATL / 供应量
 *   - OHLC 蜡烛：days=1 → 30 分钟粒度；3~30 天 → 4 小时；31 天以上 → 4 天
 *   - market_chart 的成交量序列（无 key 情况下唯一能拿到成交量的官方途径）
 *
 * 做不到（这些限制直接决定了界面上要标注什么）：
 *   - /coins/{id}/ohlc 的返回结构只有 [时间戳,开,高,低,收]，**不含成交量**。
 *     成交量只能用 market_chart 按蜡烛时间窗聚合近似，属工程近似、非官方口径。
 *   - 历史深度：无 key 只能回溯 365 天。
 *   - 没有资金费率、持仓量的历史序列，也没有多空比 → 衍生品因子无法计算。
 *   - OHLC 官方缓存 15 分钟，做不到秒级实时。
 *   - OHLC 时间戳是蜡烛的**收盘时间**（官方原文），不是开盘时间。
 *
 * ============ 为什么不带 API key ============
 * CoinGecko 官方明确要求「把 key 放在后端、用代理注入」，并把 CORS 问题
 * 直接指向后端代理；Demo key 放在前端等于违反官方指引且会被薅额度。
 * 本应用是纯前端，因此使用无 key 模式，靠「串行队列 + 缓存 + 429 退避」
 * 去适配这个按 IP 共享的限流桶。
 */

const CoinGecko = {
    BASE: 'https://api.coingecko.com/api/v3',

    // 各端点的缓存时长，取自官方文档的数据新鲜度说明
    TTL: {
        markets: 60 * 1000,      // /coins/markets 无 key 为 60 秒
        ohlc: 15 * 60 * 1000,    // /coins/{id}/ohlc 官方缓存 15 分钟
        chart: 60 * 1000,        // /coins/{id}/market_chart 官方缓存 30 秒，留余量取 60 秒
        search: 10 * 60 * 1000,  // 搜索结果变动慢
    },

    // CoinGecko 的粒度是「按 days 决定」，不能像币安那样自由指定 interval。
    // 所以只提供它真正能给出的档位，并在界面上如实标注粒度。
    TIMEFRAMES: [
        { key: '24h', label: '24小时', days: 1, barMs: 30 * 60 * 1000, granularity: '30分钟' },
        { key: '7d', label: '7天', days: 7, barMs: 4 * 3600 * 1000, granularity: '4小时' },
        { key: '30d', label: '30天', days: 30, barMs: 4 * 3600 * 1000, granularity: '4小时' },
        { key: '1y', label: '1年', days: 365, barMs: 4 * 24 * 3600 * 1000, granularity: '4天' },
    ],

    _cache: new Map(),
    _queue: Promise.resolve(),
    _lastCallAt: 0,
    _minIntervalMs: 1200,   // 串行 + 最小间隔，避免打在共享限流桶上

    isAvailable() {
        return typeof fetch === 'function';
    },

    // ---------------- 底层请求 ----------------

    _cacheKey(path, params) {
        return path + '?' + Object.keys(params).sort().map(k => k + '=' + params[k]).join('&');
    },

    _getCache(key, ttl) {
        const hit = this._cache.get(key);
        if (!hit) return null;
        if (Date.now() - hit.ts > ttl) { this._cache.delete(key); return null; }
        return hit.data;
    },

    /**
     * 所有请求走同一条串行队列：CoinGecko 无 key 时按 IP 共享限流，
     * 并发打过去只会更快触发 429。
     */
    _enqueue(fn) {
        const run = this._queue.then(async () => {
            const wait = this._minIntervalMs - (Date.now() - this._lastCallAt);
            if (wait > 0) await new Promise(r => setTimeout(r, wait));
            this._lastCallAt = Date.now();
            return fn();
        });
        // 队列本身不能被单次失败打断
        this._queue = run.then(() => undefined, () => undefined);
        return run;
    },

    async _request(path, params, ttlKey) {
        const key = this._cacheKey(path, params);
        const cached = this._getCache(key, this.TTL[ttlKey] || 60000);
        if (cached) return cached;

        return this._enqueue(async () => {
            const qs = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
            const url = `${this.BASE}${path}${qs ? '?' + qs : ''}`;

            let res;
            try {
                res = await fetch(url);
            } catch (e) {
                const err = new Error('无法连接 CoinGecko：' + e.message);
                err.network = true;
                throw err;
            }

            if (res.status === 429) {
                const err = new Error('CoinGecko 请求过于频繁（免费接口按 IP 共享限流），请稍后再试');
                err.rateLimited = true;
                throw err;
            }
            if (res.status === 404) {
                const err = new Error('CoinGecko 没有这个币种');
                err.notFound = true;
                throw err;
            }
            if (!res.ok) {
                throw new Error(`CoinGecko 请求失败 HTTP ${res.status}`);
            }

            const data = await res.json();
            this._cache.set(key, { ts: Date.now(), data });
            return data;
        });
    },

    // ---------------- 业务接口 ----------------

    /**
     * 全市场搜索。用于找出币安没有收录的币种。
     * @returns {Promise<Array<{id,symbol,name,rank,thumb}>>}
     */
    async search(query) {
        const q = String(query || '').trim();
        if (!q) return [];
        const data = await this._request('/search', { query: q }, 'search');
        return (data.coins || []).map(c => ({
            id: c.id,
            symbol: (c.symbol || '').toUpperCase(),
            name: c.name || c.symbol,
            rank: c.market_cap_rank || null,
            thumb: c.thumb || c.large || '',
        }));
    },

    /** 批量行情，一次最多 250 个 id */
    async markets(ids) {
        const list = (Array.isArray(ids) ? ids : [ids]).slice(0, 250);
        if (!list.length) return [];
        return this._request('/coins/markets', {
            vs_currency: 'usd',
            ids: list.join(','),
            price_change_percentage: '1h,24h,7d,30d',
        }, 'markets');
    },

    async market(id) {
        const list = await this.markets([id]);
        return list && list[0] ? list[0] : null;
    },

    async ohlc(id, days) {
        return this._request(`/coins/${id}/ohlc`, { vs_currency: 'usd', days }, 'ohlc');
    },

    async marketChart(id, days) {
        return this._request(`/coins/${id}/market_chart`, { vs_currency: 'usd', days }, 'chart');
    },

    /**
     * 组装成和币安 K 线同构的蜡烛数组，供图表与指标计算直接复用。
     *
     * 成交量处理：OHLC 端点不含成交量，这里用 market_chart 的 total_volumes
     * 按蜡烛时间窗求和补齐。这是近似 —— OHLC 时间戳是收盘时间，
     * 所以每根蜡烛覆盖 (T - barMs, T]。界面必须标注成交量是估算值。
     *
     * @returns {Promise<{candles:Array, volumeApprox:boolean, granularity:string, days:number}>}
     */
    async buildCandles(id, days) {
        const tf = this.TIMEFRAMES.find(t => t.days === days) || this.TIMEFRAMES[1];

        const [rawOhlc, chart] = await Promise.all([
            this.ohlc(id, tf.days),
            this.marketChart(id, tf.days).catch(() => null),
        ]);

        if (!Array.isArray(rawOhlc) || !rawOhlc.length) {
            throw new Error('CoinGecko 没有返回该币种的 K 线数据');
        }

        // 成交量的时间序列（可能拿不到，那就留空而不是编造）
        const vols = (chart && Array.isArray(chart.total_volumes)) ? chart.total_volumes : null;

        const candles = rawOhlc.map(row => {
            const closeTime = row[0];
            const open = row[1], high = row[2], low = row[3], close = row[4];
            let volume = 0;

            if (vols) {
                const from = closeTime - tf.barMs;
                // total_volumes 的点位是采样值，落在开区间 (from, closeTime] 内即计入
                const bucket = vols.filter(v => v[0] > from && v[0] <= closeTime);
                volume = bucket.reduce((s, v) => s + (Number(v[1]) || 0), 0);

                // 粒度不匹配时（例如 4 天蜡烛配小时级采样）点数会很多，仍取和；
                // 若一个采样点都没落进来，说明对齐失败，宁可记 0 也不瞎补。
            }

            return {
                time: closeTime,          // 与币安不同：这里是收盘时间，图表内部按秒处理
                open, high, low, close, volume,
            };
        }).filter(c => [c.open, c.high, c.low, c.close].every(v => isFinite(v) && v > 0));

        // 图表按秒做时间轴，CoinGecko 给的是毫秒
        candles.forEach(c => { c.time = Math.floor(c.time / 1000); });

        return {
            candles,
            volumeApprox: !!vols,
            granularity: tf.granularity,
            days: tf.days,
            label: tf.label,
        };
    },

    /** 只作废行情缓存（自动刷新时用，保证拿到最新价而不是 60 秒内的旧值） */
    invalidateMarkets(id) {
        for (const key of Array.from(this._cache.keys())) {
            if (key.indexOf('/coins/markets') === 0 && key.indexOf(id) >= 0) {
                this._cache.delete(key);
            }
        }
    },

    /** 清空缓存（手动刷新时用） */
    clearCache() {
        this._cache.clear();
    },
};
