/**
 * 数字格式化。
 *
 * 不用 toLocaleString / Intl：小程序在不同机型上的 JS 引擎实现不一致，
 * 部分环境会忽略 locale 与 options，价格可能直接显示成一长串小数。
 * 所以千分位与小数位都自己拼，保证各端显示一致。
 */

function thousands(str) {
    const parts = String(str).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
}

/**
 * 转成数字，且把「空值」与「真的是 0」区分开。
 *
 * 不能只写 Number(v)：Number(null) === 0、Number('') === 0，
 * 于是缺失的价格会被显示成 0.000000 —— 看起来像币价归零，
 * 比显示 -- 危险得多。所以先显式排掉空值。
 */
function toNum(v) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return NaN;
    const n = Number(v);
    return isFinite(n) ? n : NaN;
}

/** 价格：按量级自适应小数位，与网页端 formatPrice 的口径一致 */
function price(v) {
    const n = toNum(v);
    if (isNaN(n)) return '--';
    const abs = Math.abs(n);
    let digits;
    if (abs >= 1) digits = 2;
    else if (abs >= 0.01) digits = 4;
    else digits = 6;
    return thousands(n.toFixed(digits));
}

/** 带正负号的百分比：+1.23% / -1.23% */
function pct(v) {
    const n = toNum(v);
    if (isNaN(n)) return '--';
    return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

/** 金额：中文单位，亿 / 万 */
function amount(v) {
    const n = toNum(v);
    if (isNaN(n) || n === 0) return '--';
    if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(2) + '万';
    return n.toFixed(2);
}

/** 大数字：用于持仓量等，K/M/B 口径与网页端 formatLargeNumber 一致 */
function large(v) {
    const n = toNum(v);
    if (isNaN(n)) return '--';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
    return n.toFixed(2);
}

/** 涨跌方向的样式类名，涨绿跌红（与网页端一致的 rise-green / fall-red） */
function dirClass(v) {
    const n = toNum(v);
    if (isNaN(n) || n === 0) return 'flat';
    return n > 0 ? 'up' : 'down';
}

module.exports = { price, pct, amount, large, dirClass, thousands, toNum };
