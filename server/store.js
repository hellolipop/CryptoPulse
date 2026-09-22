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
 * 存在哪：
 *   server/data/paper-state.json（已在 .gitignore 中）。
 *   写入采用「临时文件 + rename」保证原子性，并保留一份上一版备份，
 *   避免写到一半断电/被杀进程导致整个文件损坏。
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
 *   - 用户密码只保存 scrypt 哈希，不保存明文；会话令牌暂存在进程内存，重启服务后需要重新登录。
 *   - 当前服务仍只监听 127.0.0.1。若将来放到公网，必须补 HTTPS、持久化会话、限流和更强的登录验证。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '8788', 10);
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = process.env.STORE_FILE || path.join(DATA_DIR, 'paper-state.json');
const BACKUP_FILE = STORE_FILE + '.bak';
const TMP_FILE = STORE_FILE + '.tmp';

// 请求体上限。模拟盘状态里成交记录是有上限的（每账户 200 笔），
// 正常不会超过几百 KB；给到 2MB 是留余量，同时挡住异常大的写入。
const MAX_BODY = 2 * 1024 * 1024;

const SCHEMA_VERSION = 2;
const sessions = new Map();

// ---------- 存储 ----------

function emptyStore() {
    return { schemaVersion: SCHEMA_VERSION, users: {}, accounts: {} };
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
                if (!parsed.schemaVersion) parsed.schemaVersion = SCHEMA_VERSION;
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

function requireUser(req, store) {
    const token = bearer(req);
    const username = sessions.get(token);
    return username && store.users[username] ? username : null;
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

// ---------- HTTP 工具（与 proxy.js 保持一致的做法） ----------

function isLocalOrigin(origin) {
    if (!origin) return false;
    try {
        const u = new URL(origin);
        return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    } catch (e) { return false; }
}

function corsHeaders(origin) {
    if (!isLocalOrigin(origin)) return {};
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
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
        try { writeStore(store); } catch (e) { send(res, 500, { error: '用户数据保存失败' }, origin); return; }
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, username);
        send(res, route.endsWith('/register') ? 201 : 200, { ok: true, token, user: { username } }, origin);
        return;
    }

    if (route === 'POST /api/auth/logout') {
        sessions.delete(bearer(req));
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
        }, origin);
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

server.listen(PORT, '127.0.0.1', () => {
    console.log('─'.repeat(58));
    console.log('模拟盘持久化服务已启动');
    console.log(`  监听    http://127.0.0.1:${PORT}`);
    console.log(`  数据文件 ${STORE_FILE}`);
    console.log(`  接口    GET/PUT /api/paper/state?account=<id>`);
    console.log('  安全    仅监听本机、登录后按用户隔离；公网部署前仍需 HTTPS、限流与更强验证');
    console.log('─'.repeat(58));
});

module.exports = server;
