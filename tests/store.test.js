'use strict';
// 整体包在 async IIFE 里，以便使用顶层 await（文件仍是 CommonJS）
(async () => {

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/**
 * 模拟盘持久化服务 —— 单元测试
 *
 * 运行：node tests/store.test.js
 *
 * 重点守的是「会话持久化」这件刚改过的事：
 *   重启服务后是否仍保持登录、落盘的是不是令牌摘要而不是令牌本身、
 * 登出与过期是否真的失效、旧的 v2 文件能不能平滑升级。
 *
 * 这些都是「看着能用、出事才知道」的行为 —— 比如摘要写成明文，
 * 功能测试全绿，但数据文件泄露就等于所有会话被接管，所以必须断言到位。
 */

const MOD = path.join(__dirname, '..', 'server', 'store.js');

// 用临时目录和「端口 0」（由系统分配空闲端口）——
// 避免踩到正在运行的 8788，也避免多次测试之间抢端口。
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-store-'));
const FILE = path.join(TMP_DIR, 'paper-state.json');
process.env.PORT = '0';
process.env.STORE_FILE = FILE;

let BASE = '';

// ---------- 极简测试框架 ----------
let passed = 0, failed = 0;
const failures = [];

function ok(cond, name, extra) {
    if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
    else {
        failed++;
        failures.push(name + (extra ? ' — ' + extra : ''));
        console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  → ' + extra : ''));
    }
}
function eq(actual, expected, name) {
    ok(actual === expected, name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

// ---------- 启动 / 重启被测服务 ----------
let current = null;

/**
 * 加载（或重新加载）服务模块。
 *
 * 每次都清掉 require 缓存，于是拿到的是一个全新的模块实例 ——
 * 进程内存里不会留下任何来自上一次的会话状态，这正是「重启」的等价物。
 */
function loadServer() {
    delete require.cache[require.resolve(MOD)];
    const origLog = console.log;
    // 屏蔽服务启动横幅。注意这里必须 await 到底再恢复：
    // 横幅是在 listen 回调里打的，若在同步段就恢复，等于没屏掉。
    console.log = () => {};
    return (async () => {
        try {
            const server = require(MOD);
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                if (server.listening) { resolve(); return; }
                server.once('listening', resolve);
            });
            // 端口 0 由系统分配，重启后可能变化，所以每次都重新取
            BASE = `http://127.0.0.1:${server.address().port}`;
            current = server;
            return server;
        } finally {
            console.log = origLog;
        }
    })();
}

async function restart() {
    if (current) await new Promise(r => current.close(r));
    // require 缓存已清，重新加载即得到一份干净的进程内状态
    return loadServer();
}

async function req(method, p, { token, body } = {}) {
    const headers = { Origin: 'http://localhost:8080' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(BASE + p, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* 可能没有响应体 */ }
    return { status: res.status, data };
}

function readFile() {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// ============================================================
try {

await loadServer();

section('基本登录');
{
    const health = await req('GET', '/api/paper/health');
    eq(health.status, 200, '健康检查 200');

    const reg = await req('POST', '/api/auth/register', { body: { username: 'persist_a', password: 'probe12345' } });
    eq(reg.status, 201, '注册返回 201');
    ok(!!(reg.data && reg.data.token), '返回了令牌');

    const me = await req('GET', '/api/auth/me', { token: reg.data.token });
    eq(me.status, 200, '带令牌可读到自己');
}

let tokenA = (await req('POST', '/api/auth/login', { body: { username: 'persist_a', password: 'probe12345' } })).data.token;

section('重启服务后仍保持登录（本次改动的核心）');
{
    await restart();
    const me = await req('GET', '/api/auth/me', { token: tokenA });
    eq(me.status, 200, '重启后同一令牌仍然有效');
    eq(me.data && me.data.user && me.data.user.username, 'persist_a', '且解析回正确的用户名');

    const st = await req('GET', '/api/paper/state', { token: tokenA });
    eq(st.status, 200, '重启后仍能读模拟盘');
}

section('落盘的是令牌摘要，不是令牌本身');
{
    const raw = fs.readFileSync(FILE, 'utf8');
    ok(!raw.includes(tokenA), '文件里搜不到令牌原文');
    const parsed = readFile();
    ok(!!parsed.sessions[sha256(tokenA)], '文件里存的是该令牌的 SHA-256');
    ok(!parsed.sessions[tokenA], '键不是令牌明文');
    const rec = parsed.sessions[sha256(tokenA)];
    eq(rec.username, 'persist_a', '会话记录了归属用户名');
    ok(typeof rec.expiresAt === 'number' && rec.expiresAt > Date.now(), '会话带未来有效期');
}

section('登出后失效，且重启后不会「复活」');
{
    const out = await req('POST', '/api/auth/logout', { token: tokenA });
    eq(out.status, 200, '登出返回 200');
    eq((await req('GET', '/api/auth/me', { token: tokenA })).status, 401, '登出后立即失效');

    await restart();
    eq((await req('GET', '/api/auth/me', { token: tokenA })).status, 401, '重启后仍失效（会话已从文件删除）');
}

section('无效令牌一律被拒');
{
    eq((await req('GET', '/api/auth/me', { token: 'deadbeef'.repeat(8) })).status, 401, '伪造令牌 401');
    eq((await req('GET', '/api/auth/me')).status, 401, '不带令牌 401');
    eq((await req('GET', '/api/paper/state', { token: 'deadbeef'.repeat(8) })).status, 401, '伪造令牌读模拟盘 401');
}

section('过期会话被拒');
{
    tokenA = (await req('POST', '/api/auth/login', { body: { username: 'persist_a', password: 'probe12345' } })).data.token;
    const parsed = readFile();
    parsed.sessions[sha256(tokenA)].expiresAt = Date.now() - 1000;   // 改成已过期
    fs.writeFileSync(FILE, JSON.stringify(parsed, null, 2));

    await restart();
    eq((await req('GET', '/api/auth/me', { token: tokenA })).status, 401, '过期令牌被拒');
}

section('旧的 v2 文件（无 sessions 字段）可平滑升级');
{
    if (current) await new Promise(r => current.close(r));
    // 模拟升级前的文件：schemaVersion 为 2，没有 sessions，但有既有模拟盘数据
    fs.writeFileSync(FILE, JSON.stringify({
        schemaVersion: 2,
        users: {},
        accounts: { legacy_user: { savedAt: '2026-01-01T00:00:00.000Z', rev: 3, data: { totalCapital: 12345 } } },
    }, null, 2));

    await loadServer();

    const reg = await req('POST', '/api/auth/register', { body: { username: 'legacy_user', password: 'probe12345' } });
    eq(reg.status, 201, '可在升级后的文件上注册');

    const st = await req('GET', '/api/paper/state', { token: reg.data.token });
    eq(st.status, 200, '能读到既有账户');
    eq(st.data && st.data.rev, 3, '既有模拟盘数据未被丢失');
    eq(st.data && st.data.data && st.data.data.totalCapital, 12345, '既有数据内容完整');

    const parsed = readFile();
    eq(parsed.schemaVersion, 3, '文件已升级到 schemaVersion 3');
    ok(parsed.sessions && typeof parsed.sessions === 'object', '已补上 sessions 字段');
    ok(!!parsed.sessions[sha256(reg.data.token)], '新注册的会话已落盘');
}

section('会话按用户隔离');
{
    const other = (await req('POST', '/api/auth/register', { body: { username: 'persist_b', password: 'probe12345' } })).data.token;
    const st = await req('GET', '/api/paper/state', { token: other });
    eq(st.status, 200, '另一个用户可正常访问');
    eq(st.data.empty, true, '看不到 legacy_user 的账本');
}

} catch (e) {
    failed++;
    failures.push('测试执行异常: ' + e.message);
    console.log('  \x1b[31m✗\x1b[0m 测试执行异常: ' + e.message + '\n' + (e.stack || ''));
} finally {
    if (current) await new Promise(r => current.close(r));
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) { /* 临时目录清不掉不影响结论 */ }
}

// ============================================================
console.log('\n' + '─'.repeat(56));
console.log(`通过 ${passed}　失败 ${failed}`);
if (failed) {
    console.log('\n失败项：');
    failures.forEach(f => console.log('  · ' + f));
    process.exit(1);
} else {
    console.log('全部通过');
}

})();
