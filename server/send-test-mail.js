#!/usr/bin/env node
'use strict';
/**
 * 邮件提醒的自检工具
 *
 * 用途：在依赖浏览器扫描之前，先确认「授权码对不对、能不能发出去、邮件长什么样」。
 * 发信这一环最容易出问题的是凭据与端口/加密方式的搭配，单独验证比混在K线扫描里排查省事。
 *
 * 用法：
 *   node server/send-test-mail.js              # 发一封样例提醒（结构与真实提醒一致）
 *   node server/send-test-mail.js --check      # 只检查配置是否完整，不发信
 *   node server/send-test-mail.js --to a@b.c   # 本次改发到别的地址（不写入配置文件）
 *
 * 注意：这里用 force 跳过节流，同一条可以反复发，方便调试。
 */

const notify = require('./notify');

const has = flag => process.argv.includes(flag);

/**
 * 取某个开关带的值，`--to=a@b.c` 与 `--to a@b.c` 都认。
 *
 * 两种写法都支持是因为文档里写的是空格那种（更像命令行习惯），而实现最初只认等号那种 ——
 * 只认等号的话，写成空格会被静默忽略，看起来像「改了地址但还是发给自己」。
 */
const argOf = name => {
    const eq = process.argv.find(x => x.startsWith('--' + name + '='));
    if (eq) return eq.split('=').slice(1).join('=');
    const i = process.argv.indexOf('--' + name);
    const next = i > -1 ? process.argv[i + 1] : null;
    return (next && !next.startsWith('--')) ? next : null;
};

const USAGE = [
    '用法：',
    '  node server/send-test-mail.js                发一封样例提醒（结构与真实提醒一致）',
    '  node server/send-test-mail.js --check        只检查配置是否完整，不发信',
    '  node server/send-test-mail.js --to a@b.com   本次改发到别的地址（不写入配置文件）',
].join('\n');

/**
 * 内置样例：一条K线买卖点提醒，字段与浏览器实际发来的完全一致。
 *
 * 为什么不再拿「你最近一条预测记录」当样例：真实提醒来自「已开启交易」的币种在
 * 某根K线收盘时出现的买卖点，那是浏览器扫描出来的，存储里没有对应的现成记录。
 * 拿一条来源不对的记录当样例，反而看不出真实提醒长什么样。
 *
 * 里面的数字是编的，但结构与真实一致。
 */
function sampleMarker() {
    const nowSec = Math.floor(Date.now() / 1000);
    const bar = nowSec - (nowSec % (4 * 3600));   // 对齐到4小时整点，像一根真的K线
    return {
        coinId: 'ethereum',
        coinSymbol: 'ETH',
        timeframe: 4,
        signalType: 'strong_buy',
        signalText: '强烈买入',
        score: 78,
        price: 2683.59,
        markerTime: bar,                    // 这个买卖点所在的K线
        execTime: bar + 4 * 3600,           // 成交时刻＝下一根K线开盘
        execPrice: 2684.11,
        predictedAt: Date.now(),
        sensitivity: 'balanced',
        actionTip: '综合评分较高，可考虑分批建仓，仓位控制在60-80%',
        algoVersion: '1.0.1',
        gate: 'off',
        source: 'paper-marker',
    };
}

async function main() {
    // --help 要放在配置检查之前：配置没填全时也得能看到怎么用
    if (has('--help') || has('-h')) {
        console.log(USAGE);
        return;
    }

    const state = notify.loadConfig();
    console.log('配置文件 ' + notify.configFile());

    if (!state.configured) {
        console.log('✗ ' + state.reason);
        if (state.hint) console.log('  提示：' + state.hint);
        console.log('\n可参考 server/mail-config.example.json 填写后重试。');
        process.exit(1);
    }

    const cfg = state.config;
    console.log('已配置：作为 ' + cfg.user + ' 发送到 ' + cfg.to);
    console.log('服务器 ' + cfg.host + ':' + cfg.port + '（' + (cfg.secure ? '隐式 TLS' : 'STARTTLS') + '）');
    if (state.hint) console.log('提示：' + state.hint);

    if (has('--check')) {
        console.log('\n--check：只检查配置，未发送。去掉 --check 即可真发一封。');
        return;
    }

    // --to 只在本次发送里改收件地址，不动配置文件
    const to = argOf('to');
    const signal = sampleMarker();
    console.log('\n使用内置样例（一条K线买卖点提醒）' + (to ? '，本次改发到 ' + to : ''));

    console.log('正在发送…');
    const result = await notify.sendSignalMail(signal, { force: true, to });
    if (result.ok) {
        console.log(`✓ 已发送到 ${result.to}（${result.elapsedMs}ms）`);
        console.log('  主题：' + result.subject);
        console.log('  去邮箱看看；若没看到，先查垃圾邮件。');
    } else {
        console.log('✗ ' + result.error);

        // 按实际错因给提示。第一版是无条件把四条全打出来，结果认证失败（535）时
        // 后面也挂一条「证书链建不出信任路径」，读起来像真因 —— 排查方向上会被带偏。
        const err = String(result.error || '');
        const hints = [];
        if (/535|AUTH|认证/i.test(err)) {
            hints.push('授权码填成了登录密码（QQ / 163 / Gmail 都要单独生成授权码或应用专用密码）');
            hints.push('服务商那边还没开启 SMTP 服务（QQ / 163 默认是关闭的）');
            hints.push('授权码被重置过，或同一账号短时间登录太频繁被临时限制');
        } else if (/证书|certificate|CERT/.test(err)) {
            // 证书问题的成因与修法已经写在错误信息里了，这里不重复第二遍
        } else {
            hints.push('端口与加密方式不匹配：465 用隐式 TLS，587 用 STARTTLS');
            hints.push('服务器地址写错，或网络只放通了其中一种端口');
        }
        if (hints.length) {
            console.log('\n常见原因：');
            hints.forEach(h => console.log('  - ' + h));
        }
        process.exit(1);
    }
}

main().catch(e => {
    console.error('执行失败：' + e.message);
    process.exit(1);
});
