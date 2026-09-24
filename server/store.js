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

const SCHEMA_VERSION = 4;

// 会话有效期。到期后客户端会收到 401，界面提示重新登录。
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

// ---------- 存储 ----------

function emptyStore() {
    return { schemaVersion: SCHEMA_VERSION, users: {}, accounts: {}, sessions: {}, predictions: {} };
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
        'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
        // Authorization 不是 CORS 安全列表头，带上它会触发预检；
        // 预检响应里不列出它，浏览器就会直接拦掉后续的真实请求。
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '600',
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

    send(res, 404, { error: '未知路径：' + url.pathname }, origin);
});

server.listen(PORT, HOST, () => {
    console.log('─'.repeat(58));
    console.log('模拟盘持久化服务已启动');
    console.log(`  监听    http://${HOST}:${PORT}`);
    console.log(`  数据文件 ${STORE_FILE}`);
    console.log(`  接口    GET/PUT /api/paper/state?account=<id>`);
    console.log(`  安全    ${LAN_MODE ? '局域网模式：已绑定外部网卡，登录后按用户隔离；请勿直接暴露公网' : '仅监听本机'}；公网部署前仍需 HTTPS、限流与更强验证`);
    console.log('─'.repeat(58));
});

module.exports = server;
