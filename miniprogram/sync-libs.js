#!/usr/bin/env node
'use strict';
/**
 * 把网页端的纯逻辑模块同步进小程序。
 *
 * 为什么用脚本同步，而不是在小程序里手抄一份：
 *   technical.js / signals.js / stocks.js 都不碰 DOM、不碰 localStorage，
 *   是可以在小程序里原样跑的纯逻辑。但小程序用 CommonJS，需要给每个文件
 *   补一行 module.exports。手抄一份的话，两边必然逐渐走样 ——
 *   网页端改了 MA 窗口降级、改了评分权重，小程序那份就悄悄过期了。
 *   所以从唯一源头生成，改完网页端跑一次这个脚本即可。
 *
 * 用法：node miniprogram/sync-libs.js
 */

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'js');
const OUT_DIR = path.join(__dirname, 'libs');

const LIBS = [
    { file: 'technical.js', export: 'TechnicalAnalysis', desc: '技术指标与评分' },
    { file: 'signals.js', export: 'SignalGenerator', desc: '交易信号生成' },
    { file: 'stocks.js', export: 'Stocks', desc: '币安美股（USDT-M 合约）数据源' },
];

// 小程序不支持的新语法在这里挡下来，避免生成出一份跑不起来的代码
const FORBIDDEN = [
    { re: /\bwindow\s*\./, msg: 'window.' },
    { re: /\bdocument\s*\./, msg: 'document.' },
    { re: /\blocalStorage\b/, msg: 'localStorage' },
    { re: /\bXMLHttpRequest\b/, msg: 'XMLHttpRequest' },
];

const header = (lib) => `/* eslint-disable */
// ⚠️ 本文件由 miniprogram/sync-libs.js 自动生成，请勿手改。
// 源头：crypto-analyzer/js/${lib.file}
// 重新生成：node miniprogram/sync-libs.js
`;

function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });

    let ok = 0;
    let bad = 0;

    LIBS.forEach((lib) => {
        const src = path.join(SRC_DIR, lib.file);
        if (!fs.existsSync(src)) {
            console.error(`✗ 缺少源文件：js/${lib.file}`);
            bad++;
            return;
        }

        const body = fs.readFileSync(src, 'utf8');

        if (body.indexOf('module.exports') >= 0) {
            console.error(`✗ js/${lib.file} 里已经出现 module.exports，会造成重复导出`);
            bad++;
            return;
        }

        const hits = FORBIDDEN.filter(f => f.re.test(body)).map(f => f.msg);
        if (hits.length) {
            console.error(`✗ js/${lib.file} 用到了小程序里没有的浏览器 API：${hits.join('、')}`);
            bad++;
            return;
        }

        const out = header(lib) + body + `\nmodule.exports = ${lib.export};\n`;
        const dest = path.join(OUT_DIR, lib.file);
        const prev = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
        fs.writeFileSync(dest, out);

        const state = prev === null ? '新增' : (prev === out ? '未变' : '更新');
        console.log(`  ${state}  libs/${lib.file}  ←  js/${lib.file}   (导出 ${lib.export} · ${lib.desc})`);
        ok++;
    });

    console.log(`\n完成：${ok} 个模块同步${bad ? `，${bad} 个失败` : ''}。`);
    if (bad) process.exit(1);
}

main();
