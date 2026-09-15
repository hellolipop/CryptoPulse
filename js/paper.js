/**
 * 模拟自动交易模块（纸上交易）
 *
 * 按系统给出的买入/卖出信号自动模拟成交，全程不接真实交易所、不发送任何真实订单，
 * 只用于检验「照着信号做」能否赚钱。
 *
 * 成交规则：
 *   - 买入信号 → 用全部可用资金买入
 *   - 卖出信号 → 清空全部持仓
 *   - 观望信号 → 不做任何操作
 *   - 仅在方向发生变化时成交（与预测记录的口径一致），
 *     避免每 30 秒刷新一次就重复下单
 *   - 不计手续费与滑点，成交价取信号触发时的价格
 *
 * 账户按「币种 + 周期」隔离：
 * 4小时看多与日线看多是两套独立的判断，成交时点也不同，
 * 混在一起统计没有意义，也会和预测准确率的口径对不上。
 */

const PaperTrader = {
    storageKey: 'cryptoPulse_paperAccounts',
    enabledKey: 'cryptoPulse_paperEnabled',

    // 单个账户保留的成交记录上限
    maxTrades: 200,

    // 初始资金（USDT）
    initialCapital: 10000,

    accounts: null,
    enabled: false,

    // ---------------- 存储 ----------------

    /**
     * 账户键：币种 + 周期
     */
    accountKey(coinId, timeframe) {
        return `${coinId}_${timeframe}`;
    },

    /**
     * 读取全部账户（懒加载并缓存）
     */
    load() {
        if (this.accounts) return this.accounts;
        try {
            const raw = localStorage.getItem(this.storageKey);
            const parsed = raw ? JSON.parse(raw) : {};
            this.accounts = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
        } catch (e) {
            console.warn('[模拟] 读取账户失败:', e.message);
            this.accounts = {};
        }
        return this.accounts;
    },

    /**
     * 写回全部账户
     */
    save() {
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(this.accounts || {}));
        } catch (e) {
            console.warn('[模拟] 保存账户失败:', e.message);
        }
    },

    /**
     * 开关状态单独持久化，避免和账户数据耦合
     */
    loadEnabled() {
        try {
            return localStorage.getItem(this.enabledKey) === '1';
        } catch (e) {
            return false;
        }
    },

    saveEnabled(on) {
        this.enabled = !!on;
        try {
            localStorage.setItem(this.enabledKey, on ? '1' : '0');
        } catch (e) {
            console.warn('[模拟] 保存开关失败:', e.message);
        }
    },

    // ---------------- 账户 ----------------

    /**
     * 取账户，不存在则初始化
     * @param {string} coinId
     * @param {number|string} timeframe
     * @returns {Object}
     */
    getAccount(coinId, timeframe) {
        const accounts = this.load();
        const key = this.accountKey(coinId, timeframe);
        if (!accounts[key]) {
            accounts[key] = {
                key,
                coinId,
                timeframe,
                initialCapital: this.initialCapital,
                cash: this.initialCapital,
                holdings: 0,
                avgCost: 0,
                trades: [],
                lastSide: null,
                firstBuyPrice: null,
                createdAt: Date.now(),
            };
        }
        return accounts[key];
    },

    /**
     * 重置账户（清空成交记录与持仓，资金回到初始值）
     */
    reset(coinId, timeframe) {
        const accounts = this.load();
        delete accounts[this.accountKey(coinId, timeframe)];
        this.save();
        return this.getAccount(coinId, timeframe);
    },

    /**
     * 将当前持仓的均价按最新价重估（仅用于展示浮盈，不落库）
     * @param {Object} acc
     * @param {number} price
     */
    snapshot(acc, price) {
        const holdingsValue = acc.holdings * (price > 0 ? price : 0);
        return {
            cash: acc.cash,
            holdings: acc.holdings,
            avgCost: acc.avgCost,
            holdingsValue,
            equity: acc.cash + holdingsValue,
            holding: acc.holdings > 0,
            unrealized: acc.holdings > 0 && acc.avgCost > 0
                ? (price - acc.avgCost) * acc.holdings
                : 0,
            unrealizedPct: acc.holdings > 0 && acc.avgCost > 0
                ? (price / acc.avgCost - 1)
                : 0,
        };
    },

    /**
     * 收到信号时的处理入口
     *
     * @param {Object} p - { coinId, coinSymbol, timeframe, signalType, signalText, price,
     *                       score, totalScore, sensitivity }
     * @returns {Object|null} 成交记录，未成交返回 null
     */
    onSignal(p) {
        if (!this.enabled) return null;
        if (!p || !p.coinId || !p.price || p.price <= 0) return null;

        const side = this.toSide(p.signalType);
        if (!side) return null; // 观望不操作

        const acc = this.getAccount(p.coinId, p.timeframe);

        // 仅方向变化时成交
        if (acc.lastSide === side) return null;

        // 买入需要有可用资金
        if (side === 'buy' && acc.cash <= 1) {
            acc.lastSide = side;
            this.save();
            return null;
        }

        // 空仓时收到卖出信号：只记录方向，避免后续同一方向反复触发
        if (side === 'sell' && acc.holdings <= 0) {
            acc.lastSide = side;
            this.save();
            return null;
        }

        const now = Date.now();
        const trade = {
            id: `${acc.key}-${now}`,
            time: now,
            side,
            price: p.price,
            signalText: p.signalText || '',
            signalType: p.signalType || '',
            score: typeof p.score === 'number' ? p.score : null,
            totalScore: typeof p.totalScore === 'number' ? p.totalScore : null,
            sensitivity: p.sensitivity || '',
            qty: 0,
            amount: 0,
            pnl: null,
            pnlPct: null,
        };

        if (side === 'buy') {
            const qty = acc.cash / p.price;
            const cost = acc.cash;

            // 按加权方式更新持仓均价（正常情况下买入前为空仓）
            const prevQty = acc.holdings;
            const prevCost = acc.avgCost * prevQty;
            acc.holdings = prevQty + qty;
            acc.avgCost = acc.holdings > 0 ? (prevCost + cost) / acc.holdings : 0;
            acc.cash = 0;

            trade.qty = qty;
            trade.amount = cost;

            if (acc.firstBuyPrice === null) acc.firstBuyPrice = p.price;
        } else {
            const qty = acc.holdings;
            const proceeds = qty * p.price;

            trade.qty = qty;
            trade.amount = proceeds;
            trade.avgCost = acc.avgCost;
            trade.pnl = (p.price - acc.avgCost) * qty;
            trade.pnlPct = acc.avgCost > 0 ? (p.price / acc.avgCost - 1) : 0;

            acc.cash += proceeds;
            acc.holdings = 0;
            acc.avgCost = 0;
        }

        // 成交后的账户快照，用于计算权益曲线与最大回撤
        trade.cashAfter = acc.cash;
        trade.holdingsAfter = acc.holdings;
        trade.equityAfter = acc.cash + acc.holdings * p.price;

        acc.trades.push(trade);
        if (acc.trades.length > this.maxTrades) {
            acc.trades = acc.trades.slice(-this.maxTrades);
        }
        acc.lastSide = side;

        this.save();
        return trade;
    },

    /**
     * 信号类型转买卖方向
     * @param {string} signalType
     * @returns {'buy'|'sell'|null}
     */
    toSide(signalType) {
        if (signalType === 'buy' || signalType === 'strong_buy') return 'buy';
        if (signalType === 'sell' || signalType === 'strong_sell') return 'sell';
        return null;
    },

    /**
     * 同步已记录的方向状态
     *
     * 开关刚打开时调用，把当前信号方向记下来，
     * 这样不会立刻对「已经发生过的信号」补一笔成交，
     * 只有后续方向变化才真正下单。
     *
     * @param {string} coinId
     * @param {number|string} timeframe
     * @param {string} signalType
     */
    syncSide(coinId, timeframe, signalType) {
        const acc = this.getAccount(coinId, timeframe);
        acc.lastSide = this.toSide(signalType); // 可能为 null（观望）
        this.save();
    },

    /**
     * 统计账户表现
     *
     * @param {string} coinId
     * @param {number|string} timeframe
     * @param {number} currentPrice - 当前价格，用于计算持仓市值
     * @returns {Object}
     */
    getMetrics(coinId, timeframe, currentPrice) {
        const acc = this.getAccount(coinId, timeframe);
        const price = currentPrice > 0
            ? currentPrice
            : (acc.trades.length ? acc.trades[acc.trades.length - 1].price : 0);

        const snap = this.snapshot(acc, price);
        const totalReturn = acc.initialCapital > 0
            ? (snap.equity / acc.initialCapital - 1)
            : 0;

        // 同期买入持有：以首次买入价为基准，衡量「不做择时」的收益
        const holdReturn = (acc.firstBuyPrice && price > 0)
            ? (price / acc.firstBuyPrice - 1)
            : null;

        // 每笔卖出代表一轮交易结束
        const sells = acc.trades.filter(t => t.side === 'sell');
        const wins = sells.filter(t => (t.pnl || 0) > 0).length;
        const realized = sells.reduce((sum, t) => sum + (t.pnl || 0), 0);

        // 最大回撤：由各次成交后的权益快照 + 当前权益构成权益曲线
        const curve = acc.trades
            .map(t => t.equityAfter)
            .filter(v => typeof v === 'number');
        curve.push(snap.equity);

        let peak = acc.initialCapital;
        let maxDrawdown = 0;
        curve.forEach(v => {
            if (v > peak) peak = v;
            const dd = peak > 0 ? (peak - v) / peak : 0;
            if (dd > maxDrawdown) maxDrawdown = dd;
        });

        return {
            initialCapital: acc.initialCapital,
            cash: snap.cash,
            holdings: snap.holdings,
            holdingsValue: snap.holdingsValue,
            equity: snap.equity,
            holding: snap.holding,
            avgCost: snap.avgCost,
            unrealized: snap.unrealized,
            unrealizedPct: snap.unrealizedPct,
            totalReturn,
            holdReturn,
            excessReturn: holdReturn === null ? null : totalReturn - holdReturn,
            roundTrips: sells.length,
            wins,
            losses: sells.length - wins,
            winRate: sells.length ? wins / sells.length : null,
            realized,
            maxDrawdown,
            firstBuyPrice: acc.firstBuyPrice,
            lastSide: acc.lastSide,
            trades: acc.trades,
        };
    },

    /**
     * 取成交记录（按时间倒序）
     */
    getTrades(coinId, timeframe, limit = 50) {
        const acc = this.getAccount(coinId, timeframe);
        return acc.trades.slice().reverse().slice(0, limit);
    },
};
