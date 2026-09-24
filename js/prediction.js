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
    // 未登录/未识别用户时的兜底键
    baseStorageKey: 'cryptoPulse_predictionHistory',
    storageKey: 'cryptoPulse_predictionHistory',

    // 本地历史记录上限，超出后丢弃最早的。
    //
    // 注意这只限制「本机界面上能看到多少条」：后端保存的是完整历史
    // （按 id 合并、只增不删）。长期准确率与因子分析请以后端的表格为准，
    // 否则本机裁掉的老记录会让统计越算越偏。
    maxRecords: 150,

    /**
     * 切换为按用户隔离的本地存储键。
     *
     * 原先用的是固定的全局键，同一浏览器上多个账号会互相看到、互相覆盖彼此的
     * 预测记录 —— 模拟盘早就按用户隔离了，这里当初漏了。
     *
     * 首次登录某个账号时，若该账号还没有自己的键、而旧的全局键里有数据，
     * 就把旧数据迁过来（与 paper.js 的处理一致）：这样升级不会让已有记录凭空消失。
     *
     * @param {string} username
     */
    setUserStorage(username) {
        const safe = String(username || '').trim().replace(/[^A-Za-z0-9_\u4e00-\u9fff-]/g, '_').slice(0, 64);
        if (!safe) return;
        const userKey = `${this.baseStorageKey}_${safe}`;
        try {
            if (!localStorage.getItem(userKey) && localStorage.getItem(this.baseStorageKey)) {
                localStorage.setItem(userKey, localStorage.getItem(this.baseStorageKey));
            }
        } catch (e) { /* 本地缓存不可用时仍可使用后端 */ }
        this.storageKey = userKey;
        // 换了存储键，之前那次推送的签名就失效了，必须重推
        this._lastPushed = '';
    },

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
        // 顺手排一次后端同步。尽力而为：后端没开、没登录都不影响记录本身，
        // 所以不 await、也不把异常抛给调用方（record/evaluate 在渲染链路里）。
        this.schedulePush();
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
     * @param {Object} p - { coinId, coinSymbol, timeframe, signalType, signalText, score,
     *                        price, intervalSeconds, algoVersion, factors, criteria }
     *   - factors: 因子快照，记录当时各因子读到什么（分项得分、权重、指标、闸门状态）
     *   - criteria: 当时的复盘口径（判定阈值、复盘窗口），口径变了要能从数据里看出来
     *   - algoVersion: 产生这条记录的算法版本
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
            // 因子快照与判断口径。
            //
            // 只存最终评分是不够的：事后要回答「是哪个因子把方向带偏了」，
            // 就必须知道当时的各因子读数；要区分「因子变好了」还是「判断口径变了」，
            // 就必须知道当时的阈值与复盘窗口。这两样缺一个，表格都分析不出结论。
            algoVersion: p.algoVersion || null,
            factors: p.factors || null,
            criteria: p.criteria || null,
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
     * 必须同时限定标的与周期：本函数只拿到一份K线（当前正在显示的那份），
     * 而记录里混着多个币种、多个周期。
     *
     * 这里曾经不做限定，于是把「当前显示的币」的K线套到了所有到期记录上：
     * 显示 ETH 时，BTC 的记录被拿 ETH 的收盘价复盘；显示 BTC 时反过来。
     * 危害不止于一条记录判错 —— correct 一旦写入就永久生效（此后每次都跳过它），
     * 错误判定会落盘、同步到后端、写进 CSV，事后单看数字也认不出哪条是错的。
     * 所以这里宁可不复盘：留到下次还有机会补上，用错标的的数据则永久写坏。
     *
     * @param {Array} candleData - 某一标的、某一周期的K线
     * @param {string} coinId - 这份K线所属的币种
     * @param {number} timeframe - 这份K线所属的周期
     * @returns {boolean} 是否有记录被更新
     */
    evaluate(candleData, coinId, timeframe) {
        if (!candleData || candleData.length < 2) return false;
        if (!coinId) return false;

        const list = this.load();
        const now = Date.now();
        let updated = false;

        list.forEach(rec => {
            if (rec.correct !== null) return;        // 已复盘
            if (rec.coinId !== coinId) return;       // 不是这份K线的标的
            if (rec.timeframe !== timeframe) return; // 不是这份K线的周期
            if (now < rec.resolveAt) return;         // 未到期

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
     * 核对**已复盘**记录的结论是否需要修正
     *
     * 存在的理由：修好「用错标的复盘」之后，已经写坏的那批记录不会自己变对 ——
     * 它们的结论是拿别的币的收盘价算出来的，而且已经落盘、同步到后端、写进 CSV。
     * correct 一旦写入就永久生效，所以必须回过头去核对。
     *
     * 做法是**核对并就地修正**，不是「先清空、再重算」。这个区别很关键：
     * 清空会让判不出来的记录（K线已超出可取范围）彻底丢掉结论，把本来对的一起毁掉；
     * 核对只在「用该记录自己标的的K线、能算出一个与存值不符的结果」时才改写，
     * 算不出来的（findCloseAt 返回 null）一律原样留着。
     *
     * 被修正的记录会留下 prevEvalPrice / prevCorrect / reviewFixedAt 供审计与回退。
     *
     * @param {Array} candleData - 某一标的、某一周期的K线
     * @param {string} coinId - 这份K线所属的币种
     * @param {number} timeframe - 这份K线所属的周期
     * @returns {number} 被修正的记录条数
     */
    verifyResolved(candleData, coinId, timeframe) {
        if (!candleData || candleData.length < 2) return 0;
        if (!coinId) return 0;

        // 容许的相对误差。同一交易对同一根K线的收盘价本应逐位一致，放宽一点点
        // 是为了容忍现货/合约这类数据源的微小差异；而「串了标的」的偏差是几十倍
        // 到上亿倍，任何合理阈值都分辨得出。
        const tolerance = 0.001;

        const list = this.load();
        const now = Date.now();
        let fixed = 0;
        let checked = 0;

        list.forEach(rec => {
            if (rec.correct === null) return;        // 还没复盘，交给 evaluate
            if (rec.coinId !== coinId) return;       // 不是这份K线的标的
            if (rec.timeframe !== timeframe) return; // 不是这份K线的周期
            if (!rec.evalPrice) return;              // 没有存值可比，不动

            const closePrice = this.findCloseAt(candleData, rec.resolveAt);
            if (closePrice === null) return;         // 核不了就不动它 —— 宁可存疑，不可毁掉对的

            if (Math.abs(closePrice / rec.evalPrice - 1) <= tolerance) {
                // 核对通过。留个记号，批量复核就不必再为它反复取K线 ——
                // 核过一次就是定论：那根K线的收盘价不会再变。
                if (!rec.reviewCheckedAt) { rec.reviewCheckedAt = now; checked++; }
                return;
            }

            rec.prevEvalPrice = rec.evalPrice;
            rec.prevCorrect = rec.correct;
            rec.reviewFixedAt = now;
            rec.reviewCheckedAt = now;               // 修正也是一次核对
            rec.evalPrice = closePrice;
            rec.changePct = rec.price ? (closePrice / rec.price - 1) : 0;
            rec.correct = this.judgeCorrect(rec.signalType, rec.changePct);
            fixed++;
        });

        if (fixed || checked) this.save(list);
        return fixed;
    },

    /**
     * 汇总「还需要复核」的工作量，按币种 + 周期分组。
     *
     * 供批量复盘的驱动方使用：按组去取各自的K线，这样即使某个币从没被打开过，
     * 它的预测也能结算 —— 否则那些记录只会一直挂在待复盘里。
     *
     * @returns {Array} [{ coinId, timeframe, pending, verify, oldestResolveAt }]
     *   - pending: 已到期但未复盘
     *   - verify: 已复盘但还没核对过结论的（核对过的记为 reviewCheckedAt，不再重复取数）
     *   - oldestResolveAt: 该组最老的复盘时点，取K线时要覆盖到它
     */
    getReviewGroups() {
        const list = this.load();
        const now = Date.now();
        const groups = new Map();

        list.forEach(rec => {
            if (!rec || !rec.coinId) return;
            const isPending = rec.correct === null && now >= rec.resolveAt;
            // 已复盘的只在「还没核对过」时才算工作量。不加这个条件的话，每个周期
            // 都会为同一批老记录重复取K线，永远跑不完，也白白浪费请求。
            const needsVerify = rec.correct !== null && !rec.reviewCheckedAt;
            if (!isPending && !needsVerify) return;

            const key = rec.coinId + '|' + rec.timeframe;
            let g = groups.get(key);
            if (!g) {
                g = {
                    coinId: rec.coinId, timeframe: rec.timeframe,
                    pending: 0, verify: 0, oldestResolveAt: rec.resolveAt,
                };
                groups.set(key, g);
            }
            if (isPending) g.pending++;
            if (needsVerify) g.verify++;
            if (typeof rec.resolveAt === 'number' && rec.resolveAt < g.oldestResolveAt) {
                g.oldestResolveAt = rec.resolveAt;
            }
        });

        // 待复盘的排前面：那是还在累积的新数据，核对历史是补旧账
        return Array.from(groups.values())
            .sort((a, b) => (b.pending - a.pending) || (b.verify - a.verify));
    },

    /**
     * 在K线中找到复盘时间点之后的第一个收盘价
     * @param {Array} candleData
     * @param {number} resolveAt - 毫秒时间戳
     * @returns {number|null}
     */
    findCloseAt(candleData, resolveAt) {
        const targetSec = Math.floor(resolveAt / 1000);
        // 从前往后找，定位第一根 time >= targetSec 的K线 ——
        // 也就是「复盘窗口到期后的第一根」，这正是要取的收盘价
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

    // ---------------- 后端同步 ----------------
    //
    // 为什么需要它：预测记录原先只躺在 localStorage 里 —— 清一次缓存、换个浏览器
    // 或换台设备就全没了。而「因子要不要调整」这个问题必须看长期样本，长期样本
    // 不该只存在于浏览器里。
    //
    // 与模拟盘同步的关系：复用同一套后端地址、账号与登录会话（只有一份配置，
    // 见 PaperTrader.getSyncConfig），但走独立接口 /api/predictions。
    // 不另存一份配置，是为了避免「模拟盘连上了、预测没连上」这种半通状态。
    //
    // 合并策略与模拟盘不同，这点很关键：
    //   - 模拟盘是「一份整体状态」，冲突时按时间戳取新、整体覆盖；
    //   - 预测记录是「一条条事实」，后端按 id 合并、只增不删。
    //     因为本地只留最近 maxRecords 条，若按整体覆盖，本地裁剪会把后端的
    //     历史一起删掉，长期样本就白攒了。同理，界面上「清空历史」也只清本地。

    authKey: 'cryptoPulse_authSession',
    pushDebounceMs: 2000,
    _pushTimer: null,
    _lastPushed: '',

    /** 同步状态，供界面显示（同步失败必须让人看得见，不能静默） */
    sync: { status: 'off', message: '未启用', lastSyncAt: null },

    /** 取后端地址与账号（复用模拟盘那份配置） */
    getSyncConfig() {
        if (typeof PaperTrader !== 'undefined' && PaperTrader.getSyncConfig) {
            return PaperTrader.getSyncConfig();
        }
        return { url: '', account: 'default' };
    },

    /** 取登录会话（复用模拟盘那套） */
    getAuthSession() {
        if (typeof PaperTrader !== 'undefined' && PaperTrader.getAuthSession) {
            return PaperTrader.getAuthSession();
        }
        try {
            const parsed = JSON.parse(localStorage.getItem(this.authKey) || 'null');
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (e) { return null; }
    },

    setSyncStatus(status, message, at) {
        this.sync = {
            status,
            message: message || '',
            lastSyncAt: at || this.sync.lastSyncAt || null,
        };
        if (typeof this.onSyncChange === 'function') {
            try { this.onSyncChange(this.sync); } catch (e) { /* 界面回调出错不影响数据 */ }
        }
    },

    /** 排一次防抖推送 */
    schedulePush() {
        if (!this.getSyncConfig().url) return;
        clearTimeout(this._pushTimer);
        this._pushTimer = setTimeout(() => this.pushToBackend(), this.pushDebounceMs);
    },

    /**
     * 把本地记录推到后端（按 id 合并）。
     * 失败只改状态，不抛异常、不回滚本地 —— 本地那份始终有效。
     */
    async pushToBackend() {
        const cfg = this.getSyncConfig();
        if (!cfg.url) return null;
        const session = this.getAuthSession();
        if (!session || !session.token) {
            this.setSyncStatus('error', '请先登录');
            return null;
        }

        const list = this.load();
        if (!list.length) {
            // 本地为空时不推：后端只增不删，推空列表没有意义，
            // 还能避免用户「清空本地历史」时误把后端样本一起清掉。
            this.setSyncStatus('ok', '本地暂无预测记录');
            return null;
        }

        // 用整个请求体做签名：复盘会就地修改 evalPrice/correct，
        // 无法用「条数 + 最后一条 id」这类摘要判断内容是否变化。
        const body = JSON.stringify({ records: list });
        if (body === this._lastPushed) {
            this.setSyncStatus('ok', '已是最新');
            return null;
        }

        this.setSyncStatus('syncing', '正在同步预测记录…');
        try {
            const resp = await fetch(`${cfg.url}/api/predictions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
                body,
            });
            // 401 不是「同步坏了」，是登录失效，要引导重新登录
            if (resp.status === 401) { this.handleAuthExpired(); return null; }
            if (!resp.ok) throw new Error('HTTP ' + resp.status);

            const r = await resp.json();
            this._lastPushed = body;
            this.setSyncStatus('ok', `已同步 ${r.total} 条（新增 ${r.added}，更新 ${r.updated}）`, r.savedAt);
            return r;
        } catch (e) {
            this.setSyncStatus('error', '同步失败：' + e.message);
            return null;
        }
    },

    /**
     * 从后端拉记录，与本地按 id 合并。
     *
     * 合并规则：同一个 id 上，本地那份是更新的（复盘是在本机做的），所以本地优先；
     * 只有当本地这条还没复盘、而远端已复盘时才采纳远端。远端独有的（本地已裁掉
     * 的更早记录）一并收进来，再按时间排序裁到 maxRecords。
     *
     * @returns {Array|null} 合并后的本地列表；未拉取时返回 null
     */
    async pullFromBackend() {
        const cfg = this.getSyncConfig();
        if (!cfg.url) return null;
        const session = this.getAuthSession();
        if (!session || !session.token) {
            this.setSyncStatus('error', '请先登录');
            return null;
        }

        this.setSyncStatus('syncing', '正在读取后端预测记录…');
        try {
            const resp = await fetch(`${cfg.url}/api/predictions`, {
                headers: { Authorization: `Bearer ${session.token}` },
            });
            if (resp.status === 401) { this.handleAuthExpired(); return null; }
            if (!resp.ok) throw new Error('HTTP ' + resp.status);

            const r = await resp.json();
            const remote = Array.isArray(r.records) ? r.records : [];
            if (!remote.length) {
                this.setSyncStatus('ok', '后端暂无记录，正在上传本地');
                await this.pushToBackend();
                return null;
            }

            const byId = new Map();
            remote.forEach(rec => { if (rec && rec.id) byId.set(rec.id, rec); });
            this.load().forEach(rec => {
                if (!rec || !rec.id) return;
                const old = byId.get(rec.id);
                if (!old || (rec.correct === null && old.correct !== null)) byId.set(rec.id, rec);
            });

            const merged = Array.from(byId.values())
                .sort((a, b) => (a.predictedAt || 0) - (b.predictedAt || 0))
                .slice(-this.maxRecords);
            try {
                localStorage.setItem(this.storageKey, JSON.stringify(merged));
            } catch (e) { /* 本地写不进去也不影响已拉到的数据 */ }

            this._lastPushed = '';
            this.setSyncStatus('ok', `已合并后端 ${remote.length} 条`);
            return merged;
        } catch (e) {
            this.setSyncStatus('error', '读取失败：' + e.message);
            return null;
        }
    },

    /** 启动/登录后调用一次：配了后端就拉一次并合并，不阻塞界面 */
    async initSync() {
        const cfg = this.getSyncConfig();
        if (!cfg.url) {
            this.setSyncStatus('off', '未启用');
            return null;
        }
        return this.pullFromBackend();
    },

    /** 后端返回 401：令牌已不被承认，交给模拟盘那套统一清会话并弹登录框 */
    handleAuthExpired() {
        if (typeof PaperTrader !== 'undefined' && PaperTrader.handleAuthExpired) {
            PaperTrader.handleAuthExpired();
            return;
        }
        try { localStorage.removeItem(this.authKey); } catch (e) { /* 清不掉也只是下次再判一次 */ }
        this.setSyncStatus('error', '登录已过期，请重新登录');
    },
};
