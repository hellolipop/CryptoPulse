const api = require('../../utils/api.js');
const store = require('../../utils/store.js');
const format = require('../../utils/format.js');
const analyzeMod = require('../../utils/analyze.js');
const chart = require('../../utils/chart.js');

Page({
    data: {
        coinId: '',
        market: 'spot',
        symbol: '',
        name: '',
        isStock: false,

        loading: true,
        pending: false,
        error: '',

        price: '--',
        changePercent: '--',
        dirClass: 'flat',
        high: '--',
        low: '--',
        amountText: '--',
        tradeCount: '--',

        timeframes: [],
        timeframe: '24',
        timeframeLabel: '',

        sensitivities: [],
        sensitivity: 'balanced',

        // 长期均线（可能已降级）
        longMALabel: '',
        longMAValue: '--',
        longMADirClass: 'flat',
        longMANote: '',
        depthNote: '',

        indicators: [],
        levels: [],
        signal: null,
        factors: [],
        excludedNote: '',
        tips: [],
        advice: null,
        bars: 0,
        watched: false,
    },

    onLoad(query) {
        const coinId = decodeURIComponent(query.coinId || '');
        const market = decodeURIComponent(query.market || 'spot');
        const symbol = decodeURIComponent(query.symbol || '');

        const meta = store.getCoinMeta(coinId) || {};
        const settings = store.getSettings();

        const timeframes = analyzeMod.TIMEFRAMES.map(function (t) {
            return { key: t.key, label: t.label };
        });
        const sensitivities = Object.keys(analyzeMod.SENSITIVITY).map(function (k) {
            return { key: k, label: analyzeMod.SENSITIVITY[k].label };
        });

        this.setData({
            coinId: coinId,
            market: market,
            symbol: symbol || meta.symbol || coinId.toUpperCase(),
            name: meta.name || store.displayName(symbol),
            isStock: market === 'futures',
            timeframes: timeframes,
            timeframe: settings.timeframe,
            sensitivities: sensitivities,
            sensitivity: settings.sensitivity,
            watched: store.isWatched(coinId),
        });

        wx.setNavigationBarTitle({ title: (symbol || coinId).toUpperCase() });

        this._reqToken = 0;
        this.setupCanvas();
        this.loadAll();
    },

    onShow() {
        // 从别的页面回来时不必重算，但自选状态可能被列表页改过
        this.setData({ watched: store.isWatched(this.data.coinId) });
    },

    onPullDownRefresh() {
        this.loadAll().then(function () { wx.stopPullDownRefresh(); });
    },

    // ---------------- 画布 ----------------

    setupCanvas() {
        const that = this;
        wx.createSelectorQuery().in(this)
            .select('#kline')
            .fields({ node: true, size: true })
            .exec(function (res) {
                const item = res && res[0];
                if (!item || !item.node) return;
                const canvas = item.node;
                const ctx = canvas.getContext('2d');
                // getSystemInfoSync 在新基础库已标记废弃，优先用 getWindowInfo，
                // 并保留回退以便在旧版本上仍能跑到
                const info = (wx.getWindowInfo && wx.getWindowInfo()) ||
                    (wx.getSystemInfoSync && wx.getSystemInfoSync()) || {};
                const dpr = info.pixelRatio || 2;
                canvas.width = item.width * dpr;
                canvas.height = item.height * dpr;
                ctx.scale(dpr, dpr);
                that._canvas = canvas;
                that._ctx = ctx;
                that._cw = item.width;
                that._ch = item.height;
                that.redraw();
            });
    },

    redraw() {
        if (!this._ctx || !this._candles || !this._candles.length) return;
        const a = this._analysis || {};
        chart.draw(this._ctx, this._cw, this._ch, this._candles, {
            ma7: a.indicators ? a.indicators.ma7 : null,
            ma25: a.indicators ? a.indicators.ma25 : null,
            longMA: a.indicators ? a.indicators.longMA : null,
            longMAWindow: a.indicators && a.indicators.longMA ? a.indicators.longMA.window : '',
            timeframe: this.data.timeframe,
            maxBars: 110,
        });
    },

    // ---------------- 加载 ----------------

    async loadAll() {
        const token = ++this._reqToken;
        this._status = 'loading';
        const tf = analyzeMod.getTimeframe(this.data.timeframe);

        this.setData({ loading: true, pending: false, error: '', timeframeLabel: tf.label });

        try {
            // 行情与K线是首屏的关键路径，并行取
            const results = await Promise.all([
                api.ticker(this.data.market, this.data.symbol),
                api.klines(this.data.market, this.data.symbol, tf.interval, 300),
            ]);
            if (token !== this._reqToken) return;

            const tick = results[0];
            const candles = results[1];
            if (!candles.length) throw new Error('没有取到K线数据');

            this._candles = candles;
            this.applyTicker(tick);

            // 先用技术面 + 量能出一版结果，让用户马上看到东西
            this._analysis = analyzeMod.analyze({
                candles: candles,
                market: this.data.market,
                timeframe: this.data.timeframe,
                sensitivity: this.data.sensitivity,
                fng: this._fng,
                deriv: this._deriv,
            });
            this._status = 'technical';
            this.render();

            this.setData({ loading: false, pending: true });

            // 情绪面与衍生品不在关键路径上，后台补
            this.loadContext(token);
        } catch (err) {
            if (token !== this._reqToken) return;
            this._status = 'error';
            this.setData({ loading: false, pending: false, error: this.friendlyError(err) });
        }
    },

    async loadContext(token) {
        const tasks = [];

        // 恐慌贪婪指数只对加密币有意义，个股不取
        if (this.data.market === 'spot') {
            tasks.push(api.fearGreed().then((v) => { this._fng = v; }));
        }
        // 衍生品：合约标的的费率恒贴近 0、不参与评分，所以也不取
        if (this.data.market === 'spot') {
            tasks.push(api.derivatives(this.data.symbol).then((v) => { this._deriv = v; }));
        }

        if (!tasks.length) {
            this.setData({ pending: false });
            return;
        }

        await Promise.all(tasks.map(p => p.catch(() => {})));
        if (token !== this._reqToken) return;
        if (!this._candles || !this._candles.length) return;

        // 拿全了再算一次完整口径
        this._analysis = analyzeMod.analyze({
            candles: this._candles,
            market: this.data.market,
            timeframe: this.data.timeframe,
            sensitivity: this.data.sensitivity,
            fng: this._fng,
            deriv: this._deriv,
        });
        this._status = 'full';
        this.setData({ pending: false });
        this.render();
    },

    applyTicker(t) {
        this.setData({
            price: format.price(t.price),
            changePercent: format.pct(t.changePercent),
            dirClass: format.dirClass(t.changePercent),
            high: format.price(t.high24h),
            low: format.price(t.low24h),
            amountText: t.quoteVolume ? format.amount(t.quoteVolume) : '--',
            tradeCount: t.tradeCount ? String(t.tradeCount) : '--',
        });
    },

    // ---------------- 渲染 ----------------

    render() {
        const a = this._analysis;
        if (!a) return;
        const ind = a.indicators;
        const last = function (arr) {
            if (!arr || !arr.length) return null;
            const v = arr[arr.length - 1];
            return (v === null || v === undefined || !isFinite(v)) ? null : v;
        };

        // 长期均线：可能降级到更短的窗口，标题直接写实际窗口
        const lm = ind.longMA || {};
        const longValue = last(lm.series);
        let longMALabel;
        let longMAValue;
        let longMADirClass = 'flat';
        let longMANote = '';
        if (longValue) {
            longMALabel = 'MA' + lm.window + ' 牛熊线';
            longMAValue = format.price(longValue);
            longMADirClass = ind.currentPrice > longValue ? 'up' : 'down';
            if (lm.substituted) {
                longMANote = lm.bars + ' 根K线不足 200，MA200 不可得，此处改用 MA' + lm.window;
            }
        } else {
            longMALabel = '长期均线';
            longMAValue = '不可用';
            longMANote = (lm.bars || 0) + ' 根K线不足 60，长期均线不可得，大趋势项未参与评分';
        }

        // 技术指标
        const boll = ind.bollingerBands || {};
        const macdHist = last(ind.macd.histogram);
        const indicators = [
            { label: 'RSI(14)', value: fmtNum(last(ind.rsi), 1) },
            { label: 'MACD柱', value: fmtNum(macdHist, 4), cls: macdHist > 0 ? 'up' : (macdHist < 0 ? 'down' : 'flat') },
            { label: 'KDJ-K', value: fmtNum(last(ind.kdj.k), 1) },
            { label: '布林上轨', value: boll.upper ? format.price(last(boll.upper)) : '--' },
            { label: '布林下轨', value: boll.lower ? format.price(last(boll.lower)) : '--' },
            { label: 'EMA99', value: format.price(last(ind.ema99)) },
        ];

        // 关键价位
        const sr = ind.supportResistance || {};
        const levels = [];
        if (sr.resistance1) {
            levels.push({ label: '第二压力', value: format.price(sr.resistance2), cls: 'down' });
            levels.push({ label: '第一压力', value: format.price(sr.resistance1), cls: 'down' });
        }
        if (sr.support1) {
            levels.push({ label: '第一支撑', value: format.price(sr.support1), cls: 'up' });
            levels.push({ label: '第二支撑', value: format.price(sr.support2), cls: 'up' });
        }

        // 因子面板：值为 null 表示这一项没参与评分，显示「不适用」而不是 50 分
        const bd = a.signal.breakdown || {};
        const factors = [
            mkFactor('技术面', bd.technical, a.weights.technical),
            mkFactor('量能', bd.volume, a.weights.volume),
            mkFactor('情绪面', bd.sentiment, a.weights.sentiment,
                a.isStock ? '加密指标，个股不适用' : '数据未取到'),
            mkFactor('消息面', bd.news, a.weights.news, '本版未接入资讯源'),
            mkFactor('衍生品', bd.derivatives, a.weights.derivatives,
                a.isStock ? '美股费率恒贴近 0' : '数据未取到'),
        ];

        const sigDir = a.totalScore >= a.sensitivity.thresholds.buy ? 'up'
            : a.totalScore <= a.sensitivity.thresholds.sell ? 'down' : 'flat';

        this.setData({
            timeframeLabel: a.timeframe.label,
            bars: a.bars,
            longMALabel: longMALabel,
            longMAValue: longMAValue,
            longMADirClass: longMADirClass,
            longMANote: longMANote,
            depthNote: a.depthNote || '',
            indicators: indicators,
            levels: levels,
            signal: {
                text: a.signal.text,
                desc: a.signal.desc,
                totalScore: a.totalScore,
                dirClass: sigDir,
                sensitivityLabel: a.sensitivity.label,
            },
            factors: factors,
            excludedNote: a.excluded.join('；'),
            tips: a.signal.actionTips || [],
            advice: a.signal.positionAdvice || null,
        });

        this.redraw();
    },

    // ---------------- 交互 ----------------

    async switchTimeframe(e) {
        const key = e.currentTarget.dataset.key;
        if (key === this.data.timeframe) return;
        store.setSettings({ timeframe: key });
        this.setData({ timeframe: key });
        // 已取到的情绪/衍生品数据可以复用，不必重取
        await this.loadAll();
    },

    async switchSensitivity(e) {
        const key = e.currentTarget.dataset.key;
        if (key === this.data.sensitivity) return;
        store.setSettings({ sensitivity: key });
        this.setData({ sensitivity: key });
        // 只影响阈值与权重，K线不用重取
        if (this._candles && this._candles.length) {
            this._analysis = analyzeMod.analyze({
                candles: this._candles,
                market: this.data.market,
                timeframe: this.data.timeframe,
                sensitivity: key,
                fng: this._fng,
                deriv: this._deriv,
            });
            this.render();
        }
    },

    toggleWatch() {
        const coinId = this.data.coinId;
        if (store.isWatched(coinId)) {
            const r = store.removeWatch(coinId);
            if (!r.ok) { wx.showToast({ title: r.message, icon: 'none' }); return; }
            this.setData({ watched: false });
            wx.showToast({ title: '已移出自选', icon: 'none' });
        } else {
            store.setCoinMeta({
                coinId: coinId,
                symbol: this.data.symbol,
                name: this.data.name,
                binanceSymbol: this.data.symbol,
                market: this.data.market,
            });
            const r = store.addWatch(coinId);
            if (!r.ok) { wx.showToast({ title: r.message, icon: 'none' }); return; }
            this.setData({ watched: true });
            wx.showToast({ title: '已加入自选', icon: 'none' });
        }
    },

    copySymbol() {
        wx.setClipboardData({ data: this.data.symbol });
    },

    friendlyError(err) {
        const msg = (err && err.message) || String(err);
        if (msg.indexOf('domain list') >= 0 || msg.indexOf('not in domain') >= 0) {
            return '请求域名未通过校验：请在微信开发者工具「详情 → 本地设置」勾选「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」，然后重新编译。';
        }
        return '加载失败：' + msg;
    },
});

function fmtNum(v, digits) {
    if (v === null || v === undefined || !isFinite(v)) return '--';
    return Number(v).toFixed(digits);
}

/**
 * 因子面板的一行。
 * 权重为 0 或值为 null 时判定为「不适用」，显示「—」并给出原因 ——
 * 直接显示 50 分会被读成「中性」，用户会以为指标算过并且算出了中性。
 */
function mkFactor(label, value, weight, naReason) {
    const na = !weight || value === null || value === undefined || !isFinite(value);
    return {
        label: label,
        value: na ? '—' : Math.round(value),
        na: na,
        naReason: na ? (naReason || '该项未参与本次评分') : '',
        cls: na ? 'flat' : (value >= 55 ? 'up' : (value <= 45 ? 'down' : 'flat')),
    };
}
