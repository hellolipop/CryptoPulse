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
 * 以及后来加的预测记录持久化：按 id 合并、只增不删（否则客户端本地裁剪
 * 会把后端的历史样本删掉），以及 CSV 表格能否正确生成 ——
 * 表格是拿来分析「因子要不要调」的，未复盘的记录必须留空而不是写成「错误」，
 * 否则准确率会被系统性算低。
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
// 邮件相关的文件同样指到临时目录：否则测一次就会拿真实授权码去发信，
// 并把测试记录写进真实的分析日志里
process.env.MAIL_CONFIG_FILE = path.join(TMP_DIR, 'mail-config.json');
process.env.MAIL_LOG_FILE = path.join(TMP_DIR, 'notify-log.json');

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
function contains(hay, needle, name) {
    ok(String(hay).indexOf(needle) >= 0, name, `没找到 ${JSON.stringify(needle)}`);
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
    eq(parsed.schemaVersion, 5, '文件已升级到 schemaVersion 5');
    ok(parsed.sessions && typeof parsed.sessions === 'object', '已补上 sessions 字段');
    ok(!!parsed.sessions[sha256(reg.data.token)], '新注册的会话已落盘');
    ok(parsed.predictions && typeof parsed.predictions === 'object', '已补上 predictions 字段');
    ok(parsed.mail && typeof parsed.mail === 'object', '已补上 mail 字段（推送邮箱）');
}

section('会话按用户隔离');
{
    const other = (await req('POST', '/api/auth/register', { body: { username: 'persist_b', password: 'probe12345' } })).data.token;
    const st = await req('GET', '/api/paper/state', { token: other });
    eq(st.status, 200, '另一个用户可正常访问');
    eq(st.data.empty, true, '看不到 legacy_user 的账本');
}

section('预测记录：按 id 合并、只增不删');
{
    const token = (await req('POST', '/api/auth/register', { body: { username: 'pred_a', password: 'probe12345' } })).data.token;

    const rec = (id, extra) => Object.assign({
        id,
        coinId: 'ethereum',
        coinSymbol: 'ETH',
        timeframe: 240,
        signalType: 'buy',
        signalText: '买入',
        score: 62,
        price: 3000,
        predictedAt: 1790000000000,
        resolveAt: 1790000000000 + 1200000,
        algoVersion: '1.0.0',
        factors: {
            breakdown: { technical: 65, volume: 58, news: null, sentiment: 50, derivatives: null },
            weights: { technical: 40, volume: 20, sentiment: 16, news: 0, derivatives: 0 },
            indicators: { rsi: 55.2, macd: { macd: 1.2, signal: 0.8, histogram: 0.4 }, kdj: { k: 60, d: 55, j: 70 } },
            sensitivity: 'balanced',
        },
        criteria: { directionThreshold: 0.003, holdThreshold: 0.02, horizonMs: 1200000 },
        evalPrice: null,
        changePct: null,
        correct: null,
    }, extra || {});

    const first = await req('POST', '/api/predictions', {
        token,
        body: { records: [rec('rec-1'), rec('rec-2', { predictedAt: 1790000100000 })] },
    });
    eq(first.status, 200, '首次推送返回 200');
    eq(first.data.added, 2, '新增 2 条');
    eq(first.data.updated, 0, '本次没有更新');
    eq(first.data.total, 2, '后端共 2 条');

    const second = await req('POST', '/api/predictions', {
        token,
        body: { records: [rec('rec-1', { evalPrice: 3060, changePct: 0.02, correct: true })] },
    });
    eq(second.data.added, 0, '同 id 不新增');
    eq(second.data.updated, 1, '同 id 记作更新');
    eq(second.data.total, 2, '总数不变');

    const list = await req('GET', '/api/predictions', { token });
    eq(list.data.total, 2, '能取回 2 条');
    const one = list.data.records.find(r => r.id === 'rec-1');
    eq(one.correct, true, '复盘结果已落库');
    eq(one.algoVersion, '1.0.0', '算法版本已落库');
    eq(one.factors.indicators.rsi, 55.2, '因子快照已落库');

    const third = await req('POST', '/api/predictions', {
        token,
        body: { records: [rec('rec-3', { predictedAt: 1790000200000 })] },
    });
    eq(third.data.total, 3, '载荷未包含的旧记录被保留（只增不删）');

    const empty = await req('POST', '/api/predictions', { token, body: { records: [] } });
    eq(empty.data.total, 3, '推送空列表不会清空后端');

    eq((await req('GET', '/api/predictions')).status, 401, '未登录取记录被拒');
    eq((await req('POST', '/api/predictions', { body: { records: [] } })).status, 401, '未登录推送被拒');
}

section('预测记录：CSV 表格');
{
    const token = (await req('POST', '/api/auth/login', { body: { username: 'pred_a', password: 'probe12345' } })).data.token;
    const res = await fetch(BASE + '/api/predictions.csv', {
        headers: { Origin: 'http://localhost:8080', Authorization: `Bearer ${token}` },
    });
    eq(res.status, 200, '下载表格返回 200');
    ok(String(res.headers.get('content-type')).includes('text/csv'), '响应类型为 CSV');

    // 用 arrayBuffer 而不是 text()：按 Fetch 规范，Response.text() 会去掉开头的
    // BOM，用文本判断永远测不到它。BOM 是 Excel 正确识别中文表头的前提，
    // 所以必须按原始字节断言。
    const buf = Buffer.from(await res.arrayBuffer());
    ok(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF, '带 BOM（Excel 打开中文表头不乱码）');

    const text = buf.toString('utf8').replace(/^\uFEFF/, '');
    const lines = text.split('\r\n').filter(Boolean);
    eq(lines.length, 4, '表头 1 行 + 数据 3 行');
    ok(lines[0].includes('算法版本'), '表头含算法版本列');
    ok(lines[0].includes('RSI'), '表头含 RSI 列');
    ok(lines[0].includes('技术_rsi'), '表头含技术面子因子列');
    ok(lines.some(l => l.includes('"正确"')), '已复盘的记录标为「正确」');

    // 未复盘的「是否正确」必须是空单元格。写成 false/错误 会被当成判错，
    // 让准确率被系统性算低 —— 这正是这张表最容易出错、也最需要守住的地方。
    const unresolved = lines.find(l => l.includes('rec-2'));
    ok(!!unresolved && unresolved.includes(',"",'), '未复盘的「是否正确」为空而非判错');

    await restart();
    const again = await fetch(BASE + '/api/predictions.csv', {
        headers: { Origin: 'http://localhost:8080', Authorization: `Bearer ${token}` },
    });
    eq(again.status, 200, '重启后仍能下载（记录已落盘，不是内存态）');
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
section('推送邮箱：按账号隔离，必须本人验证');
try {
    // 前面的用例结尾把服务关了（顺带释放端口），这里重新起一个
    await restart();

    // 发信那一环在 notify.test.js 里已经对着假 SMTP 验过了，这里只验**协议**：
    // 谁在什么时候能拿到哪个地址、验证码怎么存、错了会怎样、解绑之后如何。
    // 所以把两个发信函数换成桩，把服务端真正生成的那个码接出来。
    // （store.js 里是 `notify.sendVerificationMail(...)` 这种取属性再调用，
    //   所以替换模块上的属性就能生效，不需要注入。）
    const notifyMod = require('../server/notify');
    const realVerification = notifyMod.sendVerificationMail;
    const realSignal = notifyMod.sendSignalMail;

    let lastCode = null;
    let verifyOpts = null;
    let signalOpts = null;

    notifyMod.sendVerificationMail = async opts => {
        lastCode = opts.code;
        verifyOpts = opts;
        return { ok: true, to: opts.to, messageId: '<mock@cryptopulse.local>' };
    };
    notifyMod.sendSignalMail = async (signal, opts) => {
        signalOpts = opts || {};
        return { ok: true, to: signalOpts.to, subject: 'stub' };
    };

    // 发信账号（host/user/pass）是这台机器一份。这里故意在配置里留一个 to：
    // 它就是「以前那个全局收件地址」，用来证明**它不会再被任何账号用上**。
    // 临时目录在前面的用例收尾时被清掉了，这里补建一次 —— 不补的话
    // 下面这句会以一个跟被测行为毫无关系的 ENOENT 失败。
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.writeFileSync(process.env.MAIL_CONFIG_FILE, JSON.stringify({
        provider: 'qq', user: 'sender@qq.com', pass: 'auth-code',
        to: 'global_fallback@qq.com',
    }));

    const tokenA = (await req('POST', '/api/auth/register', { body: { username: 'mail_a', password: 'probe12345' } })).data.token;
    const tokenB = (await req('POST', '/api/auth/register', { body: { username: 'mail_b', password: 'probe12345' } })).data.token;
    const sig = {
        coinId: 'ethereum', timeframe: 4, signalType: 'buy', signalText: '买入',
        markerTime: 1790337600, source: 'paper-marker', score: 70, price: 2600,
    };

    eq((await req('GET', '/api/notify/email')).status, 401, '未登录读设置 401');
    eq((await req('POST', '/api/notify/email', { body: { email: 'a@b.com' } })).status, 401, '未登录请求验证码 401');
    eq((await req('POST', '/api/notify/email/confirm', { body: { code: '123456' } })).status, 401, '未登录确认验证码 401');
    eq((await req('DELETE', '/api/notify/email')).status, 401, '未登录解绑 401');

    const init = await req('GET', '/api/notify/email', { token: tokenA });
    eq(init.status, 200, '登录后可读自己的设置');
    eq(init.data.email, null, '初始没有推送邮箱');
    eq(init.data.verified, false, '初始未验证');
    eq(init.data.pending, null, '初始没有待验证的地址');
    eq(init.data.smtpReady, true, '并告知服务端发信账号已就绪');

    // --- 坏地址进不来。这个值会拼进 To 头与 RCPT TO，注入必须堵在这里 ---
    eq((await req('POST', '/api/notify/email', { token: tokenA, body: { email: 'not-an-email' } })).status,
        400, '邮箱格式不对返回 400');
    eq((await req('POST', '/api/notify/email', { token: tokenA, body: { email: 'a@b.com\r\nBcc: victim@x.com' } })).status,
        400, '含换行的地址被拒（否则就是邮件头注入）');

    // --- A 请求验证码 ---
    const askA = await req('POST', '/api/notify/email', { token: tokenA, body: { email: 'owner_a@qq.com' } });
    eq(askA.status, 200, 'A 请求验证码成功');
    eq(askA.data.email, 'owner_a@qq.com', '回显发到了哪个地址');
    const codeA = String(lastCode);
    ok(/^\d{6}$/.test(codeA), '码是 6 位数字', codeA);
    eq(verifyOpts && verifyOpts.to, 'owner_a@qq.com', '验证码寄给了用户填的那个地址');
    eq(verifyOpts && verifyOpts.account, 'mail_a', '发信时带上账号，便于排查是谁申请的');

    // 落盘的不该是码本身：数据文件可能被看到，也可能被误提交
    ok(!fs.readFileSync(FILE, 'utf8').includes(codeA), '文件里搜不到验证码明文');
    const recA = readFile().mail.mail_a;
    eq(recA.pending.codeHash, sha256('mail_a|' + codeA), '存下来的是 sha256(用户名|码)');
    eq(recA.pending.attempts, 0, '试错次数从 0 开始');
    eq(recA.email, undefined, '还没验证，所以没有生效的地址');

    // 加了用户名做前缀，是为了让 6 位码（只有 100 万种）不至于被穷举对撞
    eq(readFile().mail.mail_a.pending.codeHash === sha256(codeA), false,
        '摘要不是单纯的 sha256(码)（那个能被穷举）');

    // --- 60 秒冷却 ---
    const again = await req('POST', '/api/notify/email', { token: tokenA, body: { email: 'owner_a@qq.com' } });
    eq(again.status, 429, '60 秒内重发被挡下');
    ok(again.data.retryAfterSec > 0, '并给出还要等多少秒（界面用它起倒计时）', JSON.stringify(again.data));

    // --- 确认：先试几种错的 ---
    const wrong = await req('POST', '/api/notify/email/confirm', { token: tokenA, body: { code: '000000' } });
    eq(wrong.status, 400, '错误的验证码被拒');
    contains(wrong.data.error, '还可以试', '并告知还剩几次机会');
    eq((await req('POST', '/api/notify/email/confirm', { token: tokenA, body: { code: 'abc' } })).status,
        400, '非 6 位数字被拒');

    // B 手上没有待验证项，拿 A 的码也确认不了
    const steal = await req('POST', '/api/notify/email/confirm', { token: tokenB, body: { code: codeA } });
    eq(steal.status, 400, 'B 拿 A 的码确认不了');
    contains(steal.data.error, '没有待验证的邮箱', '原因是 B 自己那边根本没有待验证项');

    // --- 确认成功 ---
    const done = await req('POST', '/api/notify/email/confirm', { token: tokenA, body: { code: codeA } });
    eq(done.status, 200, '正确的验证码通过');
    eq(done.data.email, 'owner_a@qq.com', '生效的地址就是刚验证的那个');
    eq(done.data.verified, true, '标记为已验证');

    const after = await req('GET', '/api/notify/email', { token: tokenA });
    eq(after.data.email, 'owner_a@qq.com', '再读能读到这个地址');
    eq(after.data.verified, true, '状态是已启用');
    eq(after.data.pending, null, '待验证项已清掉');
    eq((await req('POST', '/api/notify/email/confirm', { token: tokenA, body: { code: codeA } })).status,
        400, '同一个码不能再用第二次');

    // --- 按账号隔离 ---
    const bState = await req('GET', '/api/notify/email', { token: tokenB });
    eq(bState.data.email, null, 'B 读不到 A 的地址');
    eq(bState.data.verified, false, 'B 仍是未验证状态');

    // --- 发提醒时只用本人已验证的地址 ---
    signalOpts = null;
    const noAddr = await req('POST', '/api/notify', { token: tokenB, body: { signal: sig } });
    eq(noAddr.status, 200, 'B 没验证地址时不是错误码（浏览器不该反复重试）');
    eq(noAddr.data.skipped, true, '而是「跳过」');
    contains(String(noAddr.data.error), '邮件提醒', '并提示去哪儿设置');
    eq(signalOpts, null, '根本没走到发信那一步');
    ok(!fs.readFileSync(FILE, 'utf8').includes('global_fallback@qq.com'),
        '配置里那个全局 to 完全没被写进任何账号的记录');

    signalOpts = null;
    const sentA = await req('POST', '/api/notify', { token: tokenA, body: { signal: sig } });
    eq(sentA.status, 200, 'A 的发信请求被处理');
    eq(signalOpts && signalOpts.to, 'owner_a@qq.com', '发到了 A 自己验证过的地址（不是全局那个）');
    eq(signalOpts && signalOpts.account, 'mail_a', '并带上账号，发送记录按它归属');

    // --- 诊断接口：只看得到自己的 ---
    const diagA = await req('GET', '/api/notify', { token: tokenA });
    eq(diagA.status, 200, '诊断接口可用');
    eq(diagA.data.email, 'owner_a@qq.com', '诊断里显示本账号的地址');
    eq(diagA.data.emailVerified, true, '并标明已验证');
    eq((await req('GET', '/api/notify', { token: tokenB })).data.email, null, 'B 的诊断里没有 A 的地址');

    // --- 落盘与重启 ---
    const stored = readFile().mail.mail_a;
    eq(stored.email, 'owner_a@qq.com', '已验证的地址落盘');
    ok(!!stored.verifiedAt, '并记下验证时间');
    eq(stored.pending, undefined, '待验证项不留在文件里');

    await restart();
    eq((await req('GET', '/api/notify/email', { token: tokenA })).data.email,
        'owner_a@qq.com', '重启后仍然有效（不用重新验证一遍）');

    // --- 过期的码会被作废 ---
    const askB = await req('POST', '/api/notify/email', { token: tokenB, body: { email: 'owner_b@qq.com' } });
    eq(askB.status, 200, 'B 也能请求验证码');
    const codeB = String(lastCode);

    const expired = readFile();
    expired.mail.mail_b.pending.expiresAt = Date.now() - 1000;   // 放到过期
    fs.writeFileSync(FILE, JSON.stringify(expired, null, 2));

    const tooLate = await req('POST', '/api/notify/email/confirm', { token: tokenB, body: { code: codeB } });
    eq(tooLate.status, 400, '过期的验证码被拒');
    contains(String(tooLate.data.error), '过期', '原因说明是过期');
    eq(readFile().mail.mail_b.pending, undefined, '过期即作废，不能留着继续试');

    // --- 试错用尽会作废，之后连正确的码也不认 ---
    eq((await req('POST', '/api/notify/email', { token: tokenB, body: { email: 'owner_b@qq.com' } })).status,
        200, '重新获取验证码');
    const goodB = String(lastCode);
    const badB = goodB === '000000' ? '111111' : '000000';

    let lastTry = null;
    for (let i = 0; i < 5; i++) {
        lastTry = await req('POST', '/api/notify/email/confirm', { token: tokenB, body: { code: badB } });
    }
    eq(lastTry.status, 429, '连试 5 次错之后被拒');
    eq(readFile().mail.mail_b.pending, undefined, '试错用尽即作废');
    eq((await req('POST', '/api/notify/email/confirm', { token: tokenB, body: { code: goodB } })).status,
        400, '作废后连正确的码也不认（必须重新获取）');

    // --- 解除绑定 ---
    eq((await req('DELETE', '/api/notify/email', { token: tokenA })).status, 200, '解除绑定成功');
    const unbound = await req('GET', '/api/notify/email', { token: tokenA });
    eq(unbound.data.email, null, '解绑后没有地址');
    eq(unbound.data.verified, false, '也不再是已验证状态');

    signalOpts = null;
    const afterUnbind = await req('POST', '/api/notify', { token: tokenA, body: { signal: sig } });
    eq(afterUnbind.data.skipped, true, '解绑后不再发提醒');
    eq(signalOpts, null, '同样不会退回到任何别的地址');

    // 复原，别让桩漏给后面的用例
    notifyMod.sendVerificationMail = realVerification;
    notifyMod.sendSignalMail = realSignal;
} catch (e) {
    failed++;
    failures.push('推送邮箱用例异常: ' + e.message);
    console.log('  \x1b[31m✗\x1b[0m 推送邮箱用例异常: ' + e.message + '\n' + (e.stack || ''));
} finally {
    // 关掉这一节起的服务：否则那个监听会一直吊住事件循环，跑完也不退出
    if (current) await new Promise(r => current.close(r));
}

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
