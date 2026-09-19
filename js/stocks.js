'use strict';
/**
 * 币安美股（TradFi 合约）数据源
 *
 * 为什么是合约而不是现货：
 *   本机实测币安现货 exchangeInfo 共 3705 个交易对，其中股票标的 **0 个**；
 *   币安美股走的是 USDT-M 合约市场（fapi），不在现货。所以这条路必须换
 *   一套 base URL，不能沿用现货的 data-api.binance.vision。
 *
 * ============ 能力边界（均为本机实测，不是推测）============
 *
 * 能做到：
 *   - 合约目录里有股票标的，字段 underlyingType = "EQUITY"、contractType = "TRADIFI_PERPETUAL"
 *   - 24 小时连续交易：实测 AAPLUSDT 1 小时K线的小时位覆盖 0~23，没有休市缺口
 *   - 价格 / 24h 涨跌 / 高低 / 成交额：fapi/v1/ticker/24hr 字段名与现货一致
 *   - K线：fapi/v1/klines 返回结构与现货相同（12 列），1m/15m/1h/4h/1d/1w 都可用
 *   - 资金费率历史（fapi/v1/fundingRate）与持仓量（fapi/v1/openInterest）都能取到
 *
 * 做不到 / 必须如实标注：
 *   - **历史深度很浅，且无法补充**。实测 AAPLUSDT 最早一根 K 线是 2026-04-06：
 *     日线只有 166 根、周线只有 24 根（合约 2026 年才上线）。带 startTime 往前
 *     回溯同样停在 2026-04-06；换 indexPriceKlines / markPriceKlines 也只有 170 根。
 *     这是**标的年龄**的限制，不是取数方式的问题 —— 标的只存在了 166 天，
 *     就不可能有 200 天的成交记录。
 *     因此 MA200 在日线上不可得、周线上连 MA60 都不够。处理方式见 technical.js
 *     的 LONG_MA_LADDER：按可用根数降级到最长可用窗口，并把实际窗口标在界面上，
 *     而不是让这一项静默消失。
 *   - **资金费率长期贴近 0**。实测 AAPLUSDT 的 premiumIndex lastFundingRate
 *     为 0.00000000，历史 100 期费率绝对值也都在 0.00035 以内，
 *     远低于加密合约的量级 —— 衍生品因子对股票几乎是常数，不能参与评分。
 *   - 没有加密市场的恐慌贪婪指数，也没有对应的新闻源，所以情绪面与消息面
 *     两个因子对股票不适用（详见 app.js 里 updateSignal 的股票分支）。
 *
 * ============ 为什么不用硬编码股票名单 ============
 * 用 underlyingType / contractType 字段来识别，币安上新股票时这边不用改。
 * 只认 underlyingType = "EQUITY"（美股）。同一市场里还有 HK_EQUITY / KR_EQUITY /
 * CN_EQUITY / PREMARKET / COMMODITY / FX，需要时在 UNDERLYING 里加一行即可。
 */

const Stocks = {
    BASE: 'https://fapi.binance.com',

    /** 数据来源，界面上要如实标注 */
    SOURCE_LABEL: '币安 USDT-M 合约 · TradFi',

    /**
     * 认哪些 underlyingType。
     * key 是应用内的分类标识，label 是界面上显示的市场名。
     */
    UNDERLYING: {
        EQUITY: { key: 'usstock', label: '美股', note: '美国上市公司与在美上市 ETF' },
    },

    /**
     * 常用标的的中文名。
     *
     * 只收录能确认的；拿不准的一律不猜，回落到代码本身显示
     * （宁可不本地化，也不能给用户一个错误的公司名）。
     */
    NAMES: {
        // 科技 / 半导体
        AAPL: '苹果', MSFT: '微软', NVDA: '英伟达', GOOGL: '谷歌', AMZN: '亚马逊',
        META: 'Meta', TSLA: '特斯拉', AVGO: '博通', AMD: '超威半导体', INTC: '英特尔',
        MU: '美光科技', QCOM: '高通', TSM: '台积电', ORCL: '甲骨文', IBM: 'IBM',
        DELL: '戴尔', HPE: '慧与科技', WDC: '西部数据', SNDK: '闪迪',
        AMAT: '应用材料', LRCX: '泛林集团', KLAC: '科天半导体', ASML: '阿斯麦',
        ARM: 'ARM', SMCI: '超微电脑', ANET: 'Arista', CSCO: '思科', TXN: '德州仪器',
        FLEX: '伟创力', TER: '泰瑞达', GLW: '康宁', COHR: '相干', LITE: 'Lumentum',
        MRVL: '迈威尔科技', CRDO: 'Credo', ALAB: 'Astera Labs', CIEN: 'Ciena',
        AAOI: '应用光电', SONY: '索尼', NOK: '诺基亚', QNTX: 'Quantinuum',
        // 互联网 / 软件
        NFLX: '奈飞', ADBE: 'Adobe', CRM: 'Salesforce', NOW: 'ServiceNow',
        PANW: 'Palo Alto', CRWD: 'CrowdStrike', SNOW: 'Snowflake', DDOG: 'Datadog',
        TEAM: 'Atlassian', MDB: 'MongoDB', ZS: 'Zscaler', NET: 'Cloudflare',
        SHOP: 'Shopify', APP: 'AppLovin', UBER: '优步', EBAY: 'eBay',
        PYPL: 'PayPal', SOFI: 'SoFi', ZM: 'Zoom', DKNG: 'DraftKings',
        RDDT: 'Reddit', TTWO: 'Take-Two', DIS: '迪士尼', IONQ: 'IonQ',
        ONDS: 'Ondas', MARA: 'MARA', HUT: 'Hut 8', IREN: 'IREN',
        APLD: 'Applied Digital', RKLB: 'Rocket Lab', ASTS: 'AST SpaceMobile',
        // 消费 / 医药 / 金融
        COST: '好市多', WMT: '沃尔玛', KO: '可口可乐', HD: '家得宝', CAT: '卡特彼勒',
        JPM: '摩根大通', GS: '高盛', V: 'Visa', BRKB: '伯克希尔B', BX: '黑石',
        HOOD: 'Robinhood', COIN: 'Coinbase', MSTR: 'Strategy',
        LLY: '礼来', MRK: '默沙东', NVO: '诺和诺德', MRNA: 'Moderna',
        HIMS: 'Hims & Hers', TEM: 'Tempus AI', GME: '游戏驿站', AMC: 'AMC',
        RIVN: 'Rivian', FLNC: 'Fluence', VST: 'Vistra', GEV: 'GE Vernova',
        VRT: 'Vertiv', BITO: '比特币ETF', DJT: '特朗普媒体',
        // 中概
        BABA: '阿里巴巴', PDD: '拼多多',
        // 指数 / 行业 ETF
        SPY: '标普500ETF', QQQ: '纳指100ETF', IWM: '罗素2000ETF', SMH: '半导体ETF',
        XLE: '能源ETF', XBI: '生物科技ETF', GDX: '金矿ETF', URNM: '铀矿ETF',
        EWY: '韩国ETF', EWJ: '日本ETF', EWT: '台湾ETF', EWZ: '巴西ETF',
        // 杠杆 / 反向 ETF（名字里直接标出倍数与方向，避免误当成普通 ETF）
        TQQQ: '纳指3倍做多', SQQQ: '纳指3倍做空', SOXL: '半导体3倍做多',
        SOXS: '半导体3倍做空', NVDL: '英伟达2倍做多', TSLL: '特斯拉2倍做多',
        TZA: '小盘股3倍做空', KORU: '韩国3倍做多', UVXY: '恐慌指数1.5倍',
        TMF: '20年美债3倍做多', TBT: '20年美债2倍做空',
    },

    // 各端点的缓存时长
    TTL: {
        exchangeInfo: 60 * 60 * 1000,   // 合约目录变动慢，1 小时
        tickers: 20 * 1000,             // 全量行情快照，列表用
        klines: 20 * 1000,
        funding: 10 * 60 * 1000,
        premium: 20 * 1000,
    },

    /**
     * 历史深度不足时的提示文案。
     *
     * 窗口降级的规则放在 technical.js 的 LONG_MA_LADDER 里（分析口径只应有一处定义），
     * 这里只负责把「实际发生了什么」讲清楚：到底用的是哪个窗口，
     * 还是连最短窗口都撑不住、这一项完全没参与评分。
     *
     * @param {string} timeframeKey - 周期标识（'24' 日线 / '168' 周线 / 其它）
     * @param {number} barCount - 实际取到的K线根数
     * @param {number|null} longWindow - 实际采用的长期均线窗口；null 表示没有可用窗口
     * @returns {string|null} 提示文案；null 表示深度够用、无需提示
     */
    depthWarning(timeframeKey, barCount, longWindow) {
        if (!isFinite(barCount) || barCount <= 0) return null;
        if (longWindow === 200) return null;

        const label = String(timeframeKey) === '168' ? '周线'
            : String(timeframeKey) === '24' ? '日线' : '当前周期';

        if (isFinite(longWindow) && longWindow > 0) {
            return `${label} ${barCount} 根K线（币安美股合约 2026 年才上线）不足 MA200 所需的 200 根，`
                + `大趋势已改用 MA${longWindow} —— 这是可用窗口里最长的一个。`;
        }
        return `${label}仅 ${barCount} 根K线，连最短的 MA60 都不够，大趋势项不参与本次评分。`;
    },

    _cache: new Map(),

    isAvailable() {
        return typeof fetch === 'function';
    },

    // ---------------- 纯函数：便于单测 ----------------

    /**
     * 这个合约标的是不是股票。
     * 用字段判断而不是白名单：币安上新时这里不用改。
     */
    isStockContract(s) {
        if (!s) return false;
        return Object.prototype.hasOwnProperty.call(this.UNDERLYING, s.underlyingType);
    },

    /**
     * 显示名：优先中文名，没有就用代码本身。
     * 不猜、不音译，避免给出错误的公司名。
     */
    displayName(symbol) {
        const s = String(symbol || '').toUpperCase();
        return this.NAMES[s] || s;
    },

    /**
     * 从合约美股名单推出「现货代币化股票」的集合。
     *
     * 背景：币安现货其实**也**有美股 —— 代币化股票，代码是「原代码 + B」
     * （AAPLB / NVDAB / TSLAB …）。但现货 exchangeInfo 里没有任何字段能区分
     * 它们和普通币种（实测字段集与 BTCUSDT 完全一致），所以不能用字段识别。
     *
     * 也不能简单地「以 B 结尾就算」：BNB、SHIB、ARB、CKB、TRB 这些真实币种
     * 同样以 B 结尾，那样会把一堆币错标成股票。
     *
     * 因此用合约那边的 EQUITY 名单当权威集合，反查「X 与 XB」是否成对：
     * 只有 AAPL 在美股名单里，AAPLB 才会被认出来；BNB 没有对应的「BN」，
     * 自然不会被误判。
     */
    tokenizedBaseSet(equityBases) {
        const set = new Set();
        (equityBases || []).forEach(b => {
            const s = String(b || '').toUpperCase();
            if (s) set.add(s + 'B');
        });
        return set;
    },

    /**
     * 现货代币化股票 vs 合约标的该用哪个？
     *
     * 实测同一只苹果两个市场都挂了，于是直接比较（2026-09-18 本机实测）：
     *   现货 AAPLBUSDT：日线 52 根（2026-07-29 上线）、周线 8 根、24h 成交额 203 万美元
     *   合约 AAPLUSDT： 日线 166 根（2026-04-06 上线）、周线 24 根、24h 成交额 5408 万美元
     * 合约的历史深度是现货的 3 倍、流动性是 26 倍，做技术分析只能用合约。
     * 所以「美股」分类统一用合约标的；现货那批只在搜索结果里出现，并标注清楚。
     */
    VENUE_CHOICE_NOTE: '合约标的历史深度与流动性都明显优于现货代币化股票',

    /**
     * 把 exchangeInfo 归一化成应用内的目录条目。
     *
     * 只保留：状态 TRADING、计价 USDT、且属于 UNDERLYING 里登记的类型。
     * 过滤计价币是必须的：实测同名标的存在 USD1 计价的版本（如 SPCXUSD1），
     * 混进来会让下游按 "XXXUSDT" 拼请求时拿不到数据。
     */
    normalizeCatalog(data) {
        const out = [];
        const seen = new Set();
        const symbols = (data && data.symbols) || [];

        for (let i = 0; i < symbols.length; i++) {
            const s = symbols[i];
            if (!this.isStockContract(s)) continue;
            if (s.status !== 'TRADING') continue;
            if (s.quoteAsset !== 'USDT') continue;

            const base = String(s.baseAsset || '').toUpperCase();
            if (!base || seen.has(base)) continue;
            seen.add(base);

            const meta = this.UNDERLYING[s.underlyingType];
            out.push({
                coinId: base.toLowerCase(),
                symbol: base,
                name: this.displayName(base),
                binanceSymbol: s.symbol,
                market: 'futures',
                marketLabel: meta.label,
                underlyingType: s.underlyingType,
                contractType: s.contractType || '',
                onboardDate: Number(s.onboardDate) || 0,
                pricePrecision: Number(s.pricePrecision),
                quantityPrecision: Number(s.quantityPrecision),
                tickSize: this._filterValue(s, 'PRICE_FILTER', 'tickSize'),
                stepSize: this._filterValue(s, 'LOT_SIZE', 'stepSize'),
                minNotional: Number(this._filterValue(s, 'MIN_NOTIONAL', 'notional')) || 0,
                _vol: 0,
            });
        }

        return out;
    },

    _filterValue(s, filterType, field) {
        const filters = (s && s.filters) || [];
        for (let i = 0; i < filters.length; i++) {
            if (filters[i].filterType === filterType) return filters[i][field];
        }
        return undefined;
    },

    /**
     * K线数组 → 应用内的蜡烛结构。
     * 合约与现货的 K 线列定义一致：[开盘时间,开,高,低,收,量,...]，
     * 但下游是按对象取值的，这里统一转换，避免两套结构。
     */
    toCandle(k) {
        return {
            time: Math.floor(k[0] / 1000),
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
        };
    },

    toCandles(list) {
        if (!Array.isArray(list)) return [];
        const out = [];
        for (let i = 0; i < list.length; i++) {
            const c = this.toCandle(list[i]);
            if (isFinite(c.time) && isFinite(c.close)) out.push(c);
        }
        return out;
    },

    /**
     * 24h 行情 → 应用内的 coinInfo 字段。
     * 合约与现货的 ticker 字段名一致（实测 tickKeys 完全相同）。
     */
    toPriceInfo(t) {
        if (!t || t.lastPrice === undefined) return null;
        return {
            current_price: parseFloat(t.lastPrice),
            price_change_24h: parseFloat(t.priceChange),
            price_change_percentage_24h: parseFloat(t.priceChangePercent),
            high_24h: parseFloat(t.highPrice),
            low_24h: parseFloat(t.lowPrice),
            open_24h: parseFloat(t.openPrice),
            weighted_avg_price: parseFloat(t.weightedAvgPrice),
            trade_count: parseInt(t.count, 10),
            total_volume: parseFloat(t.volume),
            quote_volume: parseFloat(t.quoteVolume),
            market_cap: 0,
        };
    },

    // ---------------- 网络 ----------------

    _cacheGet(key, ttl) {
        const hit = this._cache.get(key);
        if (!hit) return null;
        if (Date.now() - hit.ts > ttl) { this._cache.delete(key); return null; }
        return hit.data;
    },

    _cacheSet(key, data) {
        this._cache.set(key, { ts: Date.now(), data });
        return data;
    },

    async _getJson(path, ttl, cacheKey) {
        const key = cacheKey || path;
        const cached = this._cacheGet(key, ttl);
        if (cached) return cached;

        const resp = await fetch(this.BASE + path);
        if (!resp.ok) {
            const err = new Error(`币安合约接口返回 HTTP ${resp.status}`);
            err.status = resp.status;
            throw err;
        }
        const data = await resp.json();
        return this._cacheSet(key, data);
    },

    /** 合约目录（只含股票标的） */
    async loadCatalog() {
        const data = await this._getJson('/fapi/v1/exchangeInfo', this.TTL.exchangeInfo);
        return this.normalizeCatalog(data);
    },

    /** 单个标的 24h 行情 */
    async ticker(symbol) {
        const raw = await this._getJson(
            `/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(symbol)}`, this.TTL.tickers
        );
        // 实测该端点在带 symbols（复数）参数时会忽略过滤、直接返回全量数组。
        // 单数 symbol 参数正常返回对象，但这里仍按数组兜底一次，
        // 免得某天返回结构变了就静默拿到 null 价格。
        const t = Array.isArray(raw)
            ? raw.filter(x => x && x.symbol === symbol)[0]
            : raw;
        return this.toPriceInfo(t);
    },

    /**
     * 全量 24h 行情快照。
     *
     * 实测 fapi/v1/ticker/24hr 在带 symbols 参数时并没有按列表过滤
     * （返回的是全量），所以这里直接取全量、在本地筛，
     * 比依赖那个参数更可靠；一次请求就能覆盖整个美股分类。
     */
    async allTickers() {
        const list = await this._getJson('/fapi/v1/ticker/24hr', this.TTL.tickers);
        const map = {};
        if (!Array.isArray(list)) return map;
        for (let i = 0; i < list.length; i++) {
            const t = list[i];
            if (!t || !t.symbol) continue;
            const p = this.toPriceInfo(t);
            if (p) map[t.symbol] = p;
        }
        return map;
    },

    /** K线 */
    async klines(symbol, interval, limit) {
        const raw = await this._getJson(
            `/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`,
            this.TTL.klines
        );
        return this.toCandles(raw);
    },

    /**
     * 资金费率历史。
     * 注意：股票合约的费率长期贴近 0（实测 |费率| < 0.00035），
     * 衍生品因子对股票基本是常数，界面上要说明，不要拿它当信号。
     */
    async fundingHistory(symbol, limit) {
        const raw = await this._getJson(
            `/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}&limit=${limit || 500}`,
            this.TTL.funding
        );
        if (!Array.isArray(raw)) return [];
        return raw
            .map(x => ({ t: Math.floor(Number(x.fundingTime) / 1000), rate: parseFloat(x.fundingRate) }))
            .filter(x => isFinite(x.t) && isFinite(x.rate))
            .sort((a, b) => a.t - b.t);
    },

    /** 资金费率与标记价格 */
    async premiumIndex(symbol) {
        const d = await this._getJson(
            `/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`, this.TTL.premium
        );
        return {
            lastFundingRate: parseFloat(d.lastFundingRate),
            markPrice: parseFloat(d.markPrice),
            indexPrice: parseFloat(d.indexPrice),
            nextFundingTime: Number(d.nextFundingTime) || 0,
        };
    },

    /** 持仓量 */
    async openInterest(symbol) {
        try {
            const d = await this._getJson(
                `/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`, this.TTL.premium
            );
            return parseFloat(d.openInterest);
        } catch (e) {
            return null;
        }
    },

    clearCache() {
        this._cache.clear();
    },
};
