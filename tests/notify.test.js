'use strict';
/**
 * 买卖信号邮件提醒 —— 单元测试
 *
 * 运行：node tests/notify.test.js
 *
 * 为什么能测：发信这一环的难点是「凭据对不对、协议说得对不对」。前者没法测（没有
 * 你的授权码），后者可以 —— 本测试自己起一个假的 SMTP 服务器，把假服务端当成
 * QQ/163 来对话，于是 EHLO / AUTH / MAIL / RCPT / DATA 的每一步、以及隐式 TLS 与
 * STARTTLS 两条路径，都能在本地真实验证。
 *
 * 特别验证一件事：**证书校验默认是开着的**。用自签证书起服务，不传 ca 时必须连接
 * 失败；传了 ca 才成功。这条断言的作用是证明没有为了让测试通过而偷偷关掉校验。
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const tls = require('tls');
const path = require('path');
const { execFileSync } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-notify-'));
// 让配置与发送记录都落到临时目录，绝不碰你的真实文件
process.env.MAIL_CONFIG_FILE = path.join(tmpDir, 'mail-config.json');
process.env.MAIL_LOG_FILE = path.join(tmpDir, 'notify-log.json');

const notify = require('../server/notify');
const mailer = require('../server/mailer');

let passed = 0, failed = 0, skipped = 0;
const failures = [];

function ok(cond, name, extra) {
    if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
    else {
        failed++;
        failures.push(name + (extra ? ' — ' + extra : ''));
        console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  → ' + extra : ''));
    }
}
function eq(a, b, name) {
    ok(a === b, name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
function contains(hay, needle, name) {
    ok(String(hay).indexOf(needle) >= 0, name, `没找到 ${JSON.stringify(needle)}`);
}
function skip(name, why) {
    skipped++;
    console.log('  \x1b[33m—\x1b[0m ' + name + '（跳过：' + why + '）');
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

function json(v) { return JSON.stringify(v, null, 2); }

// ---------------- 样例信号 ----------------

function sampleSignal(over) {
    return Object.assign({
        coinId: 'ethereum',
        coinSymbol: 'ETH',
        timeframe: 4,
        signalType: 'strong_buy',
        signalText: '强烈买入',
        score: 74,
        price: 2683.59,
        predictedAt: 1790265600000,
        sensitivity: 'balanced',
        algoVersion: '1.0.1',
        actionTip: '综合评分较高，可考虑分批建仓，仓位控制在60-80%',
        gate: 'funding',
        fundingPercentile: 0.31,
        factors: {
            breakdown: { technical: 72, volume: 68, news: 55, sentiment: 61, derivatives: 70 },
            weights: { technical: 40, volume: 20, sentiment: 16, news: 12, derivatives: 12 },
            technicalBreakdown: {
                rsi: 12, macd: 10, ma: 7,
                longMA: { window: 200, substituted: false, value: 2508.21 },
                momentum: 6, bollinger: 0, vwap: 5, stochRSI: 10, kdj: 8, ahr999: 4, obv: 5,
            },
            indicators: {
                rsi: 28.4,
                macd: { macd: 53.31, signal: 53.41, histogram: -0.1 },
                kdj: { k: 63.56, d: 63.3, j: 64.09 },
                ma7: 2753.38, ma25: 2710.02, ma200: 2508.21,
            },
            volumeMetrics: { ratio: 1.42 },
        },
    }, over || {});
}

// ---------------- 假 SMTP 服务器 ----------------

/**
 * 起一个假 SMTP 服务器
 * @param {Object} o - { creds, implicitTls, authMethods, rejectAuth, rejectRcpt }
 * @returns {Promise<{port:number, state:Object, close:Function}>}
 */
function startMockSmtp(o) {
    const opts = o || {};
    const state = { received: [], commands: [], auth: null, quit: false };
    const secureContext = opts.creds ? tls.createSecureContext(opts.creds) : null;

    function handleSession(sock, secure, greetingDone) {
        let buf = '';
        let inData = false;
        let dataLines = [];
        let pendingAuth = null;
        let authUser = null;
        const cmds = [];

        const write = s => sock.write(s + '\r\n');
        if (!greetingDone) write('220 mock.local ESMTP ready');

        const onData = chunk => {
            buf += chunk.toString('utf8');
            let i;
            while ((i = buf.indexOf('\r\n')) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 2);

                if (inData) {
                    if (line === '.') {
                        inData = false;
                        state.received.push({ commands: cmds.slice(), data: dataLines.join('\r\n') });
                        dataLines = [];
                        write('250 2.0.0 Ok: queued as MOCK1');
                    } else {
                        dataLines.push(line);
                    }
                    continue;
                }

                cmds.push(line);
                state.commands.push(line);

                // AUTH LOGIN 的后续两步先拦截（它们也是 base64 密文，不是命令）
                if (pendingAuth === 'user') {
                    pendingAuth = 'pass';
                    authUser = Buffer.from(line, 'base64').toString('utf8');
                    write('334 ' + Buffer.from('Password:').toString('base64'));
                    continue;
                }
                if (pendingAuth === 'pass') {
                    pendingAuth = null;
                    const authPass = Buffer.from(line, 'base64').toString('utf8');
                    if (opts.rejectAuth) { write('535 5.7.8 Authentication credentials invalid'); continue; }
                    state.auth = { method: 'LOGIN', user: authUser, pass: authPass };
                    write('235 2.7.0 Authentication successful');
                    continue;
                }

                const u = line.toUpperCase();
                if (u.startsWith('EHLO')) {
                    write('250-mock.local greets you');
                    write('250-AUTH ' + (opts.authMethods || 'PLAIN LOGIN'));
                    if (!secure && secureContext) write('250-STARTTLS');
                    write('250 SIZE 10485760');
                } else if (u === 'STARTTLS') {
                    write('220 2.0.0 Ready to start TLS');
                    sock.removeListener('data', onData);
                    const upgraded = new tls.TLSSocket(sock, { isServer: true, secureContext });
                    // 升级后不再发问候语（RFC 3207），客户端会重新 EHLO
                    handleSession(upgraded, true, true);
                } else if (u.startsWith('AUTH PLAIN')) {
                    if (opts.rejectAuth) { write('535 5.7.8 Authentication credentials invalid'); continue; }
                    const token = line.split(/\s+/)[2] || '';
                    const parts = Buffer.from(token, 'base64').toString('utf8').split('\u0000');
                    state.auth = { method: 'PLAIN', user: parts[1], pass: parts[2] };
                    write('235 2.7.0 Authentication successful');
                } else if (u.startsWith('AUTH LOGIN')) {
                    if (opts.rejectAuth) { write('535 5.7.8 Authentication credentials invalid'); continue; }
                    pendingAuth = 'user';
                    write('334 ' + Buffer.from('Username:').toString('base64'));
                } else if (u.startsWith('MAIL FROM')) {
                    write('250 2.1.0 Ok');
                } else if (u.startsWith('RCPT TO')) {
                    if (opts.rejectRcpt) { write('550 5.1.1 No such user'); continue; }
                    write('250 2.1.5 Ok');
                } else if (u === 'DATA') {
                    inData = true;
                    write('354 End data with <CR><LF>.<CR><LF>');
                } else if (u === 'QUIT') {
                    state.quit = true;
                    write('221 2.0.0 Bye');
                    sock.end();
                } else {
                    write('500 5.5.2 Command unrecognized');
                }
            }
        };
        sock.on('data', onData);
        sock.on('error', () => { /* 客户端断开是正常情况 */ });
    }

    return new Promise((resolve, reject) => {
        const server = opts.implicitTls && opts.creds
            ? tls.createServer(opts.creds, sock => handleSession(sock, true, false))
            : net.createServer(sock => handleSession(sock, false, false));
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            resolve({
                port: server.address().port,
                state,
                close: () => new Promise(r => server.close(() => r())),
            });
        });
    });
}

/** 从收到的报文中取出某个 MIME 部分的解码结果 */
function decodePart(data, mimeType) {
    const lines = data.split('\r\n');
    const idx = lines.findIndex(l => l.toLowerCase().startsWith('content-type: ' + mimeType.toLowerCase()));
    if (idx < 0) return null;
    let i = idx;
    while (i < lines.length && lines[i] !== '') i++;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].startsWith('--')) break;
        body.push(lines[j]);
    }
    return Buffer.from(body.join(''), 'base64').toString('utf8');
}

/** 取出某个头的值 */
function headerOf(data, name) {
    const line = data.split('\r\n').find(l => l.toLowerCase().startsWith(name.toLowerCase() + ':'));
    return line ? line.slice(name.length + 1).trim() : null;
}

function decodeRfc2047(v) {
    const m = /^=\?UTF-8\?B\?(.+)\?=$/i.exec(String(v));
    return m ? Buffer.from(m[1], 'base64').toString('utf8') : v;
}

// ---------------- 生成一次性自签证书 ----------------

/**
 * TLS 那几条断言要连一个自签的服务器，而 Node 自身没有生成证书的能力，所以借 openssl。
 * 两套候选写法都试一下：系统自带的 LibreSSL 通常可用；而某些自编译的 OpenSSL 3
 * 会去找不存在的默认配置文件（这台机器上就如此），此时用 OPENSSL_CONF=/dev/null 绕开。
 * 都不行就跳过相关断言，并把原因打出来 —— 跳过必须说明为什么，不能悄悄少测。
 */
function makeCert() {
    const key = path.join(tmpDir, 'key.pem');
    const cert = path.join(tmpDir, 'cert.pem');
    const args = [
        'req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert,
        '-days', '1', '-nodes', '-subj', '/CN=localhost',
    ];
    const candidates = [
        { cmd: '/usr/bin/openssl', env: {} },
        { cmd: 'openssl', env: { OPENSSL_CONF: '/dev/null' } },
    ];
    const errors = [];
    for (const c of candidates) {
        try {
            execFileSync(c.cmd, args, {
                stdio: 'ignore',
                env: Object.assign({}, process.env, c.env),
            });
            return { ok: true, key: fs.readFileSync(key), cert: fs.readFileSync(cert), caPem: fs.readFileSync(cert, 'utf8') };
        } catch (e) {
            errors.push(c.cmd + ' → ' + (e.message || '').split('\n')[0]);
        }
    }
    return { ok: false, error: errors.join('；') };
}

// ============================================================

async function main() {
    // ---------------- 1. MIME 组装 ----------------
    section('1. MIME 组装');

    const built = mailer.buildMessage({
        from: 'a@qq.com', to: 'b@qq.com', subject: '买入 · ETH 4小时',
        text: '纯文本正文，含中文', html: '<b>HTML 正文，含中文</b>',
    });
    ok(/^<[0-9a-f]+@cryptopulse\.local>$/.test(built.messageId), 'Message-ID 格式正确', built.messageId);

    ['From:', 'To:', 'Subject:', 'Date:', 'Message-ID:', 'MIME-Version:', 'Content-Type:'].forEach(h => {
        contains(built.message, h, '报文含头部 ' + h);
    });
    contains(built.message, 'multipart/alternative', '声明为 multipart/alternative');

    ok(built.message.indexOf('=?UTF-8?B?') > 0, '中文主题用 RFC2047 编码（否则客户端显示乱码）');
    eq(decodeRfc2047(headerOf(built.message, 'Subject')), '买入 · ETH 4小时', '主题解码后与原值一致');

    const ascii = mailer.buildMessage({ from: 'a@b.c', to: 'd@e.f', subject: 'Plain ASCII', text: 'x', html: 'y' });
    eq(ascii.message.indexOf('=?UTF-8?B?'), -1, '纯 ASCII 主题不做编码（避免无谓的编码）');

    const bareLf = built.message.split('\n').filter(l => !l.endsWith('\r'));
    eq(bareLf.length, 1, '全文仅允许最后一行的换行不带 \\r（SMTP 要求 CRLF）');

    const textPart = decodePart(built.message, 'text/plain');
    eq(textPart, '纯文本正文，含中文', 'base64 正文可原样解回（含中文）');
    eq(decodePart(built.message, 'text/html'), '<b>HTML 正文，含中文</b>', 'HTML 部分同样可解回');

    const boundary = /boundary="([^"]+)"/.exec(built.message)[1];
    contains(built.message, '--' + boundary + '--', '结尾的 boundary 有闭合标记');
    contains(built.message, 'Content-Transfer-Encoding: base64', '声明为 base64 编码');

    const longText = 'A'.repeat(400);
    const wrapped = mailer.wrap76(Buffer.from(longText).toString('base64'));
    const wrapLines = wrapped.split('\r\n').filter(Boolean);
    ok(wrapLines.every(l => l.length <= 76), 'base64 按 76 列折行');
    eq(Buffer.from(wrapLines.join(''), 'base64').toString('utf8'), longText, '折行后仍能解回');

    // 日期格式必须能被邮件客户端解析（英文星期与月份）
    ok(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/
        .test(headerOf(built.message, 'Date')), 'Date 头符合 RFC 2822', headerOf(built.message, 'Date'));

    // ---------------- 2. 邮件内容 ----------------
    section('2. 邮件内容（要告知「具体情况」）');

    const mail = notify.composeSignalMail(sampleSignal());
    contains(mail.subject, '强烈买入', '主题含信号');
    contains(mail.subject, 'ETH', '主题含币种');
    contains(mail.subject, '4小时', '主题含周期');
    contains(mail.subject, '74分', '主题含评分');

    eq(mail.text.indexOf('信号价格    2683.59') >= 0, true, '正文含信号价格');
    contains(mail.text, '仓位建议', '正文含仓位建议');
    contains(mail.text, '综合评分较高，可考虑分批建仓', '仓位建议内容是信号里那条');
    contains(mail.text, '灵敏度：均衡', '灵敏度 key 翻成中文');
    contains(mail.text, '费率闸门', '正文含费率闸门状态');
    contains(mail.text, '算法版本    1.0.1', '正文含算法版本');

    ['技术面', '量能', '市场情绪', '消息面', '衍生品'].forEach(k => {
        contains(mail.text, k, '五因子分解含 ' + k);
    });
    contains(mail.text, '权重 40', '因子分解带权重（否则无法还原总分）');

    ['RSI', 'MACD', '均线排列', '长期均线', '短期动量', '布林带', 'VWAP', 'StochRSI', 'KDJ', 'AHR999', 'OBV']
        .forEach(k => contains(mail.text, k, '技术面子因子含 ' + k));
    contains(mail.text, '窗口 MA200', '长期均线显示实际窗口');

    ['RSI(14) 28.4', 'MACD 53.31', 'MACD柱 -0.10', 'MA200 2508.21', '量比 1.42', '资金费率分位 31%']
        .forEach(k => contains(mail.text, k, '关键读数含 ' + k));

    contains(mail.html, '强烈买入', 'HTML 含信号');
    contains(mail.html, '2683.59', 'HTML 含价格');
    contains(mail.html, '技术面', 'HTML 含因子分解');

    // HTML 里插入的值必须转义，否则币种名里一个 < 就能破坏整封邮件的结构
    const evil = notify.composeSignalMail(sampleSignal({ coinSymbol: '<script>x</script>', price: 1 }));
    eq(evil.html.indexOf('<script>'), -1, 'HTML 中的外部内容被转义');
    contains(evil.html, '&lt;script&gt;', '转义后的形态正确');

    // ---------------- 3. 节流与去重 ----------------
    section('3. 节流与去重');

    const sig = sampleSignal();
    const t0 = 1790265600000;
    eq(notify.checkThrottle(sig, [], t0).allow, true, '没有历史记录时允许发送');

    const sent = [{ at: t0, ok: true, key: 'ethereum|4|strong_buy' }];
    const dup = notify.checkThrottle(sig, sent, t0 + 60 * 1000);
    eq(dup.allow, false, '同一信号在冷却期内不重复发');
    contains(dup.reason, '冷却', '拒绝原因说明是冷却期');

    eq(notify.checkThrottle(sampleSignal({ signalType: 'sell' }), sent, t0 + 60000).allow, true,
        '换了信号类型（不同 key）可以发');
    eq(notify.checkThrottle(sampleSignal({ timeframe: 1 }), sent, t0 + 60000).allow, true,
        '换了周期可以发');
    eq(notify.checkThrottle(sig, sent, t0 + 7 * 3600 * 1000).allow, true,
        '超过冷却期后可以再发');

    const many = [];
    for (let i = 0; i < notify.MAX_PER_HOUR; i++) {
        many.push({ at: t0 + i, ok: true, key: 'x|' + i + '|buy' });
    }
    const capped = notify.checkThrottle({ coinId: 'z', timeframe: 1, signalType: 'buy' }, many, t0 + 1000);
    eq(capped.allow, false, '一小时内达到上限后拒绝');
    contains(capped.reason, '上限', '拒绝原因说明是达到上限');
    eq(capped.hard, true, '小时上限被标记为「硬」——任何 force 都越不过它（否则一次客户端 bug 就能刷屏）');

    const withFails = many.slice(0, 19).concat([
        { at: t0, ok: false, key: 'f|1|buy' },
        { at: t0, ok: false, key: 'f|2|buy' },
    ]);
    eq(notify.checkThrottle({ coinId: 'z', timeframe: 1, signalType: 'buy' }, withFails, t0 + 1000).allow,
        true, '失败的记录不占配额（否则一次服务端故障会把额度吃光）');

    // ---------------- 4. K线买卖点提醒（本次的触发方式） ----------------
    section('4. K线买卖点提醒（本次的触发方式）');

    // 与浏览器扫描后实际发来的结构一致
    function markerSample(over) {
        return Object.assign({
            coinId: 'ethereum',
            coinSymbol: 'ETH',
            timeframe: 4,
            signalType: 'strong_buy',
            signalText: '强烈买入',
            score: 78,
            price: 2683.59,
            markerTime: 1790265600,      // 这个买卖点所在的K线（秒）
            execTime: 1790279985,        // 下一根K线的开盘时刻
            execPrice: 2684.11,
            predictedAt: 1790265600000,
            sensitivity: 'balanced',
            actionTip: '可考虑分批建仓，仓位控制在60-80%',
            gate: 'off',
            source: 'paper-marker',
        }, over || {});
    }

    const mk = markerSample();
    const mkMail = notify.composeSignalMail(mk);
    contains(mkMail.subject, 'K线买卖点', '主题标明这是K线买卖点');
    contains(mkMail.subject, '强烈买入', '主题含信号档位');
    contains(mkMail.text, '买卖点评分', '分值叫「买卖点评分」而不是「综合评分」');
    eq(mkMail.text.indexOf('综合评分'), -1, '不出现「综合评分」措辞（它与买卖点评分不是同一个量）');
    contains(mkMail.text, 'K线时间', '正文给出这个买卖点所在K线的时间');
    contains(mkMail.text, '成交口径', '正文说明成交口径');
    contains(mkMail.text, '2684.11', '成交口径里带上成交价');
    contains(mkMail.text, '该K线收盘价', '信号价格标明是该K线收盘价');
    contains(mkMail.text, '费率闸门    关闭', '闸门 key 翻成中文');
    contains(mkMail.text, '已开启交易', '页脚说明提醒范围是已开启交易的币种');
    contains(mkMail.html, '成交口径', 'HTML 含成交口径');
    eq(mkMail.html.indexOf('综合评分'), -1, 'HTML 也不出现「综合评分」');

    // 买卖点带的是自己那套评分口径，没有五因子分解的分数。
    // 空标题必须整段消失，否则看起来像「明细丢了」。
    eq(mkMail.text.indexOf('五因子分解'), -1, '买卖点邮件不出现空的「五因子分解」标题');
    eq(mkMail.text.indexOf('关键读数'), -1, '买卖点邮件不出现空的「关键读数」标题');
    eq(mkMail.html.indexOf('五因子分解'), -1, 'HTML 里也不出现空的「五因子分解」标题');
    eq(mkMail.html.indexOf('关键读数'), -1, 'HTML 里也不出现空的「关键读数」标题');
    // 老式的实时信号仍然要有这两段（别为了买卖点把它们一起删了）
    contains(notify.composeSignalMail(sampleSignal()).text, '五因子分解', '有因子快照的信号仍然保留五因子分解');
    contains(notify.composeSignalMail(sampleSignal()).text, '关键读数', '有指标读数的信号仍然保留关键读数');
    contains(mkMail.html, '已开启交易', 'HTML 页脚同样说明提醒范围');

    // 闸门开启时要如实说明「本次未对它求值」，不能让用户以为这个点已经过闸
    const mkGate = notify.composeSignalMail(markerSample({ gate: 'funding' }));
    contains(mkGate.text, '未对闸门求值', '闸门开启时明确说明本次未求值');
    contains(mkGate.text, '以模拟盘为准', '并指出以模拟盘为准');
    contains(mkGate.html, '未对闸门求值', 'HTML 里也有这句说明');
    const mkOff = notify.composeSignalMail(markerSample({ gate: 'off' }));
    eq(mkOff.text.indexOf('未对闸门求值'), -1, '闸门关闭时不需要这句说明');

    // 点级去重：同一个买卖点只发一次
    const mlog = [{ at: 1790265700000, ok: true, key: 'ethereum|4|1790265600' }];
    const dupMarker = notify.checkThrottle(mk, mlog, 1790265700000);
    eq(dupMarker.allow, false, '同一个买卖点不重复发');
    contains(dupMarker.reason, '已经提醒过', '拒绝原因说明是同一个点');

    // 换一根K线（正常的多空交替）必须立刻放行 —— 这正是不能套冷却期的原因
    eq(notify.checkThrottle(markerSample({ markerTime: 1790280000 }), mlog, 1790265700000).allow, true,
        '新的买卖点立刻放行，不套冷却期');
    eq(notify.checkThrottle(markerSample({ markerTime: 1790280000, signalType: 'sell', signalText: '卖出' }),
        mlog, 1790265700000).allow, true, '反方向的点同样立刻放行（买→卖→买不会被吞掉）');

    // 不带 markerTime 的老结构仍然走冷却期，行为不变
    const oldStyle = [{ at: 1790265700000, ok: true, key: 'ethereum|4|strong_buy' }];
    const oldDup = notify.checkThrottle(
        { coinId: 'ethereum', timeframe: 4, signalType: 'strong_buy' }, oldStyle, 1790265700000);
    eq(oldDup.allow, false, '不带K线时间的结构仍按冷却期处理');
    contains(oldDup.reason, '冷却', '原因仍然是冷却期');

    // ---------------- 5. 配置加载 ----------------
    section('5. 配置加载');

    fs.rmSync(process.env.MAIL_CONFIG_FILE, { force: true });
    const missing = notify.loadConfig();
    eq(missing.configured, false, '配置不存在时如实报告未配置');
    contains(missing.reason, 'mail-config.json', '提示里给出配置文件路径');

    fs.writeFileSync(process.env.MAIL_CONFIG_FILE, json({ provider: 'qq', user: 'a@qq.com', pass: 'x', to: 'b@qq.com' }));
    const good = notify.loadConfig();
    eq(good.configured, true, 'provider 简写即可完成配置');
    eq(good.config.host, 'smtp.qq.com', 'provider 简写带出服务器地址');
    eq(good.config.port, 465, 'provider 简写带出端口');
    eq(good.config.secure, true, 'provider 简写带出加密方式');
    eq(good.config.from, 'a@qq.com', '未指定 from 时用 user');
    contains(good.hint, '授权码', '给出该服务商的注意事项');

    fs.writeFileSync(process.env.MAIL_CONFIG_FILE, json({ provider: 'qq', user: '', pass: '', to: '' }));
    const incomplete = notify.loadConfig();
    eq(incomplete.configured, false, '字段不全时报告未配置');
    contains(incomplete.reason, 'user', '缺字段提示里点名 user');
    // to 不再是必填：收件地址改成每个账号在网页上自己填并验证（见 store.js），
    // 配置文件里那个 to 只剩「自检工具的默认收件人」这一个用途。
    eq(incomplete.reason.indexOf('to') === -1, true, 'to 不再是必填字段');
    fs.writeFileSync(process.env.MAIL_CONFIG_FILE, json({ provider: 'qq', user: 'a@qq.com', pass: 'x' }));
    eq(notify.loadConfig().configured, true, '没有 to 也能算配置完整（收件地址不在配置里）');

    fs.writeFileSync(process.env.MAIL_CONFIG_FILE, json({ provider: 'nosuch', user: 'a', pass: 'b', to: 'c' }));
    contains(notify.loadConfig().reason, '未知的 provider', '未知 provider 有明确提示');

    // ---------------- 6. 收件地址校验 ----------------
    section('6. 收件地址校验（它来自用户输入，会被拼进邮件头）');

    ['you@example.com', 'a.b+tag@sub.example.co', 'x@y.cn'].forEach(addr => {
        eq(notify.isEmailAddress(addr), true, '合法地址被接受：' + addr);
    });
    eq(notify.isEmailAddress('  you@example.com  '), true, '首尾空白会被去掉后再判断（粘贴常带空格）');

    // 最关键的一条：含换行的「地址」就是一次邮件头注入，必须挡在外面。
    // 注意首尾空白会被 trim 掉（见下面那条断言），所以这里要验的是**夹在中间**的换行。
    ['a@b.com\r\nBcc: victim@x.com', 'a@b.com\nX-Evil: 1', 'no-at-sign', 'a@b', '@b.com',
        'a@.com', 'a b@c.com', '', null, undefined, 'a@b\tc.com'].forEach(addr => {
        eq(notify.isEmailAddress(addr), false, '非法地址被拒绝：' + JSON.stringify(addr));
    });
    // trim 之后再判断：粘贴来的地址常带首尾空白，去了就好，
    // 而这也保证了「校验通过的那个值一定不含空白」——注入要靠夹在中间的换行，那种会被拒
    eq(notify.isEmailAddress('a@b.com\n'), true, '仅有尾随换行会被去掉，不算注入');
    eq(notify.isEmailAddress('a'.repeat(250) + '@b.com'), false, '超长地址被拒绝');

    // ---------------- 7. 真实发送链路（对本地假 SMTP） ----------------
    section('7. 发送链路（本地假 SMTP 服务器）');

    const certResult = makeCert();
    const creds = certResult.ok ? certResult : null;
    if (!creds) {
        const why = '无法生成测试用自签证书：' + certResult.error;
        skip('隐式 TLS 发送', why);
        skip('STARTTLS 发送', why);
        skip('证书校验默认开启', why);
    } else {
        // --- 隐式 TLS（465 那种）---
        const tlsMock = await startMockSmtp({ creds, implicitTls: true });
        const cfgBase = {
            host: 'localhost', port: tlsMock.port, secure: true,
            user: 'sender@qq.com', pass: 'auth-code', from: 'sender@qq.com', to: 'me@qq.com',
            ca: creds.caPem,
        };

        const r1 = await mailer.sendMail({
            config: cfgBase, to: 'me@qq.com', subject: '中文主题测试', text: '你好', html: '<p>你好</p>',
        });
        eq(typeof r1.messageId, 'string', '隐式 TLS 发送成功并返回 Message-ID');
        eq(tlsMock.state.auth && tlsMock.state.auth.method, 'PLAIN', '服务端声明 PLAIN 时用 AUTH PLAIN');
        eq(tlsMock.state.auth && tlsMock.state.auth.user, 'sender@qq.com', 'AUTH 里带上了账号');
        eq(tlsMock.state.auth && tlsMock.state.auth.pass, 'auth-code', 'AUTH 里带上了授权码');
        eq(tlsMock.state.quit, true, '发完发 QUIT 正常退出');

        const recv1 = tlsMock.state.received[0];
        ok(recv1 && recv1.data.length > 0, '服务端收到了 DATA 内容');
        contains(recv1.commands.join(' | '), 'MAIL FROM:<sender@qq.com>', 'MAIL FROM 正确');
        contains(recv1.commands.join(' | '), 'RCPT TO:<me@qq.com>', 'RCPT TO 正确');
        eq(decodeRfc2047(headerOf(recv1.data, 'Subject')), '中文主题测试', '收到的主题中文完好');
        eq(decodePart(recv1.data, 'text/plain'), '你好', '收到的正文中文完好');

        // --- 只有 AUTH LOGIN 时要走两步流程 ---
        const loginMock = await startMockSmtp({ creds, implicitTls: true, authMethods: 'LOGIN' });
        await mailer.sendMail({
            config: Object.assign({}, cfgBase, { port: loginMock.port }),
            to: 'me@qq.com', subject: 'x', text: 'y', html: 'z',
        });
        eq(loginMock.state.auth && loginMock.state.auth.method, 'LOGIN', '只声明 LOGIN 时用 AUTH LOGIN');
        eq(loginMock.state.auth && loginMock.state.auth.user, 'sender@qq.com', 'AUTH LOGIN 第二步带上账号');
        eq(loginMock.state.auth && loginMock.state.auth.pass, 'auth-code', 'AUTH LOGIN 第三步带上授权码');
        await loginMock.close();

        // --- 证书校验默认开启：不给 ca 就必须失败 ---
        const strictMock = await startMockSmtp({ creds, implicitTls: true });
        let rejected = null;
        try {
            await mailer.sendMail({
                config: Object.assign({}, cfgBase, { port: strictMock.port, ca: undefined }),
                to: 'me@qq.com', subject: 'x', text: 'y', html: 'z',
            });
        } catch (e) { rejected = e; }
        ok(rejected !== null, '未提供 ca 时连接自签服务器必须失败（证明校验没有被关闭）');
        if (rejected) {
            ok(/self.signed|unable to verify|issuer|certificate/i.test(rejected.message),
                '失败原因与证书有关', rejected.message);
            // 证书失败必须自带「该往哪修」，否则只会看到一句 UNABLE_TO_GET_ISSUER_CERT_LOCALLY。
            // 两种成因（整份根证书列表缺失 / 只缺这条链的中间证书）都给，这里只要求给出其中一种
            // 可执行的修法，且不能是「关闭校验」。
            contains(rejected.message, '→', '证书错误后面附了怎么修');
            ok(/--use-bundled-ca|配置里的 ca/.test(rejected.message),
                '给出的修法是可执行的（换证书列表，或指明 ca）', rejected.message);
            eq(/NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized\s*[:=]\s*false/.test(rejected.message), false,
                '不把「关闭校验」当成修法');
        }
        await strictMock.close();

        // --- 服务端拒收 ---
        const badAuthMock = await startMockSmtp({ creds, implicitTls: true, rejectAuth: true });
        let authErr = null;
        try {
            await mailer.sendMail({
                config: Object.assign({}, cfgBase, { port: badAuthMock.port }),
                to: 'me@qq.com', subject: 'x', text: 'y', html: 'z',
            });
        } catch (e) { authErr = e; }
        ok(authErr !== null, '授权码错误时抛错');
        contains(authErr && authErr.message, '535', '错误里带服务端返回码，便于定位');
        await badAuthMock.close();

        const badRcptMock = await startMockSmtp({ creds, implicitTls: true, rejectRcpt: true });
        let rcptErr = null;
        try {
            await mailer.sendMail({
                config: Object.assign({}, cfgBase, { port: badRcptMock.port }),
                to: 'nobody@qq.com', subject: 'x', text: 'y', html: 'z',
            });
        } catch (e) { rcptErr = e; }
        ok(rcptErr !== null, '收件人被拒时抛错');
        contains(rcptErr && rcptErr.message, '550', '错误里带服务端返回码');
        await badRcptMock.close();

        await tlsMock.close();

        // --- STARTTLS（587 那种）：先明文，再升级 ---
        const startTlsMock = await startMockSmtp({ creds, implicitTls: false });
        const r2 = await mailer.sendMail({
            config: {
                host: 'localhost', port: startTlsMock.port, secure: false,
                user: 'sender@qq.com', pass: 'auth-code', from: 'sender@qq.com', to: 'me@qq.com',
                ca: creds.caPem,
            },
            to: 'me@qq.com', subject: 'STARTTLS 路径', text: '内部正文', html: '<p>内部正文</p>',
        });
        eq(typeof r2.messageId, 'string', 'STARTTLS 路径发送成功');
        eq(r2.auth, 'PLAIN', 'STARTTLS 之后正常完成认证');
        const recv2 = startTlsMock.state.received[0];
        ok(recv2 && recv2.data.length > 0, 'STARTTLS 之后 DATA 内容送达');
        // STARTTLS 发生在升级之前，属于「上一个会话」，所以要看全局命令记录，
        // 而不是升级后那个会话里捕获的命令列表
        contains(startTlsMock.state.commands.join(' | '), 'STARTTLS', '确实走了 STARTTLS 命令');
        const ehloCount = startTlsMock.state.commands.filter(c => /^EHLO/i.test(c)).length;
        eq(ehloCount, 2, '升级后重新发了一次 EHLO（RFC 3207 要求）');
        eq(decodeRfc2047(headerOf(recv2.data, 'Subject')), 'STARTTLS 路径', 'STARTTLS 之后主题完好');
        await startTlsMock.close();

        // --- 服务端不支持 STARTTLS 时必须给出可操作的提示 ---
        const noStartTls = await startMockSmtp({ creds: null, implicitTls: false });
        let stlsErr = null;
        try {
            await mailer.sendMail({
                config: {
                    host: 'localhost', port: noStartTls.port, secure: false,
                    user: 'a@b.c', pass: 'd', to: 'e@f.g',
                },
                to: 'e@f.g', subject: 'x', text: 'y', html: 'z',
            });
        } catch (e) { stlsErr = e; }
        ok(stlsErr !== null, '服务端不提供 STARTTLS 时抛错');
        contains(stlsErr && stlsErr.message, '465', '提示可改用 465 端口（而不是只说一句失败）');
        await noStartTls.close();
    }

    // ---------------- 8. 与接口层的衔接 ----------------
    section('8. sendSignalMail 的对外行为');

    // 没配邮箱时：不报错，只标记跳过（没配邮箱是正常状态）
    fs.rmSync(process.env.MAIL_CONFIG_FILE, { force: true });
    fs.rmSync(process.env.MAIL_LOG_FILE, { force: true });
    const noCfg = await notify.sendSignalMail(sampleSignal(), {});
    eq(noCfg.ok, false, '未配置邮箱时不发送');
    eq(noCfg.skipped, true, '未配置邮箱属于「跳过」而不是「失败」');
    ok(fs.existsSync(process.env.MAIL_LOG_FILE) === false, '跳过时不写发送记录');

    // 「观望」不在提醒范围
    const holdRes = await notify.sendSignalMail(sampleSignal({ signalType: 'hold' }), {});
    eq(holdRes.skipped, true, '观望信号被跳过');
    contains(holdRes.error, '买入与卖出', '给出的理由说明范围');

    // 配置齐了但「这个账号还没验证推送邮箱」—— 这是本次改动后的常态，
    // 必须跳过并说清去哪儿补，而不是发到某个陌生的默认地址
    fs.writeFileSync(process.env.MAIL_CONFIG_FILE, json({ provider: 'qq', user: 'a@qq.com', pass: 'b' }));
    const noTo = await notify.sendSignalMail(sampleSignal(), { dryRun: true });
    eq(noTo.ok, false, '没有收件地址时不发送');
    eq(noTo.skipped, true, '没有收件地址属于「跳过」而不是「失败」');
    contains(noTo.error, '交易 → 邮件提醒', '提示里说清去哪儿设置');
    contains(noTo.error, '--to', '命令行自检也给出做法');

    // 每个账号自己的地址由浏览器作为 opts.to 传进来（不走配置文件）
    const ownTo = await notify.sendSignalMail(sampleSignal(), { dryRun: true, to: 'mine@qq.com' });
    eq(ownTo.ok, true, '带上本账号的地址可以正常发送');
    eq(ownTo.to, 'mine@qq.com', '用的就是传进来的那个地址');

    // 传进来的地址也要过校验：它是用户输入，不是可信常量
    const badTo = await notify.sendSignalMail(sampleSignal(), { dryRun: true, to: 'a@b.com\r\nBcc: x@y.com' });
    eq(badTo.ok, false, '含换行的地址被拒绝（否则就是邮件头注入）');
    eq(badTo.skipped, true, '同样按「跳过」处理，日志里不落一条伪造的收件人');

    // 卖出类也在范围内（用户明确要求买卖都要有）
    fs.writeFileSync(process.env.MAIL_CONFIG_FILE, json({ provider: 'qq', user: 'a', pass: 'b', to: 'me@qq.com' }));
    const sellDry = await notify.sendSignalMail(sampleSignal({ signalType: 'sell', signalText: '卖出' }), { dryRun: true });
    eq(sellDry.ok, true, '卖出信号在提醒范围内');
    contains(sellDry.subject, '卖出', '卖出的主题正确');
    const strongSellDry = await notify.sendSignalMail(sampleSignal({ signalType: 'strong_sell' }), { dryRun: true });
    eq(strongSellDry.ok, true, '强烈卖出也在提醒范围内');

    const dry = await notify.sendSignalMail(sampleSignal(), { dryRun: true });
    eq(dry.ok, true, 'dryRun 可以只组装不发送');
    eq(dry.dryRun, true, 'dryRun 有明确标记');
    contains(dry.text, '五因子分解', 'dryRun 返回的内容是完整的');

    // 真正走一遍 sendSignalMail（含写日志），对本地假 SMTP
    if (creds) {
        const e2eMock = await startMockSmtp({ creds, implicitTls: true });
        fs.writeFileSync(process.env.MAIL_CONFIG_FILE, json({
            host: 'localhost', port: e2eMock.port, secure: true, ca: creds.caPem,
            user: 'sender@qq.com', pass: 'auth-code', to: 'me@qq.com',
        }));
        fs.rmSync(process.env.MAIL_LOG_FILE, { force: true });

        const e2e = await notify.sendSignalMail(sampleSignal(), { force: true });
        eq(e2e.ok, true, 'sendSignalMail 端到端发送成功');
        eq(e2e.to, 'me@qq.com', '返回里带上收件地址');
        const log = JSON.parse(fs.readFileSync(process.env.MAIL_LOG_FILE, 'utf8'));
        eq(log.length, 1, '发送成功后写入了一条记录');
        eq(log[0].ok, true, '记录标记为成功');
        eq(log[0].signalType, 'strong_buy', '记录里带信号类型（便于事后查「为什么没收到」）');

        // 冷却：同一信号立刻再发应被跳过
        const again = await notify.sendSignalMail(sampleSignal(), {});
        eq(again.ok, false, '同一信号立刻重发被拒绝');
        eq(again.skipped, true, '重复发送属于「跳过」');

        // force 可以绕过冷却（测试用）
        const forced = await notify.sendSignalMail(sampleSignal(), { force: true });
        eq(forced.ok, true, 'force 可绕过冷却（测试用）');

        // 发送失败要落到日志里，而不是只在返回里
        fs.rmSync(process.env.MAIL_LOG_FILE, { force: true });
        const deadMock = await startMockSmtp({ creds, implicitTls: true, rejectAuth: true });
        fs.writeFileSync(process.env.MAIL_CONFIG_FILE, json({
            host: 'localhost', port: deadMock.port, secure: true, ca: creds.caPem,
            user: 'sender@qq.com', pass: 'wrong', to: 'me@qq.com',
        }));
        const failedSend = await notify.sendSignalMail(sampleSignal(), { force: true });
        eq(failedSend.ok, false, '授权码错误时如实报告失败');
        contains(failedSend.error, '535', '失败信息里带服务端返回码');
        const failLog = JSON.parse(fs.readFileSync(process.env.MAIL_LOG_FILE, 'utf8'));
        eq(failLog[failLog.length - 1].ok, false, '失败也写入记录（否则排查时看不到任何痕迹）');
        await deadMock.close();
        await e2eMock.close();
    } else {
        skip('sendSignalMail 端到端', '无法生成测试用自签证书：' + certResult.error);
    }

    // ---------------- 9. 内嵌K线图 ----------------
    section('9. 内嵌K线图（邮件里的买卖点位置）');

    // 用一段覆盖各种字节值的二进制当图。这里刻意不追求「是张真 PNG」——
    // 邮件这一层只负责原样搬运字节，不需要会解码图片；真正的图长什么样，
    // 是在浏览器里实测的（见 tests 之外的人工验证）。
    // 之所以塞满 0x00-0xFF：确认 base64 之后再装回 MIME 体时，没有任何字节被吃掉。
    const imgBytes = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) imgBytes[i] = i;
    const imgB64 = imgBytes.toString('base64');

    const noImg = mailer.buildMessage({ from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't', html: 'h' });
    contains(noImg.message, 'multipart/alternative', '不带图时仍是 multipart/alternative');
    eq(noImg.message.indexOf('multipart/related'), -1, '不带图时不引入 related 层');

    const withImg = mailer.buildMessage({
        from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't', html: 'h',
        image: { base64: imgB64, contentType: 'image/png', filename: 'chart.png', cid: 'chart@cryptopulse' },
    });
    contains(withImg.message, 'multipart/related', '带图时外层是 multipart/related');
    contains(withImg.message, 'type="multipart/alternative"', 'related 声明内层类型');
    contains(withImg.message, 'Content-Type: multipart/alternative', '内层仍然是 alternative');
    contains(withImg.message, 'Content-Type: image/png; name="chart.png"', '图片部分声明类型与文件名');
    contains(withImg.message, 'Content-Disposition: inline; filename="chart.png"', '图片是内嵌而不是附件');
    contains(withImg.message, 'Content-ID: <chart@cryptopulse>', '图片带 Content-ID（正文靠它引用）');

    // 两层的 boundary 都要闭合，否则客户端会把后半封邮件当成附件正文
    const relB = /multipart\/related; boundary="([^"]+)"/.exec(withImg.message)[1];
    const altB = /multipart\/alternative; boundary="([^"]+)"/.exec(withImg.message)[1];
    ok(relB !== altB, '两层用的 boundary 不同（同名会让解析歧义）');
    contains(withImg.message, '--' + altB + '--', '内层 boundary 有闭合标记');
    contains(withImg.message, '--' + relB + '--', '外层 boundary 有闭合标记');

    // 图片字节必须能原样取回
    const imgPart = new RegExp('Content-ID: <chart@cryptopulse>\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--' + relB).exec(withImg.message);
    ok(imgPart !== null, '能在报文里定位到图片部分');
    if (imgPart) {
        const raw = imgPart[1].split('\r\n').join('');
        eq(Buffer.from(raw, 'base64').equals(imgBytes), true, 'base64 解回来与原字节完全一致');
        ok(imgPart[1].split('\r\n').every(l => l.length <= 76), '图片的 base64 也按 76 列折行（SMTP 行长限制）');
        eq(raw.length, imgB64.length, '折行只加换行，没有丢字符');
    }
    const msgLines = withImg.message.split('\r\n');
    eq(msgLines.some(l => l === '.'), false,
        '没有任何单独一行是「.」——否则 DATA 阶段会被当成结束符，邮件被截断');

    // 文件名与 Content-ID 会拼进头部，必须挡住注入
    const evilHead = mailer.buildMessage({
        from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't', html: 'h',
        image: { base64: imgB64, filename: 'x"\r\nX-Evil: 1\r\n.png', cid: 'c\r\nX-Evil2: 1' },
    });
    // 要验的是「没能造出新头部」这个性质，而不是「X-Evil 这几个字母消失」——
    // 清理的做法是剔掉不安全的字符，字母会原样留下当文件名的一部分，这没问题。
    const evilLines = evilHead.message.split('\r\n');
    eq(evilLines.some(l => /^X-Evil/i.test(l)), false, '文件名里的换行没能注入出新的头部行');
    eq(evilLines.some(l => /^X-Evil2/i.test(l)), false, 'Content-ID 里的换行没能注入出新的头部行');
    eq(evilHead.message.indexOf('\r\n\r\n\r\n'), -1, '没有出现被注入出来的空头行');
    const evilName = /name="([^"]*)"/.exec(evilHead.message);
    ok(evilName && evilName[1].length > 0, '清理之后文件名仍然可用（不是被清成空串）', evilName && evilName[1]);
    eq(/[\r\n]/.test(evilName ? evilName[1] : ''), false, '文件名取值里不含任何换行');

    // 只接受图片类型；否则一个 text/html 的「图片」就绕过了正文编码
    let typeErr = null;
    try {
        mailer.buildMessage({
            from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't', html: 'h',
            image: { base64: imgB64, contentType: 'text/html' },
        });
    } catch (e) { typeErr = e; }
    ok(typeErr !== null, '非 image/* 的类型被拒绝');

    let b64Err = null;
    try {
        mailer.buildMessage({
            from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't', html: 'h',
            image: { base64: '这不是 base64 ！' + imgB64 },
        });
    } catch (e) { b64Err = e; }
    ok(b64Err !== null, '非 base64 的内容被拒绝');

    // 上游直接给 data URL 也要认（省得两边各写一次拆前缀的代码）
    const dataUrl = mailer.buildMessage({
        from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't', html: 'h',
        image: { base64: 'data:image/png;base64,' + imgB64 },
    });
    contains(dataUrl.message, 'Content-ID: <chart@cryptopulse>', 'data URL 前缀被拆掉后可用');

    // 正文与配图必须一致：说「见内嵌图」就一定真有图
    const mkChart = notify.composeSignalMail(markerSample({
        chart: { base64: imgB64, width: 960, height: 430 },
    }));
    contains(mkChart.text, 'K线图', '带图的正文里说明了有K线图');
    contains(mkChart.text, '竖虚线', '并说明图里怎么标出这次的点');
    contains(mkChart.html, 'cid:chart@cryptopulse', 'HTML 用 cid 引用内嵌图');
    eq(mkChart.chartDropped, null, '正常带图时没有丢弃原因');
    ok(!!mkChart.image, '组装结果里带上了图片对象');

    const mkNoChart = notify.composeSignalMail(markerSample());
    eq(mkNoChart.text.indexOf('K线图'), -1, '不带图的正文不提K线图');
    eq(mkNoChart.html.indexOf('cid:'), -1, '不带图的 HTML 不出现 cid 引用');
    eq(mkNoChart.image, null, '不带图时没有图片对象');

    // 图太大时降级为纯文字，而不是让整封邮件发不出去
    const huge = notify.composeSignalMail(markerSample({
        chart: { base64: 'A'.repeat(notify.MAX_CHART_BASE64 + 8) },
    }));
    eq(huge.image, null, '超限的配图被丢掉');
    eq(huge.text.indexOf('K线图'), -1, '超限降级后正文也不再提图（措辞与事实一致）');
    contains(String(huge.chartDropped), '过大', '丢弃原因是「过大」而不是别的');

    // 图坏了同样只降级，不抛
    const broken = notify.composeSignalMail(markerSample({ chart: { base64: '@@@' } }));
    eq(broken.image, null, '非法 base64 被丢掉');
    contains(String(broken.chartDropped), 'base64', '丢弃原因说明是编码问题');

    if (creds) {
        const imgMock = await startMockSmtp({ creds, implicitTls: true });
        fs.writeFileSync(process.env.MAIL_CONFIG_FILE, json({
            host: 'localhost', port: imgMock.port, secure: true, ca: creds.caPem,
            user: 'sender@qq.com', pass: 'auth-code', to: 'me@qq.com',
        }));
        fs.rmSync(process.env.MAIL_LOG_FILE, { force: true });

        const sentWithImg = await notify.sendSignalMail(markerSample({
            chart: { base64: imgB64, width: 960, height: 430 },
        }), { force: true });
        eq(sentWithImg.ok, true, '带图邮件端到端发送成功');

        const recv = imgMock.state.received[imgMock.state.received.length - 1];
        const wire = recv ? recv.data : '';
        contains(wire, 'multipart/related', '假服务端收到的确实是带图结构');
        contains(wire, 'Content-ID: <chart@cryptopulse>', '收到的报文里有 Content-ID');
        const gotPart = new RegExp('Content-ID: <chart@cryptopulse>\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--').exec(wire);
        ok(gotPart !== null, '收到的报文里能定位到图片部分');
        if (gotPart) {
            eq(Buffer.from(gotPart[1].split('\r\n').join(''), 'base64').equals(imgBytes), true,
                '经 SMTP 传完之后图片字节仍然完全一致');
        }
        const imgLog = JSON.parse(fs.readFileSync(process.env.MAIL_LOG_FILE, 'utf8'));
        eq(imgLog[imgLog.length - 1].chart, true, '记录里标明这封带了配图');

        // 纯文字那封要如实记成「没有图」，别让人以为漏发了
        const plain = await notify.sendSignalMail(sampleSignal({ coinId: 'x', timeframe: 1 }), { force: true });
        eq(plain.ok, true, '不带图的邮件照常发送');
        const pLog = JSON.parse(fs.readFileSync(process.env.MAIL_LOG_FILE, 'utf8'));
        eq(pLog[pLog.length - 1].chart, false, '不带配图的那封记为 chart=false');

        // force 是给「同一条再发一次看看」用的，不能连小时兜底也一起打开
        const flood = [];
        for (let i = 0; i < notify.MAX_PER_HOUR; i++) {
            flood.push({ at: Date.now() - 1000, ok: true, key: 'k|' + i + '|buy' });
        }
        fs.writeFileSync(process.env.MAIL_LOG_FILE, json(flood));
        const overCap = await notify.sendSignalMail(markerSample({ markerTime: 1 }), { force: true });
        eq(overCap.ok, false, 'force 也突破不了小时上限');
        contains(String(overCap.error), '上限', '拒绝原因说明是小时上限');

        await imgMock.close();
    } else {
        skip('带图邮件端到端', '无法生成测试用自签证书：' + certResult.error);
    }

    // ---------------- 10. 「已确认」才发，「待确认」要说清楚 ----------------
    section('10. 已确认 / 待确认');

    // 提醒只由已收盘K线上的买卖点触发，所以主题与正文都要点明这一点
    const conf = notify.composeSignalMail(markerSample());
    contains(conf.subject, '已确认', '主题点明这是已确认的买卖点');
    contains(conf.text, '【信号状态】', '正文有一段专讲信号状态');
    eq(conf.text.indexOf('已确认') >= 0, true, '正文标明已确认');
    contains(conf.text, '不会再变', '并说清「已确认」意味着什么');
    contains(conf.text, '只发已确认的信号', '明确本提醒只发已确认的信号');
    contains(conf.html, '信号状态', 'HTML 也有信号状态这一段');
    contains(conf.html, '已确认', 'HTML 标明已确认');

    // 没有待确认信号时也要写出来：不写，收信人就无法确认「图上只有已确认的点」
    contains(conf.text, '待确认', '没待确认信号时也保留「待确认」这一项');
    contains(conf.text, '无。当前没有未收盘的信号', '并如实写明没有');
    contains(conf.html, '当前没有未收盘的信号', 'HTML 同样写明没有');

    // 有待确认信号时：标出档位、价格、时间，并说清它不算数
    const pendSig = { side: 'sell', label: '卖出', strong: false, price: 2701.4, time: 1790279985, score: 41 };
    const withPend = notify.composeSignalMail(markerSample({ pendingSignal: pendSig }));
    contains(withPend.text, '卖出 · 2701.40', '正文里待确认信号带上档位与价格');
    contains(withPend.text, '还没收盘', '说明它还没收盘');
    contains(withPend.text, '随时可能翻转或消失', '说明它随时会变');
    contains(withPend.text, '不作为成交依据', '明确它不是成交依据');
    contains(withPend.text, '浅色箭头', '把图上那个箭头和它对应起来');
    contains(withPend.html, '不作为成交依据', 'HTML 同样说清');
    contains(withPend.html, '浅色箭头', 'HTML 里也对应到图上的浅色箭头');

    // 带图时，配图说明里也要点出浅色箭头 —— 图注与正文不能各说各话
    const pendChart = notify.composeSignalMail(markerSample({
        pendingSignal: pendSig, chart: { base64: imgB64 },
    }));
    contains(pendChart.html, '浅色箭头', '带图时配图说明里也点出浅色箭头');

    // 待确认信号绝不能喧宾夺主：主题只写已确认的那个
    contains(withPend.subject, '强烈买入', '主题仍是已确认的那个信号');
    eq(withPend.subject.indexOf('卖出'), -1, '主题不出现待确认信号的档位');

    // 老式的实时信号没有「待确认」这个概念，别凭空长出一段
    eq(notify.composeSignalMail(sampleSignal()).text.indexOf('【信号状态】'), -1,
        '实时信号的正文不出现【信号状态】段');
    eq(notify.composeSignalMail(sampleSignal()).html.indexOf('信号状态'), -1,
        '实时信号的 HTML 也不出现信号状态');

    // ---------------- 11. 验证码邮件（推送邮箱的验证） ----------------
    section('11. 验证码邮件');

    // 参数与配置问题先测：这部分不需要证书
    fs.rmSync(process.env.MAIL_CONFIG_FILE, { force: true });
    const vNoCfg = await notify.sendVerificationMail({ to: 'mine@qq.com', code: '123456' });
    eq(vNoCfg.ok, false, '没配发信账号时不谎报成功');
    contains(String(vNoCfg.error), '发信邮箱', '说明是发信配置的问题');

    fs.writeFileSync(process.env.MAIL_CONFIG_FILE, json({ provider: 'qq', user: 'a@qq.com', pass: 'x' }));
    const vBadTo = await notify.sendVerificationMail({ to: 'not-an-email', code: '123456' });
    eq(vBadTo.ok, false, '非法收件地址被拒绝');
    const vBadCode = await notify.sendVerificationMail({ to: 'a@b.com', code: 'abc' });
    eq(vBadCode.ok, false, '非 6 位数字的码被拒绝');

    if (creds) {
        const codeMock = await startMockSmtp({ creds, implicitTls: true });
        fs.writeFileSync(process.env.MAIL_CONFIG_FILE, json({
            host: 'localhost', port: codeMock.port, secure: true, ca: creds.caPem,
            user: 'sender@qq.com', pass: 'auth-code', to: 'me@qq.com',
        }));

        const vOk = await notify.sendVerificationMail({
            to: 'owner@qq.com', code: '042815', account: 'alice', ttlMinutes: 10,
        });
        eq(vOk.ok, true, '验证码邮件发送成功');
        eq(vOk.to, 'owner@qq.com', '发到了用户当场填的那个地址');

        const recv = codeMock.state.received[codeMock.state.received.length - 1];
        const wire = recv ? recv.data : '';
        contains(recv.commands.join(' | '), 'RCPT TO:<owner@qq.com>', 'RCPT TO 用的就是这个地址');
        contains(decodeRfc2047(headerOf(wire, 'Subject')), '042815', '主题里带上验证码（一眼能抄）');
        const body = decodePart(wire, 'text/plain');
        contains(body, '042815', '纯文本里有验证码');
        contains(body, '10 分钟', '说明有效期');
        contains(body, 'alice', '带上账号，便于确认是自己申请的');
        contains(decodePart(wire, 'text/html'), '042815', 'HTML 版同样有验证码');
        contains(wire, 'multipart/alternative', '验证码邮件不带图，仍是 alternative 结构');
        // 地址可能填错，所以这封信里不该出现任何行情或持仓内容
        eq(/买入|卖出|持仓|评分|价位/.test(body), false, '验证码邮件里不带任何行情或持仓内容');
        await codeMock.close();

        // 发信失败必须如实报错：否则用户会一直等一封永远不会到的邮件
        const deadCode = await startMockSmtp({ creds, implicitTls: true, rejectAuth: true });
        fs.writeFileSync(process.env.MAIL_CONFIG_FILE, json({
            host: 'localhost', port: deadCode.port, secure: true, ca: creds.caPem,
            user: 'sender@qq.com', pass: 'wrong',
        }));
        const vFail = await notify.sendVerificationMail({ to: 'owner@qq.com', code: '042815' });
        eq(vFail.ok, false, 'SMTP 认证失败时如实报错');
        contains(String(vFail.error), '535', '错误里带服务端返回码，便于定位');
        await deadCode.close();
    } else {
        skip('验证码邮件端到端', '无法生成测试用自签证书：' + certResult.error);
    }

    // ---------------- 收尾 ----------------
    console.log('\n' + '─'.repeat(56));
    console.log(`通过 ${passed}　失败 ${failed}${skipped ? '　跳过 ' + skipped : ''}`);
    if (failed) {
        console.log('\n失败项：');
        failures.forEach(f => console.log('  · ' + f));
        fs.rmSync(tmpDir, { recursive: true, force: true });
        process.exit(1);
    } else {
        console.log('全部通过');
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

main().catch(e => {
    console.error('\n测试自身出错：' + e.stack);
    process.exit(1);
});
