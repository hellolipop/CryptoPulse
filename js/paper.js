/**
 * 模拟自动交易模块（纸上交易）
 *
 * 按系统给出的买入/卖出信号自动模拟成交，全程不接真实交易所、不发送任何真实订单，
 * 只用于检验「照着信号做」能否赚钱。
 *
 * 资金模型（两层）：
 *   总资金 totalCapital     —— 账户层面的总盘子，默认 200000 USDT
 *   币种配额 allocations[]  —— 每个币种从总资金里分到的金额，由用户手动填写
 *   未配额 = 总资金 - 已配额之和，这部分不参与任何交易
 *
 * 运行模型：
 *   每个币种有独立的开关（enabled），开启哪个币种就只跑哪个币种的信号，
 *   互不影响；切换币种看到的是该币种自己的账户与成交记录。
 *
 * 成交规则（与K线图上标注的买卖点完全一致）：
 *   - 买入点 → 用该币种配额内的全部可用资金买入
 *   - 卖出点 → 清空该币种全部持仓
 *   - 仅在方向发生变化时成交，同一方向的连续信号不重复下单
 *   - 以K线收盘价成交，不计手续费与滑点
 *
 * 之所以改为「回放K线买卖点」而不是听实时信号：
 *   图上画出的买卖点和右侧的实时信号是两套不同算法算出来的，
 *   两者经常不一致。此前用实时信号驱动，会出现「图上1点标了买入、
 *   模拟却没有任何动作」的情况。现在统一以图上的买卖点为唯一依据，
 *   并且按历史K线回放，所见即所做。
 */

const PaperTrader = {
    // v2：账户改为按币种独立，并新增总资金与配额，故换用新的存储键
    storageKey: 'cryptoPulse_paperV2',

    // 单账户保留的成交记录上限
    maxTrades: 200,

    // 总资金默认值（USDT）
    defaultTotalCapital: 200000,

    data: null,

    // ---------------- 存储 ----------------

    /**
     * 读取全部数据（含总资金、配额、开关、各币种账户）
     */
    load() {
        if (this.data) return this.data;

        let parsed = null;
        try {
            const raw = localStorage.getItem(this.storageKey);
            parsed = raw ? JSON.parse(raw) : null;
        } catch (e) {
            console.warn('[模拟] 读取数据失败:', e.message);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};

        this.data = {
            totalCapital: (typeof parsed.totalCapital === 'number' && parsed.totalCapital > 0)
                ? parsed.totalCapital
                : this.defaultTotalCapital,
            allocations: (parsed.allocations && typeof parsed.allocations === 'object') ? parsed.allocations : {},
            enabled: (parsed.enabled && typeof parsed.enabled === 'object') ? parsed.enabled : {},
            accounts: (parsed.accounts && typeof parsed.accounts === 'object') ? parsed.accounts : {},
        };
        return this.data;
    },

    save() {
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(this.data || {}));
        } catch (e) {
            console.warn('[模拟] 保存失败:', e.message);
        }
    },

    // ---------------- 总资金与配额 ----------------

    getTotalCapital() {
        return this.load().totalCapital;
    },

    /**
     * 设置总资金
     * 不允许小于已配额之和，否则配额会失去意义。
     *
     * @param {number} amount
     * @returns {{ok: boolean, message?: string}}
     */
    setTotalCapital(amount) {
        const v = Number(amount);
        if (!isFinite(v) || v <= 0) {
            return { ok: false, message: '总资金需大于 0' };
        }

        const allocated = this.getAllocatedTotal();
        if (v < allocated) {
            return { ok: false, message: `总资金不能小于已配额 ${this.formatAmount(allocated)}` };
        }

        const data = this.load();
        data.totalCapital = v;
        this.save();
        return { ok: true };
    },

    /**
     * 取某币种的配额金额
     * @returns {number} 未配置返回 0
     */
    getAllocation(coinId) {
        const v = this.load().allocations[coinId];
        return (typeof v === 'number' && v > 0) ? v : 0;
    },

    /**
     * 已配额之和
     * @param {string} [excludeCoinId] - 排除该币种（用于校验时避免把它自己算两次）
     */
    getAllocatedTotal(excludeCoinId) {
        const allocations = this.load().allocations;
        return Object.keys(allocations).reduce((sum, id) => {
            if (excludeCoinId && id === excludeCoinId) return sum;
            const v = allocations[id];
            return sum + ((typeof v === 'number' && v > 0) ? v : 0);
        }, 0);
    },

    /**
     * 未配额（总资金 - 已配额之和）
     */
    getIdleCapital() {
        return Math.max(0, this.getTotalCapital() - this.getAllocatedTotal());
    },

    /**
     * 设置某币种的配额
     *
     * 配额变化会重置该币种的账户：投入本金变了，
     * 之前基于旧本金算出的收益率就不再可比，留着会造成误读。
     *
     * @param {string} coinId
     * @param {number} amount
     * @returns {{ok: boolean, message?: string, reset?: boolean}}
     */
    setAllocation(coinId, amount) {
        if (!coinId) return { ok: false, message: '缺少币种' };

        const v = Number(amount);
        if (!isFinite(v) || v <= 0) {
            return { ok: false, message: '配额金额需大于 0' };
        }

        const total = this.getTotalCapital();
        const others = this.getAllocatedTotal(coinId);
        if (others + v > total) {
            const available = Math.max(0, total - others);
            return {
                ok: false,
                message: `超出可用额度，最多可配 ${this.formatAmount(available)}`,
            };
        }

        const data = this.load();
        const changed = data.allocations[coinId] !== v;
        data.allocations[coinId] = v;

        // 配额变化 → 按新本金重建该币种账户
        // 但要保留「从何时开始模拟」与策略周期，否则改金额会把
        // 起点重置成无限早，凭空多出一堆历史成交
        let reset = false;
        if (changed) {
            const prev = data.accounts[coinId] || {};
            delete data.accounts[coinId];

            const acc = this.getAccount(coinId);
            if (prev.enabledAt) acc.enabledAt = prev.enabledAt;
            if (prev.createdAt) acc.createdAt = prev.createdAt;
            if (prev.strategyTimeframe !== undefined && prev.strategyTimeframe !== null) {
                acc.strategyTimeframe = prev.strategyTimeframe;
            }
            reset = true;
        }

        this.save();
        return { ok: true, reset };
    },

    /**
     * 取消某币种的配额与开关，并清掉它的账户
     */
    clearAllocation(coinId) {
        const data = this.load();
        delete data.allocations[coinId];
        delete data.enabled[coinId];
        delete data.accounts[coinId];
        this.save();
    },

    formatAmount(v) {
        return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
    },

    // ---------------- 运行开关（按币种） ----------------

    isEnabled(coinId) {
        return !!this.load().enabled[coinId];
    },

    /**
     * 设置某币种的运行开关
     * 未配置配额时不允许开启，否则账户没有本金可交易。
     *
     * 开启时记下 enabledAt，作为回放的起点：
     * 只回放这一刻之后的K线买卖点，开启前的历史不补记。
     *
     * @param {string} coinId
     * @param {boolean} on
     * @param {string|number} [timeframe] - 开启时选中的周期，仅作初始展示
     * @returns {{ok: boolean, message?: string}}
     */
    setEnabled(coinId, on, timeframe) {
        if (!coinId) return { ok: false, message: '缺少币种' };

        if (on && this.getAllocation(coinId) <= 0) {
            return { ok: false, message: '请先设置配额金额' };
        }

        const data = this.load();
        data.enabled[coinId] = !!on;

        if (on) {
            const acc = this.getAccount(coinId);
            if (!acc.enabledAt) acc.enabledAt = Date.now();
            if (timeframe !== undefined && timeframe !== null) {
                acc.strategyTimeframe = timeframe;
            }
        }

        this.save();
        return { ok: true };
    },

    // ---------------- 账户 ----------------

    /**
     * 取某币种的账户，不存在则按当前配额初始化
     */
    getAccount(coinId) {
        const data = this.load();
        if (!data.accounts[coinId]) {
            const capital = this.getAllocation(coinId);
            data.accounts[coinId] = {
                coinId,
                initialCapital: capital,
                cash: capital,
                holdings: 0,
                avgCost: 0,
                trades: [],
                lastSide: null,
                firstBuyPrice: null,
                lastTimeframe: null,
                enabledAt: null,
                strategyTimeframe: null,
                createdAt: Date.now(),
            };
        }
        return data.accounts[coinId];
    },

    /**
     * 重置账户：从此刻起重来回放，资金回到配额值
     *
     * 因为回放是确定性的，单纯清空账户会在下次回放时被重建，
     * 所以这里把起点推到当前时刻，等于「从现在开始重新模拟」。
     */
    reset(coinId) {
        const data = this.load();
        const prev = data.accounts[coinId] || {};
        const tf = prev.strategyTimeframe;

        delete data.accounts[coinId];
        const acc = this.getAccount(coinId);
        acc.enabledAt = Date.now();
        if (tf !== undefined && tf !== null) acc.strategyTimeframe = tf;

        this.save();
        return acc;
    },

    /**
     * 账户快照（按给定价格重估持仓）
     */
    snapshot(acc, price) {
        const p = price > 0 ? price : 0;
        const holdingsValue = acc.holdings * p;
        const hasCost = acc.holdings > 0 && acc.avgCost > 0;

        return {
            cash: acc.cash,
            holdings: acc.holdings,
            avgCost: acc.avgCost,
            holdingsValue,
            equity: acc.cash + holdingsValue,
            holding: acc.holdings > 0,
            unrealized: hasCost ? (p - acc.avgCost) * acc.holdings : 0,
            unrealizedPct: hasCost ? (p / acc.avgCost - 1) : 0,
        };
    },

    /**
     * 按K线买卖点回放，重建该币种的账户
     *
     * 这是一个纯重算：每次都从配额本金出发，按时间顺序把买卖点走一遍，
     * 因此结果只取决于信号序列本身，不依赖页面是否开着、当时看的是哪个币种。
     * 任何时候切回该币种，都会得到完全一致的历史记录。
     *
     * @param {string} coinId
     * @param {Array} series - 买卖点序列（按时间升序）
     *        [{ time(秒), price, side:'buy'|'sell', label, score }]
     * @param {string|number} [timeframe] - 本次回放所用的K线周期，仅用于展示
     * @returns {Object|null} 重建后的账户，未配额返回 null
     */
    replay(coinId, series, timeframe) {
        if (!coinId || !Array.isArray(series)) return null;

        const capital = this.getAllocation(coinId);
        if (capital <= 0) return null;

        const data = this.load();
        const prev = data.accounts[coinId] || {};
        // 旧数据没有 enabledAt，用账户创建时间兜底，
        // 这样升级前的账户也能从「当初开启的那一刻」开始回放
        const enabledAt = prev.enabledAt || prev.createdAt || 0;
        const hasTf = timeframe !== undefined && timeframe !== null;
        const prevTf = prev.strategyTimeframe;

        const acc = {
            coinId,
            initialCapital: capital,
            cash: capital,
            holdings: 0,
            avgCost: 0,
            trades: [],
            lastSide: null,
            firstBuyPrice: null,
            lastTimeframe: hasTf ? timeframe : (prevTf !== undefined ? prevTf : null),
            enabledAt: enabledAt || null,
            // 记录本次实际采用的周期：模拟始终跟随图上正在看的周期，
            // 所以切周期后这里会同步更新，不留旧值以免说明与记录对不上
            strategyTimeframe: hasTf ? timeframe : (prevTf !== undefined ? prevTf : null),
            createdAt: prev.createdAt || Date.now(),
        };

        for (let i = 0; i < series.length; i++) {
            const p = series[i];
            if (!p || !p.price || p.price <= 0) continue;

            const side = p.side;
            if (side !== 'buy' && side !== 'sell') continue;

            // 只回放开启模拟之后的买卖点，开启前的历史不补记
            if (enabledAt && p.time * 1000 < enabledAt) continue;

            // 同向不重复下单；买卖点序列本身已是多空交替
            if (acc.lastSide === side) continue;

            // 满仓时再遇买入、空仓时再遇卖出：只记方向，不产生成交
            if (side === 'buy' && acc.cash <= 1) { acc.lastSide = side; continue; }
            if (side === 'sell' && acc.holdings <= 0) { acc.lastSide = side; continue; }

            const now = p.time * 1000;
            const trade = {
                id: `${coinId}-${p.time}`,
                time: now,
                coinId,
                timeframe: acc.strategyTimeframe,
                side,
                price: p.price,
                signalText: p.label || '',
                signalType: side,
                score: typeof p.score === 'number' ? p.score : null,
                totalScore: null,
                sensitivity: p.sensitivity || '',
                qty: 0,
                amount: 0,
                pnl: null,
                pnlPct: null,
            };

            if (side === 'buy') {
                const qty = acc.cash / p.price;
                const cost = acc.cash;

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

            // 成交后的账户快照，用于权益曲线与最大回撤
            trade.cashAfter = acc.cash;
            trade.holdingsAfter = acc.holdings;
            trade.equityAfter = acc.cash + acc.holdings * p.price;

            acc.trades.push(trade);
            if (acc.trades.length > this.maxTrades) {
                acc.trades = acc.trades.slice(-this.maxTrades);
            }
            acc.lastSide = side;
        }

        data.accounts[coinId] = acc;
        this.save();
        return acc;
    },

    /**
     * 统计某币种账户的表现
     *
     * @param {string} coinId
     * @param {number} currentPrice
     */
    getMetrics(coinId, currentPrice) {
        const acc = this.getAccount(coinId);
        const price = currentPrice > 0
            ? currentPrice
            : (acc.trades.length ? acc.trades[acc.trades.length - 1].price : 0);

        const snap = this.snapshot(acc, price);
        const initial = acc.initialCapital;
        const totalReturn = initial > 0 ? (snap.equity / initial - 1) : 0;

        // 同期买入持有：以首次买入价为基准，衡量不做择时的收益
        const holdReturn = (acc.firstBuyPrice && price > 0)
            ? (price / acc.firstBuyPrice - 1)
            : null;

        const sells = acc.trades.filter(t => t.side === 'sell');
        const wins = sells.filter(t => (t.pnl || 0) > 0).length;
        const realized = sells.reduce((sum, t) => sum + (t.pnl || 0), 0);

        // 最大回撤：成交后权益快照 + 当前权益构成权益曲线
        const curve = acc.trades
            .map(t => t.equityAfter)
            .filter(v => typeof v === 'number');
        curve.push(snap.equity);

        let peak = initial;
        let maxDrawdown = 0;
        curve.forEach(v => {
            if (v > peak) peak = v;
            const dd = peak > 0 ? (peak - v) / peak : 0;
            if (dd > maxDrawdown) maxDrawdown = dd;
        });

        return {
            coinId,
            allocation: this.getAllocation(coinId),
            initialCapital: initial,
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
            lastTimeframe: acc.lastTimeframe,
            trades: acc.trades,
        };
    },

    /**
     * 取成交记录（按时间倒序）
     */
    getTrades(coinId, limit = 50) {
        return this.getAccount(coinId).trades.slice().reverse().slice(0, limit);
    },

    /**
     * 组合总览
     *
     * 把所有「已配额」的币种汇总，用于查看总资金整体的使用与盈亏情况。
     * priceOf 用于解析各币种最新价（拿不到价格时退化为该账户最后一笔成交价）。
     *
     * @param {Function} priceOf - (coinId) => number
     */
    getPortfolio(priceOf) {
        const data = this.load();
        const coinIds = Object.keys(data.allocations).filter(id => (data.allocations[id] || 0) > 0);

        const items = [];
        let allocated = 0;
        let equity = 0;
        let roundTrips = 0;
        let wins = 0;
        let holdingCount = 0;

        coinIds.forEach(id => {
            const price = typeof priceOf === 'function' ? (priceOf(id) || 0) : 0;
            const m = this.getMetrics(id, price);

            allocated += m.allocation;
            equity += m.equity;
            roundTrips += m.roundTrips;
            wins += m.wins;
            if (m.holding) holdingCount++;

            items.push({
                coinId: id,
                allocation: m.allocation,
                equity: m.equity,
                totalReturn: m.totalReturn,
                holding: m.holding,
                enabled: this.isEnabled(id),
                roundTrips: m.roundTrips,
                winRate: m.winRate,
            });
        });

        // 按账户总值倒序，方便看谁贡献大
        items.sort((a, b) => b.equity - a.equity);

        const totalCapital = data.totalCapital;

        return {
            totalCapital,
            allocated,
            idle: Math.max(0, totalCapital - allocated),
            equity,
            totalReturn: allocated > 0 ? (equity / allocated - 1) : 0,
            usedRatio: totalCapital > 0 ? (allocated / totalCapital) : 0,
            coinCount: coinIds.length,
            holdingCount,
            runningCount: coinIds.filter(id => this.isEnabled(id)).length,
            roundTrips,
            winRate: roundTrips ? wins / roundTrips : null,
            items,
        };
    },
};
