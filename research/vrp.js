'use strict';
/**
 * 波动率风险溢价（VRP）检验
 *
 * 检验对象：Deribit DVOL（30 天前瞻隐含波动率）与同期已实现波动率之差，
 *           即「期权贵不贵」，以及它能否用来择时。
 *
 * 三条必须先立好的规矩（否则结论一定是假的）：
 *   1. 加密 7×24 交易，IV 与 RV 一律按 365 天年化。
 *      误用 252 会在数据里凭空造出一个约 +45% 的假方差溢价。
 *   2. 必须区分两种口径：
 *        ex-ante（可交易）：IV_t − RV_{t-30→t}     ← 只用 t 时刻已知信息
 *        ex-post（含未来）：IV_t − RV_{t→t+30}     ← 不能当信号，只能验证溢价是否兑现
 *      把后者当信号就是未来函数。
 *   3. DVOL 是 240 秒 EMA 平滑值 + 30 天重叠窗口，名义样本远大于有效样本，
 *      所有 t 值必须用 Newey-West 修正，滞后阶至少取 30。
 */

const fs = require('fs');
const path = require('path');

// 历史数据目录：由 fetch-vrp.sh 生成（内含 DVOL 日线与币安K线）
const DATA = process.env.VRP_DATA || path.join(__dirname, 'data');
const DVOL_DIR = process.env.VRP_DVOL || DATA;
const ANN = 365;          // 年化天数：加密 7×24
const WIN = 30;           // 窗口：DVOL 是 30 天，RV 必须对齐 30 天
const NW_LAG = 30;        // 重叠窗口 30 天 → NW 滞后至少 30

// ==================== 基础统计 ====================

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
const quantile = (a, q) => { const s = a.slice().sort((x, y) => x - y); const pos = (s.length - 1) * q; const b = Math.floor(pos); return s[b + 1] !== undefined ? s[b] + (pos - b) * (s[b + 1] - s[b]) : s[b]; };

/** Newey-West 标准误（用于重叠样本的均值检验） */
function nwMeanSE(x, lag) {
    const n = x.length;
    const m = mean(x);
    const d = x.map(v => v - m);
    let s = 0;
    for (let k = 0; k <= lag; k++) {
        let g = 0;
        for (let i = k; i < n; i++) g += d[i] * d[i - k];
        g /= n;
        s += (k === 0 ? 1 : 2 * (1 - k / (lag + 1))) * g;
    }
    return Math.sqrt(Math.max(s, 0) / n);
}

function nwTest(x, lag = NW_LAG) {
    const m = mean(x);
    const se = nwMeanSE(x, lag);
    return { n: x.length, mean: m, se, t: se > 0 ? m / se : NaN, median: median(x) };
}

/** 普通最小二乘 + Newey-West 标准误 */
function olsNW(y, cols, lag = NW_LAG) {
    const n = y.length;
    const k = cols.length + 1;
    const X = y.map((_, i) => [1, ...cols.map(c => c[i])]);

    // (X'X)^-1
    const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let i = 0; i < n; i++) for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    const inv = invert(XtX);
    if (!inv) return null;

    const Xty = new Array(k).fill(0);
    for (let i = 0; i < n; i++) for (let a = 0; a < k; a++) Xty[a] += X[i][a] * y[i];
    const beta = inv.map(row => row.reduce((s, v, j) => s + v * Xty[j], 0));

    const resid = y.map((v, i) => v - X[i].reduce((s, x, j) => s + x * beta[j], 0));

    // NW 协方差：Cov(β) = (X'X)^-1 · S · (X'X)^-1，
    // 其中 S = Σ_l w_l · Σ_i (e_i x_i)(e_{i-l} x_{i-l})'
    // 注意这里不能除以 n：前面已经用 (X'X)^-1 而不是 (X'X/n)^-1，
    // 多除一个 n 会把 t 值放大 n 倍（n≈2000），得出 t=-2000 这种荒谬结果。
    const S = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let l = 0; l <= lag; l++) {
        const w = l === 0 ? 1 : (1 - l / (lag + 1));
        for (let i = l; i < n; i++) {
            for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) {
                S[a][b] += w * X[i][a] * resid[i] * X[i - l][b] * resid[i - l];
            }
        }
    }
    const cov = mul(inv, mul(S, inv));
    const se = cov.map((row, i) => Math.sqrt(Math.max(row[i], 0)));

    // R²
    const ym = mean(y);
    const sst = y.reduce((s, v) => s + (v - ym) * (v - ym), 0);
    const sse = resid.reduce((s, v) => s + v * v, 0);

    return { beta, se, t: beta.map((b, i) => b / se[i]), r2: sst > 0 ? 1 - sse / sst : NaN, n, resid };
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

// ==================== 数据装载 ====================

function loadDvol(sym) {
    const f = path.join(DVOL_DIR, `dvol_${sym}.csv`);
    const out = [];
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        const p = line.split(',');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(p[0])) continue;
        const iv = parseFloat(p[4]);
        if (isFinite(iv)) out.push({ date: p[0], iv });
    }
    out.sort((a, b) => (a.date < b.date ? -1 : 1));
    return out;
}

function loadDaily(sym) {
    const pair = `${sym}USDT`;
    const files = fs.readdirSync(DATA).filter(f => f.startsWith(`${pair}-1d-`) && f.endsWith('.csv')).sort();
    const rows = [];
    for (const f of files) {
        for (const line of fs.readFileSync(path.join(DATA, f), 'utf8').split('\n')) {
            const p = line.split(',');
            if (p.length < 6 || !/^-?\d/.test(p[0])) continue;
            const raw = Number(p[0]);
            const t = raw > 1e14 ? Math.floor(raw / 1e6) : Math.floor(raw / 1e3);
            rows.push({
                t,
                date: new Date(t * 1000).toISOString().slice(0, 10),
                o: +p[1], h: +p[2], l: +p[3], c: +p[4],
            });
        }
    }
    const seen = new Set();
    return rows.filter(r => (seen.has(r.t) ? false : (seen.add(r.t), true))).sort((a, b) => a.t - b.t);
}

/** 由 5 分钟K线算每日已实现方差（未年化） */
function load5mDailyVar(sym) {
    const pair = `${sym}USDT`;
    const files = fs.readdirSync(DATA).filter(f => f.startsWith(`${pair}-5m-`) && f.endsWith('.csv')).sort();
    const byDay = new Map();
    let prevC = null, prevDay = null;
    for (const f of files) {
        const lines = fs.readFileSync(path.join(DATA, f), 'utf8').split('\n');
        for (const line of lines) {
            const p = line.split(',');
            if (p.length < 6 || !/^-?\d/.test(p[0])) continue;
            const raw = Number(p[0]);
            const t = raw > 1e14 ? Math.floor(raw / 1e6) : Math.floor(raw / 1e3);
            const c = +p[4];
            const day = new Date(t * 1000).toISOString().slice(0, 10);
            if (prevC !== null && prevDay === day && prevC > 0 && c > 0) {
                const r = Math.log(c / prevC);
                byDay.set(day, (byDay.get(day) || 0) + r * r);
            }
            prevC = c; prevDay = day;
        }
    }
    return byDay;
}

// ==================== 构造面板 ====================

function buildPanel(sym) {
    const dvol = loadDvol(sym);
    const daily = loadDaily(sym);
    const var5m = load5mDailyVar(sym);

    const dvolMap = new Map(dvol.map(d => [d.date, d.iv]));
    const dvMap = new Map(daily.map((r, i) => [r.date, { i, ...r }]));

    // 逐日滚动的 trailing 30 天 RV（三种估计量，均按 365 年化）
    const rows = [];
    for (let i = 1; i < daily.length; i++) {
        const r = daily[i];
        if (i < WIN) continue;
        if (!dvolMap.has(r.date)) continue;

        const iv = dvolMap.get(r.date) / 100;   // DVOL 是波动率点，转小数
        if (!(iv > 0)) continue;

        // 收盘价已实现方差
        let s2 = 0, cnt = 0;
        for (let k = i - WIN + 1; k <= i; k++) {
            if (daily[k - 1].c > 0 && daily[k].c > 0) {
                const x = Math.log(daily[k].c / daily[k - 1].c);
                s2 += x * x; cnt++;
            }
        }
        const rvCC = cnt ? ANN * (s2 / cnt) : NaN;

        // Parkinson（区间估计量）
        let sp = 0, cp = 0;
        for (let k = i - WIN + 1; k <= i; k++) {
            const d = daily[k];
            if (d.l > 0 && d.h > 0) {
                const hl = Math.log(d.h / d.l);
                sp += hl * hl / (4 * Math.log(2)); cp++;
            }
        }
        const rvPark = cp ? ANN * (sp / cp) : NaN;

        // 5 分钟高频已实现方差
        let s5 = 0, c5 = 0;
        for (let k = i - WIN + 1; k <= i; k++) {
            const v = var5m.get(daily[k].date);
            if (isFinite(v)) { s5 += v; c5++; }
        }
        const rv5m = c5 >= WIN - 2 ? ANN * (s5 / c5) : NaN;

        rows.push({ date: r.date, i, close: r.c, iv, rvCC, rvPark, rv5m });
    }

    // 前瞻：未来 30 天已实现方差 / 未来收益
    for (const row of rows) {
        const i = row.i;
        // 未来 30 天 RV（用收盘价口径，与前视口径保持一致）
        let sf = 0, cf = 0;
        for (let k = i + 1; k <= Math.min(i + WIN, daily.length - 1); k++) {
            if (daily[k - 1].c > 0 && daily[k].c > 0) {
                const x = Math.log(daily[k].c / daily[k - 1].c);
                sf += x * x; cf++;
            }
        }
        row.rvFwd = cf >= WIN - 2 ? ANN * (sf / cf) : NaN;
        row.ret1 = (daily[Math.min(i + 1, daily.length - 1)].c / row.close - 1);
        row.ret7 = (daily[Math.min(i + 7, daily.length - 1)].c / row.close - 1);
        row.ret30 = (daily[Math.min(i + 30, daily.length - 1)].c / row.close - 1);
        // 5 分钟口径的未来 RV（用于稳健性）
        let sf5 = 0, cf5 = 0;
        for (let k = i + 1; k <= Math.min(i + WIN, daily.length - 1); k++) {
            const v = var5m.get(daily[k].date);
            if (isFinite(v)) { sf5 += v; cf5++; }
        }
        row.rvFwd5m = cf5 >= WIN - 2 ? ANN * (sf5 / cf5) : NaN;
    }

    return rows;
}

// ==================== 各项检验 ====================

function pct(x, d = 2) { return isFinite(x) ? (x * 100).toFixed(d) + '%' : '--'; }
function num(x, d = 3) { return isFinite(x) ? x.toFixed(d) : '--'; }

function reportLevel(rows, tag) {
    // ex-ante：可用作信号；ex-post：含未来，只用于验证溢价是否兑现
    const grid = [
        ['收盘价RV', 'rvCC'],
        ['Parkinson', 'rvPark'],
        ['5分钟RV', 'rv5m'],
    ];
    console.log(`\n【${tag}】VRP 水平（年化方差口径 IV²−RV，及波动率点口径 IV−√RV）`);
    console.log('  RV 估计量      N    ex-ante方差均值   NW t     ex-ante波动率点   NW t    ex-post方差均值   NW t');
    for (const [name, key] of grid) {
        const exA = [], exAvol = [], exP = [];
        for (const r of rows) {
            const rv = r[key];
            if (!isFinite(rv) || rv <= 0) continue;
            exA.push(r.iv * r.iv - rv);
            exAvol.push(r.iv - Math.sqrt(rv));
            if (isFinite(r.rvFwd) && r.rvFwd > 0) exP.push(r.iv * r.iv - r.rvFwd);
        }
        if (!exA.length) continue;
        const a = nwTest(exA), av = nwTest(exAvol), p = nwTest(exP);
        console.log(
            '  ' + name.padEnd(12) + String(a.n).padStart(5) + '   ' +
            pct(a.mean).padStart(12) + '  ' + num(a.t, 2).padStart(7) + '   ' +
            pct(av.mean).padStart(13) + '  ' + num(av.t, 2).padStart(7) + '   ' +
            pct(p.mean).padStart(13) + '  ' + num(p.t, 2).padStart(7)
        );
    }
    console.log('  说明：方差口径的均值是小数（0.14 = 14% 年化方差），波动率点口径更直观。');
}

function reportPersistence(rows) {
    const x = rows.map(r => r.iv * r.iv - r.rvCC).filter(isFinite);
    if (x.length < 60) return;
    const y = x.slice(1), xl = x.slice(0, -1);
    const m = olsNW(y, [xl]);
    const b = m.beta[1];
    const halfLife = b > 0 && b < 1 ? Math.log(0.5) / Math.log(b) : NaN;
    console.log(`\n【持久性】VRP AR(1) 系数 = ${num(b, 4)}（t=${num(m.t[1], 2)}），半衰期 ≈ ${num(halfLife, 1)} 天`);
}

function reportRegime(rows) {
    const data = rows.filter(r => isFinite(r.rvCC) && isFinite(r.iv));
    if (data.length < 100) return;
    const ivs = data.map(r => r.iv);
    const qs = [0.2, 0.4, 0.6, 0.8].map(q => quantile(ivs, q));
    const buckets = [[], [], [], [], []];
    for (const r of data) {
        const b = r.iv <= qs[0] ? 0 : r.iv <= qs[1] ? 1 : r.iv <= qs[2] ? 2 : r.iv <= qs[3] ? 3 : 4;
        buckets[b].push(r.iv * r.iv - r.rvCC);
    }
    console.log('\n【状态依赖】按 DVOL 水平五分组看 VRP（检验「低波动状态 VRP 更高」）');
    console.log('  分组(IV分位)      N    VRP均值       NW t');
    const labels = ['最低20%', '20-40%', '40-60%', '60-80%', '最高20%'];
    buckets.forEach((b, i) => {
        if (b.length < 20) return;
        const s = nwTest(b);
        console.log('  ' + labels[i].padEnd(14) + String(s.n).padStart(5) + '   ' + pct(s.mean).padStart(9) + '  ' + num(s.t, 2).padStart(7));
    });
}

/**
 * 非重叠子样本复核
 *
 * 30 天重叠窗口会把有效样本从约 1980 压到约 66，
 * 而 Newey-West 对高持续序列容易过度拒绝（名义 5% 的经验 size 可高达 0.33）。
 * 所以关键结论必须再用「每 30 天抽一点」的非重叠样本复核一次，
 * 用最朴素的 t 检验，不做任何 HAC 修正。
 */
function reportNonOverlap(rows) {
    const sub = [];
    for (let i = 0; i < rows.length; i += WIN) sub.push(rows[i]);

    const t1 = a => {
        if (a.length < 10) return null;
        const m = mean(a), s = sd(a);
        return { n: a.length, mean: m, t: m / (s / Math.sqrt(a.length)) };
    };

    console.log(`\n【非重叠复核】每 ${WIN} 天取 1 点，得到 ${sub.length} 个互不重叠的观测（朴素 t 检验，无 HAC 修正）`);

    for (const [name, key] of [['收盘价RV', 'rvCC'], ['5分钟RV', 'rv5m']]) {
        const v = sub.filter(r => isFinite(r[key])).map(r => r.iv * r.iv - r[key]);
        const s = t1(v);
        if (s) console.log(`  VRP(方差口径,${name}) 均值 = ${pct(s.mean)}　朴素 t = ${num(s.t, 2)}　N = ${s.n}`);
    }

    // 方向预测：非重叠样本上的回归
    const d = sub.filter(r => isFinite(r.rvCC) && isFinite(r.ret30));
    if (d.length >= 20) {
        const y = d.map(r => r.ret30);
        const x = d.map(r => r.iv * r.iv - r.rvCC);
        const mx = mean(x), my = mean(y);
        const cov = mean(x.map((v, i) => (v - mx) * (y[i] - my)));
        const vx = mean(x.map(v => (v - mx) ** 2));
        const b = cov / vx;
        const resid = y.map((v, i) => v - (my - b * mx) - b * x[i]);
        const se = Math.sqrt(mean(resid.map(r => r * r)) / ((d.length - 2) * vx));
        console.log(`  未来30天收益 ~ VRP 回归：β = ${num(b, 4)}（朴素 t = ${num(b / se, 2)}）　N = ${d.length}`);
        // 分组
        const sorted = d.slice().sort((a, b2) => (a.iv * a.iv - a.rvCC) - (b2.iv * b2.iv - b2.rvCC));
        const q = Math.floor(sorted.length / 3);
        const lo = sorted.slice(0, q), hi = sorted.slice(-q);
        console.log(`  VRP 最低三分位未来收益均值 = ${pct(mean(lo.map(r => r.ret30)))}（上涨 ${pct(lo.filter(r => r.ret30 > 0).length / lo.length)}）`);
        console.log(`  VRP 最高三分位未来收益均值 = ${pct(mean(hi.map(r => r.ret30)))}（上涨 ${pct(hi.filter(r => r.ret30 > 0).length / hi.length)}）`);
    }
}

function reportRvForecast(rows) {
    const d = rows.filter(r => isFinite(r.rv5m) && r.rv5m > 0 && isFinite(r.rvFwd5m) && r.rvFwd5m > 0 && isFinite(r.iv));
    if (d.length < 200) { console.log('\n【VRP→未来RV】样本不足，跳过'); return; }

    const y = d.map(r => Math.log(r.rvFwd5m));
    const lrv1 = d.map(r => Math.log(r.rv5m));
    // HAR 风格：用 1 日 / 7 日 / 30 日均值（这里用日度 RV 的滚动均值近似）
    const rvSeries = d.map(r => r.rv5m);
    const roll = (i, w) => { const a = rvSeries.slice(Math.max(0, i - w + 1), i + 1); return Math.log(mean(a)); };
    const l1 = d.map((_, i) => roll(i, 1));
    const l7 = d.map((_, i) => roll(i, 7));
    const l30 = d.map((_, i) => roll(i, 30));
    const lvrp = d.map(r => Math.log(Math.max(r.iv * r.iv - r.rv5m, 1e-8)));

    const split = Math.floor(d.length * 0.7);
    const fit = (cols, name) => {
        const ytr = y.slice(0, split), yte = y.slice(split);
        const ctr = cols.map(c => c.slice(0, split)), cte = cols.map(c => c.slice(split));
        const m = olsNW(ytr, ctr);
        if (!m) return;
        const pred = yte.map((_, i) => m.beta[0] + m.beta.slice(1).reduce((s, b, j) => s + b * cte[j][i], 0));
        const bench = mean(ytr);
        const mse = mean(yte.map((v, i) => (v - pred[i]) ** 2));
        const mseB = mean(yte.map(v => (v - bench) ** 2));
        const oosR2 = 1 - mse / mseB;
        const tStr = m.t.map((t, j) => (j === 0 ? 'const' : 'x' + j) + '=' + num(t, 2)).join(' ');
        console.log('  ' + name.padEnd(26) + ' 样本内R²=' + num(m.r2, 3).padStart(6) + '  样本外R²=' + num(oosR2, 4).padStart(8) + '   ' + tStr);
    };

    console.log('\n【VRP→未来30天RV】目标 = 未来30天实现方差(5分钟口径)的对数，样本外为后 30%');
    fit([l1, l7, l30], 'HAR(1,7,30) 基准');
    fit([l1, l7, l30, lvrp], 'HAR + log VRP');
}

function reportDirection(rows) {
    console.log('\n【VRP→收益方向】用 ex-ante VRP 分组看前瞻收益（若真有方向预测力，应单调）');
    const data = rows.filter(r => isFinite(r.rvCC) && isFinite(r.iv) && isFinite(r.ret30));
    if (data.length < 100) return;
    const vrps = data.map(r => r.iv * r.iv - r.rvCC);
    const qs = [0.2, 0.4, 0.6, 0.8].map(q => quantile(vrps, q));
    const buckets = [[], [], [], [], []];
    for (const r of data) {
        const v = r.iv * r.iv - r.rvCC;
        const b = v <= qs[0] ? 0 : v <= qs[1] ? 1 : v <= qs[2] ? 2 : v <= qs[3] ? 3 : 4;
        buckets[b].push(r);
    }
    console.log('  VRP分组         N    未来30天收益均值   上涨占比   NW t');
    const labels = ['最低20%', '20-40%', '40-60%', '60-80%', '最高20%'];
    buckets.forEach((b, i) => {
        if (b.length < 20) return;
        const rets = b.map(r => r.ret30);
        const s = nwTest(rets);
        const up = rets.filter(x => x > 0).length / rets.length;
        console.log('  ' + labels[i].padEnd(12) + String(s.n).padStart(5) + '   ' + pct(s.mean).padStart(14) + '   ' + pct(up).padStart(8) + '  ' + num(s.t, 2).padStart(6));
    });

    // 回归：未来收益 ~ VRP
    const y = data.map(r => r.ret30);
    const x = data.map(r => r.iv * r.iv - r.rvCC);
    const m = olsNW(y, [x]);
    if (m) console.log(`  回归 β = ${num(m.beta[1], 4)}（t=${num(m.t[1], 2)}），R²=${num(m.r2, 4)}　→ VRP 每升高 0.01（年化方差），未来30天收益变动 ${pct(m.beta[1] * 0.01, 3)}`);
}

function reportLookahead(rows) {
    const a = [], b = [];
    for (const r of rows) {
        if (!isFinite(r.rvCC) || !isFinite(r.rvFwd)) continue;
        a.push(r.iv * r.iv - r.rvCC);      // 正确：只用过去
        b.push(r.iv * r.iv - r.rvFwd);     // 错误：用了未来
    }
    if (a.length < 50) return;
    console.log('\n【未来函数量化】同样叫 VRP，用未来 RV 与用过去 RV 差多少');
    console.log(`  ex-ante（正确）均值 = ${pct(mean(a))}　ex-post（含未来）均值 = ${pct(mean(b))}　差值 = ${pct(mean(b) - mean(a))}`);
    console.log('  这条差值就是「把未来函数当信号」能凭空多出来的虚假收益。');
}

// ==================== 主流程 ====================

for (const sym of ['BTC', 'ETH']) {
    const rows = buildPanel(sym);
    if (!rows.length) { console.log(`${sym}: 无数据`); continue; }
    console.log('\n' + '='.repeat(104));
    console.log(`${sym}：DVOL 起点 ${rows[0].date} ~ ${rows[rows.length - 1].date}，共 ${rows.length} 个日频观测`);
    console.log(`有效样本提示：30 天重叠窗口 → 非重叠观测仅约 ${Math.floor(rows.length / WIN)} 个`);
    console.log('='.repeat(104));
    reportLevel(rows, sym);
    reportPersistence(rows);
    reportRegime(rows);
    reportNonOverlap(rows);
    reportRvForecast(rows);
    reportDirection(rows);
    reportLookahead(rows);
}
