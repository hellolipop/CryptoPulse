'use strict';
/**
 * 极简 SMTP 客户端 + MIME 组装
 *
 * 为什么手写而不引入 nodemailer：本项目是零依赖的（没有 package.json / node_modules），
 * 部署方式就是 `node server/store.js` 加一个静态文件服务。为了发信引入第一棵树状的
 * 依赖，会把「拷过去就能跑」这件事弄没。这里需要的能力其实很小：EHLO、AUTH、投递。
 *
 * 支持两种连接方式：
 *   - 隐式 TLS（465 端口，连上就是 TLS）：QQ / 163 / Gmail 都支持，推荐
 *   - STARTTLS（587 端口，先明文再升级）：老式配置，也支持
 *
 * 证书校验**保持开启**。发信凭据比行情数据更敏感，遇到本机对某条证书链建不出信任
 * 路径时（这台机器上 Node 对某些链就是如此），正确做法是补齐 CA 或换通道，
 * 绝不是 rejectUnauthorized:false。
 *
 * 正文一律用 base64（RFC 2045 要求按 76 列折行）。这样做除了省掉 quoted-printable
 * 的编码转换，还顺带解决了两个坑：中文不需要额外处理；base64 的字母表里没有「.」，
 * 所以永远不会出现行首单个句点，也就不必做 SMTP 的点填充。
 */

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const crypto = require('crypto');

const CRLF = '\r\n';
const DEFAULT_TIMEOUT = 20000;

function b64(s) {
    return Buffer.from(s, 'utf8').toString('base64');
}

/** base64 按 76 列折行 */
function wrap76(s) {
    return s.replace(/(.{76})/g, '$1' + CRLF);
}

/** 非 ASCII 的头部值要用 RFC 2047 编码，否则中文主题在客户端里是乱码 */
function encodeHeader(value) {
    const s = String(value);
    // 拆开写是为了避开正则里的控制字符字面量，含义是「全部落在可打印 ASCII 内」
    const printableAscii = /^[\u0020-\u007E]*$/;
    return printableAscii.test(s) ? s : '=?UTF-8?B?' + b64(s) + '?=';
}

/** RFC 2822 的日期格式，必须是英文星期与月份 */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function rfc2822Date(d) {
    const pad = n => String(n).padStart(2, '0');
    // 时区必须带正负号：RFC 2822 要求「+0800」这种形式，漏掉符号（写成 0800）
    // 会让严格的邮件客户端解析失败。getTimezoneOffset 的符号与 UTC 偏移相反。
    const offMinutes = -d.getTimezoneOffset();
    const sign = offMinutes >= 0 ? '+' : '-';
    const abs = Math.abs(offMinutes);
    const zone = sign + pad(Math.floor(abs / 60)) + pad(abs % 60);
    return `${DAYS[d.getDay()]}, ${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${zone}`;
}

/**
 * 组装整封邮件的字节流（不含 SMTP 命令）
 * @returns {{message: string, messageId: string}}
 */
function buildMessage({ from, to, subject, text, html, image, now }) {
    const rand = () => crypto.randomBytes(12).toString('hex');
    const messageId = '<' + rand() + '@cryptopulse.local>';
    const date = rfc2822Date(now || new Date());

    const head = contentType => [
        'From: ' + encodeHeader('CryptoPulse') + ' <' + from + '>',
        'To: <' + to + '>',
        'Subject: ' + encodeHeader(subject),
        'Date: ' + date,
        'Message-ID: ' + messageId,
        'MIME-Version: 1.0',
        'Content-Type: ' + contentType,
    ];

    const part = (boundary, mime, body) => [
        '--' + boundary,
        'Content-Type: ' + mime + '; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        wrap76(b64(body)),
    ];

    const img = normalizeImage(image);

    // 没有图时保持原样：最外层就是 multipart/alternative。
    // 不动这条路径是有意的 —— 纯文字邮件是最常用、也最不能出问题的那条。
    if (!img) {
        const boundary = 'cp-' + rand();
        return {
            messageId,
            message: [
                ...head('multipart/alternative; boundary="' + boundary + '"'),
                '',
                ...part(boundary, 'text/plain', text),
                ...part(boundary, 'text/html', html),
                '--' + boundary + '--',
                '',
            ].join(CRLF),
        };
    }

    // 有图时用 multipart/related 把「正文 + 内嵌图」绑在一起：
    // 正文里的 <img src="cid:..."> 只有在这种结构下才会被客户端当场显示，
    // 而不是变成一个需要手动打开的附件。RFC 2387 说的就是这个用法。
    const alt = 'cp-alt-' + rand();
    const rel = 'cp-rel-' + rand();
    const lines = [
        ...head('multipart/related; boundary="' + rel + '"; type="multipart/alternative"'),
        '',
        // 没有 MIME 能力的客户端会显示这段 preamble，写点有用的
        '这是一封多部分邮件，请用支持 MIME 的客户端查看。',
        '',
        '--' + rel,
        'Content-Type: multipart/alternative; boundary="' + alt + '"',
        '',
        ...part(alt, 'text/plain', text),
        ...part(alt, 'text/html', html),
        '--' + alt + '--',
        '',
        '--' + rel,
        'Content-Type: ' + img.contentType + '; name="' + img.filename + '"',
        'Content-Transfer-Encoding: base64',
        'Content-Disposition: inline; filename="' + img.filename + '"',
        'Content-ID: <' + img.cid + '>',
        '',
        wrap76(img.base64),
        '--' + rel + '--',
        '',
    ];
    return { message: lines.join(CRLF), messageId };
}

/**
 * 校验并规整内嵌图片。
 *
 * 两个必须挡住的东西：
 *   - 文件名与 Content-ID 会直接拼进头部。带换行的值能把额外头部注入进来，
 *     所以这里只留安全字符，而不是「原样透传再指望上层传干净」。
 *   - contentType 只允许 image/*，否则一个 text/html 的「图片」就能绕过正文编码。
 *
 * 返回 null 表示没有可用的图（调用方按纯文字发）。
 */
function normalizeImage(image) {
    if (!image || typeof image !== 'object') return null;
    const raw = typeof image.base64 === 'string' ? image.base64.trim() : '';
    // 允许上游直接给 data URL，省得两边各写一次拆前缀的代码
    const base64 = raw.replace(/^data:[^;,]*;base64,/, '').replace(/\s+/g, '');
    if (!base64) return null;
    // 只允许标准 base64，避免把任意字节塞进 MIME 体里
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
        throw new Error('内嵌图片不是合法的 base64');
    }

    const contentType = String(image.contentType || 'image/png').toLowerCase();
    if (!/^image\/[a-z0-9.+-]+$/.test(contentType)) {
        throw new Error('内嵌图片的 Content-Type 只能是 image/*，收到：' + contentType);
    }

    const safe = (v, fallback) => {
        const s = String(v === undefined || v === null ? '' : v)
            .replace(/[^A-Za-z0-9._@-]/g, '');
        return s || fallback;
    };
    const ext = contentType === 'image/jpeg' ? 'jpg' : contentType.split('/')[1];
    return {
        base64,
        contentType,
        filename: safe(image.filename, 'chart.' + ext),
        cid: safe(image.cid, 'chart@cryptopulse'),
    };
}

/**
 * 一次 SMTP 会话。
 * 把「发一条命令、等响应码」封装成可 await 的一步，并处理多行响应
 * （SMTP 的多行响应形如 `250-XXX` 续行、`250 XXX` 结尾）。
 */
class SmtpSession {
    constructor(socket, timeout) {
        this.socket = socket;
        this.timeout = timeout || DEFAULT_TIMEOUT;
        this.buffer = '';
        this.pending = null;
        this.failure = null;
        this.closed = false;

        this._onData = chunk => {
            this.buffer += chunk.toString('utf8');
            this._settle();
        };
        this._onError = err => {
            this.failure = err;
            this._settle();
        };
        this._onClose = () => {
            this.closed = true;
            this._settle();
        };
        socket.on('data', this._onData);
        socket.on('error', this._onError);
        socket.on('close', this._onClose);
    }

    _settle() {
        if (!this.pending) return;
        const lines = this.buffer.split(CRLF).filter(l => l !== '');
        if (!lines.length) return;
        const last = lines[lines.length - 1];
        // 结尾行的格式是「三位码 + 空格」，中间行是「三位码 + 连字符」
        if (!/^\d{3} /.test(last)) {
            if (this.failure) {
                const p = this.pending;
                this.pending = null;
                p.reject(this.failure);
            } else if (this.closed) {
                const p = this.pending;
                this.pending = null;
                p.reject(new Error('连接在收到完整响应前被关闭'));
            }
            return;
        }
        this.buffer = '';
        const p = this.pending;
        this.pending = null;
        p.resolve({ code: parseInt(last.slice(0, 3), 10), lines });
    }

    read() {
        return new Promise((resolve, reject) => {
            this.pending = { resolve, reject };
            this._settle();
        });
    }

    /** 发一条命令并读取响应；codes 里给出可接受的响应码 */
    async command(line, codes) {
        const expect = codes || [250];
        const r = await this._write(line);
        if (!expect.includes(r.code)) {
            const detail = r.lines.join(' | ');
            throw new Error(`SMTP ${line.split(' ')[0]} 被拒绝：${detail}`);
        }
        return r;
    }

    _write(line) {
        this.socket.write(line + CRLF);
        return this._race(this.read());
    }

    _race(promise) {
        return Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('SMTP 响应超时（' + this.timeout + 'ms）')), this.timeout
            )),
        ]);
    }

    /** 读取欢迎语，等的是 220 */
    async greeting() {
        const r = await this._race(this.read());
        if (r.code !== 220) throw new Error('SMTP 未正常问候：' + r.lines.join(' | '));
        return r;
    }

    /** 发 EHLO 并返回服务端声明的能力（如 AUTH、STARTTLS） */
    async ehlo(clientName) {
        const r = await this.command('EHLO ' + clientName, [250]);
        const caps = [];
        r.lines.slice(1).forEach(l => {
            const text = l.slice(4).trim();
            if (text) caps.push(text);
        });
        return caps;
    }

    /**
     * 只摘掉监听、不关闭 socket。
     * STARTTLS 升级时必须用这个：socket 要留着交给 TLS 层，关掉就没法升级了。
     */
    detach() {
        try {
            this.socket.removeListener('data', this._onData);
            this.socket.removeListener('error', this._onError);
            this.socket.removeListener('close', this._onClose);
        } catch (e) { /* 已经不在了就算了 */ }
    }

    destroy() {
        this.detach();
        try {
            this.socket.destroy();
        } catch (e) { /* 已经不在了就算了 */ }
    }
}

/** 认证：优先 AUTH PLAIN（一次往返），否则用 AUTH LOGIN（两次） */
async function authenticate(session, caps, user, pass) {
    const authLine = caps.find(c => /^AUTH\b/i.test(c)) || '';
    const methods = authLine.toUpperCase().split(/\s+/).slice(1);

    if (methods.includes('PLAIN')) {
        const token = Buffer.from('\u0000' + user + '\u0000' + pass, 'utf8').toString('base64');
        await session.command('AUTH PLAIN ' + token, [235]);
        return 'PLAIN';
    }
    if (methods.includes('LOGIN') || methods.length === 0) {
        await session.command('AUTH LOGIN', [334]);
        await session.command(Buffer.from(user, 'utf8').toString('base64'), [334]);
        await session.command(Buffer.from(pass, 'utf8').toString('base64'), [235]);
        return 'LOGIN';
    }
    throw new Error('服务端不支持 AUTH PLAIN / LOGIN，声明的是：' + authLine);
}

function connectPlain(host, port, timeout) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host, port });
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('连接超时')); }, timeout);
        socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
        socket.once('error', err => { clearTimeout(timer); reject(err); });
    });
}

/**
 * 组装 TLS 连接参数。
 *
 * SNI（servername）不能是 IP 地址 —— Node 会直接抛
 * 「Setting the TLS ServerName to an IP address is not permitted」。
 * 配置里写 IP（内网邮件服务器很常见）就会踩到，所以这里显式判断，
 * 只有真是主机名时才发 SNI。证书校验本身不受影响：没有 SNI 时
 * Node 仍会用 IP 去比对证书里的 IP SAN。
 */
function tlsOptionsFor(host, tlsOptions) {
    const opts = Object.assign({}, tlsOptions || {});
    if (!opts.servername && net.isIP(host) === 0) opts.servername = host;
    return opts;
}

/**
 * 证书校验失败时，把「该往哪修」直接写进错误信息。
 *
 * 这台机器上真的踩到过，而且和邮箱配置毫无关系：当时的 Node 编译时链接的是系统
 * OpenSSL 库（node_shared_openssl = true），读的是系统 CA 存储；那份存储在这个
 * 环境下不完整，于是**连百度和苹果官网都验不过**。这种情况下往配置里补 ca 是没用的
 * —— 缺的不是某一个中间证书，而是整份根证书列表。
 *
 * 两种成因给两种建议，不混在一起说，也不提供关闭校验这个选项。
 */
function explainCertError(err) {
    const e = err instanceof Error ? err : new Error(String(err));
    if (e.certHint) return e;
    const text = (e.code || '') + ' ' + (e.message || '');
    if (!/CERT|certificate|self.signed/i.test(text)) return e;

    const shared = !!(process.config && process.config.variables
        && process.config.variables.node_shared_openssl);
    e.certHint = shared
        ? `这个 Node（${process.version}）编译时链接的是系统 OpenSSL 库，读的就是系统 CA 存储。`
          + '它不完整时任何站点都验不过，与邮箱配置无关；补 ca 也没用（缺的是整份根证书列表）。'
          + '换用官方 Node，或用 NODE_OPTIONS=--use-bundled-ca 让它读 Node 自带的证书列表。'
        : '若只是这条证书链缺一个中间证书或根证书，用配置里的 ca 指明它 —— 而不是关闭校验。';
    e.message = e.message + '\n  → ' + e.certHint;
    return e;
}

function connectTls(host, port, timeout, plainSocket, tlsOptions) {
    const opts = tlsOptionsFor(host, tlsOptions);
    return new Promise((resolve, reject) => {
        const socket = plainSocket
            ? tls.connect(Object.assign({ socket: plainSocket }, opts))
            : tls.connect(Object.assign({ host, port }, opts));
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('TLS 建立超时')); }, timeout);
        socket.once('secureConnect', () => { clearTimeout(timer); resolve(socket); });
        socket.once('error', err => { clearTimeout(timer); reject(explainCertError(err)); });
    });
}

/**
 * 读取额外信任的 CA。
 *
 * 存在的意义：这台机器上 Node 对某些证书链建不出信任路径（见 repair-prediction-review.js
 * 里的同类问题）。遇到这种情况正确做法是补上 CA，而不是关掉校验 —— 所以这里只提供
 * 「多信谁」，不提供「不校验」。
 *
 * @param {string} ca - 文件路径，或直接是 PEM 内容
 */
function loadCa(ca) {
    if (!ca) return null;
    if (/-----BEGIN CERTIFICATE-----/.test(ca)) return ca;
    return fs.readFileSync(ca, 'utf8');
}

/**
 * 发送一封邮件。
 *
 * @param {Object} opts
 * @param {Object} opts.config - { host, port, secure, user, pass, from, fromName }
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} opts.text - 纯文本正文（客户端不支持 HTML 时用）
 * @param {string} opts.html - HTML 正文
 * @param {Object} [opts.image] - 内嵌图 {base64, contentType, filename, cid}
 * @returns {Promise<Object>} { messageId, auth, elapsedMs }
 */
async function sendMail(opts) {
    const cfg = opts.config || {};
    if (!cfg.host || !cfg.port) throw new Error('缺少 SMTP 服务器地址或端口');
    if (!cfg.user || !cfg.pass) throw new Error('缺少 SMTP 账号或授权码');
    const from = cfg.from || cfg.user;
    const to = opts.to || cfg.to;
    if (!to) throw new Error('缺少收件地址');

    const timeout = cfg.timeout || DEFAULT_TIMEOUT;
    const clientName = cfg.clientName || 'cryptopulse.local';
    const started = Date.now();

    // 465 是隐式 TLS；其余（如 587）先明文再 STARTTLS
    const secure = cfg.secure !== undefined ? cfg.secure : cfg.port === 465;

    // 只允许「多信一个 CA」，不提供关闭校验的开关
    const tlsOptions = {};
    const ca = loadCa(cfg.ca);
    if (ca) tlsOptions.ca = ca;
    if (cfg.servername) tlsOptions.servername = cfg.servername;

    let session;
    let auth = '';
    try {
        if (secure) {
            session = new SmtpSession(await connectTls(cfg.host, cfg.port, timeout, null, tlsOptions), timeout);
        } else {
            session = new SmtpSession(await connectPlain(cfg.host, cfg.port, timeout), timeout);
        }
        await session.greeting();

        let caps = await session.ehlo(clientName);

        if (!secure) {
            if (!caps.some(c => /^STARTTLS\b/i.test(c))) {
                throw new Error('该端口未提供 STARTTLS，若服务商要求加密请改用 465 端口');
            }
            // 必须先真的发出 STARTTLS 并等服务端回 220，再升级。
            // 漏掉这一步的后果很隐蔽：服务端还在等命令，客户端却已经开始握手，
            // 双方各自苦等，最后表现为「TLS 建立超时」。
            await session.command('STARTTLS', [220]);
            // 升级前先摘掉旧 socket 上的监听（注意是 detach 而不是 destroy ——
            // socket 要留给 TLS 层），否则旧监听会吃掉握手的字节
            const plain = session.socket;
            session.detach();
            const upgraded = await connectTls(cfg.host, cfg.port, timeout, plain, tlsOptions);
            session = new SmtpSession(upgraded, timeout);
            caps = await session.ehlo(clientName);
        }

        auth = await authenticate(session, caps, cfg.user, cfg.pass);

        await session.command('MAIL FROM:<' + from + '>', [250]);
        await session.command('RCPT TO:<' + to + '>', [250, 251]);
        await session.command('DATA', [354]);

        const { message, messageId } = buildMessage({
            from,
            to,
            subject: opts.subject,
            text: opts.text,
            html: opts.html,
            // 内嵌图（可选）：正文里用 cid: 引用它，见 buildMessage
            image: opts.image,
        });
        await session.command(message + CRLF + '.', [250]);

        try { await session.command('QUIT', [221]); } catch (e) { /* 有些服务端直接断，不算失败 */ }

        return { messageId, auth, elapsedMs: Date.now() - started };
    } finally {
        if (session) session.destroy();
    }
}

module.exports = { sendMail, buildMessage, normalizeImage, encodeHeader, rfc2822Date, wrap76, SmtpSession };
