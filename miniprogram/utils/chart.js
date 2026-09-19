/**
 * K线绘制（Canvas 2D）。
 *
 * 网页端用的是 TradingView lightweight-charts，小程序里没法直接搬，
 * 所以这里手绘。只画真正需要的东西：蜡烛、两条均线、长期均线、成交量，
 * 以及右侧价格刻度与底部时间刻度。不做缩放与拖动 —— 自用工具里
 * 周期切换比捏合缩放更常用，省下来的交互复杂度换成更稳的绘制。
 *
 * 配色与网页端 chart.js 保持一致，切换过来不会有割裂感。
 */

const COLOR = {
    up: '#089981',
    down: '#f23645',
    ma7: '#f0b90b',
    ma25: '#8e5cf6',
    maLong: '#3b82f6',
    grid: '#f0f3f8',
    text: '#848e9c',
    axis: '#eaecef',
    volUp: 'rgba(8, 153, 129, 0.45)',
    volDown: 'rgba(242, 54, 69, 0.45)',
};

const PAD = { top: 22, right: 52, bottom: 18, left: 6 };
const LEGEND_H = 0;

function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
}

function timeLabel(sec, timeframe) {
    const d = new Date(sec * 1000);
    if (String(timeframe) === '24' || String(timeframe) === '168') {
        return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} W 逻辑宽度（CSS 像素）
 * @param {number} H 逻辑高度
 * @param {Array} candles 全部K线
 * @param {Object} opts { ma7, ma25, longMA, longMAWindow, timeframe, maxBars }
 */
function draw(ctx, W, H, candles, opts) {
    const o = opts || {};
    ctx.clearRect(0, 0, W, H);

    if (!candles || !candles.length) {
        ctx.fillStyle = COLOR.text;
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('暂无K线数据', W / 2, H / 2);
        return;
    }

    const maxBars = o.maxBars || 110;
    const total = candles.length;
    const start = Math.max(0, total - maxBars);
    const view = candles.slice(start);
    const n = view.length;

    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    // 价格占上方 74%，成交量占下方，中间留 6px 间隔
    const volH = Math.max(24, Math.round(plotH * 0.2));
    const priceH = plotH - volH - 6;

    // ---- 价格区间 ----
    let hi = -Infinity;
    let lo = Infinity;
    view.forEach(function (c) {
        if (c.high > hi) hi = c.high;
        if (c.low < lo) lo = c.low;
    });
    // 把均线也算进纵向范围，否则均线会跑出画布被裁掉
    ['ma7', 'ma25'].forEach(function (k) {
        const arr = o[k];
        if (!arr) return;
        for (let i = start; i < total; i++) {
            const v = arr[i];
            if (v === null || v === undefined || !isFinite(v)) continue;
            if (v > hi) hi = v;
            if (v < lo) lo = v;
        }
    });
    const longSeries = o.longMA && o.longMA.series;
    if (longSeries) {
        for (let i = start; i < total; i++) {
            const v = longSeries[i];
            if (v === null || v === undefined || !isFinite(v)) continue;
            if (v > hi) hi = v;
            if (v < lo) lo = v;
        }
    }
    if (!isFinite(hi) || !isFinite(lo)) return;

    const span = hi - lo || (hi === 0 ? 1 : Math.abs(hi) * 0.02);
    const padV = span * 0.06;
    hi += padV;
    lo -= padV;

    const yOfPrice = (p) => PAD.top + priceH - ((p - lo) / (hi - lo)) * priceH;
    const slot = plotW / n;
    const xOfIndex = (i) => PAD.left + slot * (i + 0.5);

    // ---- 网格与右侧价格刻度 ----
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const rows = 4;
    for (let r = 0; r <= rows; r++) {
        const y = PAD.top + (priceH / rows) * r;
        ctx.strokeStyle = COLOR.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(PAD.left, y + 0.5);
        ctx.lineTo(PAD.left + plotW, y + 0.5);
        ctx.stroke();

        const price = hi - ((hi - lo) / rows) * r;
        ctx.fillStyle = COLOR.text;
        ctx.fillText(formatTick(price), PAD.left + plotW + 6, y);
    }

    // ---- 成交量区底边 ----
    const volTop = PAD.top + priceH + 6;
    ctx.strokeStyle = COLOR.axis;
    ctx.beginPath();
    ctx.moveTo(PAD.left, volTop + volH + 0.5);
    ctx.lineTo(PAD.left + plotW, volTop + volH + 0.5);
    ctx.stroke();

    let volMax = 0;
    view.forEach(function (c) { if (c.volume > volMax) volMax = c.volume; });
    if (volMax <= 0) volMax = 1;

    // ---- 蜡烛 + 成交量 ----
    const bodyW = Math.max(1, Math.min(slot * 0.66, 12));
    view.forEach(function (c, i) {
        const x = xOfIndex(i);
        const rise = c.close >= c.open;
        const color = rise ? COLOR.up : COLOR.down;

        // 影线
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, yOfPrice(c.high));
        ctx.lineTo(Math.round(x) + 0.5, yOfPrice(c.low));
        ctx.stroke();

        // 实体（涨跌都不留空心，小屏上空心容易看不清）
        const yOpen = yOfPrice(c.open);
        const yClose = yOfPrice(c.close);
        const top = Math.min(yOpen, yClose);
        const h = Math.max(1, Math.abs(yClose - yOpen));
        ctx.fillStyle = color;
        ctx.fillRect(x - bodyW / 2, top, bodyW, h);

        // 成交量
        const vh = Math.max(1, (c.volume / volMax) * volH);
        ctx.fillStyle = rise ? COLOR.volUp : COLOR.volDown;
        ctx.fillRect(x - bodyW / 2, volTop + volH - vh, bodyW, vh);
    });

    // ---- 均线 ----
    drawLine(ctx, o.ma7, start, total, xOfIndex, yOfPrice, COLOR.ma7);
    drawLine(ctx, o.ma25, start, total, xOfIndex, yOfPrice, COLOR.ma25);
    if (longSeries) drawLine(ctx, longSeries, start, total, xOfIndex, yOfPrice, COLOR.maLong);

    // ---- 底部时间刻度 ----
    ctx.fillStyle = COLOR.text;
    ctx.textAlign = 'center';
    const ticks = [0, Math.floor(n / 2), n - 1];
    ticks.forEach(function (i, k) {
        ctx.textAlign = k === 0 ? 'left' : (k === 2 ? 'right' : 'center');
        const x = k === 0 ? PAD.left : (k === 2 ? PAD.left + plotW : xOfIndex(i));
        ctx.fillText(timeLabel(view[i].time, o.timeframe), x, H - 8);
    });

    // ---- 图例（左上角）----
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let lx = PAD.left + 2;
    const ly = 11;
    const legend = [
        { text: 'MA7', color: COLOR.ma7 },
        { text: 'MA25', color: COLOR.ma25 },
    ];
    if (longSeries) legend.push({ text: 'MA' + (o.longMAWindow || ''), color: COLOR.maLong });
    legend.forEach(function (item) {
        ctx.fillStyle = item.color;
        ctx.fillRect(lx, ly - 1.5, 8, 3);
        lx += 11;
        ctx.fillStyle = COLOR.text;
        ctx.font = '9px sans-serif';
        ctx.fillText(item.text, lx, ly);
        lx += ctx.measureText(item.text).width + 10;
    });
    void LEGEND_H;
}

function drawLine(ctx, arr, start, end, xOfIndex, yOfPrice, color) {
    if (!arr) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    let started = false;
    for (let i = start; i < end; i++) {
        const v = arr[i];
        if (v === null || v === undefined || !isFinite(v)) { started = false; continue; }
        const x = xOfIndex(i - start);
        const y = yOfPrice(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
    }
    ctx.stroke();
}

/** 价格刻度：按量级决定小数位，避免大数把轴撑爆 */
function formatTick(v) {
    const abs = Math.abs(v);
    if (abs >= 10000) return (v / 1000).toFixed(1) + 'k';
    if (abs >= 100) return v.toFixed(1);
    if (abs >= 1) return v.toFixed(2);
    if (abs >= 0.01) return v.toFixed(4);
    return v.toFixed(6);
}

module.exports = { draw, COLOR };
