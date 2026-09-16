'use strict';
/**
 * 订单流预测能力检验（成交型失衡）
 *
 * 必须先说清楚口径：
 *   真正的 OFI（Cont-Kukanov-Stoikov 2014）需要「最优买卖价与量」，
 *   即需要限价单到达/撤销事件。免费归档里没有盘口数据（Bybit 在本机不可达，
 *   Binance 也没有 bookTicker/bookDepth 归档），所以本脚本算的是
 *   **成交型失衡（trade imbalance, TI）**：
 *       TI_t = (主动买量 − 主动卖量) / (主动买量 + 主动卖量)
 *   主动方方向来自逐笔成交的 is_buyer_maker 字段。
 *   TI 与真 OFI 不是一回事：CKS 明确指出 OFI 把「市价卖」与「撤买单」视为等价，
 *   而 TI 只看得见已成交的部分。所有结论只对 TI 成立。
 *
 * 最关键的诊断（用来区分「领先」与「同步」）：
 *   互相关 corr(TI_t, r_{t+j})，j 从负到正扫描。
 *   - 峰在 j=0 且两侧对称 → 同步指标，不是预测
 *   - j<0 侧有大量质量     → TI 是在反应已经发生的价格变化
 *   - 只有 j>0 侧有质量     → 才谈得上领先
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const DIR = process.env.OFI_DATA || path.join(__dirname, 'data', 'trades');
const NW_LAG = 60;   // 重叠修正：秒级重叠窗口

// ---------- 统计工具 ----------
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
function corr(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 30) return NaN;
    const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
    let sab = 0, sa = 0, sb = 0;
    for (let i = 0; i < n; i++) {
        const x = a[i] - ma, y = b[i] - mb;
        sab += x * y; sa += x * x; sb += y * y;
    }
    return (sa > 0 && sb > 0) ? sab / Math.sqrt(sa * sb) : NaN;
}
const quantile = (a, q) => { const s = a.slice().sort((x, y) => x - y); const p = (s.length - 1) * q; const b = Math.floor(p); return s[b + 1] !== undefined ? s[b] + (p - b) * (s[b + 1] - s[b]) : s[b]; };

/** Newey-West 均值标准误 */
function nwSE(x, lag) {
    const n = x.length, m = mean(x), d = x.map(v => v - m);
    let s = 0;
    for (let k = 0; k <= lag; k++) {
        let g = 0;
        for (let i = k; i < n; i++) g += d[i] * d[i - k];
        s += (k === 0 ? 1 : 2 * (1 - k / (lag + 1))) * (g / n);
    }
    return Math.sqrt(Math.max(s, 0) / n);
}

/** OLS + Newey-West 标准误（协方差不能除以 n，否则 t 值会被放大 n 倍） */
function olsNW(y, cols, lag) {
    const n = y.length, k = cols.length + 1;
    const X = y.map((_, i) => [1, ...cols.map(c => c[i])]);
    const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let i = 0; i < n; i++) for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    const inv = invert(XtX);
    if (!inv) return null;
    const Xty = new Array(k).fill(0);
    for (let i = 0; i < n; i++) for (let a = 0; a < k; a++) Xty[a] += X[i][a] * y[i];
    const beta = inv.map(r => r.reduce((s, v, j) => s + v * Xty[j], 0));
    const resid = y.map((v, i) => v - X[i].reduce((s, x, j) => s + x * beta[j], 0));
    const S = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let l = 0; l <= lag; l++) {
        const w = l === 0 ? 1 : (1 - l / (lag + 1));
        for (let i = l; i < n; i++)
            for (let a = 0; a < k; a++) for (let b = 0; b < k; b++)
                S[a][b] += w * X[i][a] * resid[i] * X[i - l][b] * resid[i - l];
    }
    const cov = mul(inv, mul(S, inv));
    const se = cov.map((r, i) => Math.sqrt(Math.max(r[i], 0)));
    const ym = mean(y);
    const sst = y.reduce((s, v) => s + (v - ym) * (v - ym), 0);
    const sse = resid.reduce((s, v) => s + v * v, 0);
    return { beta, se, t: beta.map((b, i) => b / se[i]), r2: sst > 0 ? 1 - sse / sst : NaN, n };
}
function invert(M) {
    const n = M.length;
    const A = M.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
        if (Math.abs(A[p][c]) < 1e-12) return null;
        [A[c], A[p]] = [A[p], A[c]];
        const pv = A[c][c];
        for (let j = 0; j < 2 * n; j++) A[c][j] /= pv;
        for (let r = 0; r < n; r++) {
            if (r === c) continue;
            const f = A[r][c];
            if (f === 0) continue;
            for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j];
        }
    }
    return A.map(r => r.slice(n));
}
function mul(A, B) {
    const n = A.length, m = B[0].length, p = B.length;
    return Array.from({ length: n }, (_, i) => Array.from({ length: m }, (_, j) => {
        let s = 0; for (let k = 0; k < p; k++) s += A[i][k] * B[k][j]; return s;
    }));
}

// ---------- 逐笔成交 -> 秒级 K 线 ----------
function streamZip(file) {
    return spawn('unzip', ['-p', file]);
}

async function buildBars(sym, bucketSecs) {
    const files = fs.readdirSync(DIR)
        .filter(f => f.startsWith(`${sym}-aggTrades-`) && f.endsWith('.zip'))
        .sort();
    if (!files.length) return null;

    // 一次遍历同时聚合多个桶宽，避免把几 GB 的 CSV 读两遍
    const maps = bucketSecs.map(() => new Map());

    for (const f of files) {
        const child = streamZip(path.join(DIR, f));
        const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        for await (const line of rl) {
            if (!line || line.charCodeAt(0) < 48 || line.charCodeAt(0) > 57) continue; // 跳过表头
            const p = line.split(',');
            if (p.length < 7) continue;
            const price = +p[1], qty = +p[2], ts = +p[5];
            if (!(price > 0) || !(qty > 0) || !isFinite(ts)) continue;
            const isSell = p[6].trim() === 'true';   // 买方是挂单 → 卖方主动
            for (let bi = 0; bi < bucketSecs.length; bi++) {
                const bs = bucketSecs[bi];
                const sec = Math.floor(ts / (bs * 1000)) * bs;
                const map = maps[bi];
                let b = map.get(sec);
                if (!b) { b = { buy: 0, sell: 0, open: price, close: price, n: 0 }; map.set(sec, b); }
                if (isSell) b.sell += qty; else b.buy += qty;
                b.close = price;
                b.n++;
            }
        }
        await new Promise(r => child.on('close', r));
    }

    const out = {};
    for (let bi = 0; bi < bucketSecs.length; bi++) {
        const bs = bucketSecs[bi];
        const map = maps[bi];
        const keys = [...map.keys()].sort((a, b) => a - b);
        if (!keys.length) continue;
        // 补齐空档：无成交的桶沿用上一个价格、成交量记 0
        const full = [];
        let prevClose = null;
        for (let s = keys[0]; s <= keys[keys.length - 1]; s += bs) {
            const b = map.get(s);
            if (b) { full.push({ t: s, ...b }); prevClose = b.close; }
            else if (prevClose !== null) full.push({ t: s, buy: 0, sell: 0, open: prevClose, close: prevClose, n: 0 });
        }
        out[bs] = { files: files.length, buckets: full, activeRatio: full.filter(x => x.n > 0).length / full.length };
    }
    return out;
}

// ---------- 检验 ----------
function analyse(sym, bars, bucketSec, label) {
    const B = bars.buckets;
    const n = B.length;
    const ret = new Array(n).fill(NaN);      // 桶内收益
    const ti = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        const b = B[i];
        const vol = b.buy + b.sell;
        ti[i] = vol > 0 ? (b.buy - b.sell) / vol : 0;
        if (i && B[i - 1].close > 0 && b.close > 0) ret[i] = Math.log(b.close / B[i - 1].close);
    }

    console.log('\n' + '='.repeat(100));
    console.log(`${sym}  ${label}   共 ${n} 个 ${bucketSec}s 桶，有成交占比 ${(bars.activeRatio * 100).toFixed(1)}%，文件 ${bars.files} 个`);
    console.log('='.repeat(100));

    // 1) 同期关系（CKS 的对照口径：同期解释力）
    const pairs0 = [];
    for (let i = 1; i < n; i++) if (isFinite(ret[i])) pairs0.push([ti[i], ret[i]]);
    const c0 = corr(pairs0.map(p => p[0]), pairs0.map(p => p[1]));
    console.log(`\n【同期】corr(TI_t, r_t) = ${isFinite(c0) ? c0.toFixed(4) : '--'}　（同期解释力 R² ≈ ${isFinite(c0) ? (c0 * c0).toFixed(4) : '--'}）`);
    console.log('  这是「同时刻」关系，不是预测力。CKS 论文报的 65% R² 就是这一口径。');

    // 2) 互相关函数：区分领先 / 同步 / 反应
    console.log('\n【互相关扫描】corr(TI_t, r_{t+j})，j 为秒（bucket）偏移');
    const lags = [-60, -30, -10, -5, -2, -1, 0, 1, 2, 5, 10, 30, 60];
    const tiA = [], retA = [];
    for (let i = 0; i < n; i++) { tiA.push(ti[i]); retA.push(ret[i]); }
    const line = [];
    for (const j of lags) {
        const a = [], b = [];
        for (let i = 0; i < n; i++) {
            const k = i + j;
            if (k < 0 || k >= n) continue;
            if (!isFinite(retA[k])) continue;
            a.push(tiA[i]); b.push(retA[k]);
        }
        const c = corr(a, b);
        line.push(`${j > 0 ? '+' : ''}${j}:${isFinite(c) ? c.toFixed(3) : '--'}`);
    }
    console.log('  ' + line.join('  '));
    console.log('  j<0 = TI 与「过去」收益相关（那是反应）；j>0 = 与「未来」收益相关（那才是预测）。');

    // 3) 预测性回归：未来 k 个桶的收益 ~ TI_t
    const KS = bucketSec === 1 ? [1, 5, 10, 30, 60] : [1, 5, 15, 30, 60];
    console.log('\n【预测回归】r_{t→t+k} = a + b·TI_t + ε　（Newey-West 修正，滞后 ' + NW_LAG + '）');
    console.log('  k(桶)   N         b           t       R²      命中率    命中率95%CI        平均|收益|');
    const results = {};
    for (const k of KS) {
        const y = [], x = [], xPrev = [], xNow = [];
        for (let i = 1; i + k < n; i++) {
            if (!isFinite(ret[i])) continue;
            const fwd = Math.log(B[i + k].close / B[i].close);
            if (!isFinite(fwd)) continue;
            y.push(fwd); x.push(ti[i]); xNow.push(ret[i]); xPrev.push(ret[i - 1]);
        }
        if (y.length < 500) continue;
        const m = olsNW(y, [x], NW_LAG);
        const hits = y.filter((v, i) => Math.sign(v) === Math.sign(x[i]) && v !== 0).length;
        const decided = y.filter((v, i) => v !== 0 && x[i] !== 0).length;
        const p = hits / decided;
        const se = Math.sqrt(p * (1 - p) / decided);
        const absRet = mean(y.map(Math.abs));
        results[k] = { m, n: y.length, hit: p, se, absRet, beta: m.beta[1] };
        console.log(
            '  ' + String(k).padStart(5) +
            String(y.length).padStart(7) +
            '  ' + m.beta[1].toExponential(3).padStart(11) +
            '  ' + m.t[1].toFixed(2).padStart(7) +
            '  ' + m.r2.toFixed(5).padStart(8) +
            '  ' + (p * 100).toFixed(2).padStart(7) + '%' +
            '  [' + ((p - 1.96 * se) * 100).toFixed(2) + '%, ' + ((p + 1.96 * se) * 100).toFixed(2) + '%]' +
            '  ' + (absRet * 10000).toFixed(2).padStart(9) + 'bp'
        );
    }

    // 4) 控制「过去收益」后 TI 是否还有增量
    console.log('\n【增量检验】加上同期与滞后收益做控制，TI 是否还显著');
    for (const k of KS.slice(0, 3)) {
        const y = [], x = [], xNow = [], xPrev = [];
        for (let i = 1; i + k < n; i++) {
            if (!isFinite(ret[i])) continue;
            const fwd = Math.log(B[i + k].close / B[i].close);
            if (!isFinite(fwd)) continue;
            y.push(fwd); x.push(ti[i]); xNow.push(ret[i]); xPrev.push(ret[i - 1]);
        }
        if (y.length < 500) continue;
        const m1 = olsNW(y, [x], NW_LAG);
        const m2 = olsNW(y, [x, xNow], NW_LAG);
        const m3 = olsNW(y, [x, xNow, xPrev], NW_LAG);
        console.log(
            `  k=${k}：单独 TI  b=${m1.beta[1].toExponential(2)} t=${m1.t[1].toFixed(2)} R²=${m1.r2.toFixed(5)}` +
            `　| +同期收益 b=${m2.beta[1].toExponential(2)} t=${m2.t[1].toFixed(2)} R²=${m2.r2.toFixed(5)}` +
            `　| +两期收益 b=${m3.beta[1].toExponential(2)} t=${m3.t[1].toFixed(2)} R²=${m3.r2.toFixed(5)}`
        );
    }

    // 5) 成本对照
    console.log('\n【成本对照】合约 taker 双边约 10bp（0.05%×2）');
    for (const k of Object.keys(results)) {
        const r = results[k];
        console.log(`  k=${k}：信号平均可捕获 |收益| ${(r.absRet * 10000).toFixed(2)}bp　→　${r.absRet * 10000 > 10 ? '超过' : '低于'} 10bp 成本`);
    }

    // 6) 分组（按 TI 强弱）
    const k0 = KS[0];
    const y0 = [], x0 = [];
    for (let i = 1; i + k0 < n; i++) {
        if (!isFinite(ret[i])) continue;
        const fwd = Math.log(B[i + k0].close / B[i].close);
        if (!isFinite(fwd)) continue;
        y0.push(fwd); x0.push(ti[i]);
    }
    if (y0.length > 1000) {
        const qs = [0.05, 0.25, 0.5, 0.75, 0.95].map(q => quantile(x0, q));
        const groups = [[], [], [], [], []];
        for (let i = 0; i < y0.length; i++) {
            const v = x0[i];
            const g = v <= qs[0] ? 0 : v <= qs[1] ? 1 : v <= qs[2] ? 2 : v <= qs[3] ? 3 : 4;
            groups[g].push(y0[i]);
        }
        console.log(`\n【分组】按 TI 分位看未来 ${k0} 桶收益（若 TI 有预测力，应单调）`);
        const names = ['最弱5%', '5-25%', '25-50%', '50-75%', '75-95%', '最强5%'];
        const ed = [[], [], [], [], [], []];
        for (let i = 0; i < y0.length; i++) {
            const v = x0[i];
            const g = v <= qs[0] ? 0 : v <= qs[1] ? 1 : v <= qs[2] ? 2 : v <= qs[3] ? 3 : v <= qs[4] ? 4 : 5;
            ed[g].push(y0[i]);
        }
        ed.forEach((g, i) => {
            if (g.length < 50) return;
            const mu = mean(g);
            const t = mu / (sd(g) / Math.sqrt(g.length));
            console.log(`  ${names[i].padEnd(8)} N=${String(g.length).padStart(7)}  未来收益均值 ${(mu * 10000).toFixed(3).padStart(8)}bp  朴素 t=${t.toFixed(2).padStart(6)}`);
        });
    }
}

// ---------- 主流程 ----------
(async () => {
    if (!fs.existsSync(DIR)) { console.log('缺少数据目录：' + DIR); process.exit(1); }
    for (const sym of ['BTCUSDT', 'ETHUSDT']) {
        const bars = await buildBars(sym, [1, 60]);
        if (!bars) { console.log(`${sym}: 无数据`); continue; }
        if (bars[1]) analyse(sym, bars[1], 1, '秒级');
        if (bars[60]) analyse(sym, bars[60], 60, '分钟级');
    }
})();
