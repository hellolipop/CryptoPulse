'use strict';
/**
 * 币安测试网连接器
 *
 * ============ 安全设计（每一条都对应一个具体风险）============
 *
 * 1. 域名硬编码白名单，只允许测试网
 *    风险：若 base URL 可由外部拼装，密钥会被签给钓鱼域名。
 *    做法：ALLOWED_HOSTS 白名单 + 每次请求前校验，命中非白名单直接抛错。
 *
 * 2. 密钥只存在内存，绝不落盘
 *    风险：localStorage / IndexedDB 里的密钥可被 XSS 或恶意扩展读取，
 *          且会长期驻留（OWASP HTML5 Cheat Sheet 明确不建议在客户端存储敏感信息）。
 *    做法：只挂在模块私有字段上；不写 localStorage、不进日志、不进错误上报；
 *          刷新页面即失效。
 *
 * 3. 签名在本地完成，用 Web Crypto (crypto.subtle) 做 HMAC-SHA256
 *    做法：先百分号编码再拼接，签名作为最后一个参数（币安官方要求）。
 *
 * 4. 下单前双重校验：交易所规则 + 防误触双阈值
 *    风险：手滑多打一个零、或限价打成远离市价的数字。
 *    做法：LOT_SIZE / MIN_NOTIONAL / PRICE_FILTER 逐个校验；
 *          名义金额超上限、或限价偏离现价超阈值 → 直接拦截或强制二次确认。
 *
 * 5. 客户端限速 + 429/418 退避
 *    风险：超限会被按 IP 封禁（2 分钟~3 天），且限频是按 IP 而非密钥计。
 *
 * 6. 「状态未知」不当失败重试
 *    风险：HTTP 503 / Unknown error 时订单可能已成交，盲目重试会重复下单。
 *    做法：标记为 unknown，交由调用方用订单查询确认。
 *
 * 7. 紧急停止
 *    做法：撤销全部挂单 + 置 halted 标记拒绝后续交易请求。
 *    注意：这只是前端止血，最彻底的做法是去币安撤销该密钥（已在界面上写明）。
 *
 * ============ 明确不做的事 ============
 * 不接入实盘。纯前端没有可信执行点，无法安全持有实盘密钥，
 * 也无法在签名前做服务端策略审查。实盘需要服务端签名代理。
 */

const BinanceTestnet = {
    // 硬编码，不接受任何外部传入
    BASE: 'https://testnet.binance.vision',
    ALLOWED_HOSTS: ['testnet.binance.vision'],

    LIMITS: {
        maxNotionalUSDT: 200,        // 单笔名义金额上限
        warnNotionalUSDT: 100,       // 超过即提示
        maxPriceDeviation: 0.05,     // 限价偏离现价超过 5% → 强制确认
        maxOrdersPerMinute: 10,      // 客户端限速
        recvWindow: 5000,            // 币安建议 ≤5000
        journalMax: 200,             // 本地订单记账上限
    },

    // 只在内存中
    _creds: null,
    _timeOffset: 0,
    _lastTimeSync: 0,
    _orderTimes: [],
    _halted: false,
    _rulesCache: {},

    // ---------------- 凭据 ----------------

    setCredentials(key, secret) {
        if (!key || !secret) return { ok: false, message: '请填写 API Key 与 Secret' };
        const host = new URL(this.BASE).host;
        if (!this.ALLOWED_HOSTS.includes(host)) return { ok: false, message: '非白名单域名' };
        this._creds = { key: String(key).trim(), secret: String(secret).trim() };
        this._timeOffset = 0;
        this._lastTimeSync = 0;
        return { ok: true };
    },

    clearCredentials() {
        this._creds = null;
        this._timeOffset = 0;
        this._lastTimeSync = 0;
        this._rulesCache = {};
        this._halted = false;
    },

    isConnected() {
        // 代理模式下「已连接」＝代理可达且持有密钥，浏览器自己不持有任何凭据
        if (this.isProxyMode()) return this._proxyHealthy === true;
        return !!(this._creds && this._creds.key && this._creds.secret);
    },

    hasTradePermission() { return !this._halted; },

    setHalted(v) { this._halted = !!v; },
    isHalted() { return this._halted; },

    // ---------------- 连接方式 ----------------
    //
    // 实测结论（2026-09-17，浏览器环境）：
    //   GET  https://testnet.binance.vision/api/v3/time                      → 200
    //   GET  同上，带 X-MBX-APIKEY 请求头                                      → Failed to fetch
    //   OPTIONS 预检（Access-Control-Request-Headers: x-mbx-apikey）          → Failed to fetch
    // 即：币安未对需要鉴权的请求开放 CORS，**纯前端无法直连下单（含测试网）**。
    // 这不是安全策略选择，是技术硬约束。
    //
    // 因此推荐并默认使用「本地签名代理」：密钥放在代理进程里，
    // 浏览器只知道代理地址、永远不接触密钥 —— 既绕开 CORS，又比浏览器持钥安全得多。

    PROXY_KEY: 'cryptoPulse_bnProxyUrl',

    /** 代理地址不是机密，可以持久化，省得每次重填 */
    setProxy(url) {
        const u = String(url || '').trim().replace(/\/$/, '');
        if (u && !/^https?:\/\//.test(u)) return { ok: false, message: '代理地址需以 http:// 或 https:// 开头' };
        try {
            if (u) localStorage.setItem(this.PROXY_KEY, u);
            else localStorage.removeItem(this.PROXY_KEY);
        } catch (e) { /* 忽略 */ }
        return { ok: true };
    },

    getProxy() {
        try { return localStorage.getItem(this.PROXY_KEY) || ''; } catch (e) { return ''; }
    },

    isProxyMode() { return !!this.getProxy(); },

    /** 代理健康检查：返回 { ok, hasKeys, tradeEnabled, host } */
    async checkProxy() {
        const base = this.getProxy();
        if (!base) { this._proxyHealthy = false; return { ok: false, message: '未配置代理地址' }; }
        try {
            const res = await fetch(`${base}/health`);
            const data = await res.json();
            const out = Object.assign({ ok: res.ok }, data);
            this._proxyHealthy = !!(res.ok && data && data.hasKeys);
            return out;
        } catch (e) {
            this._proxyHealthy = false;
            return { ok: false, message: '无法连接本地代理：' + e.message };
        }
    },

    // ---------------- 底层请求 ----------------

    _assertHost() {
        const host = new URL(this.BASE).host;
        if (!this.ALLOWED_HOSTS.includes(host)) {
            throw new Error('已阻断：请求目标不在白名单域名内');
        }
    },

    _encode(params) {
        return Object.keys(params)
            .filter(k => params[k] !== undefined && params[k] !== null && params[k] !== '')
            .map(k => `${k}=${encodeURIComponent(params[k])}`)
            .join('&');
    },

    async _sign(query) {
        if (!this._creds) throw new Error('未连接');
        if (!(window.crypto && window.crypto.subtle)) {
            throw new Error('当前环境不支持 Web Crypto（需要 HTTPS 或 localhost）');
        }
        const enc = new TextEncoder();
        const ck = await crypto.subtle.importKey(
            'raw', enc.encode(this._creds.secret),
            { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
        );
        const buf = await crypto.subtle.sign('HMAC', ck, enc.encode(query));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    },

    /** 用服务端时间校准本地时钟，避免 -1021 */
    async _syncTime() {
        const now = Date.now();
        if (now - this._lastTimeSync < 300000 && this._lastTimeSync) return;
        // 时钟校准失败不应阻断交易：拿不到就用本地时间，由 recvWindow 兜底
        try {
            const res = await fetch(`${this.BASE}/api/v3/time`);
            if (!res.ok) return;
            const data = await res.json();
            if (data && data.serverTime) {
                this._timeOffset = data.serverTime - Date.now();
                this._lastTimeSync = now;
            }
        } catch (e) {
            // 静默降级
        }
    },

    /** 客户端滑动窗口限速 */
    _rateLimit() {
        const now = Date.now();
        this._orderTimes = this._orderTimes.filter(t => now - t < 60000);
        if (this._orderTimes.length >= this.LIMITS.maxOrdersPerMinute) {
            throw new Error(`本地限速：每分钟最多 ${this.LIMITS.maxOrdersPerMinute} 笔下单`);
        }
        this._orderTimes.push(now);
    },

    _errorMessage(data) {
        if (!data) return '';
        if (typeof data === 'string') return data;
        if (data.msg) return data.msg;
        if (data.message) return data.message;
        return '';
    },

    /**
     * @param {string} method
     * @param {string} path
     * @param {Object} params
     * @param {{signed?:boolean, trading?:boolean}} opts
     */
    async request(method, path, params, opts) {
        opts = opts || {};
        if (opts.trading && this._halted) {
            throw new Error('已处于紧急停止状态，请先恢复后再下单');
        }
        const p = Object.assign({}, params || {});
        if (this.isProxyMode()) return this._proxyRequest(method, path, p, opts);
        return this._directRequest(method, path, p, opts);
    },

    /**
     * 经本地签名代理转发。
     * 代理进程负责签名与限额，密钥不进入浏览器。
     * 代理返回原始币安 JSON，因此上层业务代码无需区分两种模式。
     */
    async _proxyRequest(method, path, params, opts) {
        const base = this.getProxy();
        if (!base) throw new Error('未配置本地签名代理地址');
        if (!/^https?:\/\//.test(base)) throw new Error('代理地址不合法');
        if (opts.trading) this._rateLimit();

        const query = this._encode(params);
        const url = `${base}${path}${query ? '?' + query : ''}`;

        let res;
        try {
            res = await fetch(url, { method });
        } catch (e) {
            this._proxyHealthy = false;
            throw new Error('无法连接本地代理（请确认代理已启动）：' + e.message);
        }
        return this._handleResponse(res);
    },

    async _directRequest(method, path, params, opts) {
        this._assertHost();
        const p = params;
        if (opts.signed) {
            if (!this.isConnected()) throw new Error('未连接');
            if (opts.trading) this._rateLimit();
            await this._syncTime();
            p.timestamp = Date.now() + this._timeOffset;
            p.recvWindow = this.LIMITS.recvWindow;
        }

        let query = this._encode(p);
        if (opts.signed) {
            const sig = await this._sign(query);
            query += `&signature=${sig}`;      // 签名必须是最后一个参数
        }

        const url = `${this.BASE}${path}${query ? '?' + query : ''}`;
        const headers = {};
        if (this.isConnected()) headers['X-MBX-APIKEY'] = this._creds.key;

        let res;
        try {
            res = await fetch(url, { method, headers });
        } catch (e) {
            // 浏览器直连鉴权端点会被 CORS 拦截，这里给出可操作的提示
            const err = new Error(
                '网络请求失败：' + e.message +
                '（浏览器直连币安鉴权端点会被 CORS 阻断，请改用本地签名代理）');
            err.corsLikely = true;
            throw err;
        }
        return this._handleResponse(res);
    },

    /** 统一的响应处理：限频 / 状态未知 / 业务错误 三种语义必须区分 */
    async _handleResponse(res) {
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }

        if (res.status === 429 || res.status === 418) {
            const retry = res.headers.get('Retry-After');
            throw new Error(`被交易所限频（HTTP ${res.status}）${retry ? '，需等待 ' + retry + ' 秒' : ''}，已停止重试`);
        }
        if (res.status === 503) {
            // 状态未知：订单可能已成交，绝不能当作失败重试
            const err = new Error('交易所返回 503，订单状态未知，请用「查询订单」确认后再决定是否重下');
            err.unknownState = true;
            throw err;
        }
        if (!res.ok) {
            throw new Error(this._errorMessage(data) || `请求失败 HTTP ${res.status}`);
        }
        return data;
    },

    // ---------------- 业务接口 ----------------

    async ping() {
        await this.request('GET', '/api/v3/ping');
        return true;
    },

    async getAccount() {
        return this.request('GET', '/api/v3/account', {}, { signed: true });
    },

    async getOpenOrders(symbol) {
        return this.request('GET', '/api/v3/openOrders', symbol ? { symbol } : {}, { signed: true });
    },

    async getAllOrders(symbol, limit) {
        return this.request('GET', '/api/v3/allOrders', { symbol, limit: limit || 50 }, { signed: true });
    },

    async getOrder(symbol, orderId) {
        return this.request('GET', '/api/v3/order', { symbol, orderId }, { signed: true });
    },

    async getPrice(symbol) {
        const d = await this.request('GET', '/api/v3/ticker/price', { symbol });
        return parseFloat(d.price);
    },

    /** 交易规则（步长/最小额/价格精度），带缓存 */
    async getRules(symbol) {
        if (this._rulesCache[symbol]) return this._rulesCache[symbol];
        const info = await this.request('GET', '/api/v3/exchangeInfo', { symbol });
        const s = info.symbols && info.symbols[0];
        if (!s) throw new Error('未找到交易对规则：' + symbol);

        const pick = type => (s.filters || []).find(f => f.filterType === type) || {};
        const lot = pick('LOT_SIZE');
        const notional = pick('NOTIONAL') || pick('MIN_NOTIONAL');
        const priceFilter = pick('PRICE_FILTER');

        const rules = {
            symbol,
            baseAsset: s.baseAsset,
            quoteAsset: s.quoteAsset,
            minQty: parseFloat(lot.minQty || 0),
            stepSize: parseFloat(lot.stepSize || 0),
            minNotional: parseFloat(notional.minNotional || 0),
            tickSize: parseFloat(priceFilter.tickSize || 0),
            status: s.status,
        };
        this._rulesCache[symbol] = rules;
        return rules;
    },

    /** 按步长向下取整，避免 LOT_SIZE 被拒 */
    floorToStep(value, step) {
        if (!step || step <= 0) return value;
        const decimals = Math.max(0, Math.round(-Math.log10(step)));
        const n = Math.floor(value / step + 1e-9) * step;
        return parseFloat(n.toFixed(decimals));
    },

    /**
     * 下单前的完整校验（规则 + 防误触）
     * 返回 { ok, blocked, needsConfirm, errors, warnings, notional, fee, normalizedQty, normalizedPrice, rules }
     */
    async validateOrder(order) {
        const { symbol, side, type, price, quantity, refPrice, availableQuote, availableBase } = order;
        const errors = [];
        const warnings = [];
        let blocked = false;
        let needsConfirm = false;

        let rules;
        try {
            rules = await this.getRules(symbol);
        } catch (e) {
            return { ok: false, blocked: true, errors: ['无法获取交易规则：' + e.message], warnings, notional: 0, fee: 0 };
        }

        if (rules.status && rules.status !== 'TRADING') {
            errors.push(`该交易对当前状态为 ${rules.status}，不可下单`);
            blocked = true;
        }

        if (!(quantity > 0)) errors.push('数量必须大于 0');
        if (type === 'LIMIT' && !(price > 0)) errors.push('限价单必须填写价格');

        // 步长归一化
        const normalizedQty = this.floorToStep(quantity || 0, rules.stepSize);
        if (normalizedQty <= 0) {
            errors.push(`数量小于最小步长 ${rules.stepSize}`);
            blocked = true;
        } else if (Math.abs(normalizedQty - quantity) > 1e-12) {
            warnings.push(`数量已按步长 ${rules.stepSize} 调整为 ${normalizedQty}`);
        }
        if (rules.minQty && normalizedQty < rules.minQty) {
            errors.push(`数量低于最小下单量 ${rules.minQty} ${rules.baseAsset}`);
            blocked = true;
        }

        const effPrice = type === 'LIMIT' ? price : refPrice;
        const notional = normalizedQty * (effPrice || 0);

        if (rules.minNotional && notional < rules.minNotional) {
            errors.push(`名义金额 ${notional.toFixed(2)} 低于最小额 ${rules.minNotional} ${rules.quoteAsset}`);
            blocked = true;
        }

        // ---- 防误触双阈值（对齐交易所 fat finger check 的思路）----
        if (notional > this.LIMITS.maxNotionalUSDT) {
            errors.push(`单笔名义金额 ${notional.toFixed(2)} 超过系统上限 ${this.LIMITS.maxNotionalUSDT}，已拦截`);
            blocked = true;
        } else if (notional > this.LIMITS.warnNotionalUSDT) {
            warnings.push(`单笔名义金额较大（${notional.toFixed(2)}）`);
            needsConfirm = true;
        }

        if (type === 'LIMIT' && refPrice > 0) {
            const dev = Math.abs(price / refPrice - 1);
            if (dev > this.LIMITS.maxPriceDeviation * 4) {
                errors.push(`限价偏离现价 ${(dev * 100).toFixed(1)}%，超出 20% 硬上限，已拦截`);
                blocked = true;
            } else if (dev > this.LIMITS.maxPriceDeviation) {
                warnings.push(`限价偏离现价 ${(dev * 100).toFixed(1)}%，请确认价格没打错`);
                needsConfirm = true;
            }
        }

        // 余额校验
        if (side === 'BUY' && availableQuote !== undefined && availableQuote !== null) {
            if (notional > availableQuote) {
                errors.push(`可用 ${rules.quoteAsset} 不足（需要 ${notional.toFixed(2)}，可用 ${availableQuote.toFixed(2)}）`);
                blocked = true;
            }
        }
        if (side === 'SELL' && availableBase !== undefined && availableBase !== null) {
            if (normalizedQty > availableBase) {
                errors.push(`可用 ${rules.baseAsset} 不足（需要 ${normalizedQty}，可用 ${availableBase}）`);
                blocked = true;
            }
        }

        return {
            ok: errors.length === 0,
            blocked,
            needsConfirm,
            errors,
            warnings,
            notional,
            fee: notional * 0.001,        // 现货 taker 0.1%
            normalizedQty,
            normalizedPrice: price,
            rules,
        };
    },

    async placeOrder(order) {
        const params = {
            symbol: order.symbol,
            side: order.side,
            type: order.type,
            quantity: order.quantity,
        };
        if (order.type === 'LIMIT') {
            params.price = order.price;
            params.timeInForce = 'GTC';
        }
        const res = await this.request('POST', '/api/v3/order', params, { signed: true, trading: true });
        this.journal(res);
        return res;
    },

    async cancelOrder(symbol, orderId) {
        const res = await this.request('DELETE', '/api/v3/order', { symbol, orderId }, { signed: true, trading: true });
        this.journal(res);
        return res;
    },

    async cancelAllOrders(symbol) {
        const res = await this.request('DELETE', '/api/v3/openOrders', { symbol }, { signed: true, trading: true });
        return res;
    },

    /** 紧急停止：撤单 + 拒新单 */
    async killSwitch(symbol) {
        let cancelled = 0;
        let err = null;
        try {
            const res = await this.cancelAllOrders(symbol);
            cancelled = Array.isArray(res) ? res.length : 0;
        } catch (e) {
            err = e.message;
        }
        this._halted = true;
        return { cancelled, error: err };
    },

    resume() { this._halted = false; },

    // ---------------- 本地订单记账（不含任何密钥）----------------

    JOURNAL_KEY: 'cryptoPulse_bnOrders',

    journal(order) {
        if (!order || !order.orderId) return;
        try {
            const list = this.getJournal();
            const t = {
                orderId: order.orderId,
                symbol: order.symbol,
                side: order.side,
                type: order.type,
                price: parseFloat(order.price || order.cummulativeQuoteQty || 0),
                origQty: parseFloat(order.origQty || 0),
                executedQty: parseFloat(order.executedQty || 0),
                status: order.status,
                time: order.transactTime || order.time || Date.now(),
                clientOrderId: order.clientOrderId || '',
                env: 'testnet',
            };
            const idx = list.findIndex(x => x.orderId === t.orderId);
            if (idx >= 0) list[idx] = t; else list.unshift(t);
            localStorage.setItem(this.JOURNAL_KEY, JSON.stringify(list.slice(0, this.LIMITS.journalMax)));
        } catch (e) {
            console.warn('[币安] 本地记账失败:', e.message);
        }
    },

    getJournal() {
        try {
            const raw = localStorage.getItem(this.JOURNAL_KEY);
            const list = raw ? JSON.parse(raw) : [];
            return Array.isArray(list) ? list : [];
        } catch (e) { return []; }
    },

    clearJournal() {
        try { localStorage.removeItem(this.JOURNAL_KEY); } catch (e) {}
    },
};
