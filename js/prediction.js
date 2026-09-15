/**
 * 预测记录与复盘模块
 *
 * 每次产生新的方向性预测时落一条记录，等到预测周期走完后
 * 用后续K线的实际收盘价回头验证，统计方向判断的准确率。
 *
 * 判定规则（涨跌幅相对预测时价格）：
 *   看多（买入/强烈买入）  涨跌幅 > +阈值  → 正确
 *   看空（卖出/强烈卖出）  涨跌幅 < -阈值  → 正确
 *   观望                    |涨跌幅| ≤ 2%  → 正确
 *
 * 复盘窗口 = 当前周期 5 根K线，限制在 10 分钟 ~ 14 天之间。
 */

const PredictionTracker = {
    storageKey: 'cryptoPulse_predictionHistory',

    // 历史记录上限，超出后丢弃最早的
    maxRecords: 150,

    // 方向判定阈值：涨幅/跌幅超过该比例才算方向判对，避免把噪声算成正确
    directionThreshold: 0.003, // 0.3%

    // 观望判定：波动在此范围内视为横盘
    holdThreshold: 0.02, // 2%

    /**
     * 读取全部历史记录
     * @returns {Array}
     */
    load() {
        try {
            const raw = localStorage.getItem(this.storageKey);
            const list = raw ? JSON.parse(raw) : [];
            return Array.isArray(list) ? list : [];
        } catch (e) {
            console.warn('[预测] 读取历史失败:', e.message);
            return [];
        }
    },

    /**
     * 写回历史记录
     * @param {Array} list
     */
    save(list) {
        try {
            const trimmed = list.slice(-this.maxRecords);
            localStorage.setItem(this.storageKey, JSON.stringify(trimmed));
        } catch (e) {
            console.warn('[预测] 保存历史失败:', e.message);
        }
    },

    /**
     * 计算复盘窗口（毫秒）
     * @param {number} intervalSeconds - 当前周期单根K线秒数
     * @returns {number}
     */
    getHorizonMs(intervalSeconds) {
        const fiveCandles = (intervalSeconds || 3600) * 5 * 1000;
        return Math.min(14 * 24 * 3600 * 1000, Math.max(10 * 60 * 1000, fiveCandles));
    },

    /**
     * 记录一次预测（自动去重）
     *
     * 仅在三类情况下新增记录：
     *   1. 该币种+周期还没有任何记录
     *   2. 方向相对上一条记录发生变化
     *   3. 上一条记录已完成复盘（进入新的预测周期）
     *
     * @param {Object} p - { coinId, coinSymbol, timeframe, signalType, signalText, score, price, intervalSeconds }
     * @returns {boolean} 是否新增了记录
     */
    record(p) {
        if (!p || !p.coinId || !p.price) return false;

        const list = this.load();
        const sameScope = list.filter(r => r.coinId === p.coinId && r.timeframe === p.timeframe);
        const last = sameScope[sameScope.length - 1];

        if (last && last.signalType === p.signalType && last.correct === null) {
            // 方向未变且尚未复盘，视为同一次预测
            return false;
        }

        const now = Date.now();
        list.push({
            id: `${p.coinId}-${p.timeframe}-${now}`,
            coinId: p.coinId,
            coinSymbol: p.coinSymbol || p.coinId.toUpperCase(),
            timeframe: p.timeframe,
            signalType: p.signalType,
            signalText: p.signalText,
            score: p.score,
            price: p.price,
            predictedAt: now,
            resolveAt: now + this.getHorizonMs(p.intervalSeconds),
            // 复盘结果
            evalPrice: null,
            changePct: null,
            correct: null,
        });

        this.save(list);
        return true;
    },

    /**
     * 用最新K线复盘所有到期的预测
     *
     * @param {Array} candleData - K线数据 [{time, open, high, low, close, volume}]
     * @returns {boolean} 是否有记录被更新
     */
    evaluate(candleData) {
        if (!candleData || candleData.length < 2) return false;

        const list = this.load();
        const now = Date.now();
        let updated = false;

        list.forEach(rec => {
            if (rec.correct !== null) return;      // 已复盘
            if (now < rec.resolveAt) return;       // 未到期

            const closePrice = this.findCloseAt(candleData, rec.resolveAt);
            if (closePrice === null) return;       // K线数据还没覆盖到该时间点

            rec.evalPrice = closePrice;
            rec.changePct = rec.price ? (closePrice / rec.price - 1) : 0;
            rec.correct = this.judgeCorrect(rec.signalType, rec.changePct);
            updated = true;
        });

        if (updated) this.save(list);
        return updated;
    },

    /**
     * 在K线中找到复盘时间点之后的第一个收盘价
     * @param {Array} candleData
     * @param {number} resolveAt - 毫秒时间戳
     * @returns {number|null}
     */
    findCloseAt(candleData, resolveAt) {
        const targetSec = Math.floor(resolveAt / 1000);
        // 从后往前找，定位第一根 time >= targetSec 的K线
        for (let i = 0; i < candleData.length; i++) {
            if (candleData[i].time >= targetSec) {
                return candleData[i].close;
            }
        }
        // 目标时间超出已有K线范围（数据太旧或太远），无法复盘
        return null;
    },

    /**
     * 判定方向是否正确
     * @param {string} signalType
     * @param {number} changePct
     * @returns {boolean}
     */
    judgeCorrect(signalType, changePct) {
        if (signalType === 'buy' || signalType === 'strong_buy') {
            return changePct > this.directionThreshold;
        }
        if (signalType === 'sell' || signalType === 'strong_sell') {
            return changePct < -this.directionThreshold;
        }
        // 观望：横盘才算对
        return Math.abs(changePct) <= this.holdThreshold;
    },

    /**
     * 判断某条记录是否为方向性预测（看多/看空）
     * @param {string} signalType
     * @returns {boolean}
     */
    isDirectional(signalType) {
        return signalType === 'buy' || signalType === 'strong_buy'
            || signalType === 'sell' || signalType === 'strong_sell';
    },

    /**
     * 按币种 + 周期过滤记录
     *
     * 不同周期是各自独立的预测（4小时看多与日线看多是两次不同的判断），
     * 复盘时机也不同，因此准确率按「币种 + 周期」分开统计。
     *
     * @param {Array} list
     * @param {string|null} coinId
     * @param {number|null} timeframe
     * @returns {Array}
     */
    filter(list, coinId, timeframe) {
        if (!coinId) return list;
        if (timeframe === null || timeframe === undefined) {
            return list.filter(r => r.coinId === coinId);
        }
        return list.filter(r => r.coinId === coinId && r.timeframe === timeframe);
    },

    /**
     * 统计准确率
     * @param {string|null} coinId - 传入则只统计该币种
     * @param {number|null} timeframe - 传入则只统计该周期
     * @returns {Object} 统计结果
     */
    getStats(coinId, timeframe) {
        const scoped = this.filter(this.load(), coinId, timeframe);
        const resolved = scoped.filter(r => r.correct !== null);
        const pending = scoped.filter(r => r.correct === null);

        const correct = resolved.filter(r => r.correct).length;
        const accuracy = resolved.length ? (correct / resolved.length * 100) : null;

        // 仅统计看多/看空的方向准确率，观望不计入
        const directional = resolved.filter(r => this.isDirectional(r.signalType));
        const dirCorrect = directional.filter(r => r.correct).length;
        const directionalAccuracy = directional.length ? (dirCorrect / directional.length * 100) : null;

        // 多空分别统计
        const bull = resolved.filter(r => r.signalType === 'buy' || r.signalType === 'strong_buy');
        const bear = resolved.filter(r => r.signalType === 'sell' || r.signalType === 'strong_sell');

        return {
            total: scoped.length,
            resolved: resolved.length,
            pending: pending.length,
            correct,
            accuracy,
            directionalTotal: directional.length,
            directionalCorrect: dirCorrect,
            directionalAccuracy,
            bullTotal: bull.length,
            bullCorrect: bull.filter(r => r.correct).length,
            bearTotal: bear.length,
            bearCorrect: bear.filter(r => r.correct).length,
        };
    },

    /**
     * 取历史记录（按时间倒序）
     * @param {string|null} coinId
     * @param {number|null} timeframe
     * @param {number} limit
     * @returns {Array}
     */
    getHistory(coinId, timeframe, limit = 20) {
        const scoped = this.filter(this.load(), coinId, timeframe);
        return scoped.slice().reverse().slice(0, limit);
    },

    /**
     * 清空历史记录
     * @param {string|null} coinId - 传入则只清该币种
     * @param {number|null} timeframe - 传入则连同周期一起限定
     */
    clear(coinId, timeframe) {
        if (!coinId) {
            this.save([]);
            return;
        }
        const keep = this.load().filter(r =>
            r.coinId !== coinId || (timeframe !== null && timeframe !== undefined && r.timeframe !== timeframe)
        );
        this.save(keep);
    },
};
