const api = require('../../utils/api.js');
const store = require('../../utils/store.js');
const format = require('../../utils/format.js');

const CATS = [
    { key: 'watch', label: '自选' },
    { key: 'hot', label: '热门' },
    { key: 'stock', label: '美股' },
];

Page({
    data: {
        cats: CATS,
        cat: 'watch',
        list: [],
        keyword: '',
        results: [],
        resultNote: '',
        loading: false,
        loadingText: '',
        error: '',
        refreshing: false,
    },

    onLoad() {
        this._catalog = null;
        this._stockCatalog = null;
        this.loadList();
    },

    onShow() {
        // 从详情页返回时刷新行情；目录缓存不重建
        if (this._loadedOnce) this.loadList();
    },

    // ---------------- 分类 ----------------

    switchCat(e) {
        const key = e.currentTarget.dataset.key;
        if (key === this.data.cat) return;
        this.setData({ cat: key, keyword: '', results: [], resultNote: '', error: '' });
        this.loadList();
    },

    // ---------------- 列表加载 ----------------

    async loadList() {
        const cat = this.data.cat;
        this.setData({ loading: true, error: '', loadingText: cat === 'stock' ? '加载美股目录…' : '加载行情…' });

        try {
            let base;
            if (cat === 'watch') base = this.buildWatchlist();
            else if (cat === 'hot') base = this.buildHot();
            else base = await this.buildStock();

            this.setData({ list: base, loading: false, loadingText: '' });
            this._loadedOnce = true;
            this.fillQuotes();
        } catch (err) {
            this.setData({
                loading: false,
                loadingText: '',
                error: this.friendlyError(err),
            });
        }
    },

    buildWatchlist() {
        const ids = store.getWatchlist();
        const out = [];
        ids.forEach((id) => {
            const meta = store.getCoinMeta(id);
            if (meta && meta.binanceSymbol) out.push(this.toRow(meta));
        });
        return out;
    },

    buildHot() {
        return store.POPULAR_COINS.map(function (c) {
            return {
                coinId: c.coinId,
                symbol: c.symbol,
                name: c.name,
                binanceSymbol: c.symbol + 'USDT',
                market: 'spot',
                price: null,
                changePercent: null,
                amountText: '',
                watched: store.isWatched(c.coinId),
            };
        });
    },

    async buildStock() {
        const catalog = await this.ensureStockCatalog();
        return catalog.map(c => this.toRow(c));
    },

    toRow(meta) {
        return {
            coinId: meta.coinId,
            symbol: meta.symbol,
            name: meta.name || store.displayName(meta.symbol),
            binanceSymbol: meta.binanceSymbol,
            market: meta.market || 'spot',
            price: null,
            changePercent: null,
            amountText: '',
            watched: store.isWatched(meta.coinId),
        };
    },

    /**
     * 批量补行情。
     * 现货与合约分两条路：把合约交易对塞进现货的批量接口会让整批请求失败。
     *
     * 单个标的失败可以忍（列表照常显示，只是那一行没有价格），
     * 但**全部都失败时必须说出来**：最常见的原因是开发者工具没勾「不校验合法域名」，
     * 如果静默吞掉，用户看到的就只是一列 --，完全不知道问题出在哪。
     */
    async fillQuotes() {
        const list = this.data.list;
        if (!list.length) return;

        const spotSymbols = [];
        const stockSymbols = [];
        list.forEach((c) => {
            if (c.market === 'futures') stockSymbols.push(c.binanceSymbol);
            else spotSymbols.push(c.binanceSymbol);
        });

        let spotMap = {};
        let stockMap = {};
        const jobs = [];
        let jobCount = 0;
        let failCount = 0;
        let firstErr = null;

        if (spotSymbols.length) {
            jobCount++;
            jobs.push(api.spotTickers(spotSymbols).then(m => { spotMap = m; })
                .catch((e) => { failCount++; if (!firstErr) firstErr = e; }));
        }
        if (stockSymbols.length) {
            jobCount++;
            jobs.push(api.stockTickers().then(m => { stockMap = m; })
                .catch((e) => { failCount++; if (!firstErr) firstErr = e; }));
        }
        if (jobs.length) await Promise.all(jobs);

        const rows = this.data.list.map(function (c) {
            const q = c.market === 'futures' ? stockMap[c.binanceSymbol] : spotMap[c.binanceSymbol];
            if (!q) return c;
            return Object.assign({}, c, {
                price: format.price(q.price),
                changePercent: format.pct(q.changePercent),
                dirClass: format.dirClass(q.changePercent),
                amountText: q.quoteVolume ? format.amount(q.quoteVolume) : '',
            });
        });

        const patch = { list: rows };
        if (jobCount > 0 && failCount === jobCount) patch.error = this.friendlyError(firstErr);
        this.setData(patch);
    },

    // ---------------- 目录（懒加载） ----------------

    async ensureStockCatalog() {
        if (this._stockCatalog) return this._stockCatalog;
        this._stockCatalog = await api.stockCatalog();
        return this._stockCatalog;
    },

    async ensureSpotCatalog() {
        if (this._catalog) return this._catalog;
        this._catalog = await api.spotCatalog();
        return this._catalog;
    },

    // ---------------- 搜索 ----------------

    onKeyword(e) {
        const kw = (e.detail.value || '').trim();
        this.setData({ keyword: kw });
        if (!kw) {
            this.setData({ results: [], resultNote: '' });
            return;
        }
        this.runSearch(kw);
    },

    async runSearch(kw) {
        this.setData({ searching: true, resultNote: '加载币种目录…' });
        try {
            // 美股与现货目录都要参与搜索：在「自选」分类下输入 AAPL 也应该能搜到
            const [spot, stock] = await Promise.all([
                this.ensureSpotCatalog().catch(() => []),
                this.ensureStockCatalog().catch(() => []),
            ]);
            const q = kw.toLowerCase();
            const match = function (c) {
                return c.symbol.toLowerCase().indexOf(q) >= 0 ||
                    (c.name || '').toLowerCase().indexOf(q) >= 0 ||
                    c.coinId.indexOf(q) >= 0;
            };
            const stocks = stock.filter(match);
            const spots = spot.filter(match);
            const results = stocks.concat(spots).slice(0, 60).map(c => this.toRow(c));

            this.setData({
                searching: false,
                results: results,
                resultNote: results.length
                    ? `共 ${stocks.length + spots.length} 个结果` + (spots.length > 60 ? '（只显示前 60 个）' : '')
                    : '',
            });
            if (results.length) this.fillResultQuotes();
        } catch (err) {
            this.setData({ searching: false, resultNote: '', error: this.friendlyError(err) });
        }
    },

    async fillResultQuotes() {
        const rows = this.data.results;
        const spotSymbols = [];
        const stockSymbols = [];
        rows.forEach(function (c) {
            if (c.market === 'futures') stockSymbols.push(c.binanceSymbol);
            else spotSymbols.push(c.binanceSymbol);
        });

        let spotMap = {};
        let stockMap = {};
        const jobs = [];
        let jobCount = 0;
        let failCount = 0;
        let firstErr = null;

        if (spotSymbols.length) {
            jobCount++;
            jobs.push(api.spotTickers(spotSymbols).then(m => { spotMap = m; })
                .catch((e) => { failCount++; if (!firstErr) firstErr = e; }));
        }
        if (stockSymbols.length) {
            jobCount++;
            jobs.push(api.stockTickers().then(m => { stockMap = m; })
                .catch((e) => { failCount++; if (!firstErr) firstErr = e; }));
        }
        await Promise.all(jobs);

        const merged = this.data.results.map(function (c) {
            const q = c.market === 'futures' ? stockMap[c.binanceSymbol] : spotMap[c.binanceSymbol];
            if (!q) return c;
            return Object.assign({}, c, {
                price: format.price(q.price),
                changePercent: format.pct(q.changePercent),
                dirClass: format.dirClass(q.changePercent),
                amountText: q.quoteVolume ? format.amount(q.quoteVolume) : '',
            });
        });
        // 与列表一致：全都取不到行情时要说出来，不能只留一列 --
        const patch = { results: merged };
        if (jobCount > 0 && failCount === jobCount) patch.error = this.friendlyError(firstErr);
        this.setData(patch);
    },

    clearKeyword() {
        this.setData({ keyword: '', results: [], resultNote: '' });
    },

    // ---------------- 自选 ----------------

    toggleWatch(e) {
        const coinId = e.currentTarget.dataset.coinid;
        const symbol = e.currentTarget.dataset.symbol;
        const market = e.currentTarget.dataset.market;
        const binanceSymbol = e.currentTarget.dataset.binancesymbol;

        const watched = store.isWatched(coinId);
        if (watched) {
            const r = store.removeWatch(coinId);
            if (!r.ok) { wx.showToast({ title: r.message, icon: 'none' }); return; }
            wx.showToast({ title: '已移出自选', icon: 'none' });
        } else {
            // 先登记元数据再入自选：详情页要靠它判断走现货还是合约
            store.setCoinMeta({
                coinId: coinId,
                symbol: symbol,
                name: this.findName(coinId, symbol),
                binanceSymbol: binanceSymbol,
                market: market,
            });
            const r = store.addWatch(coinId);
            if (!r.ok) { wx.showToast({ title: r.message, icon: 'none' }); return; }
            wx.showToast({ title: '已加入自选', icon: 'none' });
        }

        this.markWatched(coinId, !watched);
        if (this.data.cat === 'watch') this.loadList();
    },

    findName(coinId, symbol) {
        const all = (this._catalog || []).concat(this._stockCatalog || []);
        const hit = all.filter(c => c.coinId === coinId)[0];
        if (hit && hit.name) return hit.name;
        return store.displayName(symbol);
    },

    markWatched(coinId, watched) {
        const patch = function (arr) {
            return arr.map(function (c) {
                if (c.coinId !== coinId) return c;
                return Object.assign({}, c, { watched: watched });
            });
        };
        this.setData({ list: patch(this.data.list), results: patch(this.data.results) });
    },

    // ---------------- 跳转 ----------------

    goDetail(e) {
        const d = e.currentTarget.dataset;
        const app = getApp();
        if (app) app.globalData.lastCoinId = d.coinid;
        wx.navigateTo({
            url: '/pages/detail/detail?coinId=' + encodeURIComponent(d.coinid) +
                '&market=' + encodeURIComponent(d.market) +
                '&symbol=' + encodeURIComponent(d.binancesymbol),
        });
    },

    onPullDownRefresh() {
        this.setData({ refreshing: true });
        this.loadList().then(() => {
            wx.stopPullDownRefresh();
            this.setData({ refreshing: false });
        });
    },

    // ---------------- 错误提示 ----------------

    /**
     * wx.request 的失败信息里，最常见也最容易被误判成「程序坏了」的是
     * 「url not in domain list」—— 那是开发者工具没开「不校验合法域名」。
     * 直接把处理方法写出来，省得对着报错猜。
     */
    friendlyError(err) {
        const msg = (err && err.message) || String(err);
        if (msg.indexOf('domain list') >= 0 || msg.indexOf('not in domain') >= 0) {
            return '请求域名未通过校验：请在微信开发者工具「详情 → 本地设置」勾选「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」，然后重新编译。';
        }
        if (msg.indexOf('timeout') >= 0 || msg.indexOf('time out') >= 0) {
            return '请求超时：请检查网络能否访问币安接口。';
        }
        return '加载失败：' + msg;
    },
});
