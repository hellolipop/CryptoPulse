'use strict';
/**
 * 买卖信号邮件提醒
 *
 * 组成：读配置 → 组装邮件内容（把「具体情况」写全）→ 节流去重 → 发信 → 记录
 *
 * 为什么服务端只是「被动发信」：信号全部由浏览器算出来（server/ 不引用
 * technical.js / signals.js，也不取行情）。所以这条链路是：
 *   浏览器算出信号 → 记录预测 → POST /api/notify → 这里发信
 * 代价是**必须有一个标签页开着**才会触发；要做到合上电脑也能收，需要服务端自己
 * 定时取行情算信号，那是另一套工程，不在当前范围内。
 *
 * 配置放 server/data/mail-config.json（已在 .gitignore 内，授权码不会进仓库）。
 * 可用 provider 简写省掉手填服务器地址，见下面的 PROVIDERS。
 */

const fs = require('fs');
const path = require('path');
const { sendMail, normalizeImage } = require('./mailer');

// 常用邮箱服务商的服务器地址。用简写可以避免「端口和加密方式不匹配」这类低级错误。
const PROVIDERS = {
    qq: { host: 'smtp.qq.com', port: 465, secure: true, hint: 'QQ 邮箱的密码要填「授权码」，在设置→账户里开启 SMTP 后生成' },
    '163': { host: 'smtp.163.com', port: 465, secure: true, hint: '163 邮箱的密码要填「授权码」，在设置→POP3/SMTP/IMAP 里开启并生成' },
    gmail: { host: 'smtp.gmail.com', port: 465, secure: true, hint: 'Gmail 需要先在账号里开启两步验证，再用生成的「应用专用密码」' },
    outlook: { host: 'smtp.office365.com', port: 587, secure: false, hint: 'Outlook/Office365 用 587 + STARTTLS' },
};

// 默认只发这四个方向性信号。观望（hold）不发 —— 它是「没有结论」，不是提醒。
const DIRECTIONAL = ['strong_buy', 'buy', 'strong_sell', 'sell'];

// 内嵌K线图的 Content-ID。正文里用 cid: 引用它，MIME 里挂同一个值，
// 两处必须一致，所以只在这一个地方定义。
const CHART_CID = 'chart@cryptopulse';

// 内嵌图 base64 的上限。真实一张约几十 KB，这个上限是为了挡住异常情况：
// 一张几 MB 的图会让邮件变得难收，而且 /api/notify 的请求体本身只有 2MB。
const MAX_CHART_BASE64 = 1200 * 1024;

const COOLDOWN_HOURS = 6;      // 同一币种+周期+信号类型，多久内不重复发
const MAX_PER_HOUR = 20;       // 兜底：一小时最多发多少封，防止逻辑出错时刷屏

function nowMs() { return Date.now(); }

function dataDir() { return path.join(__dirname, 'data'); }

// 路径可用环境变量覆盖。两个用途：测试指向临时文件（否则会写进你的真实配置与
// 发送记录），以及同时维护多份配置时切换。
function configFile() {
    return process.env.MAIL_CONFIG_FILE || path.join(dataDir(), 'mail-config.json');
}
function logFile() {
    return process.env.MAIL_LOG_FILE || path.join(dataDir(), 'notify-log.json');
}

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return fallback;
    }
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
}

/**
 * 读取并规整配置。返回 {configured:false, reason} 而不是抛异常 ——
 * 没配邮箱是正常状态（用户可能只想要站内功能），不该让服务起不来。
 */
function loadConfig() {
    const raw = readJson(configFile(), null);
    if (!raw) {
        return { configured: false, reason: '还没有配置邮箱：' + configFile() };
    }
    const preset = raw.provider ? PROVIDERS[String(raw.provider).toLowerCase()] : null;
    if (raw.provider && !preset) {
        return { configured: false, reason: '未知的 provider：' + raw.provider + '（可选：' + Object.keys(PROVIDERS).join(' / ') + '）' };
    }
    const host = raw.host || (preset && preset.host);
    const port = raw.port || (preset && preset.port);
    const secure = raw.secure !== undefined ? !!raw.secure : (preset ? preset.secure : port === 465);
    const missing = [];
    if (!host) missing.push('host');
    if (!port) missing.push('port');
    if (!raw.user) missing.push('user');
    if (!raw.pass) missing.push('pass');
    if (!raw.to) missing.push('to');
    if (missing.length) {
        return { configured: false, reason: '配置缺少字段：' + missing.join('、'), hint: preset ? preset.hint : undefined };
    }
    return {
        configured: true,
        config: {
            host, port, secure,
            user: raw.user,
            pass: raw.pass,
            from: raw.from || raw.user,
            to: raw.to,
            timeout: raw.timeout || 20000,
            // 可选：额外信任的 CA（文件路径或 PEM 内容）与 SNI 名。
            // 用于本机对某条证书链建不出信任路径的情况 —— 补 CA，而不是关校验。
            ca: raw.ca,
            servername: raw.servername,
        },
        hint: preset ? preset.hint : undefined,
    };
}

// ---------------- 内容组装 ----------------

const SIGNAL_LABEL = {
    strong_buy: '强烈买入',
    buy: '买入',
    strong_sell: '强烈卖出',
    sell: '卖出',
    hold: '观望',
};

const TF_LABEL = {
    '0.25': '15分钟', '0.5': '30分钟', '1': '1小时', '4': '4小时', '24': '日线', '168': '周线',
};

// 浏览器传来的是档位 key（state.sensitivity），这里翻成中文
const SENS_LABEL = { conservative: '保守', balanced: '均衡', sensitive: '灵敏' };

// 费率闸门的状态说明
const GATE_LABEL = {
    off: '关闭',
    funding: '开启（90 天资金费率分位 ≤33% 才买、≥67% 才卖）',
};

function gateText(key) {
    if (!key) return '';
    return GATE_LABEL[key] || key;
}

function sensText(key) {
    if (!key) return '';
    return SENS_LABEL[key] || key;
}

function tfText(tf) {
    return TF_LABEL[String(tf)] || (tf + '小时');
}

function fmtPrice(p) {
    if (typeof p !== 'number' || !isFinite(p)) return '—';
    if (p >= 1000) return p.toFixed(2);
    if (p >= 1) return p.toFixed(4);
    if (p >= 0.01) return p.toFixed(6);
    return p.toPrecision(4);
}

function fmtTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const FACTOR_LABEL = {
    technical: '技术面', volume: '量能', sentiment: '市场情绪', news: '消息面', derivatives: '衍生品',
};

const SUB_LABEL = {
    rsi: 'RSI', macd: 'MACD', ma: '均线排列', longMA: '长期均线', momentum: '短期动量',
    bollinger: '布林带', vwap: 'VWAP', stochRSI: 'StochRSI', kdj: 'KDJ',
    ahr999: 'AHR999', obv: 'OBV',
};

/**
 * 从信号里取出内嵌K线图。
 *
 * 返回 {image, dropped}：dropped 非空表示「本来带了图但用不了」，原因留给日志，
 * 好回答「为什么这封没有图」。
 *
 * 任何失败都不抛：一张配图不该让整条提醒发不出去。
 * 校验本身交给 mailer.normalizeImage —— 那套规则（只允许 image/*、只允许标准 base64、
 * 文件名与 Content-ID 只留安全字符）必须和真正拼 MIME 的地方是同一份，
 * 在两边各写一遍迟早会漂移。
 */
function chartImageOf(signal) {
    const raw = signal && signal.chart;
    if (!raw || typeof raw !== 'object' || !raw.base64) return { image: null, dropped: null };
    try {
        const image = normalizeImage({
            base64: raw.base64,
            contentType: raw.contentType || 'image/png',
            filename: `chart-${signal.coinId || 'coin'}-${signal.timeframe || ''}.png`,
            cid: CHART_CID,
        });
        if (!image) return { image: null, dropped: null };
        if (image.base64.length > MAX_CHART_BASE64) {
            return {
                image: null,
                dropped: `配图过大（${Math.round(image.base64.length / 1024)}KB，上限 ${Math.round(MAX_CHART_BASE64 / 1024)}KB）`,
            };
        }
        return { image, dropped: null };
    } catch (e) {
        return { image: null, dropped: e.message };
    }
}

/**
 * 组装提醒邮件。
 *
 * 内容取舍的理由：这条提醒的用途是「决定要不要动手」，所以最前面放结论与价格；
 * 紧接着是建议仓位（这是唯一带操作含义的字段）；再往下是因子分解，因为「为什么
 * 是这个结论」决定了要不要信它；最后才是指标读数与算法版本。
 *
 * @param {Object} s - 浏览器传来的信号快照
 * @returns {{subject:string, text:string, html:string}}
 */
function composeSignalMail(s) {
    const label = SIGNAL_LABEL[s.signalType] || s.signalText || s.signalType || '未知信号';
    const coin = s.coinSymbol || s.coinId || '未知币种';
    const tf = tfText(s.timeframe);
    const score = (s.score === null || s.score === undefined) ? '—' : s.score;
    // 来自K线买卖点，也就是「已开启交易」的那些币种的成交依据。
    // 它与界面上的「综合评分」不是同一个量：综合分是五个因子加权出来的，
    // 买卖点用的是灵敏度档位下的技术面+量能评分。所以下面两个分值要分开叫。
    const isMarker = s.source === 'paper-marker';

    // 配图：有无与正文措辞必须一致，所以在组装内容这一步就定下来，
    // 而不是发信时再单独判断 —— 否则会出现「正文说见内嵌图，实际没附图」。
    const chart = chartImageOf(s);
    const image = chart.image;

    const subject = isMarker
        ? `[CryptoPulse] ${label} · ${coin} ${tf}｜K线买卖点（${score}分）`
        : `[CryptoPulse] ${label} · ${coin} ${tf}（${score}分）`;

    const f = s.factors || {};
    const bd = f.breakdown || {};
    const w = f.weights || {};
    const tb = f.technicalBreakdown || {};
    const ind = f.indicators || {};
    const vol = f.volumeMetrics || {};

    // ---- 纯文本 ----
    const t = [];
    t.push(`${label}：${coin} / ${tf}`);
    t.push('');
    t.push(`信号价格    ${fmtPrice(s.price)}${isMarker ? '（该K线收盘价）' : ''}`);
    t.push(`${isMarker ? '买卖点评分' : '综合评分'}    ${score}${s.sensitivity ? '（灵敏度：' + sensText(s.sensitivity) + '）' : ''}`);
    if (s.markerTime) t.push(`K线时间    ${fmtTime(s.markerTime * 1000)}`);
    t.push(`触发时间    ${fmtTime(s.predictedAt)}`);
    if (s.actionTip) t.push(`仓位建议    ${s.actionTip}`);
    if (s.execPrice) {
        t.push(`成交口径    该K线收盘后、按下一根K线开盘价成交（${fmtTime(s.execTime * 1000)} · 约 ${fmtPrice(s.execPrice)}）`);
    }
    if (image) {
        t.push('K线图    见邮件内嵌图；图中竖虚线标出本次买卖点所在的那根K线');
    }
    t.push('');

    // 五因子分解只有老式的实时信号才有：K线买卖点带的是一套自己的评分口径，
    // 没有这五个因子的分数。没有内容时整段不出现 —— 只留一个空标题会让人以为
    // 明细丢了（第一版就是这样，肉眼过一遍渲染结果才看出来）。
    const factorLines = Object.keys(FACTOR_LABEL).filter(k => bd[k] !== undefined).map(k => {
        const weight = w[k] === undefined ? '—' : w[k];
        return `  ${FACTOR_LABEL[k].padEnd(5, '　')} ${String(bd[k]).padStart(3)} 分   权重 ${weight}`;
    });
    if (factorLines.length) {
        t.push('【五因子分解】');
        factorLines.forEach(l => t.push(l));
        t.push('');
    }

    const subs = ['rsi', 'macd', 'ma', 'longMA', 'momentum', 'bollinger', 'vwap', 'stochRSI', 'kdj', 'ahr999', 'obv'];
    const subLines = subs.filter(k => tb[k] !== undefined).map(k => {
        const v = tb[k];
        if (v && typeof v === 'object') {
            // 长期均线是个对象：记录了实际用的窗口与是否降级
            return `  ${SUB_LABEL[k]}：窗口 MA${v.window}${v.substituted ? '（降级）' : ''}`;
        }
        return `  ${SUB_LABEL[k]}：${v > 0 ? '+' : ''}${v}`;
    });
    if (subLines.length) {
        t.push('【技术面子因子】');
        subLines.forEach(l => t.push(l));
        t.push('');
    }

    const readings = [];
    if (ind.rsi !== undefined && ind.rsi !== null) readings.push(`RSI(14) ${Number(ind.rsi).toFixed(1)}`);
    const macd = ind.macd || {};
    if (macd.macd !== undefined && macd.macd !== null) readings.push(`MACD ${Number(macd.macd).toFixed(2)}`);
    if (macd.histogram !== undefined && macd.histogram !== null) readings.push(`MACD柱 ${Number(macd.histogram).toFixed(2)}`);
    const kdj = ind.kdj || {};
    if (kdj.k !== undefined && kdj.k !== null) readings.push(`KDJ ${Number(kdj.k).toFixed(1)}/${Number(kdj.d).toFixed(1)}`);
    if (ind.ma7 !== undefined && ind.ma7 !== null) readings.push(`MA7 ${fmtPrice(ind.ma7)}`);
    if (ind.ma25 !== undefined && ind.ma25 !== null) readings.push(`MA25 ${fmtPrice(ind.ma25)}`);
    if (ind.ma200 !== undefined && ind.ma200 !== null) readings.push(`MA200 ${fmtPrice(ind.ma200)}`);
    if (vol.ratio !== undefined && vol.ratio !== null) readings.push(`量比 ${Number(vol.ratio).toFixed(2)}`);
    if (s.fundingPercentile !== undefined && s.fundingPercentile !== null) {
        readings.push(`资金费率分位 ${(Number(s.fundingPercentile) * 100).toFixed(0)}%`);
    }
    if (readings.length) {
        t.push('【关键读数】');
        t.push('  ' + readings.join('　'));
        t.push('');
    }

    if (s.gate) t.push(`费率闸门    ${gateText(s.gate)}`);
    if (isMarker && s.gate && s.gate !== 'off') {
        t.push('            （后台扫描拿不到其他币种的资金费率分位，本次未对闸门求值，');
        t.push('             实际是否成交以模拟盘为准）');
    }
    t.push(`算法版本    ${s.algoVersion || '—'}`);
    t.push('');
    t.push('——');
    t.push(isMarker
        ? '这条提醒来自你已开启交易的币种：只要出现新的K线买卖点就会发。扫描在浏览器里进行，因此只在有标签页打开时生效。'
        : '这条提醒由 CryptoPulse 在网页端探测到信号切换时触发，因此只在有标签页打开时生效。');
    t.push('信号是统计结果，不构成投资建议；本系统实测的方向性准确率并不高，请自行判断。');

    // ---- HTML ----
    const row = (k, v) => `<tr><th style="text-align:left;padding:6px 12px 6px 0;color:#6b7280;font-weight:500;white-space:nowrap">${esc(k)}</th>`
        + `<td style="padding:6px 0;color:#111827">${esc(v)}</td></tr>`;

    const factorRows = Object.keys(FACTOR_LABEL).filter(k => bd[k] !== undefined).map(k => {
        const weight = w[k] === undefined ? '—' : w[k];
        const val = Number(bd[k]);
        const color = val >= 60 ? '#059669' : (val <= 40 ? '#dc2626' : '#111827');
        return `<tr>`
            + `<td style="padding:5px 12px 5px 0;color:#374151">${esc(FACTOR_LABEL[k])}</td>`
            + `<td style="padding:5px 0;color:${color};font-variant-numeric:tabular-nums"><b>${esc(val)}</b></td>`
            + `<td style="padding:5px 0 5px 10px;color:#9ca3af;font-variant-numeric:tabular-nums">权重 ${esc(weight)}</td>`
            + `</tr>`;
    }).join('');

    const subChips = subs.filter(k => tb[k] !== undefined).map(k => {
        const v = tb[k];
        const text = (v && typeof v === 'object')
            ? `${SUB_LABEL[k]} MA${v.window}${v.substituted ? '(降级)' : ''}`
            : `${SUB_LABEL[k]} ${v > 0 ? '+' : ''}${v}`;
        const color = (v && typeof v === 'object') ? '#6b7280' : (v > 0 ? '#059669' : (v < 0 ? '#dc2626' : '#9ca3af'));
        return `<span style="display:inline-block;margin:0 6px 6px 0;padding:2px 8px;border-radius:9999px;`
            + `background:#f3f4f6;color:${color};font-size:12px">${esc(text)}</span>`;
    }).join('');

    const accent = (s.signalType === 'strong_buy' || s.signalType === 'buy') ? '#059669' : '#dc2626';

    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111827">
  <div style="border-left:4px solid ${accent};padding-left:14px;margin-bottom:20px">
    <div style="font-size:13px;color:#6b7280;letter-spacing:.5px">CryptoPulse 信号提醒</div>
    <div style="font-size:24px;font-weight:700;color:${accent};margin-top:4px">${esc(label)} · ${esc(coin)} ${esc(tf)}</div>
    <div style="font-size:13px;color:#6b7280;margin-top:4px">${esc(fmtTime(s.predictedAt))}</div>
  </div>

  <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:18px">
    ${row('信号价格', fmtPrice(s.price) + (isMarker ? '（该K线收盘价）' : ''))}
    ${row(isMarker ? '买卖点评分' : '综合评分', score + (s.sensitivity ? '（灵敏度：' + sensText(s.sensitivity) + '）' : ''))}
    ${s.markerTime ? row('K线时间', fmtTime(s.markerTime * 1000)) : ''}
    ${s.actionTip ? row('仓位建议', s.actionTip) : ''}
    ${s.execPrice ? row('成交口径', fmtTime(s.execTime * 1000) + ' 开盘价成交（约 ' + fmtPrice(s.execPrice) + '）') : ''}
    ${s.gate ? row('费率闸门', gateText(s.gate)) : ''}
  </table>
  ${image ? `<div style="margin:14px 0 4px"><img src="cid:${CHART_CID}" alt="${esc(coin)} ${esc(tf)} K线图" style="width:100%;max-width:960px;height:auto;border:1px solid #e5e7eb;border-radius:6px;display:block"></div>
  <div style="font-size:12px;color:#9ca3af;margin:0 0 4px">K线图与页面上的买卖点标注同源；图中竖虚线标出本次买卖点所在的那根K线。</div>` : ''}
  ${isMarker && s.gate && s.gate !== 'off' ? `<div style="font-size:12px;color:#9ca3af;margin:-10px 0 16px">后台扫描拿不到其他币种的资金费率分位，本次未对闸门求值；实际是否成交以模拟盘为准。</div>` : ''}

  ${factorRows ? `<div style="font-size:13px;font-weight:600;color:#374151;margin:18px 0 8px">五因子分解</div>
  <table style="width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums">${factorRows}</table>` : ''}

  ${subChips ? `<div style="font-size:13px;font-weight:600;color:#374151;margin:18px 0 8px">技术面子因子</div><div>${subChips}</div>` : ''}

  ${readings.length ? `<div style="font-size:13px;font-weight:600;color:#374151;margin:18px 0 8px">关键读数</div>
  <div style="font-size:13px;color:#374151;line-height:1.9;font-variant-numeric:tabular-nums">${readings.map(esc).join('　')}</div>` : ''}

  <div style="margin-top:22px;padding-top:14px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;line-height:1.7">
    算法版本 ${esc(s.algoVersion || '—')}<br>
    ${isMarker
        ? '这条提醒来自你已开启交易的币种：只要出现新的K线买卖点就会发。扫描在浏览器里进行，因此<b>只在有标签页打开时</b>生效。'
        : '这条提醒由 CryptoPulse 在网页端探测到信号切换时触发，因此<b>只在有标签页打开时</b>生效。'}<br>
    信号是统计结果，不构成投资建议；本系统实测的方向性准确率并不高，请自行判断。
  </div>
</div>`;

    return { subject, text: t.join('\n'), html, image, chartDropped: chart.dropped };
}

function esc(v) {
    return String(v === null || v === undefined ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------- 节流与记录 ----------------

/**
 * 一条提醒的身份标识。
 *
 * 带 markerTime 的（K线买卖点）用「币种+周期+那根K线的时间」—— 一个买卖点就是
 * 一根K线上的事，标识唯一，发过就不会再发。
 *
 * 不带的退回「币种+周期+信号类型」，配合冷却期使用。
 */
function noticeKeyOf(signal) {
    const base = `${signal.coinId}|${signal.timeframe}`;
    return signal.markerTime ? `${base}|${signal.markerTime}` : `${base}|${signal.signalType}`;
}

/**
 * 是否应当发送。两个约束：
 *   1) 同一个买卖点只发一次。K线买卖点在每根K线收盘时都可能出现，而扫描是反复跑的，
 *      不去重会变成同一件事反复提醒。这里按「币种+周期+K线时间」精确去重，
 *      **不套冷却期** —— 套了会误伤正常的多空交替（1 小时周期上十分钟内
 *      买→卖→买是完全正常的）。
 *   2) 一小时总量上限，兜底防逻辑出错时刷屏。
 * @returns {{allow:boolean, reason?:string, key:string}}
 */
function checkThrottle(signal, log, now) {
    const key = noticeKeyOf(signal);
    const logs = Array.isArray(log) ? log : [];
    const t = now || nowMs();

    const recent = logs.filter(e => e && e.ok);
    const dup = recent.filter(e => e.key === key).pop();

    if (dup && signal.markerTime) {
        return { allow: false, reason: '这个买卖点已经提醒过了', key };
    }
    if (dup) {
        const cooldownMs = COOLDOWN_HOURS * 3600 * 1000;
        if (t - dup.at < cooldownMs) {
            const mins = Math.ceil((cooldownMs - (t - dup.at)) / 60000);
            return { allow: false, reason: `同一信号在冷却期内（还要等约 ${mins} 分钟）`, key };
        }
    }

    const lastHour = recent.filter(e => t - e.at < 3600 * 1000).length;
    if (lastHour >= MAX_PER_HOUR) {
        // hard：这一条任何情况下都不许绕过。
        // force 的用途是「同一条再发一次看看」（自检、预览），
        // 不该连「一小时最多几封」这个兜底也一起打开 —— 那不是调试，那是刷屏。
        return { allow: false, hard: true, reason: `一小时内的发送量已达上限 ${MAX_PER_HOUR} 封`, key };
    }
    return { allow: true, key };
}

function appendLog(entry) {
    const logs = readJson(logFile(), []);
    logs.push(entry);
    // 只留最近 200 条，别让这个文件无限长
    writeJson(logFile(), logs.slice(-200));
}

// ---------------- 对外入口 ----------------

/**
 * 发一条信号提醒。任何失败都返回结果对象而不是抛异常 —— 调用方是 HTTP 接口，
 * 不该因为邮件发不出去把请求打成 500。
 *
 * @param {Object} signal - 浏览器传来的信号快照
 * @param {Object} [opts] - { force: 跳过节流（用于测试）, dryRun: 只组装不发送 }
 */
async function sendSignalMail(signal, opts) {
    const o = opts || {};
    if (!signal || !signal.signalType) return { ok: false, error: '缺少信号内容' };
    if (!o.force && DIRECTIONAL.indexOf(signal.signalType) < 0) {
        return { ok: false, skipped: true, error: '该信号不在提醒范围内（只发买入与卖出类）' };
    }

    const cfgState = loadConfig();
    if (!cfgState.configured) {
        return { ok: false, skipped: true, error: cfgState.reason, hint: cfgState.hint };
    }

    const log = readJson(logFile(), []);
    const check = checkThrottle(signal, log, nowMs());
    // force 能越过「同一点已发过」与冷却期，但越不过小时上限（check.hard）
    if (!check.allow && !(o.force && !check.hard)) {
        return { ok: false, skipped: true, error: check.reason };
    }

    const mail = composeSignalMail(signal);
    if (mail.chartDropped) {
        // 有图但用不了：照发文字邮件，但留个痕，免得「为什么没图」查不出来
        console.warn('[提醒] 本次不带配图：' + mail.chartDropped);
    }
    if (o.dryRun) {
        return {
            ok: true, dryRun: true, subject: mail.subject, text: mail.text, html: mail.html,
            hasChart: !!mail.image, chartDropped: mail.chartDropped || null,
        };
    }

    // 收件地址默认取配置里的；opts.to 只在本次发送里覆盖（自检工具用）
    const toAddress = o.to || cfgState.config.to;

    try {
        const sent = await sendMail({
            config: cfgState.config,
            to: toAddress,
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
            image: mail.image,
        });
        appendLog({
            at: nowMs(), ok: true, key: check.key,
            coinId: signal.coinId, timeframe: signal.timeframe, signalType: signal.signalType,
            score: signal.score, to: toAddress, messageId: sent.messageId,
            chart: !!mail.image,
            chartError: mail.chartDropped || undefined,
        });
        return { ok: true, to: toAddress, subject: mail.subject, messageId: sent.messageId, elapsedMs: sent.elapsedMs };
    } catch (e) {
        appendLog({
            at: nowMs(), ok: false, key: check.key,
            coinId: signal.coinId, timeframe: signal.timeframe, signalType: signal.signalType,
            error: e.message,
        });
        return { ok: false, error: '发送失败：' + e.message };
    }
}

module.exports = {
    PROVIDERS, DIRECTIONAL, COOLDOWN_HOURS, MAX_PER_HOUR, MAX_CHART_BASE64, CHART_CID,
    loadConfig, composeSignalMail, checkThrottle, sendSignalMail,
    configFile, logFile, tfText, fmtPrice,
};
