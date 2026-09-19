# CryptoPulse 小程序版（原生）

用微信开发者工具打开本目录，点「预览」，手机扫码即可自己使用。

---

## 为什么是原生版，而不是套一层网页

微信明确**不允许个人主体小程序配置业务域名**，而 `web-view` 组件依赖业务域名 —— 也就是说个人主体的小程序根本无法用 `web-view` 加载外部网页（[官方域名管理说明](https://developers.weixin.qq.com/doc/oplatform/developers/basic_func/domain.html)、[开放社区答复](https://developers.weixin.qq.com/community/develop/doc/000ec2721ac178f1354454de866c00)）。

所以这里做的是**原生小程序**：界面用 WXML/WXSS 重写，K线用 Canvas 手绘，
但**分析逻辑一行都没重写** —— `libs/` 里的指标、信号、美股数据源是从网页端同步过来的同一份代码（见下方「同步机制」）。
这样主体类型不受限制，个人主体也能用。

---

## 三步跑起来

### 1. 装工具

下载并安装[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)（稳定版即可），用微信扫码登录。

### 2. 导入项目

- 打开开发者工具 → 「导入项目」
- **目录**：选择本 `miniprogram` 文件夹（注意是这一层，不是仓库根目录）
- **AppID**：填你自己的小程序 AppID
  - 没有的话先去[微信公众平台](https://mp.weixin.qq.com/)注册一个个人小程序，免费，几分钟搞定
  - 也可以先留空点「游客模式」进去看界面，但**游客模式不能预览到手机**
- 后端服务：选「不使用云服务」

### 3. 预览到手机

- 确认右上角「详情 → 本地设置」里 **「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」已勾选**
  - 本项目的 `project.config.json` 里已经默认 `"urlCheck": false`，正常情况下导入后就是勾上的
- 点工具栏的「预览」，生成二维码，用手机微信扫码打开

手机上如果出现数据加载不出来，**在右上角「…」菜单里打开「调试」**，域名校验会被放开，数据就正常了。

> 预览版**不需要 ICP 备案**，也不需要自备域名和服务器。未备案的小程序只能使用开发版和体验版，而预览正好属于这一类（[官方说明](https://developers.weixin.qq.com/community/develop/doc/0006246b09cdc8f5d76449f7961400)）。

---

## 目录结构

```
miniprogram/
├── app.js / app.json / app.wxss      # 小程序入口与全局样式
├── project.config.json               # 工程配置（urlCheck:false 已设好）
├── sitemap.json
├── sync-libs.js                      # 从网页端同步纯逻辑模块（见下）
├── libs/                             # ⚠️ 自动生成，勿手改
│   ├── technical.js   ← js/technical.js   （指标与评分）
│   ├── signals.js     ← js/signals.js     （信号生成）
│   └── stocks.js      ← js/stocks.js      （美股合约数据源）
├── utils/
│   ├── fetch-shim.js                 # 用 wx.request 实现 fetch 子集
│   ├── api.js                        # 目录 / 行情 / K线 / 费率 / 情绪指数
│   ├── analyze.js                    # 指标 + 评分 + 信号（口径与网页端对齐）
│   ├── chart.js                      # Canvas 2D 手绘K线
│   ├── format.js                     # 数字格式化（不依赖 Intl）
│   └── store.js                      # 自选 / 元数据 / 设置 / 目录缓存
├── pages/
│   ├── index/                        # 行情列表：自选 / 热门 / 美股 + 搜索
│   └── detail/                       # 详情：K线、指标、综合信号、加减仓区间
└── tests/
    ├── analyze.test.js               # 分析链路（Node 里跑）
    └── wxml.test.js                  # 页面链接静态检查
```

---

## 同步机制（重要）

`libs/` 下的三个文件**不是手写的**，是脚本从网页端生成的：

```bash
node miniprogram/sync-libs.js
```

为什么这么做：`technical.js` / `signals.js` / `stocks.js` 都不碰 DOM、不碰 `localStorage`，
是可以原样复用的纯逻辑。但小程序用 CommonJS，需要给每个文件补一行 `module.exports`。
手抄一份的话两边必然逐渐走样 —— 网页端改了 MA 窗口降级规则、改了评分权重，
小程序那份就悄悄过期了。

所以**以后只要改动了这三个文件中的任何一个，跑一次同步脚本即可**。

脚本还会拦下两类问题：源文件里出现 `document` / `window` / `localStorage` 等小程序没有的 API，或者源文件里已经有 `module.exports`（会造成重复导出）。

另外为了让 `stocks.js` 里的 `fetch(...)` 原样能跑，`utils/fetch-shim.js` 用 `wx.request` 实现了 fetch 的最小子集（`ok` / `status` / `json()` / `text()`），在 `app.js` 里于任何请求之前装好。

---

## 与网页版的功能差异

已实现：自选管理、热门与美股分类、全库搜索（现货 + 美股）、K线（1小时/4小时/日线/周线）、
技术指标、关键价位、综合信号与因子面板、加减仓区间、信号灵敏度档位、历史深度提示。

**本版没做**（网页端有）：

| 功能 | 说明 |
|------|------|
| 消息面因子 | 没有接入资讯源，权重固定为 0 并在界面上标明，不参与评分 |
| 模拟盘 | 按K线买卖点回放的模拟账户 |
| 预测记录 | 历史信号的复盘与命中率统计 |
| 币安下单 | 需要本地签名代理，小程序里没法跑 |
| CoinGecko 币种 | 币安未收录的币种（如 GWEI）暂不支持 |

因此**加密币的综合评分与网页端不完全可比**：网页端是五因子（含消息面），这里是四因子再归一。
界面上会明确写出哪几项没参与评分，不会拿 50 分去顶替。

美股的口径与网页端完全一致：只由技术面 + 量能按 2:1 构成 ——
加密恐慌贪婪指数与加密新闻对个股不适用，美股合约的资金费率实测长期贴近 0
（远低于评分阈值 0.05%），三项都不参与。

---

## 跑测试

```bash
# 分析链路：指标、长期均线降级、因子权重归一、K线映射、画布绘制、存储、格式化
node miniprogram/tests/analyze.test.js

# 页面静态检查：WXML 里绑的方法是否存在、引用的字段是否声明过
node miniprogram/tests/wxml.test.js
```

`wxml.test.js` 专门防一类事故：WXML 里 `bindtap` 方法名拼错一个字，
编译不报错、运行不报错，按钮就是死着；或者引用了 `data` 里不存在的字段，
页面上永远空白。这两种都能静态查出来。

---

## 常见问题

**打开后数据全是空的，提示域名校验失败**
开发者工具「详情 → 本地设置」勾选「不校验合法域名…」后重新编译；
手机上则在右上角「…」里打开「调试」。

**手机上能出界面但取不到数据**
确认手机网络能访问币安（`data-api.binance.vision`、`fapi.binance.com`）。
部分网络环境需要代理。

**K线显示「暂无K线数据」**
美股刚上线时K线很少（周线只有 24 根），切到「日线」或「4小时」会正常。

**想给别人也用**
把开发版设为「体验版」，在后台添加体验成员（最多 30 人）。
正式发布则需要小程序认证 + 备案 + 已备案的 HTTPS 域名（用于 `request` 合法域名），
对「自己用」这个目标来说没必要。

---

## 免责声明

本项目仅供个人研究使用，所有数据来自币安公开接口，不构成任何投资建议。
