'use strict';
/**
 * 页面静态链接检查
 *
 * 运行：node miniprogram/tests/wxml.test.js
 *
 * 小程序最讨厌的一类 bug 是「点了没反应」：WXML 里 bindtap="switchTimefram"
 * 拼错一个字，编译不报错、运行不报错，按钮就是死着。同理，WXML 里引用了
 * data 里不存在的字段，页面上就永远显示空白。
 *
 * 这两样都能静态查出来：
 *   1. WXML 里出现的每个事件处理方法，必须在页面 JS 里有定义
 *   2. WXML 里引用的每个数据字段（模板块之外的 {{}} 根标识符），
 *      必须在 data 里声明、或在 setData 里被赋过值
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
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
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

// WXML 模板表达式里出现这些不算数据字段：JS 字面量、循环别名、字符串片段
const IGNORE = new Set([
    'true', 'false', 'null', 'undefined', 'NaN',
    'item', 'index', 'wx', 'Math', 'String', 'Number',
]);

function wxmlFiles() {
    const dir = path.join(ROOT, 'pages');
    const out = [];
    fs.readdirSync(dir).forEach(function (p) {
        const f = path.join(dir, p, p + '.wxml');
        if (fs.existsSync(f)) out.push(f);
    });
    return out;
}

/** 把 WXML 里的 <template name="x">...</template> 段落摘出来（模板块的字段来自行数据，不做检查） */
function splitTemplates(src) {
    const blocks = [];
    const stripped = src.replace(/<template\s+name="[\s\S]*?<\/template>/g, function (m) {
        blocks.push(m);
        return '';
    });
    return { stripped: stripped, blocks: blocks };
}

/** 取出所有事件处理方法名：bindtap / catchtap / bindinput / bindchange / catchtap 等 */
function collectHandlers(src) {
    const out = new Set();
    const re = /\b(?:bind|catch)[:]?([a-zA-Z]+)\s*=\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const name = m[2].trim();
        if (name && name.indexOf('{{') < 0) out.add(name);
    }
    return out;
}

/** 取出 {{}} 表达式里的根标识符（排除属性访问的右半边、字符串字面量） */
function collectIdentifiers(src) {
    const out = new Set();
    const re = /\{\{([\s\S]*?)\}\}/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        let expr = m[1];
        // 去掉字符串字面量，避免把 '合约' 里的中文/字母当标识符
        expr = expr.replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ');
        const idRe = /(^|[^.\w$])([A-Za-z_$][\w$]*)/g;
        let m2;
        while ((m2 = idRe.exec(expr)) !== null) {
            const id = m2[2];
            // 后面跟着 ( 的是函数调用，不是数据字段
            const after = expr.slice(m2.index + m2[0].length).replace(/^\s+/, '');
            if (after.charAt(0) === '(') continue;
            if (IGNORE.has(id)) continue;
            out.add(id);
        }
    }
    return out;
}

/** 用 Page 桩加载页面，拿到真实的 data 与 methods —— 加载逻辑统一放在 harness 里 */
function loadPage(jsPath) {
    const harness = require('./harness.js');
    return harness.makeEnv().makePage(jsPath);
}

/** 收集页面 JS 里被 setData 赋过值的字段名 */
function collectSetDataKeys(jsSrc) {
    const out = new Set();
    const re = /setData\(\s*\{/g;
    let m;
    while ((m = re.exec(jsSrc)) !== null) {
        // 从 { 开始做括号配对，取出这一段
        let i = m.index + m[0].length - 1;
        let depth = 0;
        let end = -1;
        for (let j = i; j < jsSrc.length; j++) {
            if (jsSrc[j] === '{') depth++;
            else if (jsSrc[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
        }
        if (end < 0) continue;
        const body = jsSrc.slice(i, end);
        const keyRe = /(^|[\s,{])([A-Za-z_$][\w$]*)\s*:/g;
        let k;
        while ((k = keyRe.exec(body)) !== null) out.add(k[2]);
    }
    return out;
}

// ============================================================
section('1. 每个页面的 WXML 与 JS 都能对上');

const pages = wxmlFiles();
ok(pages.length >= 2, `找到 ${pages.length} 个页面`);

pages.forEach(function (wxmlPath) {
    const pageDir = path.dirname(wxmlPath);
    const pageName = path.basename(pageDir);
    const jsPath = path.join(pageDir, pageName + '.js');
    const jsonPath = path.join(pageDir, pageName + '.json');

    console.log(`\n\x1b[1m  ── ${pageName} ──\x1b[0m`);

    ok(fs.existsSync(jsPath), `${pageName}.js 存在`);
    ok(fs.existsSync(jsonPath), `${pageName}.json 存在`);

    const jsSrc = fs.readFileSync(jsPath, 'utf8');
    const wxmlSrc = fs.readFileSync(wxmlPath, 'utf8');

    let cfg = null;
    try { cfg = loadPage(jsPath); } catch (e) { failed++; failures.push(pageName + ' 加载失败 — ' + e.message); }
    ok(!!cfg, `${pageName}.js 能被加载（Page 配置可读取）`);
    if (!cfg) return;

    ok(!!cfg.data && typeof cfg.data === 'object', `${pageName} 声明了 data`);
    ok(typeof cfg.onLoad === 'function', `${pageName} 有 onLoad`);

    const declared = new Set(Object.keys(cfg.data || {}));
    const assigned = collectSetDataKeys(jsSrc);

    // ---- 检查 1：事件处理方法必须存在 ----
    const handlers = collectHandlers(wxmlSrc);
    const methodNames = new Set(Object.keys(cfg));
    ok(handlers.size > 0, `${pageName} 的 WXML 里绑定了 ${handlers.size} 个交互`);

    const missingHandlers = [];
    handlers.forEach(function (h) {
        if (typeof cfg[h] !== 'function') missingHandlers.push(h);
    });
    ok(missingHandlers.length === 0,
        `${pageName} 的每个交互都指向真实方法（没有点了没反应的按钮）`,
        missingHandlers.length ? '未定义：' + missingHandlers.join('、') : '');

    // ---- 检查 2：WXML 用到的字段必须声明或被赋值过 ----
    const split = splitTemplates(wxmlSrc);
    const ids = collectIdentifiers(split.stripped);
    const unknown = [];
    ids.forEach(function (id) {
        if (declared.has(id) || assigned.has(id)) return;
        unknown.push(id);
    });
    ok(unknown.length === 0,
        `${pageName} 的 WXML 只引用声明过的字段`,
        unknown.length ? '未声明：' + unknown.join('、') : '');

    // ---- 检查 3：每个 handler 都用到了 dataset（有 data-* 支撑） ----
    const declaredDatasets = new Set();
    const dsRe = /data-([a-z]+)\s*=/g;
    let d;
    while ((d = dsRe.exec(wxmlSrc)) !== null) declaredDatasets.add(d[1]);

    const usedDatasets = new Set();
    const usedRe = /dataset\.([a-zA-Z]+)/g;
    let u;
    while ((u = usedRe.exec(jsSrc)) !== null) usedDatasets.add(u[1]);

    const orphan = [];
    usedDatasets.forEach(function (k) {
        if (!declaredDatasets.has(k)) orphan.push(k);
    });
    ok(orphan.length === 0,
        `${pageName} 用到的 dataset 字段在 WXML 里都有 data-* 来源`,
        orphan.length ? '缺失：' + orphan.join('、') : '');
});

// ============================================================
section('2. 页面清单与 app.json 一致');

{
    const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
    ok(Array.isArray(appJson.pages) && appJson.pages.length >= 2, 'app.json 声明了页面列表');
    appJson.pages.forEach(function (p) {
        ok(fs.existsSync(path.join(ROOT, p + '.js')), `app.json 里的 ${p}.js 存在`);
        ok(fs.existsSync(path.join(ROOT, p + '.wxml')), `app.json 里的 ${p}.wxml 存在`);
        ok(fs.existsSync(path.join(ROOT, p + '.json')), `app.json 里的 ${p}.json 存在`);
        ok(fs.existsSync(path.join(ROOT, p + '.wxss')), `app.json 里的 ${p}.wxss 存在`);
    });
    ok(appJson.window && appJson.window.navigationBarTitleText, 'app.json 配了导航栏标题');
}

// ============================================================
section('3. 关键配置：能让预览跑起来');

{
    const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'));
    eq(conf.compileType, 'miniprogram', 'compileType 是 miniprogram');
    eq(conf.miniprogramRoot, './', '代码根目录指向当前目录');
    eq(conf.setting.urlCheck, false,
        'urlCheck 为 false —— 这等价于在开发者工具里勾选「不校验合法域名」，预览到手机才能直接访问币安接口');
    eq(conf.setting.es6, true, '开启 ES6 转 ES5');
    eq(conf.setting.enhance, true, '开启增强编译（libs/technical.js 用到可选链，必须开）');
    ok(!!conf.appid, 'appid 字段存在（默认是游客模式，需替换成自己的 AppID 才能预览到手机）');
}

// ============================================================
section('4. 同步产物是最新的');

{
    const { execFileSync } = require('child_process');
    const before = ['technical.js', 'signals.js', 'stocks.js'].map(function (f) {
        return fs.readFileSync(path.join(ROOT, 'libs', f), 'utf8');
    });
    execFileSync('node', [path.join(ROOT, 'sync-libs.js')], { stdio: 'pipe' });
    const after = ['technical.js', 'signals.js', 'stocks.js'].map(function (f) {
        return fs.readFileSync(path.join(ROOT, 'libs', f), 'utf8');
    });
    let same = true;
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) same = false;
    ok(same, 'libs/ 与网页端模块一致（重跑 sync-libs.js 没有产生改动）');
}

// ============================================================
console.log('\n' + '─'.repeat(56));
console.log(`通过 ${passed}　失败 ${failed}`);
if (failed) {
    console.log('\n失败项：');
    failures.forEach(f => console.log('  · ' + f));
    process.exit(1);
} else {
    console.log('全部通过');
}
