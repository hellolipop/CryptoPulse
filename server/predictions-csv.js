/**
 * 预测记录的 CSV 表格产物
 *
 * 为什么单独成一个模块：JSON 适合存、不适合分析，这张表是要拿去筛选与分组的。
 * 除了服务进程，维护脚本也需要重写它（例如批量修正复盘结论之后要立刻刷新表格），
 * 所以列定义不能只留在 store.js 里 —— 否则脚本只能复制一份，两份迟早会不一致，
 * 而不一致的表格会直接导致分析结论出错。
 *
 * 本模块是纯函数式的：不读环境变量、不起服务、不改全局状态，写哪个文件由调用方指定。
 */

const fs = require('fs');
const path = require('path');

const PREDICTION_COLUMNS = [
    '用户名', '记录ID', '币种', '币种符号', '周期', '信号', '算法版本', '灵敏度档',
    '预测时间', '预测价格', '复盘时间点', '复盘价格', '涨跌幅%', '是否正确',
    '综合分', '技术分', '量能分', '消息分', '情绪分', '衍生品分',
    // 技术面的子因子得分。技术面在总分里权重最高（40），拆开才能看出
    // 到底是 RSI 判错了还是均线判错了 —— 这是「该调哪个因子」的直接线索。
    '技术_rsi', '技术_macd', '技术_ma', '技术_momentum', '技术_bollinger',
    '技术_vwap', '技术_stochRSI', '技术_kdj', '技术_obv',
    '权重_技术', '权重_量能', '权重_消息', '权重_情绪', '权重_衍生品',
    'RSI', 'MACD_DIF', 'MACD_DEA', 'MACD柱', 'KDJ_K', 'KDJ_D', 'KDJ_J',
    'MA7', 'MA25', 'MA200', 'StochRSI_K', 'ROC', 'ROC死区', '量比', '资金费率分位',
    '方向阈值', '观望阈值', '复盘窗口(小时)',
];

/** CSV 单元格：一律引号包裹并转义内部引号（信号名、币种符号都可能含逗号） */
function csvCell(value) {
    if (value === null || value === undefined) return '';
    return '"' + String(value).replace(/"/g, '""') + '"';
}

function predictionRow(username, rec) {
    const f = rec.factors || {};
    const b = f.breakdown || {};
    const tb = f.technicalBreakdown || {};
    const w = f.weights || {};
    const ind = f.indicators || {};
    const macd = ind.macd || {};
    const kdj = ind.kdj || {};
    const stoch = ind.stochRSI || {};
    const c = rec.criteria || {};
    const iso = ms => (typeof ms === 'number' && ms > 0) ? new Date(ms).toISOString() : '';
    const hours = ms => (typeof ms === 'number' && ms > 0) ? (ms / 3600000).toFixed(2) : '';
    return [
        username, rec.id, rec.coinId, rec.coinSymbol, rec.timeframe,
        rec.signalText || rec.signalType, rec.algoVersion, f.sensitivity,
        iso(rec.predictedAt), rec.price, iso(rec.resolveAt), rec.evalPrice,
        (rec.changePct === null || rec.changePct === undefined) ? '' : (rec.changePct * 100).toFixed(2),
        // 三态：未复盘留空，不能写成 false —— 那会被当成「判错」参与统计。
        // 分析时用「是否正确 非空」筛选出已复盘样本即可。
        (rec.correct === null || rec.correct === undefined) ? '' : (rec.correct ? '正确' : '错误'),
        rec.score, b.technical, b.volume, b.news, b.sentiment, b.derivatives,
        tb.rsi, tb.macd, tb.ma, tb.momentum, tb.bollinger, tb.vwap, tb.stochRSI, tb.kdj, tb.obv,
        w.technical, w.volume, w.news, w.sentiment, w.derivatives,
        ind.rsi, macd.macd, macd.signal, macd.histogram,
        kdj.k, kdj.d, kdj.j, ind.ma7, ind.ma25, ind.ma200,
        stoch.k, ind.roc, ind.rocScale,
        (f.volumeMetrics || {}).ratio, f.fundingPercentile,
        c.directionThreshold, c.holdThreshold, hours(c.horizonMs),
    ];
}

/**
 * 重写预测表格，返回写入的数据行数。
 *
 * 走「临时文件 + rename」：这个文件是拿来分析的，读到半截会得出错误结论。
 * 每次整份重写而不是追加 —— 记录会被复盘就地更新，追加会产生重复行，
 * 重复行会让准确率算错。
 *
 * @param {Object} store - 存储对象（含 predictions）
 * @param {string} csvFile - 目标文件路径
 */
function writePredictionsCsv(store, csvFile) {
    const rows = [];
    Object.keys(store.predictions || {}).sort().forEach(username => {
        (store.predictions[username] || []).forEach(rec => {
            if (rec && rec.id) rows.push([username, rec]);
        });
    });
    rows.sort((a, b) => (a[1].predictedAt || 0) - (b[1].predictedAt || 0));

    const lines = [PREDICTION_COLUMNS.map(csvCell).join(',')];
    rows.forEach(item => {
        lines.push(predictionRow(item[0], item[1]).map(csvCell).join(','));
    });

    fs.mkdirSync(path.dirname(csvFile), { recursive: true });
    const tmp = csvFile + '.tmp';
    // 开头加 BOM：否则 Excel 打开中文表头会乱码
    fs.writeFileSync(tmp, '\ufeff' + lines.join('\r\n') + '\r\n');
    fs.renameSync(tmp, csvFile);
    return rows.length;
}

module.exports = { PREDICTION_COLUMNS, csvCell, predictionRow, writePredictionsCsv };
