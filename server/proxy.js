#!/usr/bin/env node
'use strict';
/**
 * 币安签名代理（本地运行）
 *
 * 为什么需要它：
 *   1. 币安未对鉴权请求开放 CORS。实测 /api/v3/time 直连返回 200，
 *      但带上 X-MBX-APIKEY 请求头后，浏览器在预检阶段就被拦掉。
 *      → 纯前端根本发不出下单请求，这是技术硬约束，不是配置问题。
 *   2. 密钥不该进浏览器。放在浏览器里等于把交易能力暴露给页面脚本、
 *      浏览器扩展和共用设备；OWASP 明确不建议在客户端存储敏感信息。
 *   本代理把密钥留在本机进程，浏览器只知道一个地址。
 *
 * 安全设计（逐条对应一个风险）：
 *   - 默认只允许测试网域名；指向实盘必须显式设置 ALLOW_LIVE=1，否则拒绝启动
 *   - 端点白名单：只允许账户查询与下单撤单相关路径。
 *     代理绝不能被当成通用签名机 —— 否则一旦被调用，
 *     等于把「代签任意请求」的能力交出去，这是最危险的一种代理实现。
 *   - 单笔名义金额上限、每分钟下单上限，服务端强制，不依赖前端自觉
 *   - 只允许 localhost 来源的跨域请求，避免被局域网内其它机器调用
 *   - 密钥只从环境变量读取，不落盘、不打印、不进日志
 *
 * 启动：
 *   BINANCE_KEY=xxx BINANCE_SECRET=yyy node server/proxy.js
 * 可选环境变量：
 *   PORT=8787              监听端口
 *   ALLOW_LIVE=1           允许指向实盘（默认关闭，请务必理解风险后再开）
 *   MAX_NOTIONAL=200       单笔名义金额上限（USDT）
 *   MAX_ORDERS_PER_MIN=10  每分钟下单上限
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const { URL } = require('url');

// TLS 信任库：
// 币安测试网返回的证书链不完整，curl 会自动做 AIA 补链，Node 不会，
// 因此 Node 默认报 "unable to get local issuer certificate"。
// 这里改用操作系统自带的 CA 包（仍是完整证书校验，只是换信任库），
// 并支持用 CA_FILE 自定义。绝不使用 NODE_TLS_REJECT_UNAUTHORIZED 这类开关。
const CA_FILE = process.env.CA_FILE || '/etc/ssl/cert.pem';
let TLS_OPTS = {};
try {
    if (fs.existsSync(CA_FILE)) TLS_OPTS = { ca: fs.readFileSync(CA_FILE) };
} catch (e) {
    console.warn('读取系统 CA 失败，将使用 Node 内置信任库：' + e.message);
}

const PORT = parseInt(process.env.PORT || '8787', 10);
const KEY = process.env.BINANCE_KEY || '';
const SECRET = process.env.BINANCE_SECRET || '';
const ALLOW_LIVE = process.env.ALLOW_LIVE === '1';
const MAX_NOTIONAL = parseFloat(process.env.MAX_NOTIONAL || '200');
const MAX_ORDERS_PER_MIN = parseInt(process.env.MAX_ORDERS_PER_MIN || '10', 10);
const RECV_WINDOW = 5000;

// 默认测试网；实盘必须显式开启
const LIVE_HOST = 'api.binance.com';
const TESTNET_HOST = 'testnet.binance.vision';
const BINANCE_HOST = ALLOW_LIVE ? LIVE_HOST : TESTNET_HOST;

// ---------- 端点白名单 ----------
// 只有在这张表里的路径才允许通过。签名能力必须被限制在最小范围，
// 尤其不能出现 /sapi/* 这类资金划转、提现端点。
const ROUTES = {
    'GET /api/v3/time': { signed: false },
    'GET /api/v3/ping': { signed: false },
    'GET /api/v3/exchangeInfo': { signed: false },
    'GET /api/v3/ticker/price': { signed: false },
    'GET /api/v3/account': { signed: true },
    'GET /api/v3/openOrders': { signed: true },
    'GET /api/v3/allOrders': { signed: true },
    'GET /api/v3/order': { signed: true },
    'POST /api/v3/order': { signed: true, trading: true },
    'DELETE /api/v3/order': { signed: true, trading: true },
    'DELETE /api/v3/openOrders': { signed: true, trading: true },
};

// ---------- 限速 ----------
let orderTimes = [];

function rateLimitOk() {
    const now = Date.now();
    orderTimes = orderTimes.filter(t => now - t < 60000);
    if (orderTimes.length >= MAX_ORDERS_PER_MIN) return false;
    orderTimes.push(now);
    return true;
}

// ---------- 工具 ----------

function encodeParams(params) {
    return Object.keys(params)
        .filter(k => params[k] !== undefined && params[k] !== null && params[k] !== '')
        .map(k => `${k}=${encodeURIComponent(params[k])}`)
        .join('&');
}

function sign(query) {
    // 币安要求：先百分号编码再拼接，签名作为最后一个参数
    return crypto.createHmac('sha256', SECRET).update(query).digest('hex');
}

function isLocalOrigin(origin) {
    if (!origin) return false;
    try {
        const u = new URL(origin);
        return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    } catch (e) { return false; }
}

function corsHeaders(origin) {
    // 只回显本机来源；其它来源不给 CORS 头，浏览器自然会拦
    if (!isLocalOrigin(origin)) return {};
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
    };
}

function send(res, status, body, origin) {
    const headers = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders(origin));
    res.writeHead(status, headers);
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function forward(method, path, query) {
    return new Promise((resolve, reject) => {
        const req = https.request(Object.assign({
            host: BINANCE_HOST,
            path: query ? `${path}?${query}` : path,
            method,
            headers: { 'X-MBX-APIKEY': KEY },
            timeout: 15000,
        }, TLS_OPTS), r => {
            let data = '';
            r.on('data', c => { data += c; });
            r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: data }));
        });
        req.on('timeout', () => { req.destroy(new Error('请求币安超时')); });
        req.on('error', reject);
        req.end();
    });
}

// ---------- 服务 ----------

const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || '';

    // 预检
    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(origin));
        res.end();
        return;
    }

    // 只接受本机来源，防止被局域网其它机器当代理用
    if (origin && !isLocalOrigin(origin)) {
        send(res, 403, { msg: '拒绝：只允许本机来源调用' }, origin);
        return;
    }

    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const path = u.pathname;
    const params = {};
    u.searchParams.forEach((v, k) => { params[k] = v; });

    // 健康检查：供前端判断代理是否就绪（不暴露密钥本身）
    if (path === '/health') {
        send(res, 200, {
            ok: true,
            hasKeys: !!(KEY && SECRET),
            tradeEnabled: !!(KEY && SECRET),
            host: BINANCE_HOST,
            testnet: BINANCE_HOST === TESTNET_HOST,
            maxNotional: MAX_NOTIONAL,
        }, origin);
        return;
    }

    const routeKey = `${req.method} ${path}`;
    const route = ROUTES[routeKey];

    if (!route) {
        // 白名单之外一律拒绝。这条是安全底线：
        // 绝不能让代理变成「代签任意请求」的通用签名机。
        send(res, 403, {
            msg: `拒绝：${routeKey} 不在白名单内。代理只允许账户查询与下单撤单相关端点。`,
        }, origin);
        return;
    }

    if (!route.signed) {
        try {
            const r = await forward(req.method, path, encodeParams(params));
            const headers = corsHeaders(origin);
            headers['Content-Type'] = 'application/json; charset=utf-8';
            res.writeHead(r.status, headers);
            res.end(r.body);
        } catch (e) {
            send(res, 502, { msg: '转发失败：' + e.message }, origin);
        }
        return;
    }

    if (!KEY || !SECRET) {
        send(res, 401, { msg: '代理未配置密钥，请用 BINANCE_KEY / BINANCE_SECRET 环境变量启动' }, origin);
        return;
    }

    // 下单类请求：服务端强制限额，不依赖前端
    if (route.trading) {
        const qty = parseFloat(params.quantity || '0');
        const price = parseFloat(params.price || '0');
        const notional = qty * price;
        if (routeKey === 'POST /api/v3/order' && price > 0 && notional > MAX_NOTIONAL) {
            send(res, 400, { msg: `代理拦截：单笔名义金额 ${notional.toFixed(2)} 超过上限 ${MAX_NOTIONAL}` }, origin);
            return;
        }
        if (!rateLimitOk()) {
            send(res, 429, { msg: `代理限速：每分钟最多 ${MAX_ORDERS_PER_MIN} 笔下单` }, origin);
            return;
        }
    }

    // 签名
    const signed = Object.assign({}, params, {
        timestamp: Date.now(),
        recvWindow: RECV_WINDOW,
    });
    const query = encodeParams(signed) + '&signature=' + sign(encodeParams(signed));

    try {
        const r = await forward(req.method, path, query);
        const headers = corsHeaders(origin);
        headers['Content-Type'] = 'application/json; charset=utf-8';
        res.writeHead(r.status, headers);
        res.end(r.body);
        // 只记录端点与状态，绝不记录参数（参数里可能含敏感信息）
        console.log(`[代理] ${routeKey} → ${r.status}`);
    } catch (e) {
        send(res, 502, { msg: '转发失败：' + e.message }, origin);
    }
});

// ---------- 启动自检 ----------
if (!ALLOW_LIVE && BINANCE_HOST !== TESTNET_HOST) {
    console.error('拒绝启动：非测试网地址。如确需实盘请设置 ALLOW_LIVE=1 并自行承担风险。');
    process.exit(1);
}

server.listen(PORT, '127.0.0.1', () => {
    console.log('─'.repeat(58));
    console.log('币安签名代理已启动');
    console.log(`  监听        http://127.0.0.1:${PORT}`);
    console.log(`  目标        ${BINANCE_HOST}  ${BINANCE_HOST === TESTNET_HOST ? '（测试网，虚拟资金）' : '⚠ 实盘'}`);
    console.log(`  密钥        ${KEY && SECRET ? '已配置（仅存于本进程内存）' : '未配置 —— 下单会返回 401'}`);
    console.log(`  单笔上限    ${MAX_NOTIONAL} USDT`);
    console.log(`  下单限速    ${MAX_ORDERS_PER_MIN} 笔/分钟`);
    console.log(`  端点白名单  ${Object.keys(ROUTES).length} 条（不含任何提现/划转端点）`);
    console.log('─'.repeat(58));
    if (!KEY || !SECRET) {
        console.log('提示：请用 BINANCE_KEY=xxx BINANCE_SECRET=yyy node server/proxy.js 启动');
    }
});

module.exports = server;
