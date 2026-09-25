#!/usr/bin/env node
'use strict';
/**
 * 模拟盘持久化服务（本地运行）
 *
 * 为什么单独一个进程，而不是塞进 server/proxy.js：
 *   proxy.js 是「币安签名代理」，它的安全前提是**端点白名单收得极紧**
 *   （只有账户查询与下单撤单，绝不含提现/划转）。往里加数据读写路由会破坏
 *   这个前提 —— 一个能读写文件的服务和一个能签名的服务放在同一进程，
 *   任何一处被利用都是叠加风险。而且持久化模拟盘根本不需要 API 密钥，
 *   不该为了存个模拟盘就逼用户去配币安密钥。
 *
 * 存什么：
 *   模拟盘的全部状态 —— 总资金、各币种配额、运行开关、持仓、成交记录。
 *   这些原本只躺在浏览器的 localStorage 里：清一次缓存、换一个浏览器、
 *   换一台设备就全没了。这个服务把它们落到磁盘上。
 *
 *   此外还存预测记录（买卖点 + 当时的因子快照 + 复盘结果），并按用户维护一份
 *   CSV 表格，用于长期分析「算法因子要不要调整」。预测记录按 id 合并、只增不删：
 *   客户端本地只保留最近若干条，若按整体覆盖，本地裁剪会把后端的历史样本删掉。
 *
 * 存在哪：
 *   server/data/paper-state.json（已在 .gitignore 中）。
 *   写入采用「临时文件 + rename」保证原子性，并保留一份上一版备份，
 *   避免写到一半断电/被杀进程导致整个文件损坏。
 *   预测记录的表格另存为 server/data/predictions.csv（同样在 .gitignore 中）。
 *
 * 启动：
 *   node server/store.js
 * 可选环境变量：
 *   PORT=8788        监听端口
 *   STORE_FILE=...   数据文件路径
 *
 * 安全边界（务必知道）：
 *   - 只监听 127.0.0.1，局域网内其它机器访问不到
 *   - 只回显本机来源（localhost / 127.0.0.1）的 CORS 头，其它来源浏览器自然拦截
 *   - 用户密码只保存 scrypt 哈希，不保存明文。
 *   - 会话随数据一起落盘，所以重启服务不会被登出。落盘的是令牌的 SHA-256 摘要而非
 *     令牌本身，文件即使被看到也拿不到可用的令牌。会话自登录起 30 天过期。
 *   - 当前服务仍只监听 127.0.0.1。若将来放到公网，必须补 HTTPS、限流和更强的登录验证。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '8788', 10);
const HOST = process.env.HOST || '127.0.0.1';
const LAN_MODE = HOST !== '127.0.0.1' && HOST !== '::1' && HOST !== 'localhost';
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = process.env.STORE_FILE || path.join(DATA_DIR, 'paper-state.json');
const BACKUP_FILE = STORE_FILE + '.bak';
const TMP_FILE = STORE_FILE + '.tmp';
// 预测记录的表格产物（供分析用）。列定义与写盘逻辑见 predictions-csv.js。
//
// 注意这里是跟着 STORE_FILE 走，而不是固定放在 server/data —— 否则用临时 STORE_FILE
// 跑测试时，测试数据会写进真实的分析表格。这个坑真的踩过：跑一次测试就把 450 行的
// 表格覆盖成了 3 行测试样本，而表格是拿去分析「该调哪个因子」的，被覆盖之后分析
// 出来的结论全是错的、还看不出来。
const PREDICTIONS_CSV = path.join(path.dirname(STORE_FILE), 'predictions.csv');

// 请求体上限。模拟盘状态里成交记录是有上限的（每账户 200 笔），
// 正常不会超过几百 KB；给到 2MB 是留余量，同时挡住异常大的写入。
const MAX_BODY = 2 * 1024 * 1024;

const SCHEMA_VERSION = 5;

// 会话有效期。到期后客户端会收到 401，界面提示重新登录。
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

// ---------- 存储 ----------

function emptyStore() {
    return { schemaVersion: SCHEMA_VERSION, users: {}, accounts: {}, sessions: {}, predictions: {}, mail: {} };
}

/** 读整份存储。文件不存在/损坏都回落到空存储，不让服务因此起不来。 */
function readStore() {
    for (const file of [STORE_FILE, BACKUP_FILE]) {
        try {
            if (!fs.existsSync(file)) continue;
            const raw = fs.readFileSync(file, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && parsed.accounts && typeof parsed.accounts === 'object') {
                if (!parsed.users || typeof parsed.users !== 'object') parsed.users = {};
                // v2 及更早的文件没有 sessions 字段。这里必须补上：
                // 否则读一次再写回，会话字段就被整段丢掉了。
                if (!parsed.sessions || typeof parsed.sessions !== 'object') parsed.sessions = {};
                // v3 及更早的文件没有 predictions 字段。同样必须补上：
                // 否则读一次再写回，预测记录就被整段丢掉了。
                if (!parsed.predictions || typeof parsed.predictions !== 'object') parsed.predictions = {};
                // v4 及更早的文件没有 mail 字段（推送邮箱）。同样必须补上：
                // 否则读一次再写回，已验证的推送地址就被整段丢掉了 ——
                // 表现是「明明验证过，重启后又要重新验证一遍」。
                if (!parsed.mail || typeof parsed.mail !== 'object') parsed.mail = {};
                // 读到旧版本就地升级，下次写入即变为新格式
                if (parsed.schemaVersion !== SCHEMA_VERSION) parsed.schemaVersion = SCHEMA_VERSION;
                if (file === BACKUP_FILE) {
                    console.warn('[存储] 主文件不可用，已从备份恢复:', BACKUP_FILE);
                }
                return parsed;
            }
            console.warn('[存储] 文件结构异常，跳过:', file);
        } catch (e) {
            console.warn('[存储] 读取失败 ' + file + ':', e.message);
        }
    }
    return emptyStore();
}

function normalizeUsername(value) {
    const username = String(value || '').trim();
    return /^[A-Za-z0-9_\u4e00-\u9fff-]{2,32}$/.test(username) ? username : null;
}

function passwordHash(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
}

function makePassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    return { salt, hash: passwordHash(password, salt) };
}

function sameSecret(a, b) {
    const left = Buffer.from(String(a || ''), 'hex');
    const right = Buffer.from(String(b || ''), 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function bearer(req) {
    const value = String(req.headers.authorization || '');
    return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

/**
 * 令牌在存储里的键。
 *
 * 存摘要而不是令牌本身：令牌是 256 位随机值，不存在被爆破的可能，
 * 所以一次 SHA-256 就够，不需要加盐或慢哈希 —— 那是为了防低熵口令被字典攻击，
 * 与这里的情况不同。好处是数据文件即使被看到，也换不出任何一个可用的令牌。
 */
function tokenKey(token) {
    const raw = String(token || '').trim();
    if (!raw) return null;
    return crypto.createHash('sha256').update(raw).digest('hex');
}

/** 清掉已过期的会话，避免这个表随登录次数无限增长 */
function pruneSessions(store) {
    const now = Date.now();
    Object.keys(store.sessions || {}).forEach(key => {
        const rec = store.sessions[key];
        if (!rec || typeof rec.expiresAt !== 'number' || rec.expiresAt <= now) {
            delete store.sessions[key];
        }
    });
}

/**
 * 校验请求携带的令牌，通过则返回用户名，否则返回 null。
 *
 * 会话从存储里查而不是从进程内存 —— 这正是「重启服务不被登出」的关键。
 * 过期记录在这次读取里顺手清掉，下次写入时就从文件里消失了。
 */
function requireUser(req, store) {
    const key = tokenKey(bearer(req));
    if (!key || !store.sessions) return null;
    const rec = store.sessions[key];
    if (!rec) return null;
    if (typeof rec.expiresAt !== 'number' || rec.expiresAt <= Date.now()) {
        delete store.sessions[key];
        return null;
    }
    return store.users[rec.username] ? rec.username : null;
}

/**
 * 原子写入。
 *
 * 直接 writeFileSync 覆盖原文件有个真实的坏情况：写到一半进程被杀，
 * 文件就成了半截 JSON，下次启动整份数据读不出来。
 * 所以先写临时文件、fsync，再 rename 覆盖 —— rename 在同一文件系统内是原子的。
 * 覆盖前把旧文件留成 .bak，多一层兜底。
 */
function writeStore(store) {
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });

    const body = JSON.stringify(store, null, 2);
    const fd = fs.openSync(TMP_FILE, 'w');
    try {
        fs.writeFileSync(fd, body);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }

    if (fs.existsSync(STORE_FILE)) {
        try { fs.copyFileSync(STORE_FILE, BACKUP_FILE); } catch (e) { /* 备份失败不阻断写入 */ }
    }
    fs.renameSync(TMP_FILE, STORE_FILE);
}

// ---------- 预测记录表格 ----------
//
// 为什么另存一份 CSV：JSON 适合存，不适合分析。要回答「哪个因子需要调整」，
// 得能直接在表格里筛选、按分组算准确率。每次整份重写而不是追加 —— 记录会被复盘
// 就地更新（evalPrice/correct），追加会产生重复行，重复行会让准确率算错。
//
// 具体的列定义与写盘逻辑在 predictions-csv.js 里，本文件只负责在写入后调用它：
// 维护脚本（例如批量修正复盘结论）也要重写这张表，放在共用的模块里才不会出现
// 两份列定义各自漂移的情况。

const { writePredictionsCsv } = require('./predictions-csv');
const notify = require('./notify');

function writePredictionsCsvLocal(store) {
    return writePredictionsCsv(store, PREDICTIONS_CSV);
}

// ---------- HTTP 工具（与 proxy.js 保持一致的做法） ----------

function isLocalOrigin(origin) {
    if (!origin) return false;
    try {
        const u = new URL(origin);
        return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    } catch (e) { return false; }
}

function corsHeaders(origin) {
    if (!origin || (!LAN_MODE && !isLocalOrigin(origin))) return {};
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE',
        // Authorization 不是 CORS 安全列表头，带上它会触发预检；
        // 预检响应里不列出它，浏览器就会直接拦掉后续的真实请求。
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '600',
    };
}

/** 只回显部分地址：够确认「配的是哪个邮箱」即可，没必要把完整地址暴露在局域网响应里 */
function maskAddress(addr) {
    const s = String(addr || '');
    const at = s.indexOf('@');
    if (at <= 0) return s;
    const name = s.slice(0, at);
    const keep = name.slice(0, 2);
    return keep + '*'.repeat(Math.max(1, name.length - keep.length)) + s.slice(at);
}

/**
 * 最近 5 条发送记录，供 /api/notify 的 GET 排查「为什么没收到」
 *
 * 只回本账号自己的那几条。这份日志是全服务共用的，而每条记录里都带着收件地址 ——
 * 不过滤的话，A 账号能看到 B 账号的地址（哪怕是脱敏后的，「9548***@qq.com」
 * 也已经足够确认是谁）。每条记录带了 account 字段，早期没有该字段的记录
 * 按「收件地址等于本人地址」归属，这样升级前后的记录都能正确归类。
 */
function readRecentNotices(username, ownEmail) {
    try {
        const logs = JSON.parse(fs.readFileSync(notify.logFile(), 'utf8'));
        const mine = (Array.isArray(logs) ? logs : []).filter(e => {
            if (!e) return false;
            if (e.account) return e.account === username;
            return !!ownEmail && e.to === ownEmail;
        });
        return mine.slice(-5).map(e => ({
            at: new Date(e.at).toISOString(),
            ok: !!e.ok,
            signal: e.coinId ? `${e.coinId}/${e.timeframe}/${e.signalType}` : null,
            error: e.error || null,
            to: e.to ? maskAddress(e.to) : null,
            // 配图情况：便于回答「为什么这封没有K线图」
            chart: e.chart === undefined ? null : !!e.chart,
            chartError: e.chartError || null,
        }));
    } catch (e) {
        return [];
    }
}

// ---------- 推送邮箱（按账号隔离，必须本人验证） ----------
//
// 为什么不用 mail-config.json 里那个 to：那是「这台机器往哪个邮箱发信」，
// 所有账号共用一份。一旦有第二个账号，就等于把第一个人的邮箱给了第二个人；
// 而且谁注册一个账号，都能拿这台机器的 SMTP 往那个地址发信。
// 所以收件地址改成**每个账号一份**，而且**必须本人验证**。
//
// 为什么要验证码，而不是「填了就算」：不做验证的话，任何人都能把推送地址填成
// 别人的邮箱，用你的 SMTP 去给陌生人发信 —— 受害的是对方的收件箱和你的发信信誉。
// 它同时解决了第二个问题：地址填错一个字母就永远收不到，而这件事本身毫无提示，
// 验证码正好证明「这个地址真的能收到」。
//
// 地址与验证状态存在 store.mail[username]，与 accounts 分开：accounts 是浏览器
// 权威的模拟盘镜像、会被整份覆盖，邮箱设置不能被一次同步冲掉。
const MAIL_CODE_TTL_MS = 10 * 60 * 1000;   // 验证码有效期
const MAIL_CODE_COOLDOWN_MS = 60 * 1000;   // 同一账号两次发码的最小间隔
const MAIL_CODE_MAX_PER_HOUR = 5;          // 单账号每小时发码上限
const MAIL_CODE_MAX_PER_HOUR_ALL = 20;     // 全服务每小时上限（注册是开放的，兜一层底）
const MAIL_CODE_MAX_ATTEMPTS = 5;          // 一个验证码最多试错几次

/**
 * 正在发码的账号。
 *
 * 节流是读文件判断的，而发信要等 SMTP 往返 —— 两次请求几乎同时到达时，
 * 两边都会读到「还没发过」然后各发一封。浏览器那边按钮会禁用，但那只是界面约束，
 * 挡不住直接打接口。这里用一个进程内的集合把窗口补上。
 */
const mailCodeInFlight = new Set();

function mailRecord(store, username) {
    if (!store.mail || typeof store.mail !== 'object') store.mail = {};
    const rec = store.mail[username];
    return (rec && typeof rec === 'object') ? rec : null;
}

/**
 * 验证码的存法：不存码本身，存 sha256(用户名|码)。
 *
 * 加用户名是为了让同一个码在不同账号下算出不同摘要 —— 码只有 6 位数字（100 万种），
 * 单纯 sha256(码) 是能被穷举的，撞上就等于拿到了别人的验证码。
 */
function codeHashOf(username, code) {
    return crypto.createHash('sha256').update(`${username}|${code}`).digest('hex');
}

/** 某个账号在当前这一小时窗口里已发出的验证码数量 */
function codesSentInWindow(rec, now) {
    const p = rec && rec.pending;
    if (!p || typeof p.sentAt !== 'number') return { count: 0, windowStart: now };
    const inWindow = typeof p.windowStart === 'number' && now - p.windowStart < 3600 * 1000;
    return {
        count: inWindow ? (p.sentCount || 0) : 0,
        windowStart: inWindow ? p.windowStart : now,
    };
}

/** 全服务一小时内的发码总量（跨账号兜底） */
function codesSentTotal(store, now) {
    let total = 0;
    Object.keys(store.mail || {}).forEach(u => {
        const rec = store.mail[u];
        if (!rec || typeof rec !== 'object') return;
        total += codesSentInWindow(rec, now).count;
    });
    return total;
}

/**
 * 给界面看的本账号状态。
 *
 * 地址回显**完整值**而不是脱敏值：那是用户自己填的，脱敏只会让他看不出填错在哪。
 * 日志那一份仍然脱敏（见 readRecentNotices），那里可能出现在别人的请求里。
 */
function mailStateOf(store, username) {
    const rec = mailRecord(store, username);
    if (!rec) return { email: null, verified: false, verifiedAt: null, pending: null };

    const now = Date.now();
    const p = rec.pending;
    const pending = (p && p.email) ? {
        email: p.email,
        expiresInSec: Math.max(0, Math.round((p.expiresAt - now) / 1000)),
        resendAfterSec: Math.max(0, Math.ceil((MAIL_CODE_COOLDOWN_MS - (now - (p.sentAt || 0))) / 1000)),
    } : null;

    return {
        email: rec.email || null,
        verified: !!rec.verifiedAt,
        verifiedAt: rec.verifiedAt || null,
        pending,
    };
}

function send(res, status, body, origin) {
    const headers = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders(origin));
    res.writeHead(status, headers);
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', c => {
            size += c.length;
            if (size > MAX_BODY) {
                req.destroy();
                reject(new Error(`请求体超过上限 ${MAX_BODY} 字节`));
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/**
 * 账号键。
 * 直接拿它当文件名会有路径穿越风险（../ 之类），所以这里既要限制字符集，
 * 又要把所有账号存在**同一个文件**里 —— 后者从根上消除了穿越的可能。
 */
function safeAccountKey(raw) {
    const k = String(raw || 'default');
    return /^[A-Za-z0-9_-]{1,64}$/.test(k) ? k : null;
}

// ---------- 服务 ----------

const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || '';

    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(origin));
        res.end();
        return;
    }

    let url;
    try {
        url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    } catch (e) {
        send(res, 400, { error: '非法 URL' }, origin);
        return;
    }

    const route = `${req.method} ${url.pathname}`;

    if (route === 'POST /api/auth/register' || route === 'POST /api/auth/login') {
        let payload;
        try { payload = JSON.parse(await readBody(req)); } catch (e) {
            send(res, 400, { error: '请求体不是合法 JSON' }, origin); return;
        }
        const username = normalizeUsername(payload.username);
        const password = typeof payload.password === 'string' ? payload.password : '';
        if (!username || password.length < 6 || password.length > 128) {
            send(res, 400, { error: '用户名需为 2-32 位，密码需为 6-128 位' }, origin); return;
        }
        const store = readStore();
        if (route.endsWith('/register')) {
            if (store.users[username]) { send(res, 409, { error: '用户名已存在' }, origin); return; }
            const secret = makePassword(password);
            store.users[username] = { username, ...secret, createdAt: new Date().toISOString() };
        } else {
            const user = store.users[username];
            if (!user || !sameSecret(passwordHash(password, user.salt), user.hash)) {
                send(res, 401, { error: '用户名或密码错误' }, origin); return;
            }
        }
        // 令牌要在写盘之前生成：它必须和用户记录一起落盘，
        // 否则「重启服务仍保持登录」就不成立。
        const token = crypto.randomBytes(32).toString('hex');
        pruneSessions(store);
        store.sessions[tokenKey(token)] = {
            username,
            createdAt: new Date().toISOString(),
            expiresAt: Date.now() + SESSION_TTL_MS,
        };
        try { writeStore(store); } catch (e) { send(res, 500, { error: '用户数据保存失败' }, origin); return; }
        send(res, route.endsWith('/register') ? 201 : 200, { ok: true, token, user: { username } }, origin);
        return;
    }

    if (route === 'POST /api/auth/logout') {
        const store = readStore();
        const key = tokenKey(bearer(req));
        if (key && store.sessions && store.sessions[key]) {
            delete store.sessions[key];
            try {
                writeStore(store);
            } catch (e) {
                // 这次读取里已经删掉了，但没落盘就可能在重启后「复活」。
                // 不因此阻断登出（用户本地已清），但必须留下痕迹。
                console.error('[存储] 登出未能落盘，该会话重启后可能仍然有效:', e.message);
            }
        }
        send(res, 200, { ok: true }, origin);
        return;
    }

    if (route === 'GET /api/auth/me') {
        const store = readStore();
        const username = requireUser(req, store);
        if (!username) { send(res, 401, { error: '未登录或登录已过期' }, origin); return; }
        send(res, 200, { ok: true, user: { username } }, origin);
        return;
    }

    // 健康检查：客户端用它判断后端是否就绪，不必等一次真实读写
    if (route === 'GET /api/paper/health') {
        send(res, 200, {
            ok: true,
            service: 'paper-store',
            schemaVersion: SCHEMA_VERSION,
            file: STORE_FILE,
            csv: PREDICTIONS_CSV,
        }, origin);
        return;
    }

    // ---------- 预测记录 ----------
    //
    // 与模拟盘状态的两点关键差异：
    //   1. 按 id 合并、只增不删 —— 客户端本地只留最近 150 条，
    //      若像模拟盘那样整体覆盖，本地裁剪会把后端的历史样本删掉；
    //   2. 每次都重写一份 CSV 表格，供长期分析因子是否需要调整。

    if (url.pathname === '/api/predictions' || url.pathname === '/api/predictions.csv') {
        const store = readStore();
        const username = requireUser(req, store);
        if (!username) { send(res, 401, { error: '请先登录' }, origin); return; }

        if (url.pathname.endsWith('.csv')) {
            if (req.method !== 'GET') { send(res, 405, { error: '只支持 GET' }, origin); return; }
            try {
                writePredictionsCsvLocal(store);
                // 必须按 Buffer 读、按 Buffer 写。指定 'utf8' 时 Node 会吞掉开头的
                // BOM，而 BOM 正是 Excel 正确识别中文表头所依赖的东西 ——
                // 少了它，用户打开看到的是一堆乱码。
                const body = fs.readFileSync(PREDICTIONS_CSV);
                res.writeHead(200, Object.assign({
                    'Content-Type': 'text/csv; charset=utf-8',
                    'Content-Disposition': 'attachment; filename="predictions.csv"',
                }, corsHeaders(origin)));
                res.end(body);
            } catch (e) {
                send(res, 500, { error: '生成表格失败：' + e.message }, origin);
            }
            return;
        }

        if (req.method === 'GET') {
            const records = (store.predictions[username] || []).slice()
                .sort((a, b) => (a.predictedAt || 0) - (b.predictedAt || 0));
            send(res, 200, { ok: true, account: username, total: records.length, records }, origin);
            return;
        }

        if (req.method === 'POST') {
            let payload;
            try {
                payload = JSON.parse(await readBody(req));
            } catch (e) {
                send(res, 400, { error: '请求体不是合法 JSON' }, origin);
                return;
            }
            const incoming = Array.isArray(payload && payload.records) ? payload.records : null;
            if (!incoming) { send(res, 400, { error: 'records 必须是数组' }, origin); return; }

            const list = store.predictions[username] || (store.predictions[username] = []);
            const index = new Map();
            list.forEach((rec, i) => { if (rec && rec.id) index.set(rec.id, i); });

            let added = 0;
            let updated = 0;
            incoming.forEach(rec => {
                if (!rec || typeof rec !== 'object' || !rec.id) return;
                const at = index.get(rec.id);
                if (at === undefined) {
                    index.set(rec.id, list.length);
                    list.push(rec);
                    added++;
                } else {
                    // 同 id 覆盖：客户端是复盘结果的产生方，它那份更新。
                    // 载荷里没有的 id 一律保留 —— 这正是「只增不删」。
                    list[at] = rec;
                    updated++;
                }
            });

            // 按时间排序后再落盘：表格要按时间读，文件内容也稳定、便于比对
            list.sort((a, b) => (a.predictedAt || 0) - (b.predictedAt || 0));

            try {
                writeStore(store);
                writePredictionsCsvLocal(store);
            } catch (e) {
                send(res, 500, { error: '保存失败：' + e.message }, origin);
                return;
            }
            send(res, 200, {
                ok: true,
                account: username,
                total: list.length,
                added,
                updated,
                savedAt: new Date().toISOString(),
            }, origin);
            return;
        }

        send(res, 405, { error: '只支持 GET 与 POST' }, origin);
        return;
    }

    if (url.pathname === '/api/paper/state') {
        const store = readStore();
        const username = requireUser(req, store);
        if (!username) { send(res, 401, { error: '请先登录' }, origin); return; }
        const account = username;

        if (req.method === 'GET') {
            const rec = store.accounts[account];
            if (!rec) {
                send(res, 200, { account, empty: true, savedAt: null, rev: 0, data: null }, origin);
                return;
            }
            send(res, 200, {
                account,
                empty: false,
                savedAt: rec.savedAt || null,
                // 暴露 rev 便于客户端与测试判断「这次到底有没有真的写进去」
                rev: rec.rev || 0,
                data: rec.data,
            }, origin);
            return;
        }

        if (req.method === 'PUT') {
            let raw;
            try {
                raw = await readBody(req);
            } catch (e) {
                send(res, 413, { error: e.message }, origin);
                return;
            }

            let payload;
            try {
                payload = JSON.parse(raw);
            } catch (e) {
                send(res, 400, { error: '请求体不是合法 JSON' }, origin);
                return;
            }

            // 只接受对象：数组/标量存进去没有意义，还会让下次读取更难判断
            const data = (payload && typeof payload === 'object' && !Array.isArray(payload))
                ? (payload.data !== undefined ? payload.data : payload)
                : null;
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                send(res, 400, { error: 'data 必须是对象' }, origin);
                return;
            }

            const savedAt = new Date().toISOString();
            store.accounts[account] = {
                savedAt,
                // 每次写入自增，客户端可据此判断哪一侧更新
                rev: ((store.accounts[account] && store.accounts[account].rev) || 0) + 1,
                data,
            };

            try {
                writeStore(store);
            } catch (e) {
                console.error('[存储] 写入失败:', e.message);
                send(res, 500, { error: '写入失败：' + e.message }, origin);
                return;
            }

            send(res, 200, { ok: true, account, savedAt, rev: store.accounts[account].rev }, origin);
            console.log(`[存储] ${account} 已保存（${raw.length} 字节）`);
            return;
        }

        send(res, 405, { error: '只支持 GET / PUT' }, origin);
        return;
    }

    // ---- 买卖信号邮件提醒 ----
    //
    // 信号在浏览器里算（server/ 不引用 technical.js / signals.js，也不取行情），
    // 所以这里是被动接收：浏览器扫到「已开启交易」的币种出现新的K线买卖点时，
    // 把这个点的快照 POST 过来。
    //
    // 必须鉴权：这个服务可能绑在局域网网卡上，若不校验，同一网络里任何人都能
    // 让这台机器往外发邮件。
    if (url.pathname === '/api/notify') {
        const store = readStore();
        const username = requireUser(req, store);
        if (!username) { send(res, 401, { error: '请先登录' }, origin); return; }

        if (req.method === 'GET') {
            // 用于排查「为什么没收到」：发信能力、本账号的推送邮箱、节流参数、最近的发送记录
            const state = notify.loadConfig();
            const mine = mailStateOf(store, username);
            send(res, 200, {
                configured: state.configured,
                reason: state.reason || null,
                hint: state.hint || null,
                // 发信服务器（host / 账号 / 授权码）是这台机器一份；
                // 收件地址是每个账号一份，且必须本人验证过才生效
                smtp: state.configured
                    ? { host: state.config.host, port: state.config.port, user: state.config.user }
                    : null,
                email: mine.email,
                emailVerified: mine.verified,
                emailVerifiedAt: mine.verifiedAt,
                pendingEmail: mine.pending ? mine.pending.email : null,
                cooldownHours: notify.COOLDOWN_HOURS,
                maxPerHour: notify.MAX_PER_HOUR,
                configFile: notify.configFile(),
                recent: readRecentNotices(username, mine.email),
            }, origin);
            return;
        }

        if (req.method !== 'POST') {
            send(res, 405, { error: '只支持 GET / POST' }, origin);
            return;
        }

        let payload;
        try {
            payload = JSON.parse(await readBody(req));
        } catch (e) {
            send(res, 400, { error: '请求体不是合法 JSON' }, origin);
            return;
        }
        if (!payload || typeof payload !== 'object' || !payload.signal) {
            send(res, 400, { error: '缺少 signal' }, origin);
            return;
        }

        // 收件地址只用**本账号已验证**的那个，刻意不回落配置文件里的 to：
        // 那不是「本人的地址」，回落等于把一个人的邮箱变成所有账号共用的收件箱，
        // 正是这次要改掉的东西（谁注册一个账号都能往那个地址发信）。
        const mine = mailRecord(store, username);
        const to = (mine && mine.verifiedAt && mine.email) ? mine.email : '';
        if (!to) {
            // 跳过而不是失败：这是「还没配好」的正常状态，浏览器不该反复重试。
            // 被挡下的这条买卖点也不会补发，所以提示里要说清去哪儿补。
            send(res, 200, {
                ok: false,
                skipped: true,
                error: '本账号还没设置并验证推送邮箱，请在「交易 → 邮件提醒」里填写并验证',
            }, origin);
            return;
        }

        const result = await notify.sendSignalMail(payload.signal, {
            force: !!payload.force,
            to,
            account: username,
        });

        // 被跳过（没配邮箱、这个买卖点已经提醒过、一小时内发得太密）不算错误：
        // 这是正常状态，返回 200 让浏览器别再重试。只有真正发信失败才给 502。
        if (result.ok || result.skipped) {
            send(res, 200, result, origin);
        } else {
            send(res, 502, result, origin);
        }
        if (result.ok) {
            console.log(`[提醒] 已发送 ${result.subject} → ${result.to}（${result.elapsedMs}ms）`);
        } else if (!result.skipped) {
            console.error('[提醒] 发送失败:', result.error);
        }
        return;
    }

    // ---- 推送邮箱设置（按账号隔离，必须本人验证）----
    //
    // 「这台机器的 SMTP 该往哪个邮箱发信」这个问题的答案，不能由服务端猜、
    // 也不能由别人代填 —— 只能由账号本人填一个能收到信的地址，并证明那是他自己的。
    // 所以是两个动作：先请服务端往该地址发一个 6 位码，再把码填回来。
    if (url.pathname === '/api/notify/email') {
        const store = readStore();
        const username = requireUser(req, store);
        if (!username) { send(res, 401, { error: '请先登录' }, origin); return; }

        if (req.method === 'GET') {
            const cfgState = notify.loadConfig();
            const mine = mailStateOf(store, username);
            send(res, 200, Object.assign({
                ok: true,
                // 发信服务器没配好时验证码根本发不出去。先说清楚，
                // 免得用户在界面上反复点「发送验证码」，却不知道为什么收不到。
                smtpReady: cfgState.configured,
                smtpReason: cfgState.configured ? null : cfgState.reason,
                ttlMinutes: Math.round(MAIL_CODE_TTL_MS / 60000),
                maxPerHour: MAIL_CODE_MAX_PER_HOUR,
            }, mine), origin);
            return;
        }

        if (req.method === 'DELETE') {
            const rec = mailRecord(store, username);
            if (rec) {
                delete rec.email;
                delete rec.verifiedAt;
                delete rec.pending;
                if (!Object.keys(rec).length) delete store.mail[username];
                try {
                    writeStore(store);
                } catch (e) {
                    send(res, 500, { error: '保存失败：' + e.message }, origin);
                    return;
                }
            }
            send(res, 200, { ok: true, email: null, verified: false, pending: null }, origin);
            console.log(`[提醒] ${username} 已解除推送邮箱绑定`);
            return;
        }

        if (req.method !== 'POST') {
            send(res, 405, { error: '只支持 GET / POST / DELETE' }, origin);
            return;
        }

        let payload;
        try {
            payload = JSON.parse(await readBody(req));
        } catch (e) {
            send(res, 400, { error: '请求体不是合法 JSON' }, origin);
            return;
        }

        const email = String((payload && payload.email) || '').trim();
        // 格式必须在这里挡住：这个地址会直接拼进 To 头与 RCPT TO，
        // 一个带换行的「邮箱」就是一次邮件头注入。
        if (!notify.isEmailAddress(email)) {
            send(res, 400, { error: '邮箱格式不对，请填写完整地址（例如 you@example.com）' }, origin);
            return;
        }

        const cfgState = notify.loadConfig();
        if (!cfgState.configured) {
            send(res, 503, {
                error: '服务端还没配置发信邮箱，验证码发不出去：' + cfgState.reason,
                hint: cfgState.hint || null,
            }, origin);
            return;
        }

        const now = Date.now();
        const rec = mailRecord(store, username) || (store.mail[username] = {});
        const p = rec.pending;

        if (p && typeof p.sentAt === 'number' && now - p.sentAt < MAIL_CODE_COOLDOWN_MS) {
            const wait = Math.ceil((MAIL_CODE_COOLDOWN_MS - (now - p.sentAt)) / 1000);
            send(res, 429, { error: `验证码刚发过，请 ${wait} 秒后再试`, retryAfterSec: wait }, origin);
            return;
        }
        const win = codesSentInWindow(rec, now);
        if (win.count >= MAIL_CODE_MAX_PER_HOUR) {
            send(res, 429, { error: `一个账号一小时内最多获取 ${MAIL_CODE_MAX_PER_HOUR} 次验证码，请稍后再试` }, origin);
            return;
        }
        if (codesSentTotal(store, now) >= MAIL_CODE_MAX_PER_HOUR_ALL) {
            send(res, 429, { error: `本服务一小时内发出的验证码已达上限（${MAIL_CODE_MAX_PER_HOUR_ALL} 封），请稍后再试` }, origin);
            return;
        }
        if (mailCodeInFlight.has(username)) {
            send(res, 429, { error: '上一封验证码还在发送中，请稍候再试' }, origin);
            return;
        }

        const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
        mailCodeInFlight.add(username);
        let sent;
        try {
            sent = await notify.sendVerificationMail({
                to: email,
                code,
                account: username,
                ttlMinutes: Math.round(MAIL_CODE_TTL_MS / 60000),
            });
        } catch (e) {
            sent = { ok: false, error: e.message };
        } finally {
            mailCodeInFlight.delete(username);
        }

        if (!sent.ok) {
            // 发信失败就什么都不记。若是先落了盘再发现发不出去，用户既等不到码，
            // 还会被 60 秒冷却挡在门外 —— 而真正的原因（SMTP 不通）根本不在他视野里。
            console.error('[提醒] 验证码发送失败:', sent.error);
            send(res, 502, { error: '验证码发送失败：' + sent.error }, origin);
            return;
        }

        rec.pending = {
            email,
            codeHash: codeHashOf(username, code),
            expiresAt: now + MAIL_CODE_TTL_MS,
            attempts: 0,
            sentAt: now,
            sentCount: win.count + 1,
            windowStart: win.windowStart,
        };
        try {
            writeStore(store);
        } catch (e) {
            // 码已经发出去了，但服务端没记住它 —— 用户手上是一个没人认的码。
            // 不谎报成功，让他重新获取。
            delete rec.pending;
            send(res, 500, { error: '验证码已发出，但服务端未能保存，请重新获取' }, origin);
            return;
        }

        send(res, 200, {
            ok: true,
            email,
            expiresInSec: Math.round(MAIL_CODE_TTL_MS / 1000),
            resendAfterSec: Math.round(MAIL_CODE_COOLDOWN_MS / 1000),
            messageId: sent.messageId || null,
        }, origin);
        console.log(`[提醒] 已向 ${maskAddress(email)} 发出验证码（账号 ${username}）`);
        return;
    }

    if (url.pathname === '/api/notify/email/confirm') {
        if (req.method !== 'POST') { send(res, 405, { error: '只支持 POST' }, origin); return; }

        const store = readStore();
        const username = requireUser(req, store);
        if (!username) { send(res, 401, { error: '请先登录' }, origin); return; }

        let payload;
        try {
            payload = JSON.parse(await readBody(req));
        } catch (e) {
            send(res, 400, { error: '请求体不是合法 JSON' }, origin);
            return;
        }

        const code = String((payload && payload.code) || '').trim();
        if (!/^\d{6}$/.test(code)) { send(res, 400, { error: '验证码是 6 位数字' }, origin); return; }

        const rec = mailRecord(store, username);
        const p = rec && rec.pending;
        if (!p) {
            send(res, 400, { error: '没有待验证的邮箱：请先填写地址并获取验证码' }, origin);
            return;
        }

        // 码一旦作废就必须落盘：只从内存里删掉的话，重启后它又"活"了，
        // 用户明明看到「已作废」，却还能拿它验证成功。
        const invalidate = () => {
            delete rec.pending;
            try {
                writeStore(store);
            } catch (e) {
                console.warn('[提醒] 作废验证码未能落盘:', e.message);
            }
        };

        if (Date.now() > p.expiresAt) {
            invalidate();
            send(res, 400, { error: '验证码已过期，请重新获取' }, origin);
            return;
        }
        if ((p.attempts || 0) >= MAIL_CODE_MAX_ATTEMPTS) {
            invalidate();
            send(res, 429, { error: '验证码试错次数过多，请重新获取' }, origin);
            return;
        }
        if (!sameSecret(codeHashOf(username, code), p.codeHash)) {
            p.attempts = (p.attempts || 0) + 1;
            const left = MAIL_CODE_MAX_ATTEMPTS - p.attempts;
            if (left <= 0) {
                invalidate();
                send(res, 429, { error: '验证码错误次数过多，已作废，请重新获取' }, origin);
                return;
            }
            try {
                writeStore(store);
            } catch (e) {
                // 次数没记住不该让这次请求失败：失败的是「少记一次」，不影响正确性方向
                console.warn('[提醒] 验证码试错次数未能落盘:', e.message);
            }
            send(res, 400, { error: `验证码不对，还可以试 ${left} 次` }, origin);
            return;
        }

        const email = p.email;
        const verifiedAt = new Date().toISOString();
        rec.email = email;
        rec.verifiedAt = verifiedAt;
        delete rec.pending;
        try {
            writeStore(store);
        } catch (e) {
            send(res, 500, { error: '保存失败：' + e.message }, origin);
            return;
        }

        send(res, 200, { ok: true, email, verified: true, verifiedAt }, origin);
        console.log(`[提醒] ${username} 的推送邮箱已验证：${maskAddress(email)}`);
        return;
    }

    send(res, 404, { error: '未知路径：' + url.pathname }, origin);
});

server.listen(PORT, HOST, () => {
    console.log('─'.repeat(58));
    console.log('模拟盘持久化服务已启动');
    console.log(`  监听    http://${HOST}:${PORT}`);
    console.log(`  数据文件 ${STORE_FILE}`);
    console.log(`  接口    GET/PUT /api/paper/state?account=<id>`);
    console.log('          推送邮箱：GET / POST / DELETE /api/notify/email、POST /api/notify/email/confirm');
    console.log(`  安全    ${LAN_MODE ? '局域网模式：已绑定外部网卡，登录后按用户隔离；请勿直接暴露公网' : '仅监听本机'}；公网部署前仍需 HTTPS、限流与更强验证`);
    console.log('─'.repeat(58));
});

module.exports = server;
