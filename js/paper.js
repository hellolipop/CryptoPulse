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
 *   - 成交价用「信号确认后真正能成交的价」：信号K线收盘、即下一根K线的开盘价。
 *     信号要等那根K线走完才成立，按它自己的收盘价成交等于要求你在信号成立的
 *     同一瞬间完成下单，做不到。实测（ETH）这两个价差 0.00bp、最差 0.12bp
 *     （加密 7×24 连续交易，一根K线的收盘就是下一根的开盘），
 *     所以换口径不改变结论，但口径本身变得站得住。
 *   - 不计手续费与滑点
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
    baseStorageKey: 'cryptoPulse_paperV2',

    // 单账户保留的成交记录上限
    maxTrades: 200,

    // 总资金默认值（USDT）
    defaultTotalCapital: 200000,

    data: null,

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
        this.data = null;
        this._syncCfg = null;
        this._lastPushed = '';
    },

    /** 后端同步配置的存储键。与模拟盘数据分开存，换后端不会动手上的账 */
    syncKey: 'cryptoPulse_paperSync',
    authKey: 'cryptoPulse_authSession',

    /** 同步状态快照，供界面展示 */
    sync: { status: 'off', message: '未启用', lastSyncAt: null },

    /** 同步状态变化时的回调（由 app.js 注入，用于刷新界面） */
    onSyncChange: null,

    // ---------------- 存储 ----------------

    /**
     * 将 v1 的按「币种+周期」账户迁移到 v2 的按币种账户。
     * 旧版本没有迁移逻辑，升级后会误显示成空账户；这里仅在 v2 不存在时执行一次。
     */
    migrateLegacy() {
        let legacyAccounts = null;
        let legacyEnabled = false;
        try {
            const raw = localStorage.getItem('cryptoPulse_paperAccounts');
            legacyAccounts = raw ? JSON.parse(raw) : null;
            legacyEnabled = localStorage.getItem('cryptoPulse_paperEnabled') === '1';
        } catch (e) {
            console.warn('[模拟] 读取旧账户失败:', e.message);
        }

        if (!legacyAccounts || typeof legacyAccounts !== 'object' || Array.isArray(legacyAccounts)) {
            return null;
        }

        const migrated = {
            totalCapital: this.defaultTotalCapital,
            allocations: {},
            enabled: {},
            accounts: {},
        };

        Object.values(legacyAccounts).forEach((legacy) => {
            if (!legacy || typeof legacy !== 'object' || !legacy.coinId) return;
            const coinId = legacy.coinId;
            const capital = Number(legacy.initialCapital);
            const existing = migrated.accounts[coinId];

            // 多周期旧账户无法在新模型中同时作为一个持仓运行，优先保留成交最多、
            // 时间更新的账户；其余周期的成交记录也合并，避免历史明细消失。
            if (!existing || (legacy.trades || []).length > (existing.trades || []).length) {
                migrated.accounts[coinId] = {
                    coinId,
                    initialCapital: capital > 0 ? capital : this.defaultTotalCapital,
                    cash: Number.isFinite(Number(legacy.cash)) ? Number(legacy.cash) : (capital > 0 ? capital : this.defaultTotalCapital),
                    holdings: Number(legacy.holdings) || 0,
                    avgCost: Number(legacy.avgCost) || 0,
                    trades: Array.isArray(legacy.trades) ? legacy.trades.slice(-this.maxTrades) : [],
                    lastSide: legacy.lastSide || null,
                    firstBuyPrice: legacy.firstBuyPrice || null,
                    lastTimeframe: legacy.timeframe ?? null,
                    enabledAt: legacy.createdAt || null,
                    strategyTimeframe: legacy.timeframe ?? null,
                    createdAt: legacy.createdAt || Date.now(),
                };
            }
            migrated.allocations[coinId] = Math.max(migrated.allocations[coinId] || 0, capital > 0 ? capital : 0);
            migrated.enabled[coinId] = legacyEnabled;
        });

        const allocated = Object.values(migrated.allocations).reduce((sum, value) => sum + Number(value || 0), 0);
        migrated.totalCapital = Math.max(this.defaultTotalCapital, allocated);
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(migrated));
            localStorage.setItem('cryptoPulse_paperMigration_v2', new Date().toISOString());
        } catch (e) {
            console.warn('[模拟] 保存迁移账户失败:', e.message);
        }
        return migrated;
    },

    /**
     * 把任意来源的原始数据规整成本模块认得的形状。
     * localStorage、后端、旧版迁移三条路径共用同一份逻辑 —— 各写一遍迟早走样。
     */
    normalize(parsed) {
        const p = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
        return {
            totalCapital: (typeof p.totalCapital === 'number' && p.totalCapital > 0)
                ? p.totalCapital
                : this.defaultTotalCapital,
            allocations: (p.allocations && typeof p.allocations === 'object') ? p.allocations : {},
            enabled: (p.enabled && typeof p.enabled === 'object') ? p.enabled : {},
            accounts: (p.accounts && typeof p.accounts === 'object') ? p.accounts : {},
            // 上次落盘时间。后端同步靠它判断本地与远端哪一份更新。
            savedAt: typeof p.savedAt === 'string' ? p.savedAt : null,
        };
    },

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
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            parsed = this.migrateLegacy() || {};
        }

        this.data = this.normalize(parsed);
        return this.data;
    },

    save() {
        // 落盘时间戳：既是本地记录，也是后端同步判断新旧的依据
        if (this.data) this.data.savedAt = new Date().toISOString();

        try {
            localStorage.setItem(this.storageKey, JSON.stringify(this.data || {}));
        } catch (e) {
            console.warn('[模拟] 保存失败:', e.message);
        }

        // 顺手排一次后端同步。它是尽力而为的增强：后端没开、地址没配，
        // 都不影响模拟盘本身，所以这里不 await、也不把异常抛给调用方。
        this.schedulePush();
    },

    // ---------------- 后端同步 ----------------
    //
    // 为什么需要它：模拟盘状态（总资金、配额、持仓、成交记录）原本只躺在
    // localStorage 里 —— 清一次缓存、换个浏览器、换台设备就全没了。
    // 这里把它镜像到本地后端（server/store.js），磁盘上留一份。
    //
    // 设计取舍：
    //   - **localStorage 仍是本机权威副本**，所有读写保持同步，
    //     不把 async 引进渲染链路（渲染每帧都在读 load()）。
    //   - 后端不可用时全部功能照常，只是状态角标显示「未连接」。
    //   - 推送做了防抖与去重：replay() 每次刷新信号都会 save()，
    //     加上每 30 秒的自动刷新，直接推会把后端打爆。
    //   - 冲突按 savedAt 取新：谁的时间戳更晚用谁的，不做合并。
    //     模拟盘只有一台设备在写，这个策略够用且可解释。

    /** 推送防抖定时器与上次已推送的内容（内容没变就不重复推） */
    _pushTimer: null,
    _lastPushed: '',
    pushDebounceMs: 2000,

    /** 读取同步配置（地址与账号标识），带内存缓存 */
    getSyncConfig() {
        if (!this._syncCfg) {
            let parsed = null;
            try {
                parsed = JSON.parse(localStorage.getItem(this.syncKey) || 'null');
            } catch (e) { /* 配置损坏按未配置处理 */ }

            this._syncCfg = {
                url: (parsed && typeof parsed.url === 'string')
                    ? parsed.url.trim().replace(/\/+$/, '')
                    : '',
                account: (parsed && typeof parsed.account === 'string' && parsed.account)
                    ? parsed.account
                    : 'default',
            };
        }
        return this._syncCfg;
    },

    /**
     * 设置后端地址与账号标识。
     * @param {string} url - 留空表示关闭同步
     * @param {string} [account] - 账号标识，用于同一后端区分不同浏览器/设备
     * @returns {{ok: boolean, message?: string}}
     */
    setSyncConfig(url, account) {
        const clean = String(url || '').trim().replace(/\/+$/, '');
        if (clean && !/^https?:\/\//.test(clean)) {
            return { ok: false, message: '地址需以 http:// 或 https:// 开头' };
        }
        if (account !== undefined && account !== null && account !== '') {
            if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(account))) {
                return { ok: false, message: '账号标识只允许字母、数字、下划线、短横线（1-64 位）' };
            }
        }

        const cfg = this.getSyncConfig();
        cfg.url = clean;
        if (account) cfg.account = String(account);

        try {
            localStorage.setItem(this.syncKey, JSON.stringify(cfg));
        } catch (e) {
            return { ok: false, message: '配置保存失败：' + e.message };
        }

        // 地址清空等于关掉同步；顺手把「已推送内容」也清掉，
        // 否则重新启用时内容没变会跳过首次推送
        this._lastPushed = '';
        if (!clean) this.setSyncStatus('off', '未启用');

        return { ok: true };
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
     * 去掉易变字段后的数据签名，用于「内容没变就不重复推」的判断。
     *
     * 不直接拿 this.data 比对：savedAt 每次推送都要更新，
     * 让它参与比对等于每次都不相等，去重会彻底失效。
     * 用固定字面量顺序重建，保证同一份内容的序列化结果稳定。
     */
    contentSnapshot() {
        const d = this.data || {};
        return {
            totalCapital: d.totalCapital,
            allocations: d.allocations,
            enabled: d.enabled,
            accounts: d.accounts,
        };
    },

    /**
     * 把本机状态推到后端。
     * 失败只改状态角标，不抛异常、不回滚本地数据 —— 本地那份始终是有效的。
     */
    async pushToBackend() {
        const cfg = this.getSyncConfig();
        if (!cfg.url) return null;
        const session = this.getAuthSession();
        if (!session || !session.token) {
            this.setSyncStatus('error', '请先登录');
            return null;
        }

        // 先按「内容」判重，再盖时间戳
        const content = JSON.stringify(this.contentSnapshot());
        if (content === this._lastPushed) {
            this.setSyncStatus('ok', '已是最新');
            return null;
        }

        if (this.data) this.data.savedAt = new Date().toISOString();
        const body = JSON.stringify(this.data || {});

        const url = `${cfg.url}/api/paper/state?account=${encodeURIComponent(cfg.account)}`;
        this.setSyncStatus('syncing', '正在同步…');
        try {
            const resp = await fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
                body,
            });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);

            const r = await resp.json();
            this._lastPushed = content;
            // 后端会盖自己的时间戳，回写本地，让两边一致
            if (this.data && r.savedAt) this.data.savedAt = r.savedAt;
            this.setSyncStatus('ok', `已同步（rev ${r.rev}）`, r.savedAt);
            return r;
        } catch (e) {
            this.setSyncStatus('error', '同步失败：' + e.message);
            return null;
        }
    },

    /**
     * 从后端拉状态。
     * 只在远端比本地新时才覆盖本地 —— 避免把本机未推送的改动冲掉。
     * @returns {Object|null} 采纳的远端数据；未采纳时返回 null
     */
    async pullFromBackend() {
        const cfg = this.getSyncConfig();
        if (!cfg.url) return null;
        const session = this.getAuthSession();
        if (!session || !session.token) {
            this.setSyncStatus('error', '请先登录');
            return null;
        }

        const url = `${cfg.url}/api/paper/state?account=${encodeURIComponent(cfg.account)}`;
        this.setSyncStatus('syncing', '正在读取后端…');
        try {
            const resp = await fetch(url, { headers: { Authorization: `Bearer ${session.token}` } });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const r = await resp.json();

            if (r.empty || !r.data) {
                // 后端还是空的：把本地这份推上去，作为初始快照
                this.setSyncStatus('ok', '后端暂无数据，正在上传本地');
                await this.pushToBackend();
                return null;
            }

            const local = this.load();
            const localAt = Date.parse(local.savedAt || '') || 0;
            const remoteAt = Date.parse(r.savedAt || '') || 0;

            if (remoteAt > localAt) {
                this.data = this.normalize(r.data);
                this.data.savedAt = r.savedAt || null;
                try {
                    localStorage.setItem(this.storageKey, JSON.stringify(this.data));
                } catch (e) { /* 本地缓存写不进去也不影响已采纳的后端数据 */ }
                this._lastPushed = JSON.stringify(this.contentSnapshot());
                this.setSyncStatus('ok', '已从后端恢复', r.savedAt);
                return this.data;
            }

            this.setSyncStatus('ok', '本地较新，无需恢复');
            return null;
        } catch (e) {
            this.setSyncStatus('error', '读取失败：' + e.message);
            return null;
        }
    },

    /**
     * 启动时调用一次：配了后端就拉一次，并把结果交给回调。
     * 整个过程不阻塞界面 —— 拉不到就用本机数据，功能不受影响。
     */
    async initSync() {
        const cfg = this.getSyncConfig();
        if (!cfg.url) {
            this.setSyncStatus('off', '未启用');
            return null;
        }
        return this.pullFromBackend();
    },

    getAuthSession() {
        try {
            const parsed = JSON.parse(localStorage.getItem(this.authKey) || 'null');
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (e) { return null; }
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
     *        [{ time(秒), price, side:'buy'|'sell', label, score,
     *           execTime(秒)?, execPrice? }]
     *
     *        time / price   = 产生信号的那根K线的开盘时间与收盘价
     *        execTime / execPrice = 信号确认后真正能成交的时刻与价格
     *                          （即信号K线收盘，也就是下一根K线的开盘）
     *
     *        为什么成交价由调用方传而非这里自取：回放是纯重算函数，
     *        不持有K线数组。成交口径只应在 app.js 定义一处，否则两边
     *        各算一套价、对不上还查不出来。未提供时退化为按信号K线
     *        收盘价成交（旧行为，仅用于兼容老调用方）。
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

            // 成交价与成交时刻：优先用调用方给的「信号确认后能成交」的值，
            // 拿不到才退回信号K线自身的收盘价
            const fillPrice = (typeof p.execPrice === 'number' && p.execPrice > 0)
                ? p.execPrice
                : p.price;
            const fillTime = (typeof p.execTime === 'number' && isFinite(p.execTime))
                ? p.execTime
                : p.time;
            if (!(fillPrice > 0)) continue;

            // 只回放开启模拟之后的成交。
            // 判据用「成交时刻」而不是「信号时刻」：信号要等那根K线收盘才成立，
            // 若你在K线走完之前就开启了模拟，这根K线的信号是你开启之后才确认的，
            // 应该算数，否则会出现「明明开着却一笔都不做」。
            if (enabledAt && fillTime * 1000 < enabledAt) continue;

            // 同向不重复下单；买卖点序列本身已是多空交替
            if (acc.lastSide === side) continue;

            // 满仓时再遇买入、空仓时再遇卖出：只记方向，不产生成交
            if (side === 'buy' && acc.cash <= 1) { acc.lastSide = side; continue; }
            if (side === 'sell' && acc.holdings <= 0) { acc.lastSide = side; continue; }

            const now = fillTime * 1000;
            const trade = {
                id: `${coinId}-${p.time}`,
                time: now,
                coinId,
                timeframe: acc.strategyTimeframe,
                side,
                // price 是实际成交价；signalPrice 是信号K线自己的收盘价。
                // 两个都留档，才能核对「延迟成交」究竟差了多少。
                price: fillPrice,
                signalPrice: p.price,
                signalTime: p.time * 1000,
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
                const qty = acc.cash / fillPrice;
                const cost = acc.cash;

                const prevQty = acc.holdings;
                const prevCost = acc.avgCost * prevQty;
                acc.holdings = prevQty + qty;
                acc.avgCost = acc.holdings > 0 ? (prevCost + cost) / acc.holdings : 0;
                acc.cash = 0;

                trade.qty = qty;
                trade.amount = cost;

                if (acc.firstBuyPrice === null) acc.firstBuyPrice = fillPrice;
            } else {
                const qty = acc.holdings;
                const proceeds = qty * fillPrice;

                trade.qty = qty;
                trade.amount = proceeds;
                trade.avgCost = acc.avgCost;
                trade.pnl = (fillPrice - acc.avgCost) * qty;
                trade.pnlPct = acc.avgCost > 0 ? (fillPrice / acc.avgCost - 1) : 0;

                acc.cash += proceeds;
                acc.holdings = 0;
                acc.avgCost = 0;
            }

            // 成交后的账户快照，用于权益曲线与最大回撤
            trade.cashAfter = acc.cash;
            trade.holdingsAfter = acc.holdings;
            trade.equityAfter = acc.cash + acc.holdings * fillPrice;

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
