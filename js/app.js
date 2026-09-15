/**
 * CryptoPulse - 主应用逻辑（币安白色主题版）
 * 负责数据获取、状态管理、UI更新和用户交互
 */

const CryptoPulseApp = {
    // 状态
    state: {
        currentCoin: 'bitcoin',
        currentTimeframe: 24, // 小时数（对应 data-tf 值）
        currentTab: 'quote',  // 当前子tab: quote | info | signals | news
        watchlist: ['bitcoin', 'ethereum', 'binancecoin', 'solana', 'ripple'],
        coinInfo: {},
        priceData: null,
        candleData: [],
        indicators: {},
        newsList: [],
        signal: null,
        isLoading: false,
        lastUpdate: null,
        showSignalMarkers: true,
        showMA: true,
        showVolume: true,
        coinCatalog: [],        // 联网获取的币安全量交易对
        catalogLoaded: false,
        catalogLoading: false,
        coinMeta: {},           // 联网添加的币种元数据 { coinId: {id, symbol, name, binanceSymbol} }
        watchlistQuotes: {},    // 自选币种行情 { coinId: {price, changePercent} }
        marketTab: 'watchlist', // 币种选择器内的分类：watchlist | hot | all | defi | meme
        coinListLimit: 50,      // 列表模式显示条数
        coinListQuotes: {},      // 列表模式行情缓存 { binanceSymbol: {price, changePercent} }
        usdtToCnyRate: 7.25,    // USDT兑人民币汇率（估算）
    },

    // 常见币种的中文名（联网币种若无中文名则显示符号）
    coinNameMap: {
        'BTC': '比特币', 'ETH': '以太坊', 'BNB': '币安币', 'SOL': 'Solana',
        'XRP': '瑞波币', 'ADA': '艾达币', 'DOGE': '狗狗币', 'DOT': '波卡币',
        'AVAX': '雪崩币', 'LINK': 'Chainlink', 'MATIC': 'Polygon', 'LTC': '莱特币',
        'UNI': 'Uniswap', 'ATOM': 'Cosmos', 'XLM': '恒星币', 'TRX': '波场',
        'TON': 'Toncoin', 'SHIB': '柴犬币', 'PEPE': '佩佩蛙', 'SUI': 'Sui',
        'APT': 'Aptos', 'ARB': 'Arbitrum', 'OP': 'Optimism', 'NEAR': 'NEAR',
        'FIL': 'Filecoin', 'ETC': '以太经典', 'BCH': '比特现金', 'HBAR': 'Hedera',
        'ICP': '互联网计算机', 'VET': '唯链', 'ALGO': 'Algorand', 'SAND': 'The Sandbox',
        'MANA': 'Decentraland', 'AXS': 'Axie Infinity', 'EOS': '柚子币', 'AAVE': 'Aave',
        'MKR': 'Maker', 'GRT': 'The Graph', 'FTM': 'Fantom', 'INJ': 'Injective',
        'SEI': 'Sei', 'TIA': 'Celestia', 'WIF': 'dogwifhat', 'BONK': 'Bonk',
        'ORDI': 'Ordinals', 'JUP': 'Jupiter', 'PYTH': 'Pyth', 'STRK': 'Starknet',
        'SNX': 'Synthetix', 'CRV': 'Curve', 'COMP': 'Compound', 'ZEC': 'Zcash',
        'XMR': '门罗币', 'DASH': '达世币', 'EGLD': 'MultiversX', 'RENDER': 'Render',
        'IMX': 'Immutable', 'LDO': 'Lido', 'GALA': 'Gala', 'APE': 'ApeCoin',
        'CHZ': 'Chiliz', 'ONE': 'Harmony', 'ZIL': 'Zilliqa', 'BAT': 'Basic Attention',
        'ENJ': 'Enjin', 'KSM': 'Kusama', 'AR': 'Arweave', 'STX': 'Stacks',
        'MINA': 'Mina', 'FLOW': 'Flow', 'ROSE': 'Oasis', 'CFX': 'Conflux',
        'KAS': 'Kaspa', 'TAO': 'Bittensor', 'WLD': 'Worldcoin', 'JTO': 'Jito',
        'ENA': 'Ethena', 'ETHFI': 'Ether.fi', 'ZK': 'ZKsync', 'W': 'Wormhole',
        'PENDLE': 'Pendle', 'ONDO': 'Ondo', 'FET': 'Fetch.ai', 'THETA': 'Theta',
        'CAKE': 'PancakeSwap', 'SUSHI': 'SushiSwap', '1INCH': '1inch', 'DYDX': 'dYdX',
        'GMX': 'GMX', 'BLUR': 'Blur', 'MASK': 'Mask Network', 'ENS': 'ENS',
        'CRO': 'Cronos', 'OKB': 'OKB', 'HT': 'Huobi', 'NEO': 'NEO',
        'IOTA': 'IOTA', 'QNT': 'Quant', 'RPL': 'Rocket Pool', 'SSV': 'SSV Network',
        'ANKR': 'Ankr', 'CELO': 'Celo', 'IOTX': 'IoTeX', 'ZRX': '0x Protocol',
        'SNT': 'Status', 'LRC': 'Loopring', 'STORJ': 'Storj', 'OCEAN': 'Ocean',
        'MAGIC': 'Magic', 'ID': 'SPACE ID', 'ARKM': 'Arkham', 'CYBER': 'CyberConnect'
    },

    // 信号详细解释字典
    signalInfoMap: {
        '强烈买入': {
            type: 'buy',
            strength: 'strong',
            strengthText: '强',
            desc: '多因子综合评分达到 70 分以上，技术面、量能与情绪面形成共振，是力度最强的看多结论。',
            condition: '综合评分 ≥ 70：MACD 处于多头、均线多头排列、价格站上 MA25、KDJ 金叉、RSI 未超买、量价配合良好等多项条件同时成立。',
            advice: '可考虑分批建仓，仓位相应提高。若后续出现量能萎缩或价格跌破 MA25，需及时减仓。'
        },
        '买入': {
            type: 'buy',
            strength: 'medium',
            strengthText: '中等',
            desc: '多因子综合评分在 58 至 70 分之间，多头因素占优，趋势偏多但力度中等。',
            condition: '综合评分 ≥ 58 且 < 70：多数技术指标偏多，量能或情绪面提供配合。',
            advice: '可轻仓试探性建仓，逢回调分批加仓；同时设好止损，避免在压力位附近追高。'
        },
        '卖出': {
            type: 'sell',
            strength: 'medium',
            strengthText: '中等',
            desc: '多因子综合评分在 30 至 42 分之间，空头因素占优，需要控制仓位。',
            condition: '综合评分 ≤ 42 且 > 30：多数技术指标转空，或出现放量下跌、跌破关键支撑。',
            advice: '建议降低仓位，跌破关键支撑位需果断止损；等指标修复后再重新评估。'
        },
        '强烈卖出': {
            type: 'sell',
            strength: 'strong',
            strengthText: '强',
            desc: '多因子综合评分跌破 30 分，空头因素集中，属于力度最强的看空结论。',
            condition: '综合评分 ≤ 30：MACD 空头、均线空头排列、价格跌破 MA25、KDJ 死叉、RSI 超买回落、放量下跌等多项条件共振。',
            advice: '建议大幅减仓或离场观望，等待缩量企稳、指标出现修复信号后再评估重新介入。'
        },
        'MACD金叉': {
            type: 'buy',
            strength: 'medium',
            strengthText: '中等',
            desc: 'MACD金叉是指MACD线上穿信号线形成的交叉信号，是趋势由空转多的重要标志。当快线从下方穿过慢线向上时，表明多头力量正在增强。',
            condition: 'MACD线（DIF）从下方向上穿越信号线（DEA），形成金叉形态。',
            advice: '可考虑轻仓试探性买入，配合成交量放大信号可靠性更高。若同时处于零轴上方，趋势确认度更强。'
        },
        'MACD死叉': {
            type: 'sell',
            strength: 'medium',
            strengthText: '中等',
            desc: 'MACD死叉是指MACD线下穿信号线形成的交叉信号，是趋势由多转空的重要标志。当快线从上方穿过慢线向下时，表明空头力量正在增强。',
            condition: 'MACD线（DIF）从上方向下跌破信号线（DEA），形成死叉形态。',
            advice: '可考虑减仓或设置止损。若同时跌破零轴，趋势转空确认度更高。'
        },
        'KDJ金叉': {
            type: 'buy',
            strength: 'medium',
            strengthText: '中等',
            desc: 'KDJ金叉是指K线上穿D线形成的交叉，表明短期动能由弱转强。KDJ指标通过价格波动的快慢来判断超买超卖和趋势转折。',
            condition: 'K线从下方上穿D线，形成金叉。',
            advice: '短期买入信号，可关注后续K线能否站稳D线上方。配合其他指标综合判断更佳。'
        },
        'KDJ超卖金叉': {
            type: 'buy',
            strength: 'strong',
            strengthText: '强',
            desc: 'KDJ在超卖区域（20以下）形成金叉，是强烈的买入信号。价格经过充分回调后，动能开始修复，往往对应阶段性底部。',
            condition: 'K值和D值均处于20以下的超卖区域，同时K线上穿D线形成金叉。',
            advice: '强烈买入信号，可考虑分批建仓。超卖区域金叉的反弹力度通常较大，但需设好止损以防假突破。'
        },
        'KDJ死叉': {
            type: 'sell',
            strength: 'medium',
            strengthText: '中等',
            desc: 'KDJ死叉是指K线下穿D线形成的交叉，表明短期动能由强转弱，价格可能进入调整阶段。',
            condition: 'K线从上方下穿D线，形成死叉。',
            advice: '短期卖出信号，可考虑减仓观望。若同时跌破重要支撑位，需提高警惕。'
        },
        'KDJ超买死叉': {
            type: 'sell',
            strength: 'strong',
            strengthText: '强',
            desc: 'KDJ在超买区域（80以上）形成死叉，是强烈的卖出信号。价格经过充分上涨后，动能开始衰竭，往往对应阶段性顶部。',
            condition: 'K值和D值均处于80以上的超买区域，同时K线下穿D线形成死叉。',
            advice: '强烈卖出信号，可考虑大幅减仓或止盈。超买区域死叉的回调幅度通常较大。'
        },
        'RSI超卖回升': {
            type: 'buy',
            strength: 'strong',
            strengthText: '强',
            desc: 'RSI从超卖区域（30以下）回升至30以上，表明下跌动能衰竭，买方开始占据主动，是经典的抄底信号之一。',
            condition: 'RSI指标从30以下的超卖区域回升，突破30关口。',
            advice: '可考虑逢低分批买入。RSI超卖回升后，往往会有技术性反弹，但需确认底部形态是否成立。'
        },
        'RSI超买回落': {
            type: 'sell',
            strength: 'strong',
            strengthText: '强',
            desc: 'RSI从超买区域（70以上）回落至70以下，表明上涨动能衰竭，卖方开始占据主动，是经典的逃顶信号之一。',
            condition: 'RSI指标从70以上的超买区域回落，跌破70关口。',
            advice: '可考虑止盈减仓。RSI超买回落后，往往会有技术性回调，注意控制仓位风险。'
        },
        '均线金叉': {
            type: 'buy',
            strength: 'medium',
            strengthText: '中等',
            desc: '短期均线上穿长期均线形成金叉，表明短期平均成本超过长期平均成本，市场情绪由空转多，是趋势反转的重要信号。',
            condition: '短期均线（如MA7）从下方向上穿越长期均线（如MA25）。',
            advice: '趋势性买入信号，可考虑建仓并持有。均线金叉的可靠性较高，但需注意是否为假突破。'
        },
        '均线死叉': {
            type: 'sell',
            strength: 'medium',
            strengthText: '中等',
            desc: '短期均线下穿长期均线形成死叉，表明短期平均成本跌破长期平均成本，市场情绪由多转空，是趋势走坏的重要信号。',
            condition: '短期均线（如MA7）从上方向下跌破长期均线（如MA25）。',
            advice: '趋势性卖出信号，可考虑减仓或离场。均线死叉往往预示着中期调整的开始。'
        },
        '布林下轨反弹': {
            type: 'buy',
            strength: 'medium',
            strengthText: '中等',
            desc: '价格触及布林带下轨后反弹，表明在超卖位置获得支撑。布林带反映了价格的波动区间，下轨通常代表较强的支撑位。',
            condition: '价格触及或跌破布林带下轨后，快速回升至下轨上方。',
            advice: '短线买入信号，可轻仓参与反弹。若同时伴随成交量放大和其他指标配合，可靠性更高。'
        },
        '布林上轨回落': {
            type: 'sell',
            strength: 'medium',
            strengthText: '中等',
            desc: '价格触及布林带上轨后回落，表明在超买位置遇到压力。布林带上轨通常代表较强的阻力位，价格触及后容易出现回调。',
            condition: '价格触及或突破布林带上轨后，快速回落至上轨下方。',
            advice: '短线卖出信号，可考虑部分止盈。若价格多次触及上轨不破，形成双顶的概率增大。'
        },
        'StochRSI超卖金叉': {
            type: 'buy',
            strength: 'strong',
            strengthText: '强',
            desc: 'Stochastic RSI在超卖区域（20以下）形成金叉，是比普通RSI更灵敏的买入信号。StochRSI结合了RSI和KDJ的优点，对短期动能变化更敏感。',
            condition: 'StochRSI的%K和%D均处于20以下超卖区，同时%K上穿%D形成金叉。',
            advice: '强烈短线买入信号，反弹速度通常较快。但由于灵敏度高，信号也较多，建议配合其他指标过滤。'
        },
        'StochRSI超买死叉': {
            type: 'sell',
            strength: 'strong',
            strengthText: '强',
            desc: 'Stochastic RSI在超买区域（80以上）形成死叉，是比普通RSI更灵敏的卖出信号。价格经过快速上涨后，动能出现衰竭迹象。',
            condition: 'StochRSI的%K和%D均处于80以上超买区，同时%K下穿%D形成死叉。',
            advice: '强烈短线卖出信号，回调速度通常较快。可考虑快速止盈，避免利润回吐。'
        },
        '高点': {
            type: 'sell',
            strength: 'weak',
            strengthText: '弱',
            desc: '局部高点是指价格在一段时间内达到的相对高位，前后几根K线的最高点都低于该位置。高点可能是短期压力位或反转信号。',
            condition: '当前K线高点高于前后各3根K线的高点，形成局部最高点。',
            advice: '注意短期回调风险，持仓者可考虑部分止盈。若高点伴随放量长上影线，见顶信号更可靠。'
        },
        '低点': {
            type: 'buy',
            strength: 'weak',
            strengthText: '弱',
            desc: '局部低点是指价格在一段时间内达到的相对低位，前后几根K线的最低点都高于该位置。低点可能是短期支撑位或反弹信号。',
            condition: '当前K线低点低于前后各3根K线的低点，形成局部最低点。',
            advice: '关注反弹机会，激进者可轻仓抄底。若低点伴随放量长下影线，见底信号更可靠。'
        }
    },

    // 币安 API 基础地址
    binanceApiBase: 'https://data-api.binance.vision/api/v3',

    // 数据加载令牌：保证最后一次切换币种的请求生效
    _loadToken: 0,

    // 主流币种列表（同时映射币安交易对）
    popularCoins: [
        { id: 'bitcoin', symbol: 'BTC', name: '比特币', image: '₿', binanceSymbol: 'BTCUSDT' },
        { id: 'ethereum', symbol: 'ETH', name: '以太坊', image: 'Ξ', binanceSymbol: 'ETHUSDT' },
        { id: 'binancecoin', symbol: 'BNB', name: '币安币', image: 'B', binanceSymbol: 'BNBUSDT' },
        { id: 'solana', symbol: 'SOL', name: 'Solana', image: 'S', binanceSymbol: 'SOLUSDT' },
        { id: 'ripple', symbol: 'XRP', name: '瑞波币', image: 'X', binanceSymbol: 'XRPUSDT' },
        { id: 'cardano', symbol: 'ADA', name: '艾达币', image: 'A', binanceSymbol: 'ADAUSDT' },
        { id: 'dogecoin', symbol: 'DOGE', name: '狗狗币', image: 'D', binanceSymbol: 'DOGEUSDT' },
        { id: 'polkadot', symbol: 'DOT', name: '波卡币', image: 'P', binanceSymbol: 'DOTUSDT' },
        { id: 'avalanche-2', symbol: 'AVAX', name: '雪崩币', image: 'A', binanceSymbol: 'AVAXUSDT' },
        { id: 'chainlink', symbol: 'LINK', name: 'Chainlink', image: 'L', binanceSymbol: 'LINKUSDT' },
        { id: 'matic-network', symbol: 'MATIC', name: 'Polygon', image: 'M', binanceSymbol: 'MATICUSDT' },
        { id: 'litecoin', symbol: 'LTC', name: '莱特币', image: 'L', binanceSymbol: 'LTCUSDT' },
        { id: 'uniswap', symbol: 'UNI', name: 'Uniswap', image: 'U', binanceSymbol: 'UNIUSDT' },
        { id: 'cosmos', symbol: 'ATOM', name: 'Cosmos', image: 'C', binanceSymbol: 'ATOMUSDT' },
        { id: 'stellar', symbol: 'XLM', name: '恒星币', image: 'X', binanceSymbol: 'XLMUSDT' },
    ],

    // DeFi 币种
    defiCoins: ['UNI', 'AAVE', 'COMP', 'SNX', 'CRV', 'MKR', 'GRT', '1INCH', 'DYDX', 'GMX', 'LDO', 'RPL', 'SSV', 'PENDLE', 'JTO', 'ENA', 'ZK'],

    // MEME 币种
    memeCoins: ['DOGE', 'SHIB', 'PEPE', 'WIF', 'BONK', 'FLOKI', 'DOGS', 'POPCAT', 'MEW', 'TOKEN'],

    // 获取币安交易对符号
    getBinanceSymbol(coinId) {
        const coin = this.popularCoins.find(c => c.id === coinId);
        if (coin) return coin.binanceSymbol;
        const meta = this.state.coinMeta[coinId];
        return meta ? meta.binanceSymbol : null;
    },

    // 时间周期配置：data-tf 值 -> 币安K线间隔 / 单根K线秒数
    timeframeConfig: {
        '0.25': { interval: '1m',  seconds: 60,     label: '分时' },
        '0.5':  { interval: '15m', seconds: 900,    label: '15分' },
        '1':    { interval: '1h',  seconds: 3600,   label: '1小时' },
        '4':    { interval: '4h',  seconds: 14400,  label: '4小时' },
        '24':   { interval: '1d',  seconds: 86400,  label: '日线' },
        '168':  { interval: '1w',  seconds: 604800, label: '周线' },
    },

    /**
     * 取时间周期配置
     * @param {number|string} tf - data-tf 值（0.25 / 0.5 / 1 / 4 / 24 / 168）
     * @returns {{interval: string, seconds: number, label: string}}
     */
    getTimeframeConfig(tf) {
        return this.timeframeConfig[String(tf)] || this.timeframeConfig['24'];
    },

    /**
     * 联网加载币安全量交易对目录
     */
    async loadCoinCatalog(force = false) {
        if (this.state.catalogLoading) return;
        if (this.state.catalogLoaded && !force) return;

        // 先尝试读缓存（24 小时有效）
        if (!force) {
            try {
                const cached = JSON.parse(localStorage.getItem('cryptoPulse_catalog_v2') || 'null');
                if (cached && cached.ts && Date.now() - cached.ts < 24 * 3600 * 1000 && cached.list?.length) {
                    this.state.coinCatalog = this.sortCatalog(this.applyCoinNames(cached.list));
                    this.state.catalogLoaded = true;
                    return;
                }
            } catch (e) { /* 忽略缓存损坏 */ }
        }

        this.state.catalogLoading = true;

        try {
            const resp = await fetch(`${this.binanceApiBase}/exchangeInfo`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();

            const list = (data.symbols || [])
                .filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT')
                .map(s => {
                    const base = s.baseAsset;
                    return {
                        coinId: base.toLowerCase(),
                        symbol: base,
                        name: this.coinNameMap[base] || base,
                        binanceSymbol: s.symbol,
                        _vol: 0
                    };
                })
                .sort((a, b) => a.binanceSymbol.length - b.binanceSymbol.length);

            const seen = new Set();
            const unique = this.sortCatalog(this.applyCoinNames(list.filter(c => {
                if (seen.has(c.coinId)) return false;
                seen.add(c.coinId);
                return true;
            })));

            this.state.coinCatalog = unique;
            this.state.catalogLoaded = true;
            this.state.catalogLoading = false;

            localStorage.setItem('cryptoPulse_catalog_v2', JSON.stringify({ ts: Date.now(), list: unique }));
            console.log(`[币种目录] 联网获取成功，共 ${unique.length} 个 USDT 交易对`);

            // 目录更新后重绘币种选择器列表
            const modal = document.getElementById('coinSelectorModal');
            if (modal && !modal.classList.contains('hidden')) {
                this.renderCoinSelectorList();
            }

            // 若当前处于非自选分类，重绘列表
            if (this.state.marketTab !== 'watchlist') {
                this.renderCoinSelectorList();
            }

            return unique;
        } catch (e) {
            this.state.catalogLoading = false;
            console.warn('[币种目录] 联网获取失败，降级为内置列表:', e.message);
            this.state.coinCatalog = this.popularCoins.map(c => ({
                coinId: c.id, symbol: c.symbol, name: c.name, binanceSymbol: c.binanceSymbol
            }));
            this.state.catalogLoaded = true;
            return this.state.coinCatalog;
        }
    },

    applyCoinNames(list) {
        list.forEach(c => {
            const mapped = this.coinNameMap[c.symbol];
            if (mapped) c.name = mapped;
        });
        return list;
    },

    sortCatalog(list) {
        const hotRank = new Map(this.popularCoins.map((c, i) => [c.binanceSymbol, i]));
        return list.sort((a, b) => {
            const ra = hotRank.has(a.binanceSymbol) ? hotRank.get(a.binanceSymbol) : 9999;
            const rb = hotRank.has(b.binanceSymbol) ? hotRank.get(b.binanceSymbol) : 9999;
            if (ra !== rb) return ra - rb;
            return (a.symbol || '').localeCompare(b.symbol || '');
        });
    },

    /**
     * 批量拉取自选币种行情
     */
    async loadWatchlistQuotes() {
        const symbols = this.state.watchlist
            .map(id => this.getBinanceSymbol(id))
            .filter(Boolean);
        if (symbols.length === 0) return;

        try {
            const query = encodeURIComponent(JSON.stringify(symbols));
            const resp = await fetch(`${this.binanceApiBase}/ticker/24hr?symbols=${query}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();

            const quotes = {};
            const arr = Array.isArray(data) ? data : [data];
            arr.forEach(t => {
                const coinId = this.state.watchlist.find(id => this.getBinanceSymbol(id) === t.symbol);
                if (coinId) {
                    quotes[coinId] = {
                        price: parseFloat(t.lastPrice),
                        changePercent: parseFloat(t.priceChangePercent)
                    };
                }
            });
            this.state.watchlistQuotes = quotes;
            // 若币种选择器打开，同步刷新
            const modal = document.getElementById('coinSelectorModal');
            if (modal && !modal.classList.contains('hidden')) {
                this.renderCoinSelectorList();
            }
        } catch (e) {
            console.warn('自选行情加载失败:', e.message);
        }
    },

    // 初始化
    async init() {
        this.loadCoinMeta();
        this.loadWatchlist();
        this.loadUIState();
        this.bindEvents();
        this.initChart();
        this.initTabs();
        this.applyUIState();
        // 后台联网拉取币种目录与自选行情
        this.loadCoinCatalog();
        this.loadWatchlistQuotes();
        await this.loadCoinData(this.state.currentCoin);
        this.updateFavoriteButton();
        this.saveUIState();
        this.startAutoRefresh();
    },

    // 绑定事件
    bindEvents() {
        // 刷新按钮
        document.getElementById('refreshBtn').addEventListener('click', () => {
            this.loadCoinData(this.state.currentCoin, true);
        });

        // 新闻刷新
        const refreshNewsBtn = document.getElementById('refreshNewsBtn');
        if (refreshNewsBtn) {
            refreshNewsBtn.addEventListener('click', () => {
                this.loadNews(this.state.currentCoin);
            });
        }

        // 时间周期切换（tf-btn）
        document.querySelectorAll('.tf-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const tf = e.currentTarget.dataset.tf;
                if (tf === 'more') return; // "更多"按钮暂不展开
                document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
                e.currentTarget.classList.add('active');
                // 直接保存 data-tf 值，K线间隔由 getTimeframeConfig 映射
                this.state.currentTimeframe = parseFloat(tf);
                this.saveUIState();
                ChartManager.changeTimeframe(this.state.currentTimeframe);
                this.loadCandleData(this.state.currentCoin);
            });
        });

        // 图表设置按钮：切换均线显示
        const chartSettingsBtn = document.getElementById('chartSettingsBtn');
        if (chartSettingsBtn) {
            chartSettingsBtn.addEventListener('click', () => {
                this.state.showMA = !this.state.showMA;
                ChartManager.toggleMA(this.state.showMA);
                this.saveUIState();
                this.showToast(this.state.showMA ? '已显示均线' : '已隐藏均线');
            });
        }

        // 全屏按钮：图表全屏查看
        const chartFullscreenBtn = document.getElementById('chartFullscreenBtn');
        if (chartFullscreenBtn) {
            chartFullscreenBtn.addEventListener('click', () => {
                this.toggleChartFullscreen();
            });
        }

        // ESC 退出全屏
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && document.body.classList.contains('chart-locked')) {
                this.exitChartFullscreen();
            }
        });

        // 清空当前币种+周期的预测历史
        const clearHistoryBtn = document.getElementById('clearHistoryBtn');
        if (clearHistoryBtn) {
            clearHistoryBtn.addEventListener('click', () => {
                const coin = this.getCoinInfo(this.state.currentCoin);
                const tfLabel = this.getTimeframeConfig(this.state.currentTimeframe).label;
                if (!confirm(`确定清空 ${coin.symbol} ${tfLabel} 的预测历史记录？`)) return;

                PredictionTracker.clear(this.state.currentCoin, this.state.currentTimeframe);
                this.renderAccuracyStats();
                this.renderPredictionHistory();
                this.showToast('已清空预测历史');
            });
        }

        // 底部栏自选按钮 -> 打开币种选择器
        const watchlistToggleBtn = document.getElementById('watchlistToggleBtn');
        if (watchlistToggleBtn) {
            watchlistToggleBtn.addEventListener('click', () => {
                this.showCoinSelectorModal();
            });
        }

        // 币种选择器关闭按钮
        const closeCoinSelectorBtn = document.getElementById('closeCoinSelectorBtn');
        if (closeCoinSelectorBtn) {
            closeCoinSelectorBtn.addEventListener('click', () => {
                this.hideCoinSelectorModal();
            });
        }

        // 点击币种选择器遮罩关闭
        const coinSelectorModal = document.getElementById('coinSelectorModal');
        if (coinSelectorModal) {
            coinSelectorModal.addEventListener('click', (e) => {
                if (e.target.id === 'coinSelectorModal') {
                    this.hideCoinSelectorModal();
                }
            });
        }

        // 币种选择器搜索
        const coinSearchInput = document.getElementById('coinSearchInput');
        if (coinSearchInput) {
            coinSearchInput.addEventListener('input', (e) => {
                this.state.coinListLimit = 50;
                this.renderCoinSelectorList(e.target.value);
            });
        }

        // 币种选择器分类切换
        document.querySelectorAll('.coin-cat-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.switchCoinCategory(btn.dataset.market);
            });
        });

        // 资讯详情弹窗
        const closeNewsDetailBtn = document.getElementById('closeNewsDetailBtn');
        if (closeNewsDetailBtn) {
            closeNewsDetailBtn.addEventListener('click', () => {
                this.hideNewsDetail();
            });
        }

        const newsDetailModal = document.getElementById('newsDetailModal');
        if (newsDetailModal) {
            newsDetailModal.addEventListener('click', (e) => {
                if (e.target.id === 'newsDetailModal') {
                    this.hideNewsDetail();
                }
            });
        }

        // 信号解释弹窗
        const closeSignalDetailBtn = document.getElementById('closeSignalDetailBtn');
        if (closeSignalDetailBtn) {
            closeSignalDetailBtn.addEventListener('click', () => {
                this.hideSignalDetail();
            });
        }

        const signalDetailModal = document.getElementById('signalDetailModal');
        if (signalDetailModal) {
            signalDetailModal.addEventListener('click', (e) => {
                if (e.target.id === 'signalDetailModal') {
                    this.hideSignalDetail();
                }
            });
        }

        // 顶部币种标题点击 -> 打开币种选择器
        const coinPairTitle = document.getElementById('coinPairTitle');
        if (coinPairTitle) {
            coinPairTitle.style.cursor = 'pointer';
            coinPairTitle.parentElement.addEventListener('click', () => {
                this.showCoinSelectorModal();
            });
        }

        // 返回按钮 -> 返回行情列表（选择器已打开时则关闭它）
        const backBtn = document.getElementById('backBtn');
        if (backBtn) {
            backBtn.addEventListener('click', () => {
                this.handleBack();
            });
        }

        // 星星按钮 -> 当前币种加入/移出自选
        const favoriteBtn = document.getElementById('favoriteBtn');
        if (favoriteBtn) {
            favoriteBtn.addEventListener('click', () => {
                this.toggleFavorite();
            });
        }
    },

    /**
     * 返回：优先关闭已打开的弹层，否则回到行情列表
     */
    handleBack() {
        const selector = document.getElementById('coinSelectorModal');
        if (selector && !selector.classList.contains('hidden')) {
            this.hideCoinSelectorModal();
            return;
        }
        const newsDetail = document.getElementById('newsDetailModal');
        if (newsDetail && !newsDetail.classList.contains('hidden')) {
            this.hideNewsDetail();
            return;
        }
        const signalDetail = document.getElementById('signalDetailModal');
        if (signalDetail && !signalDetail.classList.contains('hidden')) {
            this.hideSignalDetail();
            return;
        }
        this.showCoinSelectorModal();
    },

    /**
     * 当前币种是否已在自选中
     */
    isCurrentInWatchlist() {
        return this.state.watchlist.includes(this.state.currentCoin);
    },

    /**
     * 刷新星星按钮的选中态样式
     */
    updateFavoriteButton() {
        const btn = document.getElementById('favoriteBtn');
        const icon = document.getElementById('favoriteIcon');
        if (!btn || !icon) return;

        const inList = this.isCurrentInWatchlist();

        // 已加入自选：金色实心星；未加入：灰色描边星
        icon.setAttribute('fill', inList ? 'currentColor' : 'none');
        icon.classList.toggle('text-golden', inList);
        icon.classList.toggle('text-text-secondary', !inList);

        btn.setAttribute('title', inList ? '取消自选' : '加入自选');
    },

    /**
     * 点击星星：切换当前币种的自选状态
     */
    async toggleFavorite() {
        const coinId = this.state.currentCoin;
        if (!coinId) return;

        if (this.isCurrentInWatchlist()) {
            if (this.state.watchlist.length <= 1) {
                this.showToast('至少保留一个自选币种');
                return;
            }
            // 仅移出自选，保持当前查看的币种不变
            this.removeFromWatchlist(coinId, true);
            this.showToast('已移出自选');
        } else {
            await this.addToWatchlist(coinId);
            this.showToast('已加入自选');
        }

        this.updateFavoriteButton();
    },

    /**
     * 轻提示
     * @param {string} text - 提示文案
     */
    showToast(text) {
        const el = document.getElementById('toast');
        if (!el) return;
        el.textContent = text;
        el.classList.remove('hidden');
        // 强制重排，保证连续点击也能触发过渡
        void el.offsetWidth;
        el.classList.remove('opacity-0');
        el.classList.add('opacity-100');

        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => {
            el.classList.remove('opacity-100');
            el.classList.add('opacity-0');
            setTimeout(() => el.classList.add('hidden'), 220);
        }, 1600);
    },

    /**
     * 切换图表全屏
     */
    toggleChartFullscreen() {
        if (document.body.classList.contains('chart-locked')) {
            this.exitChartFullscreen();
        } else {
            this.enterChartFullscreen();
        }
    },

    /**
     * 进入图表全屏
     */
    enterChartFullscreen() {
        const section = document.getElementById('chartSection');
        if (!section) return;

        section.classList.add('chart-fullscreen');
        document.body.classList.add('chart-locked');

        document.getElementById('fsExpandIcon')?.classList.add('hidden');
        document.getElementById('fsExitIcon')?.classList.remove('hidden');
        document.getElementById('chartFullscreenBtn')?.setAttribute('title', '退出全屏');

        // 布局生效后再让图表适配新尺寸
        requestAnimationFrame(() => ChartManager.handleResize());
        setTimeout(() => ChartManager.handleResize(), 120);
    },

    /**
     * 退出图表全屏
     */
    exitChartFullscreen() {
        const section = document.getElementById('chartSection');
        if (section) section.classList.remove('chart-fullscreen');
        document.body.classList.remove('chart-locked');

        document.getElementById('fsExpandIcon')?.classList.remove('hidden');
        document.getElementById('fsExitIcon')?.classList.add('hidden');
        document.getElementById('chartFullscreenBtn')?.setAttribute('title', '全屏查看');

        requestAnimationFrame(() => ChartManager.handleResize());
        setTimeout(() => ChartManager.handleResize(), 120);
    },

    // 初始化图表
    initChart() {
        ChartManager.init('chartContainer');
        ChartManager.setMarkerClickCallback((signalText, price, time) => {
            this.showSignalDetail(signalText, price, time);
        });
    },

    // ===== Tab 切换 =====
    initTabs() {
        document.querySelectorAll('.sub-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                this.switchTab(btn.dataset.tab);
            });
        });
    },

    switchTab(tabName) {
        if (!tabName || tabName === this.state.currentTab) return;
        this.state.currentTab = tabName;
        this.saveUIState();

        // 更新 tab 按钮样式
        document.querySelectorAll('.sub-tab').forEach(btn => {
            const active = btn.dataset.tab === tabName;
            if (active) {
                btn.classList.add('border-golden', 'text-golden');
                btn.classList.remove('border-transparent', 'text-text-secondary');
            } else {
                btn.classList.remove('border-golden', 'text-golden');
                btn.classList.add('border-transparent', 'text-text-secondary');
            }
        });

        // 切换面板显示
        document.querySelectorAll('.tab-panel').forEach(panel => {
            panel.classList.add('hidden');
        });
        const targetPanel = document.getElementById('tab-' + tabName);
        if (targetPanel) {
            targetPanel.classList.remove('hidden');
        }

        // 如果切换到图表tab，触发图表尺寸适配
        if (tabName === 'quote') {
            setTimeout(() => ChartManager.handleResize?.(), 50);
        }
    },

    // 加载自选列表
    loadWatchlist() {
        const saved = localStorage.getItem('cryptoPulse_watchlist');
        if (saved) {
            try {
                this.state.watchlist = JSON.parse(saved);
            } catch (e) {
                console.warn('读取自选列表失败', e);
            }
        }

        // 迁移清理：按交易对去重
        if (Array.isArray(this.state.watchlist) && this.state.watchlist.length > 1) {
            const currentSaved = localStorage.getItem('cryptoPulse_currentCoin');
            const seenSymbols = new Set();
            const deduped = this.state.watchlist.filter(id => {
                const sym = this.getBinanceSymbol(id) || id;
                if (id === currentSaved) {
                    seenSymbols.add(sym);
                    return true;
                }
                if (seenSymbols.has(sym)) return false;
                seenSymbols.add(sym);
                return true;
            });
            if (deduped.length !== this.state.watchlist.length) {
                console.log(`[自选] 已清理 ${this.state.watchlist.length - deduped.length} 个重复币种`);
                this.state.watchlist = deduped;
                localStorage.setItem('cryptoPulse_watchlist', JSON.stringify(deduped));
            }
        }

        const currentCoin = localStorage.getItem('cryptoPulse_currentCoin');
        if (currentCoin && this.state.watchlist.includes(currentCoin)) {
            this.state.currentCoin = currentCoin;
        } else if (currentCoin) {
            this.state.watchlist.push(currentCoin);
            this.state.currentCoin = currentCoin;
            localStorage.setItem('cryptoPulse_watchlist', JSON.stringify(this.state.watchlist));
        }
    },

    saveWatchlist() {
        localStorage.setItem('cryptoPulse_watchlist', JSON.stringify(this.state.watchlist));
        localStorage.setItem('cryptoPulse_currentCoin', this.state.currentCoin);
    },

    // ===== UI 状态持久化 =====
    uiStateKey: 'cryptoPulse_uiState',

    saveUIState() {
        const state = {
            currentCoin: this.state.currentCoin,
            currentTab: this.state.currentTab,
            marketTab: this.state.marketTab,
            timeframe: this.state.currentTimeframe,
            showMA: this.state.showMA,
            showVolume: this.state.showVolume,
            showSignals: this.state.showSignalMarkers,
        };
        try {
            localStorage.setItem(this.uiStateKey, JSON.stringify(state));
        } catch (e) {
            console.warn('保存界面状态失败:', e.message);
        }
    },

    loadUIState() {
        try {
            this._savedUIState = JSON.parse(localStorage.getItem(this.uiStateKey) || 'null');
        } catch (e) {
            this._savedUIState = null;
        }
        try {
            if (localStorage.getItem('cryptoPulse_catalog')) {
                localStorage.removeItem('cryptoPulse_catalog');
            }
        } catch (e) { /* 忽略 */ }
    },

    applyUIState() {
        const saved = this._savedUIState;

        if (saved) {
            // 时间周期按钮（tf-btn）
            if (saved.timeframe) {
                // 兼容旧版本以「小时数」存储的取值
                const legacyMap = { 1: '0.25', 6: '0.5', 4: '4', 24: '24', 168: '168' };
                let savedTf = String(saved.timeframe);
                if (!this.timeframeConfig[savedTf] && legacyMap[saved.timeframe]) {
                    savedTf = legacyMap[saved.timeframe];
                }
                if (!this.timeframeConfig[savedTf]) savedTf = '24';

                this.state.currentTimeframe = parseFloat(savedTf);

                let matched = false;
                document.querySelectorAll('.tf-btn').forEach(b => {
                    if (b.dataset.tf === 'more') return;
                    const isTarget = b.dataset.tf === savedTf;
                    b.classList.toggle('active', isTarget);
                    if (isTarget) matched = true;
                });
                if (!matched) {
                    const dailyBtn = document.querySelector('.tf-btn[data-tf="24"]');
                    if (dailyBtn) dailyBtn.classList.add('active');
                    this.state.currentTimeframe = 24;
                }
            }

            // 图表显示开关
            if (saved.showMA !== undefined) {
                this.state.showMA = saved.showMA;
                try { ChartManager.toggleMA(saved.showMA); } catch (e) {}
            }
            if (saved.showVolume !== undefined) {
                this.state.showVolume = saved.showVolume;
                try { ChartManager.toggleVolume(saved.showVolume); } catch (e) {}
            }
            if (saved.showSignals !== undefined) {
                this.state.showSignalMarkers = saved.showSignals;
            }

            // Tab 切换
            if (saved.currentTab) {
                this.switchTab(saved.currentTab);
            }

            // 市场分类
            if (saved.marketTab) {
                this.state.marketTab = saved.marketTab;
            }
        } else {
            // 默认选中日线
            const dailyBtn = document.querySelector('.tf-btn[data-tf="24"]');
            if (dailyBtn) dailyBtn.classList.add('active');
        }

        // 更新分类按钮样式
        this.updateCoinCategoryButtons();
    },

    // 自选行情价格格式化
    formatWatchPrice(price) {
        if (price === null || price === undefined || !isFinite(price)) return '--';
        if (price >= 1000) return '$' + price.toLocaleString('en-US', { maximumFractionDigits: 2 });
        if (price >= 1) return '$' + price.toFixed(2);
        if (price >= 0.01) return '$' + price.toFixed(4);
        return '$' + price.toFixed(6);
    },

    // 币种副标题
    getCoinSubtitle(coin) {
        if (coin.name && coin.name !== coin.symbol && coin.name !== coin.coinId) {
            return coin.name;
        }
        return (coin.symbol || coin.coinId || '') + '/USDT';
    },

    // ===== 币种选择器 =====
    showCoinSelectorModal() {
        const modal = document.getElementById('coinSelectorModal');
        if (!modal) return;
        modal.classList.remove('hidden');
        document.body.style.overflow = 'hidden';

        const input = document.getElementById('coinSearchInput');
        if (input) {
            input.value = '';
            setTimeout(() => input.focus(), 60);
        }

        // 渲染列表
        this.renderCoinSelectorList();

        // 后台联网拉取目录
        this.loadCoinCatalog();
        this.loadWatchlistQuotes();
    },

    hideCoinSelectorModal() {
        const modal = document.getElementById('coinSelectorModal');
        if (!modal) return;
        modal.classList.add('hidden');
        document.body.style.overflow = '';

        const input = document.getElementById('coinSearchInput');
        if (input) input.value = '';
    },

    // 切换币种选择器内的分类
    switchCoinCategory(cat) {
        if (!cat || cat === this.state.marketTab) return;
        this.state.marketTab = cat;
        this.state.coinListLimit = 50;
        this.updateCoinCategoryButtons();
        this.saveUIState();
        this.renderCoinSelectorList();
    },

    updateCoinCategoryButtons() {
        document.querySelectorAll('.coin-cat-btn').forEach(btn => {
            const active = btn.dataset.market === this.state.marketTab;
            if (active) {
                btn.classList.add('text-golden');
                btn.classList.remove('text-text-secondary');
            } else {
                btn.classList.remove('text-golden');
                btn.classList.add('text-text-secondary');
            }
        });
    },

    // 获取某个分类下的币种
    getCategoryCoins(cat) {
        const catalog = this.state.coinCatalog.length
            ? this.state.coinCatalog
            : this.popularCoins.map(c => ({
                coinId: c.id, symbol: c.symbol, name: c.name, binanceSymbol: c.binanceSymbol
            }));

        if (cat === 'all') return catalog;

        if (cat === 'watchlist') {
            return this.state.watchlist.map(id => {
                const info = this.getCoinInfo(id);
                return {
                    coinId: id,
                    symbol: info.symbol,
                    name: info.name,
                    binanceSymbol: this.getBinanceSymbol(id)
                };
            });
        }

        // 主流：内置热门币种
        if (cat === 'hot') {
            const hotSymbols = this.popularCoins.map(c => c.binanceSymbol);
            const hot = catalog.filter(c => hotSymbols.includes(c.binanceSymbol));
            return hot.length > 0 ? hot : catalog.slice(0, 20);
        }

        // DeFi
        if (cat === 'defi') {
            return catalog.filter(c => this.defiCoins.includes(c.symbol));
        }

        // MEME
        if (cat === 'meme') {
            return catalog.filter(c => this.memeCoins.includes(c.symbol));
        }

        return catalog;
    },

    // 渲染币种选择器列表
    renderCoinSelectorList(query) {
        const container = document.getElementById('coinSelectorList');
        if (!container) return;

        const q = (query || document.getElementById('coinSearchInput')?.value || '').trim().toLowerCase();

        let pool = this.getCategoryCoins(this.state.marketTab);
        if (q) {
            pool = pool.filter(c =>
                (c.symbol || '').toLowerCase().includes(q) ||
                (c.name || '').toLowerCase().includes(q) ||
                (c.coinId || '').toLowerCase().includes(q)
            );
        }

        const shown = pool.slice(0, this.state.coinListLimit);

        if (shown.length === 0) {
            container.innerHTML = `<div class="py-10 text-center">
                <p class="text-sm text-text-secondary">未找到相关币种</p>
                <p class="text-xs text-text-tertiary mt-1">试试输入符号，如 BTC、ETH</p>
            </div>`;
            return;
        }

        // 行情缺失的批量补拉
        const pending = this._listQuotePending || (this._listQuotePending = new Set());
        const missing = shown
            .filter(c => !this.state.coinListQuotes[c.binanceSymbol] && !pending.has(c.binanceSymbol))
            .map(c => c.binanceSymbol);
        if (missing.length > 0) {
            this.loadCoinListQuotes(missing);
        }

        container.innerHTML = shown.map(coin => {
            const isActive = coin.coinId === this.state.currentCoin;
            const inWatchlist = this.isSymbolInWatchlist(coin.binanceSymbol);

            // 优先用自选行情，其次用列表行情
            let quote = this.state.watchlistQuotes[coin.coinId];
            if (!quote) quote = this.state.coinListQuotes[coin.binanceSymbol];
            const hasQuote = !!quote;
            const up = hasQuote ? quote.changePercent >= 0 : true;

            return `
                <div class="coin-selector-item relative flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50 transition-colors ${isActive ? 'bg-golden/5' : ''}"
                     data-coin-id="${coin.coinId}" data-symbol="${coin.binanceSymbol}">
                    ${inWatchlist ? '<span class="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-6 rounded-r-full bg-golden"></span>' : ''}
                    <button class="coin-star-btn flex-shrink-0 p-0.5 rounded transition-transform active:scale-90"
                            data-coin-id="${coin.coinId}" data-symbol="${coin.binanceSymbol}"
                            title="${inWatchlist ? '取消自选' : '加入自选'}" aria-label="${inWatchlist ? '取消自选' : '加入自选'}">
                        <svg class="w-4 h-4 ${inWatchlist ? 'text-golden' : 'text-gray-300'}" fill="${inWatchlist ? 'currentColor' : 'none'}" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"></path>
                        </svg>
                    </button>
                    <div class="flex items-center gap-3 min-w-0 flex-1">
                        <div class="w-8 h-8 rounded-full ${inWatchlist ? 'bg-golden/10' : 'bg-gray-100'} flex items-center justify-center text-sm font-bold text-text-primary flex-shrink-0">
                            ${coin.symbol.charAt(0)}
                        </div>
                        <div class="min-w-0">
                            <div class="flex items-center gap-1.5">
                                <span class="text-sm font-semibold text-text-primary">${coin.symbol}</span>
                                ${isActive ? '<span class="text-[10px] px-1 py-px rounded bg-golden/15 text-golden">当前</span>' : ''}
                            </div>
                            <p class="text-xs text-text-secondary truncate">${this.getCoinSubtitle(coin)}</p>
                        </div>
                    </div>
                    <div class="text-right flex-shrink-0">
                        <p class="text-sm font-medium tabular-nums text-text-primary">${hasQuote ? this.formatWatchPrice(quote.price) : '--'}</p>
                        <p class="text-xs tabular-nums ${!hasQuote ? 'text-text-tertiary' : (up ? 'text-rise-green' : 'text-fall-red')}">
                            ${hasQuote ? (up ? '+' : '') + quote.changePercent.toFixed(2) + '%' : '--'}
                        </p>
                    </div>
                </div>
            `;
        }).join('');

        // 绑定行点击（切换币种）
        container.querySelectorAll('.coin-selector-item').forEach(el => {
            el.addEventListener('click', () => {
                this.addOrSwitchToCoin(el.dataset.coinId, el.dataset.symbol);
            });
        });

        // 绑定星星点击（加入/移出自选，不切换币种，需阻止冒泡）
        container.querySelectorAll('.coin-star-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleSymbolWatchlist(btn.dataset.coinId, btn.dataset.symbol);
            });
        });

        // 加载更多按钮（如果还有更多）
        if (pool.length > this.state.coinListLimit) {
            const moreDiv = document.createElement('div');
            moreDiv.className = 'px-4 py-3 text-center';
            moreDiv.innerHTML = `<button class="text-sm text-golden">加载更多（还有 ${pool.length - this.state.coinListLimit} 个）</button>`;
            moreDiv.querySelector('button').addEventListener('click', () => {
                this.state.coinListLimit += 50;
                this.renderCoinSelectorList();
            });
            container.appendChild(moreDiv);
        }
    },

    // 判断某交易对是否已在自选中
    isSymbolInWatchlist(binanceSymbol) {
        if (!binanceSymbol) return false;
        return this.state.watchlist.some(id => this.getBinanceSymbol(id) === binanceSymbol);
    },

    findWatchlistIdBySymbol(binanceSymbol) {
        if (!binanceSymbol) return null;
        return this.state.watchlist.find(id => this.getBinanceSymbol(id) === binanceSymbol) || null;
    },

    // 批量拉取列表行情
    async loadCoinListQuotes(symbols) {
        const pending = this._listQuotePending || (this._listQuotePending = new Set());
        symbols.forEach(s => pending.add(s));

        const chunks = [];
        for (let i = 0; i < symbols.length; i += 100) {
            chunks.push(symbols.slice(i, i + 100));
        }

        for (const chunk of chunks) {
            try {
                const query = encodeURIComponent(JSON.stringify(chunk));
                const resp = await fetch(`${this.binanceApiBase}/ticker/24hr?symbols=${query}`);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                const arr = Array.isArray(data) ? data : [data];
                arr.forEach(t => {
                    this.state.coinListQuotes[t.symbol] = {
                        price: parseFloat(t.lastPrice),
                        changePercent: parseFloat(t.priceChangePercent)
                    };
                });
            } catch (e) {
                console.warn('列表行情加载失败:', e.message);
            } finally {
                chunk.forEach(s => pending.delete(s));
            }
        }

        // 行情到位后刷新列表
        const modal = document.getElementById('coinSelectorModal');
        if (modal && !modal.classList.contains('hidden')) {
            this.renderCoinSelectorList();
        }
    },

    /**
     * 从列表点击币种：已在自选则直接切换，否则先加入自选再切换
     */
    async addOrSwitchToCoin(coinId, binanceSymbol) {
        const existing = this.findWatchlistIdBySymbol(binanceSymbol);
        if (existing) {
            this.hideCoinSelectorModal();
            this.switchCoin(existing);
            return;
        }

        if (this.popularCoins.find(c => c.id === coinId)) {
            await this.addToWatchlist(coinId);
            return;
        }

        const fromCatalog = this.state.coinCatalog.find(c => c.coinId === coinId);
        if (fromCatalog) {
            this.state.coinMeta[coinId] = {
                id: coinId,
                coinId: coinId,
                symbol: fromCatalog.symbol,
                name: fromCatalog.name,
                binanceSymbol: fromCatalog.binanceSymbol
            };
            this.saveCoinMeta();
        }
        await this.addToWatchlist(coinId);
    },


    // 获取币种信息
    getCoinInfo(coinId) {
        const popular = this.popularCoins.find(c => c.id === coinId);
        if (popular) return popular;

        const meta = this.state.coinMeta[coinId];
        if (meta) return meta;

        const fromCatalog = this.state.coinCatalog.find(c => c.coinId === coinId);
        if (fromCatalog) return fromCatalog;

        return {
            id: coinId,
            symbol: coinId.toUpperCase().slice(0, 6),
            name: coinId,
            binanceSymbol: coinId.toUpperCase() + 'USDT'
        };
    },

    // 切换币种
    async switchCoin(coinId) {
        if (coinId === this.state.currentCoin) return;
        this.state.currentCoin = coinId;
        this.saveWatchlist();
        this.saveUIState();
        this.updateFavoriteButton();
        await this.loadCoinData(coinId);
    },

    // 加载币种数据
    async loadCoinData(coinId, forceRefresh = false) {
        const token = ++this._loadToken;
        this.state.isLoading = true;
        this.showLoading(true);

        try {
            await Promise.allSettled([
                this.loadPriceData(coinId),
                this.loadCandleData(coinId),
                this.loadNews(coinId),
                this.loadFearGreedIndex(),
                this.loadDerivativesData(coinId)
            ]);

            if (token !== this._loadToken) return;
            if (this.state.currentCoin !== coinId) return;

            this.state.lastUpdate = new Date();
            this.updateSignal();
        } catch (error) {
            console.error('加载数据失败:', error);
        } finally {
            if (token === this._loadToken) {
                this.state.isLoading = false;
                this.showLoading(false);
            }
        }
    },

    // 加载价格数据（币安 API）
    async loadPriceData(coinId) {
        const binanceSymbol = this.getBinanceSymbol(coinId);
        if (!binanceSymbol) {
            this.useMockPriceData(coinId);
            return;
        }

        try {
            const response = await fetch(
                `${this.binanceApiBase}/ticker/24hr?symbol=${binanceSymbol}`
            );

            if (!response.ok) throw new Error('Binance API error');

            const data = await response.json();

            if (this.state.currentCoin !== coinId) return;

            const coinInfo = this.getCoinInfo(coinId);
            this.state.coinInfo = {
                id: coinId,
                symbol: coinInfo.symbol,
                name: coinInfo.name,
                image: coinInfo.image || '',
                current_price: parseFloat(data.lastPrice),
                price_change_24h: parseFloat(data.priceChange),
                price_change_percentage_24h: parseFloat(data.priceChangePercent),
                high_24h: parseFloat(data.highPrice),
                low_24h: parseFloat(data.lowPrice),
                open_24h: parseFloat(data.openPrice),
                weighted_avg_price: parseFloat(data.weightedAvgPrice),
                trade_count: parseInt(data.count, 10),
                total_volume: parseFloat(data.volume),       // 成交量（币数量）
                quote_volume: parseFloat(data.quoteVolume),  // 成交额（USDT）
                market_cap: 0,
            };

            this.updatePriceUI();

        } catch (error) {
            console.error('获取价格数据失败:', error);
            if (this.state.currentCoin === coinId) {
                this.useMockPriceData(coinId);
            }
        }
    },

    // 使用模拟价格数据
    useMockPriceData(coinId) {
        const basePrices = {
            'bitcoin': 65000,
            'ethereum': 3500,
            'binancecoin': 580,
            'solana': 145,
            'ripple': 0.52,
            'cardano': 0.45,
            'dogecoin': 0.12,
            'polkadot': 7.2,
        };
        
        const basePrice = basePrices[coinId] || 100;
        const change = (Math.random() - 0.5) * 0.1;
        const currentPrice = basePrice * (1 + change);
        
        this.state.coinInfo = {
            id: coinId,
            symbol: this.getCoinInfo(coinId).symbol,
            name: this.getCoinInfo(coinId).name,
            image: '',
            current_price: currentPrice,
            price_change_24h: currentPrice * change,
            price_change_percentage_24h: change * 100,
            high_24h: currentPrice * 1.05,
            low_24h: currentPrice * 0.95,
            total_volume: basePrice * 10000,
            quote_volume: basePrice * 500000,
            market_cap: basePrice * 20000000,
        };
        
        this.updatePriceUI();
    },

    // 获取币安K线间隔参数
    getBinanceInterval(tf) {
        const { interval } = this.getTimeframeConfig(tf);
        return { interval, limit: 200 };
    },

    // 加载K线数据（币安 API）
    async loadCandleData(coinId) {
        const binanceSymbol = this.getBinanceSymbol(coinId);
        if (!binanceSymbol) {
            this.useMockCandleData(coinId);
            return;
        }

        try {
            const { interval, limit } = this.getBinanceInterval(this.state.currentTimeframe);
            const response = await fetch(
                `${this.binanceApiBase}/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`
            );

            if (!response.ok) throw new Error('Binance Kline API error');

            const data = await response.json();

            const candleData = data.map(item => ({
                time: Math.floor(item[0] / 1000),
                open: parseFloat(item[1]),
                high: parseFloat(item[2]),
                low: parseFloat(item[3]),
                close: parseFloat(item[4]),
                volume: parseFloat(item[5]),
            }));

            this.state.candleData = candleData;
            this.evaluatePredictions();
            this.calculateIndicators();
            this.updateChart();
            this.updateSignal();

        } catch (error) {
            console.error('获取K线数据失败:', error);
            this.useMockCandleData(coinId);
        }
    },

    // 加载恐惧贪婪指数
    async loadFearGreedIndex() {
        try {
            const response = await fetch('https://api.alternative.me/fng/?limit=1');
            if (!response.ok) throw new Error('FNG API error');

            const data = await response.json();
            const fngData = data.data[0];

            this.state.fearGreedIndex = {
                value: parseInt(fngData.value),
                classification: fngData.value_classification,
                timestamp: fngData.timestamp
            };

            this.updateFearGreedUI();

        } catch (error) {
            console.warn('获取恐惧贪婪指数失败:', error);
            this.useMockFearGreedIndex();
        } finally {
            // 无论成功或降级，标记情绪数据已就绪
            this._fngReady = true;
        }
    },

    useMockFearGreedIndex() {
        const value = 50 + Math.floor(Math.random() * 20 - 10);
        let classification = '中性';
        if (value < 25) classification = '极度恐惧';
        else if (value < 46) classification = '恐惧';
        else if (value < 55) classification = '中性';
        else if (value < 75) classification = '贪婪';
        else classification = '极度贪婪';

        this.state.fearGreedIndex = {
            value,
            classification,
            timestamp: Math.floor(Date.now() / 1000)
        };

        this.updateFearGreedUI();
    },

    // 加载衍生品数据
    async loadDerivativesData(coinId) {
        const binanceSymbol = this.getBinanceSymbol(coinId);
        if (!binanceSymbol) {
            this.useMockDerivativesData(coinId);
            return;
        }

        try {
            const response = await fetch(
                `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${binanceSymbol}`,
                { signal: AbortSignal.timeout(5000) }
            );

            if (!response.ok) throw new Error('Futures API error');

            const data = await response.json();

            this.state.derivatives = {
                fundingRate: parseFloat(data.lastFundingRate) * 100,
                nextFundingTime: data.nextFundingTime,
                openInterest: null
            };

            try {
                const oiResponse = await fetch(
                    `https://fapi.binance.com/fapi/v1/openInterest?symbol=${binanceSymbol}`,
                    { signal: AbortSignal.timeout(5000) }
                );
                if (oiResponse.ok) {
                    const oiData = await oiResponse.json();
                    this.state.derivatives.openInterest = parseFloat(oiData.openInterest);
                }
            } catch (e) {
                console.warn('获取OI失败:', e);
            }

            this.updateDerivativesUI();

        } catch (error) {
            console.warn('获取衍生品数据失败:', error);
            this.useMockDerivativesData(coinId);
        }
    },

    useMockDerivativesData(coinId) {
        const basePrices = {
            'bitcoin': 78000, 'ethereum': 3500, 'binancecoin': 580,
            'solana': 145, 'ripple': 0.52, 'cardano': 0.45,
            'dogecoin': 0.12, 'polkadot': 7.2,
        };
        const basePrice = basePrices[coinId] || 100;

        const fundingRate = (Math.random() - 0.3) * 0.1;
        const openInterest = basePrice * 1000 * (0.8 + Math.random() * 0.4);

        this.state.derivatives = {
            fundingRate,
            openInterest,
            isMock: true
        };

        this.updateDerivativesUI();
    },

    // 使用模拟K线数据
    useMockCandleData(coinId) {
        const basePrices = {
            'bitcoin': 65000,
            'ethereum': 3500,
            'binancecoin': 580,
            'solana': 145,
            'ripple': 0.52,
            'cardano': 0.45,
            'dogecoin': 0.12,
            'polkadot': 7.2,
        };
        
        const basePrice = basePrices[coinId] || 100;
        const candleCount = 200;
        const candleData = [];
        let price = basePrice;
        
        const now = Math.floor(Date.now() / 1000);
        // 用所选周期的真实K线间隔生成模拟数据，避免周期切换后时间轴错乱
        const interval = this.getTimeframeConfig(this.state.currentTimeframe).seconds;
        
        for (let i = candleCount - 1; i >= 0; i--) {
            const time = now - i * interval;
            const volatility = 0.02;
            const trend = Math.sin(i / 20) * 0.005;
            
            const open = price;
            const change = (Math.random() - 0.5 + trend) * volatility * price;
            const close = open + change;
            const high = Math.max(open, close) * (1 + Math.random() * volatility * 0.5);
            const low = Math.min(open, close) * (1 - Math.random() * volatility * 0.5);
            const volume = basePrice * 1000 * (0.5 + Math.random());
            
            candleData.push({
                time: Math.floor(time),
                open,
                high,
                low,
                close,
                volume
            });
            
            price = close;
        }
        
        this.state.candleData = candleData;
        this.evaluatePredictions();
        this.calculateIndicators();
        this.updateChart();
        this.updateSignal();
    },

    // 计算技术指标
    calculateIndicators() {
        const closes = this.state.candleData.map(d => d.close);
        const highs = this.state.candleData.map(d => d.high);
        const lows = this.state.candleData.map(d => d.low);
        const volumes = this.state.candleData.map(d => d.volume);
        const currentPrice = closes[closes.length - 1];

        const ma7 = TechnicalAnalysis.calculateSMA(closes, 7);
        const ma25 = TechnicalAnalysis.calculateSMA(closes, 25);
        const ma99 = TechnicalAnalysis.calculateSMA(closes, 99);
        const ma200 = TechnicalAnalysis.calculateSMA(closes, 200);
        const ema7 = TechnicalAnalysis.calculateEMA(closes, 7);
        const ema25 = TechnicalAnalysis.calculateEMA(closes, 25);
        const ema99 = TechnicalAnalysis.calculateEMA(closes, 99);
        const rsi = TechnicalAnalysis.calculateRSI(closes, 14);
        const macd = TechnicalAnalysis.calculateMACD(closes);
        const bollinger = TechnicalAnalysis.calculateBollingerBands(closes, 20);
        const vwap = TechnicalAnalysis.calculateVWAP(highs, lows, closes, volumes);
        const obv = TechnicalAnalysis.calculateOBV(closes, volumes);
        const stochRSI = TechnicalAnalysis.calculateStochasticRSI(closes);
        const kdj = TechnicalAnalysis.calculateKDJ(highs, lows, closes);
        const supportResistance = TechnicalAnalysis.calculateSupportResistance(highs, lows, closes, currentPrice);

        const lastMA200 = ma200[ma200.length - 1];
        const ahr999 = TechnicalAnalysis.calculateAHR999(currentPrice, lastMA200);

        // 计算成交量MA
        const volMa5 = TechnicalAnalysis.calculateSMA(volumes, 5);
        const volMa10 = TechnicalAnalysis.calculateSMA(volumes, 10);

        this.state.indicators = {
            ma7,
            ma25,
            ma99,
            ma200,
            ema7,
            ema25,
            ema99,
            rsi: rsi[rsi.length - 1],
            macd: {
                value: macd.macd[macd.macd.length - 1],
                signal: macd.signal[macd.signal.length - 1],
                histogram: macd.histogram[macd.histogram.length - 1],
                ...macd
            },
            bollingerBands: bollinger,
            vwap,
            obv,
            stochRSI,
            kdj,
            ahr999,
            supportResistance,
            volMa5,
            volMa10,
            currentPrice
        };

        this.updateIndicatorsUI();
        this.updateQuickInfoBar();
        this.updateVolumeInfo();
        this.updateInfoTab();
    },

    // 更新图表
    updateChart() {
        if (!this.state.candleData || this.state.candleData.length === 0) return;
        
        ChartManager.updateCandlestickData(this.state.candleData);
        
        const timeData = this.state.candleData.map(d => d.time);
        ChartManager.updateMAData(timeData, this.state.indicators.ma7, this.state.indicators.ma25, this.state.indicators.ma99);
        
        if (this.state.indicators.supportResistance) {
            ChartManager.drawSupportResistance(this.state.indicators.supportResistance);
        }
        
        this.addSignalMarkers();
    },


    /**
     * 在K线上标注买卖点
     *
     * 只标注方向性结论（买入 / 强烈买入 / 卖出 / 强烈卖出），
     * 不再绘制高低点、MACD金叉、KDJ死叉等单项指标点，避免图形杂乱。
     */
    addSignalMarkers() {
        if (!this.state.candleData || this.state.candleData.length < 30) return;
        if (!this.state.showSignalMarkers) {
            ChartManager.clearMarkers();
            return;
        }

        const markers = this.generateSignalMarkers(this.state.candleData, this.state.indicators);
        ChartManager.addMarkers(markers);
    },

    /**
     * 生成买卖点标记
     *
     * 逐根K线用已算好的指标序列合成综合分，再按与实时信号一致的阈值
     * 归类为 强烈买入(≥70) / 买入(≥58) / 强烈卖出(≤30) / 卖出(≤42)，
     * 其余一律不标注。只在结论发生变化时落一个点。
     *
     * @param {Array} data - K线数据
     * @param {Object} ind - 技术指标
     * @returns {Array} 标记点数组
     */
    generateSignalMarkers(data, ind) {
        const markers = [];
        if (!data || data.length < 30 || !ind) return markers;

        const len = data.length;
        const closes = data.map(d => d.close);
        const volumes = data.map(d => d.volume);

        const macdLine = (ind.macd && ind.macd.macd) || [];
        const signalLine = (ind.macd && ind.macd.signal) || [];
        const histLine = (ind.macd && ind.macd.histogram) || [];
        const kLine = (ind.kdj && ind.kdj.k) || [];
        const dLine = (ind.kdj && ind.kdj.d) || [];
        const ma7 = ind.ma7 || [];
        const ma25 = ind.ma25 || [];
        const upper = (ind.bollingerBands && ind.bollingerBands.upper) || [];
        const lower = (ind.bollingerBands && ind.bollingerBands.lower) || [];
        const rsiLine = TechnicalAnalysis.calculateRSI(closes, 14);

        const classify = (v) => {
            if (v >= 70) return '强烈买入';
            if (v >= 58) return '买入';
            if (v <= 30) return '强烈卖出';
            if (v <= 42) return '卖出';
            return null;
        };

        const sideOf = (label) => {
            if (!label) return null;
            return label.indexOf('买入') > -1 ? 'buy' : 'sell';
        };

        let prevSide = null; // 'buy' | 'sell' | null
        let lastIdx = -99;   // 两次标注之间的最小间隔

        for (let i = 1; i < len; i++) {
            // MACD 尚未就绪的K线无法合成评分
            if (macdLine[i] == null || signalLine[i] == null) {
                prevSide = null;
                continue;
            }

            let score = 50;

            // MACD 位置与柱体动能
            score += macdLine[i] > signalLine[i] ? 8 : -8;
            if (histLine[i] != null && histLine[i - 1] != null) {
                score += histLine[i] > histLine[i - 1] ? 4 : -4;
            }

            // 均线排列与价格相对位置
            if (ma7[i] != null && ma25[i] != null) {
                score += ma7[i] > ma25[i] ? 8 : -8;
            }
            if (ma25[i] != null) {
                score += closes[i] > ma25[i] ? 6 : -6;
            }

            // KDJ 动能方向
            if (kLine[i] != null && dLine[i] != null) {
                score += kLine[i] > dLine[i] ? 6 : -6;
            }

            // RSI 超买超卖
            const r = rsiLine[i];
            if (r != null) {
                if (r < 30) score += 10;
                else if (r < 45) score += 3;
                else if (r > 70) score -= 10;
                else if (r > 55) score -= 3;
            }

            // 布林带位置
            if (upper[i] != null && lower[i] != null) {
                if (closes[i] < lower[i]) score += 6;
                else if (closes[i] > upper[i]) score -= 6;
            }

            // 量价配合
            const priceUp = closes[i] > closes[i - 1];
            const volUp = volumes[i] > volumes[i - 1];
            if (priceUp && volUp) score += 6;
            else if (!priceUp && volUp) score -= 6;

            score = Math.max(0, Math.min(100, score));

            const label = classify(score);
            const side = sideOf(label);

            // 中性区间既不标注也不改变已有方向，避免评分在阈值附近抖动时反复重置
            if (!side) continue;
            // 只在多空方向真正切换时落点；同一方向内的强弱变化（买入↔强烈买入）不重复标注
            if (side === prevSide) continue;
            if (i - lastIdx < 5) continue; // 间隔过近的翻转忽略，方向也不更新

            prevSide = side;

            const isBuy = side === 'buy';
            const isStrong = label.indexOf('强烈') === 0;

            markers.push({
                time: data[i].time,
                position: isBuy ? 'belowBar' : 'aboveBar',
                color: isBuy ? '#089981' : '#f23645',
                shape: isBuy ? 'arrowUp' : 'arrowDown',
                text: label,
                size: isStrong ? 2 : 1,
            });

            lastIdx = i;
        }

        // 只保留最近的标记，小屏不至于糊成一片
        return markers.slice(-30);
    },

    // 更新价格UI
    updatePriceUI() {
        const info = this.state.coinInfo;
        if (!info) return;

        const coin = this.getCoinInfo(this.state.currentCoin);

        // 币种交易对标题
        const pairTitleEl = document.getElementById('coinPairTitle');
        if (pairTitleEl) pairTitleEl.textContent = coin.symbol + '/USDT';

        // 币种英文名/中文名副标题
        const nameSubEl = document.getElementById('coinNameSub');
        if (nameSubEl) nameSubEl.textContent = coin.name || coin.symbol;

        // 当前价格
        const priceEl = document.getElementById('currentPrice');
        if (priceEl) {
            priceEl.textContent = TechnicalAnalysis.formatPrice(info.current_price);
            const isPositive = info.price_change_percentage_24h >= 0;
            priceEl.className = `text-3xl font-bold tabular-nums ${isPositive ? 'text-rise-green' : 'text-fall-red'}`;
        }

        // 人民币换算价
        const cnyEl = document.getElementById('cnyPrice');
        if (cnyEl) {
            const cnyPrice = info.current_price * this.state.usdtToCnyRate;
            cnyEl.textContent = '≈ ¥' + TechnicalAnalysis.formatLargeNumber(cnyPrice);
        }

        // 价格变化徽章
        const changePercent = info.price_change_percentage_24h;
        const isPositive = changePercent >= 0;

        const badge = document.getElementById('priceChangeBadge');
        if (badge) {
            badge.textContent = `${isPositive ? '+' : ''}${changePercent.toFixed(2)}%`;
            badge.className = `text-xs font-medium px-2 py-0.5 rounded ${isPositive ? 'bg-rise-green/10 text-rise-green' : 'bg-fall-red/10 text-fall-red'}`;
        }

        // 24H最高/最低
        const highEl = document.getElementById('high24h');
        if (highEl) highEl.textContent = '$' + TechnicalAnalysis.formatPrice(info.high_24h);
        const lowEl = document.getElementById('low24h');
        if (lowEl) lowEl.textContent = '$' + TechnicalAnalysis.formatPrice(info.low_24h);

        // 24H成交量（币数量）
        const volEl = document.getElementById('volume24h');
        if (volEl) volEl.textContent = TechnicalAnalysis.formatLargeNumber(info.total_volume);

        // 24H成交额（USDT）
        const quoteVolEl = document.getElementById('quoteVolume24h');
        if (quoteVolEl) {
            const qv = info.quote_volume || info.total_volume * info.current_price;
            quoteVolEl.textContent = '$' + TechnicalAnalysis.formatLargeNumber(qv);
        }
    },

    // 设置状态徽章
    setStatusBadge(elementId, text, color) {
        const el = document.getElementById(elementId);
        if (!el) return;
        el.textContent = text;
        let bgClass = 'bg-gray-200';
        let textClass = 'text-text-secondary';
        if (color === 'green') {
            bgClass = 'bg-rise-green/10';
            textClass = 'text-rise-green';
        } else if (color === 'red') {
            bgClass = 'bg-fall-red/10';
            textClass = 'text-fall-red';
        } else if (color === 'gold') {
            bgClass = 'bg-golden/10';
            textClass = 'text-golden';
        } else if (color === 'blue') {
            bgClass = 'bg-blue-500/10';
            textClass = 'text-blue-500';
        }
        el.className = `text-[10px] px-1.5 py-0.5 rounded ${bgClass} ${textClass}`;
    },

    // 更新快速信息栏
    updateQuickInfoBar() {
        const ind = this.state.indicators;
        if (!ind) return;

        const ema7 = ind.ema7?.[ind.ema7.length - 1];
        const ema25 = ind.ema25?.[ind.ema25.length - 1];
        const ema99 = ind.ema99?.[ind.ema99.length - 1];
        const currentPrice = ind.currentPrice;

        const ema7El = document.getElementById('ema7Value');
        if (ema7El && ema7) {
            ema7El.textContent = TechnicalAnalysis.formatPrice(ema7);
            ema7El.className = `font-medium tabular-nums ${currentPrice >= ema7 ? 'text-rise-green' : 'text-fall-red'}`;
        }

        const ema25El = document.getElementById('ema25Value');
        if (ema25El && ema25) {
            ema25El.textContent = TechnicalAnalysis.formatPrice(ema25);
            ema25El.className = `font-medium tabular-nums ${currentPrice >= ema25 ? 'text-rise-green' : 'text-fall-red'}`;
        }

        const ema99El = document.getElementById('ema99Value');
        if (ema99El && ema99) {
            ema99El.textContent = TechnicalAnalysis.formatPrice(ema99);
            ema99El.className = `font-medium tabular-nums ${currentPrice >= ema99 ? 'text-rise-green' : 'text-fall-red'}`;
        }

        const rsiQuickEl = document.getElementById('rsiQuickValue');
        if (rsiQuickEl && ind.rsi !== null && ind.rsi !== undefined) {
            rsiQuickEl.textContent = ind.rsi.toFixed(1);
            let rsiColor = 'text-text-secondary';
            if (ind.rsi > 70) rsiColor = 'text-fall-red';
            else if (ind.rsi < 30) rsiColor = 'text-rise-green';
            rsiQuickEl.className = `font-medium tabular-nums ${rsiColor}`;
        }
    },

    // 更新成交量说明
    updateVolumeInfo() {
        const ind = this.state.indicators;
        if (!ind || !this.state.candleData.length) return;

        const lastVol = this.state.candleData[this.state.candleData.length - 1]?.volume;
        const volDisplay = document.getElementById('volDisplay');
        if (volDisplay && lastVol) {
            volDisplay.textContent = TechnicalAnalysis.formatLargeNumber(lastVol);
        }

        const volMa5El = document.getElementById('volMa5');
        const ma5 = ind.volMa5?.[ind.volMa5.length - 1];
        if (volMa5El && ma5) {
            volMa5El.textContent = TechnicalAnalysis.formatLargeNumber(ma5);
        }

        const volMa10El = document.getElementById('volMa10');
        const ma10 = ind.volMa10?.[ind.volMa10.length - 1];
        if (volMa10El && ma10) {
            volMa10El.textContent = TechnicalAnalysis.formatLargeNumber(ma10);
        }
    },


    // 更新技术指标UI（Mini版）
    updateIndicatorsUI() {
        const ind = this.state.indicators;
        const currentPrice = ind.currentPrice;

        // RSI
        const rsiValue = ind.rsi;
        const rsiValEl = document.getElementById('rsiValueMini');

        if (rsiValue !== null && rsiValue !== undefined && !isNaN(rsiValue)) {
            if (rsiValEl) {
                rsiValEl.textContent = rsiValue.toFixed(1);
                let rsiColor = 'text-text-primary';
                if (rsiValue > 70) rsiColor = 'text-fall-red';
                else if (rsiValue < 30) rsiColor = 'text-rise-green';
                rsiValEl.className = `text-lg font-bold tabular-nums ${rsiColor}`;
            }
            let rsiStatus = '中性';
            let rsiStatusColor = 'gold';
            if (rsiValue > 70) { rsiStatus = '超买'; rsiStatusColor = 'red'; }
            else if (rsiValue < 30) { rsiStatus = '超卖'; rsiStatusColor = 'green'; }
            this.setStatusBadge('rsiStatusMini', rsiStatus, rsiStatusColor);
        } else if (rsiValEl) {
            rsiValEl.textContent = '--';
        }

        // MACD
        const macdValue = ind.macd?.value;
        const macdSignal = ind.macd?.signal;
        const macdValEl = document.getElementById('macdValueMini');

        if (typeof macdValue === 'number' && !isNaN(macdValue)) {
            if (macdValEl) {
                macdValEl.textContent = macdValue.toFixed(4);
                macdValEl.className = `text-lg font-bold tabular-nums ${macdValue > 0 ? 'text-rise-green' : 'text-fall-red'}`;
            }
            if (macdSignal && typeof macdSignal[macdSignal.length - 1] === 'number') {
                const lastMacd = macdValue;
                const lastSignal = macdSignal[macdSignal.length - 1];
                let macdStatus = '中性';
                let macdColor = 'gold';
                if (lastMacd > lastSignal && lastMacd > 0) { macdStatus = '金叉多头'; macdColor = 'green'; }
                else if (lastMacd > lastSignal) { macdStatus = '金叉'; macdColor = 'green'; }
                else if (lastMacd < lastSignal && lastMacd < 0) { macdStatus = '死叉空头'; macdColor = 'red'; }
                else if (lastMacd < lastSignal) { macdStatus = '死叉'; macdColor = 'red'; }
                this.setStatusBadge('macdStatusMini', macdStatus, macdColor);
            }
        } else if (macdValEl) {
            macdValEl.textContent = '--';
        }

        // KDJ
        const kdj = ind.kdj;
        const kdjKEl = document.getElementById('kdjKValueMini');
        if (kdj && kdj.k && kdj.k[kdj.k.length - 1] !== null) {
            const lastK = kdj.k[kdj.k.length - 1];
            const lastD = kdj.d[kdj.d.length - 1];
            if (kdjKEl) {
                kdjKEl.textContent = lastK.toFixed(1);
                kdjKEl.className = `text-lg font-bold tabular-nums ${lastK > 80 ? 'text-fall-red' : lastK < 20 ? 'text-rise-green' : 'text-text-primary'}`;
            }
            let kdjStatus = '中性';
            let kdjColor = 'gold';
            if (lastK > 80 && lastD > 80) { kdjStatus = '超买'; kdjColor = 'red'; }
            else if (lastK < 20 && lastD < 20) { kdjStatus = '超卖'; kdjColor = 'green'; }
            else if (lastK > lastD) { kdjStatus = '偏多'; kdjColor = 'green'; }
            else { kdjStatus = '偏空'; kdjColor = 'red'; }
            this.setStatusBadge('kdjStatusMini', kdjStatus, kdjColor);
        } else if (kdjKEl) {
            kdjKEl.textContent = '--';
        }

        // 布林带
        const boll = ind.bollingerBands;
        if (boll && boll.upper && boll.lower) {
            const lastUpper = boll.upper[boll.upper.length - 1];
            const lastLower = boll.lower[boll.lower.length - 1];
            const upperMini = document.getElementById('bollUpperMini');
            const lowerMini = document.getElementById('bollLowerMini');
            if (upperMini && lastUpper) upperMini.textContent = '上: ' + TechnicalAnalysis.formatPrice(lastUpper);
            if (lowerMini && lastLower) lowerMini.textContent = '下: ' + TechnicalAnalysis.formatPrice(lastLower);
            let bollStatus = '中性';
            let bollColor = 'gold';
            if (currentPrice >= lastUpper) { bollStatus = '突破上轨'; bollColor = 'red'; }
            else if (currentPrice <= lastLower) { bollStatus = '跌破下轨'; bollColor = 'green'; }
            else {
                const position = (currentPrice - lastLower) / (lastUpper - lastLower);
                if (position > 0.7) { bollStatus = '偏强'; bollColor = 'green'; }
                else if (position < 0.3) { bollStatus = '偏弱'; bollColor = 'red'; }
            }
            this.setStatusBadge('bollStatusMini', bollStatus, bollColor);
        }

        // 关键价位
        const sr = ind.supportResistance;
        if (sr) {
            const r2El = document.getElementById('resistance2Mini');
            const r1El = document.getElementById('resistance1Mini');
            const cpEl = document.getElementById('currentPriceLevelMini');
            const s1El = document.getElementById('support1Mini');
            const s2El = document.getElementById('support2Mini');
            if (r2El) r2El.textContent = '$' + TechnicalAnalysis.formatPrice(sr.resistance2);
            if (r1El) r1El.textContent = '$' + TechnicalAnalysis.formatPrice(sr.resistance1);
            if (cpEl) cpEl.textContent = '$' + TechnicalAnalysis.formatPrice(ind.currentPrice);
            if (s1El) s1El.textContent = '$' + TechnicalAnalysis.formatPrice(sr.support1);
            if (s2El) s2El.textContent = '$' + TechnicalAnalysis.formatPrice(sr.support2);
        }
    },

    // 更新恐惧贪婪指数UI（Mini版）
    updateFearGreedUI() {
        const fng = this.state.fearGreedIndex;
        if (!fng) return;

        const valueEl = document.getElementById('fngValueMini');
        const statusEl = document.getElementById('fngStatusMini');

        if (valueEl) valueEl.textContent = fng.value;

        const classification = this.translateFNGClassification(fng.classification);
        let fngColor = 'gold';
        if (fng.value < 25) fngColor = 'red';
        else if (fng.value < 46) fngColor = 'red';
        else if (fng.value < 55) fngColor = 'gold';
        else if (fng.value < 75) fngColor = 'green';
        else fngColor = 'green';

        this.setStatusBadge('fngStatusMini', classification, fngColor);

        if (valueEl) {
            valueEl.className = `text-lg font-bold tabular-nums ${fngColor === 'green' ? 'text-rise-green' : fngColor === 'red' ? 'text-fall-red' : 'text-golden'}`;
        }
    },

    translateFNGClassification(classification) {
        const map = {
            'Extreme Fear': '极度恐惧',
            'Fear': '恐惧',
            'Neutral': '中性',
            'Greed': '贪婪',
            'Extreme Greed': '极度贪婪'
        };
        return map[classification] || classification;
    },

    // 更新衍生品数据UI（Mini版）
    updateDerivativesUI() {
        const deriv = this.state.derivatives;
        if (!deriv) return;

        // 资金费率 Mini
        const frMiniEl = document.getElementById('fundingRateMini');
        if (frMiniEl && deriv.fundingRate !== null && deriv.fundingRate !== undefined) {
            frMiniEl.textContent = deriv.fundingRate.toFixed(4) + '%';
            frMiniEl.className = `text-lg font-bold tabular-nums ${deriv.fundingRate > 0 ? 'text-rise-green' : 'text-fall-red'}`;

            let frStatus = '正常';
            let frStatusColor = 'gold';
            if (deriv.fundingRate > 0.1) {
                frStatus = '过高';
                frStatusColor = 'red';
            } else if (deriv.fundingRate < -0.05) {
                frStatus = '负费率';
                frStatusColor = 'green';
            }
            this.setStatusBadge('fundingStatusMini', frStatus, frStatusColor);
        }
    },

    // 更新信息Tab数据
    updateInfoTab() {
        const ind = this.state.indicators;
        const info = this.state.coinInfo;
        const deriv = this.state.derivatives;
        const coin = this.getCoinInfo(this.state.currentCoin);

        // 币种基础信息
        this.setText('infoCoinName', coin.name || '--');
        this.setText('infoCoinSymbol', coin.symbol || '--');

        // 24h 行情明细（币安公开接口字段）
        const fmt = (v) => (v || v === 0) ? '$' + TechnicalAnalysis.formatPrice(v) : '--';
        this.setText('infoOpen', fmt(info.open_24h));
        this.setText('infoHigh', fmt(info.high_24h));
        this.setText('infoLow', fmt(info.low_24h));

        // 24h 涨跌额（带正负号与颜色）
        const changeEl = document.getElementById('infoChange');
        if (changeEl && info.price_change_24h !== undefined) {
            const up = info.price_change_24h >= 0;
            changeEl.textContent = `${up ? '+' : ''}${TechnicalAnalysis.formatPrice(info.price_change_24h)}`;
            changeEl.className = `text-sm font-medium tabular-nums ${up ? 'text-rise-green' : 'text-fall-red'}`;
        }

        // 24h 涨跌幅
        const pctEl = document.getElementById('infoChangePct');
        if (pctEl && info.price_change_percentage_24h !== undefined) {
            const up = info.price_change_percentage_24h >= 0;
            pctEl.textContent = `${up ? '+' : ''}${info.price_change_percentage_24h.toFixed(2)}%`;
            pctEl.className = `text-sm font-medium tabular-nums ${up ? 'text-rise-green' : 'text-fall-red'}`;
        }

        // 成交量 / 成交额
        this.setText('infoVolume', info.total_volume
            ? TechnicalAnalysis.formatLargeNumber(info.total_volume) + ' ' + (coin.symbol || '')
            : '--');
        this.setText('infoQuoteVolume', info.quote_volume
            ? '$' + TechnicalAnalysis.formatLargeNumber(info.quote_volume)
            : '--');

        // 加权均价 / 成交笔数
        this.setText('infoWeightedAvg', fmt(info.weighted_avg_price));
        this.setText('infoTradeCount', info.trade_count
            ? TechnicalAnalysis.formatLargeNumber(info.trade_count) + ' 笔'
            : '--');

        // 更多指标
        const vwap = ind.vwap;
        if (vwap && vwap[vwap.length - 1]) {
            this.setText('vwapValueInfo', '$' + TechnicalAnalysis.formatPrice(vwap[vwap.length - 1]));
        }

        // OBV 趋势
        const obv = ind.obv;
        if (obv && obv.length >= 10) {
            const recent = obv.slice(-10);
            const rising = recent[recent.length - 1] > recent[0];
            this.setText('obvTrendInfo', rising ? '上升 ↑' : '下降 ↓');
            const el = document.getElementById('obvTrendInfo');
            if (el) el.className = `text-base font-bold ${rising ? 'text-rise-green' : 'text-fall-red'}`;
        }

        // StochRSI
        if (ind.stochRSI && ind.stochRSI.k) {
            const lastK = ind.stochRSI.k[ind.stochRSI.k.length - 1];
            if (lastK !== null && lastK !== undefined) {
                this.setText('stochRSIInfo', lastK.toFixed(1));
            }
        }

        // MA200
        if (ind.ma200 && ind.ma200[ind.ma200.length - 1]) {
            const lastMA200 = ind.ma200[ind.ma200.length - 1];
            this.setText('ma200Info', '$' + TechnicalAnalysis.formatPrice(lastMA200));
            const el = document.getElementById('ma200Info');
            if (el) el.className = `text-base font-bold tabular-nums ${ind.currentPrice > lastMA200 ? 'text-rise-green' : 'text-fall-red'}`;
        }

        // AHR999
        if (ind.ahr999 && ind.ahr999.value !== null && !isNaN(ind.ahr999.value)) {
            this.setText('ahr999Info', ind.ahr999.value.toFixed(3));
        }

        // OI
        if (deriv && deriv.openInterest) {
            this.setText('oiInfo', TechnicalAnalysis.formatLargeNumber(deriv.openInterest));
        }
    },

    setText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    },


    // 加载新闻
    async loadNews(coinId) {
        try {
            const news = await NewsAnalyzer.fetchNews(coinId);
            this.state.newsList = news;
            this.renderNews();
            this.updateSignal();
        } catch (error) {
            console.error('获取新闻失败:', error);
        } finally {
            // 无论成功或降级，标记新闻已就绪，此后才允许记录预测
            this._newsReady = true;
        }
    },

    // 渲染新闻（白色主题）
    renderNews() {
        const container = document.getElementById('newsList');
        const newsList = this.state.newsList;
        
        if (!container) return;
        
        if (!newsList || newsList.length === 0) {
            container.innerHTML = '<p class="text-text-secondary text-sm text-center py-8">暂无新闻数据</p>';
            return;
        }
        
        // 更新情感标签
        const newsScore = NewsAnalyzer.calculateNewsScore(newsList);
        const badge = document.getElementById('newsSentimentBadge');
        if (badge) {
            if (newsScore.label === 'positive') {
                badge.textContent = `情绪偏多 ${newsScore.score}分`;
                badge.className = 'text-xs px-2 py-0.5 rounded-full bg-rise-green/10 text-rise-green';
            } else if (newsScore.label === 'negative') {
                badge.textContent = `情绪偏空 ${newsScore.score}分`;
                badge.className = 'text-xs px-2 py-0.5 rounded-full bg-fall-red/10 text-fall-red';
            } else {
                badge.textContent = `情绪中性 ${newsScore.score}分`;
                badge.className = 'text-xs px-2 py-0.5 rounded-full bg-gray-100 text-text-secondary';
            }
        }
        
        container.innerHTML = newsList.slice(0, 6).map((news, index) => {
            const sentimentStyle = NewsAnalyzer.getSentimentStyle(news.sentimentLabel);
            // 适配新的样式类名
            let tagClass = 'text-[10px] px-1.5 py-0.5 rounded ';
            if (sentimentStyle.className?.includes('crypto-green') || news.sentimentLabel === 'positive') {
                tagClass += 'bg-rise-green/10 text-rise-green';
            } else if (sentimentStyle.className?.includes('crypto-red') || news.sentimentLabel === 'negative') {
                tagClass += 'bg-fall-red/10 text-fall-red';
            } else {
                tagClass += 'bg-gray-100 text-text-secondary';
            }

            return `
                <div class="news-card cursor-pointer hover:bg-gray-50 -mx-1 px-1 rounded-lg transition-colors" data-news-index="${index}">
                    <div class="flex items-start justify-between gap-2 mb-1.5">
                        <span class="text-xs text-text-tertiary">${news.source || ''}</span>
                        <span class="${tagClass} flex-shrink-0">${sentimentStyle.text}</span>
                    </div>
                    <h4 class="text-sm font-medium mb-1.5 line-clamp-2 text-text-primary">${news.title}</h4>
                    <p class="text-xs text-text-secondary line-clamp-2">${news.description || ''}</p>
                    <p class="text-xs text-text-tertiary mt-1.5">${NewsAnalyzer.formatTime(news.publishedAt)}</p>
                </div>
            `;
        }).join('');

        // 绑定点击事件
        container.querySelectorAll('.news-card').forEach(card => {
            card.addEventListener('click', () => {
                const index = parseInt(card.dataset.newsIndex);
                this.showNewsDetail(newsList[index]);
            });
        });
    },

    // 显示资讯详情
    showNewsDetail(news) {
        if (!news) return;

        const modal = document.getElementById('newsDetailModal');
        if (!modal) return;

        document.getElementById('newsDetailTitle').textContent = news.title;
        document.getElementById('newsDetailCategory').textContent = news.source || '资讯';
        document.getElementById('newsDetailSource').textContent = news.source || '未知来源';
        document.getElementById('newsDetailTime').textContent = NewsAnalyzer.formatTime(news.publishedAt);

        document.getElementById('newsDetailSummary').textContent = news.description || news.title || '暂无摘要';

        const linkEl = document.getElementById('newsDetailLink');
        if (news.url) {
            linkEl.href = news.url;
            linkEl.style.display = 'flex';
        } else {
            linkEl.style.display = 'none';
        }

        // 情感分析
        const sentimentLabel = news.sentimentLabel || 'neutral';
        const sentimentScore = news.sentimentScore !== undefined ? news.sentimentScore : 50;

        const sentLabelEl = document.getElementById('newsDetailSentimentLabel');
        const sentStyle = NewsAnalyzer.getSentimentStyle(sentimentLabel);
        sentLabelEl.textContent = sentStyle.text;
        let sentClass = 'text-xs px-2 py-0.5 rounded-full font-medium ';
        if (sentimentLabel === 'positive') {
            sentClass += 'bg-rise-green/10 text-rise-green';
        } else if (sentimentLabel === 'negative') {
            sentClass += 'bg-fall-red/10 text-fall-red';
        } else {
            sentClass += 'bg-golden/10 text-golden';
        }
        sentLabelEl.className = sentClass;

        const sentBarEl = document.getElementById('newsDetailSentimentBar');
        sentBarEl.style.width = sentimentScore + '%';
        if (sentimentLabel === 'positive') {
            sentBarEl.className = 'h-full bg-rise-green rounded-full transition-all';
        } else if (sentimentLabel === 'negative') {
            sentBarEl.className = 'h-full bg-fall-red rounded-full transition-all';
        } else {
            sentBarEl.className = 'h-full bg-golden rounded-full transition-all';
        }

        const sentTextEl = document.getElementById('newsDetailSentimentText');
        if (sentimentLabel === 'positive') {
            sentTextEl.textContent = '该资讯偏向正面，可能对价格有积极影响';
        } else if (sentimentLabel === 'negative') {
            sentTextEl.textContent = '该资讯偏向负面，可能对价格产生压力';
        } else {
            sentTextEl.textContent = '该资讯情绪中性，对价格影响有限';
        }

        // 关键词
        const keywordsContainer = document.querySelector('#newsDetailKeywords .flex');
        if (keywordsContainer && news.keywords && news.keywords.length > 0) {
            keywordsContainer.innerHTML = news.keywords.map(kw =>
                `<span class="text-xs px-2 py-0.5 rounded-full bg-golden/10 text-golden">${kw}</span>`
            ).join('');
        } else if (keywordsContainer) {
            keywordsContainer.innerHTML = '<span class="text-xs text-text-tertiary">无</span>';
        }

        modal.classList.remove('hidden');
        modal.classList.add('flex');
        document.body.style.overflow = 'hidden';
    },

    hideNewsDetail() {
        const modal = document.getElementById('newsDetailModal');
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            document.body.style.overflow = '';
        }
    },

    // 显示信号详情弹窗
    showSignalDetail(signalText, price, time) {
        const modal = document.getElementById('signalDetailModal');
        if (!modal) return;

        const info = this.signalInfoMap[signalText];
        if (!info) return;

        const isBuy = info.type === 'buy';

        const iconEl = document.getElementById('signalDetailIcon');
        const typeEl = document.getElementById('signalDetailType');
        const nameEl = document.getElementById('signalDetailName');

        if (isBuy) {
            iconEl.className = 'w-12 h-12 rounded-xl flex items-center justify-center bg-rise-green/10';
            iconEl.innerHTML = `<svg class="w-6 h-6 text-rise-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"></path>
            </svg>`;
            typeEl.textContent = '买入信号';
            typeEl.className = 'text-xs text-rise-green mb-0.5';
            nameEl.className = 'text-lg font-bold text-rise-green';
        } else {
            iconEl.className = 'w-12 h-12 rounded-xl flex items-center justify-center bg-fall-red/10';
            iconEl.innerHTML = `<svg class="w-6 h-6 text-fall-red" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6"></path>
            </svg>`;
            typeEl.textContent = '卖出信号';
            typeEl.className = 'text-xs text-fall-red mb-0.5';
            nameEl.className = 'text-lg font-bold text-fall-red';
        }
        nameEl.textContent = signalText;

        // 信号强度
        const strengthTextEl = document.getElementById('signalDetailStrengthText');
        const bars = ['sigBar1', 'sigBar2', 'sigBar3'];
        const strengthMap = { weak: 1, medium: 2, strong: 3 };
        const level = strengthMap[info.strength] || 1;
        strengthTextEl.textContent = info.strengthText;

        const barColor = isBuy ? 'bg-rise-green' : 'bg-fall-red';
        const grayColor = 'bg-gray-200';
        strengthTextEl.className = `text-sm font-semibold ${isBuy ? 'text-rise-green' : 'text-fall-red'}`;
        bars.forEach((id, idx) => {
            const el = document.getElementById(id);
            if (el) {
                el.className = `w-1.5 h-4 rounded-full ${idx < level ? barColor : grayColor}`;
            }
        });

        document.getElementById('signalDetailDesc').textContent = info.desc;
        document.getElementById('signalDetailCondition').textContent = info.condition;
        document.getElementById('signalDetailAdvice').textContent = info.advice;

        modal.classList.remove('hidden');
        modal.classList.add('flex');
        document.body.style.overflow = 'hidden';
    },

    hideSignalDetail() {
        const modal = document.getElementById('signalDetailModal');
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            document.body.style.overflow = '';
        }
    },


    // 更新信号
    updateSignal() {
        const ind = this.state.indicators;

        const techScoreResult = TechnicalAnalysis.calculateTechnicalScore({
            rsi: ind.rsi,
            macd: ind.macd,
            ma7: ind.ma7,
            ma25: ind.ma25,
            ma200: ind.ma200,
            currentPrice: ind.currentPrice,
            bollingerBands: ind.bollingerBands,
            vwap: ind.vwap,
            obv: ind.obv,
            stochRSI: ind.stochRSI,
            kdj: ind.kdj,
            ahr999: ind.ahr999
        });

        const newsScoreResult = NewsAnalyzer.calculateNewsScore(this.state.newsList);
        const sentimentScore = this.calculateSentimentScore();
        const derivativesScore = this.calculateDerivativesScore();

        // 量能因子：基于K线成交量评估放量/缩量与量价配合
        const volumeResult = TechnicalAnalysis.analyzeVolume(
            this.state.candleData,
            this.getTimeframeConfig(this.state.currentTimeframe).seconds
        );
        this.state.volumeAnalysis = volumeResult;

        // 五因子加权：技术面 / 量能 / 市场情绪 / 消息面 / 衍生品
        const totalScore = Math.round(
            techScoreResult.score * 0.40 +
            volumeResult.score * 0.20 +
            sentimentScore * 0.16 +
            newsScoreResult.score * 0.12 +
            derivativesScore * 0.12
        );

        const signal = SignalGenerator.generateSignal(
            { ...techScoreResult, score: techScoreResult.score },
            { ...newsScoreResult, score: newsScoreResult.score },
            {
                supportResistance: ind.supportResistance,
                currentPrice: ind.currentPrice,
                sentimentScore,
                derivativesScore,
                volumeScore: volumeResult.score,
                volumeMetrics: volumeResult.metrics,
                volumeSignals: volumeResult.signals,
                totalScore,
                breakdown: {
                    technical: techScoreResult.score,
                    volume: volumeResult.score,
                    news: newsScoreResult.score,
                    sentiment: sentimentScore,
                    derivatives: derivativesScore
                }
            }
        );

        this.state.signal = signal;
        this.state.signal.totalScore = totalScore;

        // 记录本次预测（仅在方向变化或上一轮已复盘时才会新增）
        this.trackPrediction(signal);

        this.renderSignal();
        this.renderPredictTab();
    },

    /**
     * 记录本次预测，用于后续统计准确率
     */
    trackPrediction(signal) {
        if (!signal || !this.state.coinInfo) return;
        const price = this.state.coinInfo.current_price;
        if (!price) return;

        // 新闻与恐慌指数尚未就绪时评分不完整，此时记录会得到失真的方向，
        // 等这两个数据源加载完（成功或降级）后再开始记录
        if (!this._newsReady || !this._fngReady) return;

        const coin = this.getCoinInfo(this.state.currentCoin);
        const added = PredictionTracker.record({
            coinId: this.state.currentCoin,
            coinSymbol: coin.symbol,
            timeframe: this.state.currentTimeframe,
            signalType: signal.type,
            signalText: signal.text,
            score: signal.totalScore,
            price,
            intervalSeconds: this.getTimeframeConfig(this.state.currentTimeframe).seconds,
        });

        if (added) {
            console.log('[预测] 已记录:', signal.text, '@', price);
        }
    },

    /**
     * 用最新K线复盘到期的预测
     */
    evaluatePredictions() {
        if (!this.state.candleData || this.state.candleData.length === 0) return;
        const updated = PredictionTracker.evaluate(this.state.candleData);
        if (updated) {
            console.log('[预测] 有预测完成复盘');
        }
    },

    calculateSentimentScore() {
        const fng = this.state.fearGreedIndex;
        if (!fng || fng.value === null || fng.value === undefined) return 50;

        let adjustedScore = 50;
        if (fng.value < 20) adjustedScore = 75;
        else if (fng.value < 40) adjustedScore = 65;
        else if (fng.value < 50) adjustedScore = 55;
        else if (fng.value < 60) adjustedScore = 45;
        else if (fng.value < 80) adjustedScore = 35;
        else adjustedScore = 25;

        return adjustedScore;
    },

    calculateDerivativesScore() {
        const deriv = this.state.derivatives;
        if (!deriv || deriv.fundingRate === null || deriv.fundingRate === undefined) return 50;

        let score = 50;
        const fr = deriv.fundingRate;
        if (fr > 0.1) {
            score -= 20;
        } else if (fr > 0.05) {
            score -= 10;
        } else if (fr < -0.05) {
            score += 15;
        } else if (fr < 0) {
            score += 5;
        }

        return Math.max(0, Math.min(100, score));
    },

    // 渲染综合信号卡片
    renderSignal() {
        const signal = this.state.signal;
        if (!signal) return;

        const signalIcon = document.getElementById('signalMainIcon');
        const signalText = document.getElementById('signalMainText');
        const signalDesc = document.getElementById('signalMainDesc');
        const signalStrengthTag = document.getElementById('signalStrengthTag');

        let signalColor = 'golden';
        let strengthText = '中性';

        if (signal.type === 'strong_buy') {
            signalColor = 'rise-green';
            strengthText = '强烈买入';
        } else if (signal.type === 'buy') {
            signalColor = 'rise-green';
            strengthText = '买入';
        } else if (signal.type === 'strong_sell') {
            signalColor = 'fall-red';
            strengthText = '强烈卖出';
        } else if (signal.type === 'sell') {
            signalColor = 'fall-red';
            strengthText = '卖出';
        } else {
            strengthText = '观望';
        }

        // 信号图标
        if (signalIcon) {
            signalIcon.className = `w-14 h-14 rounded-2xl flex items-center justify-center bg-${signalColor}/10 flex-shrink-0`;
            signalIcon.innerHTML = SignalGenerator.getSignalIcon(signal.type);
            // 修复图标颜色
            const svg = signalIcon.querySelector('svg');
            if (svg) {
                svg.classList.remove('text-rise-green', 'text-fall-red', 'text-golden');
                svg.classList.add(`text-${signalColor}`);
            }
        }

        // 信号文字
        if (signalText) {
            signalText.textContent = signal.text;
            signalText.className = `text-xl font-bold text-${signalColor}`;
        }

        // 信号描述
        if (signalDesc) {
            signalDesc.textContent = signal.desc;
        }

        // 信号强度标签
        if (signalStrengthTag) {
            signalStrengthTag.textContent = strengthText;
            signalStrengthTag.className = `text-xs px-2 py-0.5 rounded-full bg-${signalColor}/10 text-${signalColor} font-medium`;
        }

        // 综合评分
        const totalScore = signal.totalScore ?? 50;
        const scoreTextEl = document.getElementById('signalScoreText');
        if (scoreTextEl) {
            scoreTextEl.textContent = '评分 ' + totalScore;
        }

        const scoreBarEl = document.getElementById('signalScoreBar');
        if (scoreBarEl) {
            scoreBarEl.style.width = `${totalScore}%`;
        }

        // 五维评分 Mini
        const scoreColorOf = (v) => SignalGenerator.getScoreColor(v)
            .replace('crypto-', '').replace('green', 'rise-green').replace('red', 'fall-red').replace('gold', 'golden');

        const techMini = document.getElementById('techScoreMini');
        if (techMini) {
            techMini.textContent = signal.techScore;
            techMini.className = `text-sm font-semibold mt-0.5 ${scoreColorOf(signal.techScore)}`;
        }

        const volumeMini = document.getElementById('volumeScoreMini');
        const volumeScore = signal.breakdown?.volume ?? 50;
        if (volumeMini) {
            volumeMini.textContent = volumeScore;
            volumeMini.className = `text-sm font-semibold mt-0.5 ${scoreColorOf(volumeScore)}`;
        }

        const sentimentMini = document.getElementById('sentimentScoreMini');
        const sentimentScore = signal.breakdown?.sentiment ?? 50;
        if (sentimentMini) {
            sentimentMini.textContent = sentimentScore;
            sentimentMini.className = `text-sm font-semibold mt-0.5 ${scoreColorOf(sentimentScore)}`;
        }

        const newsMini = document.getElementById('newsScoreMini');
        if (newsMini) {
            newsMini.textContent = signal.newsScore;
            newsMini.className = `text-sm font-semibold mt-0.5 ${scoreColorOf(signal.newsScore)}`;
        }

        const derivMini = document.getElementById('derivScoreMini');
        const derivScore = signal.breakdown?.derivatives ?? 50;
        if (derivMini) {
            derivMini.textContent = derivScore;
            derivMini.className = `text-sm font-semibold mt-0.5 ${scoreColorOf(derivScore)}`;
        }
    },

    // 渲染预测Tab
    renderPredictTab() {
        const signal = this.state.signal;
        if (!signal) return;

        // 预测方向
        const predictDir = document.getElementById('predictDirection');
        if (predictDir) {
            predictDir.textContent = signal.text || '震荡观望';
            let color = 'text-golden';
            if (signal.type === 'buy' || signal.type === 'strong_buy') color = 'text-rise-green';
            else if (signal.type === 'sell' || signal.type === 'strong_sell') color = 'text-fall-red';
            predictDir.className = `text-xl font-bold ${color}`;
        }

        // 置信度
        const totalScore = signal.totalScore ?? 50;
        const confidence = Math.abs(totalScore - 50) * 2; // 转换为 0-100 的置信度
        const confEl = document.getElementById('predictConfidence');
        if (confEl) {
            confEl.textContent = `置信度 ${confidence.toFixed(0)}%`;
        }

        // 预测摘要
        const summaryEl = document.getElementById('predictSummary');
        if (summaryEl) {
            summaryEl.textContent = signal.desc || '综合技术指标、量能、市场情绪、消息面和衍生品数据分析中...';
        }

        // 操作建议列表
        const actionTipsEl = document.getElementById('actionTipsList');
        if (actionTipsEl && signal.actionTips) {
            actionTipsEl.innerHTML = signal.actionTips.map(tip => {
                let tipClass = 'text-text-secondary';
                let iconBg = 'bg-gray-100 text-text-secondary';
                if (tip.type === 'buy') { tipClass = 'text-rise-green'; iconBg = 'bg-rise-green/10 text-rise-green'; }
                if (tip.type === 'sell') { tipClass = 'text-fall-red'; iconBg = 'bg-fall-red/10 text-fall-red'; }
                if (tip.type === 'watch') { tipClass = 'text-golden'; iconBg = 'bg-golden/10 text-golden'; }

                return `
                    <div class="flex items-start gap-3 p-3 rounded-xl bg-gray-50">
                        <div class="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${iconBg}">
                            <span class="text-sm">${tip.icon || '•'}</span>
                        </div>
                        <span class="text-sm ${tipClass} leading-relaxed">${tip.text}</span>
                    </div>
                `;
            }).join('');
        }

        // 仓位建议
        const posAdviceEl = document.getElementById('positionAdviceText');
        if (posAdviceEl && signal.positionAdvice) {
            const advice = signal.positionAdvice;
            let html = '';

            if (advice.buyZones && advice.buyZones.length > 0) {
                html += '<div class="mb-2">';
                html += '<p class="text-xs text-text-secondary mb-1">买入区域</p>';
                advice.buyZones.forEach(zone => {
                    const strongClass = zone.strength === 'strong' ? 'font-semibold' : '';
                    html += `<div class="flex items-center justify-between py-0.5 ${strongClass}">
                        <span class="text-sm text-rise-green">${zone.label}</span>
                        <span class="text-sm font-mono text-rise-green">$${TechnicalAnalysis.formatPrice(zone.level)}</span>
                    </div>`;
                });
                html += '</div>';
            }

            if (advice.sellZones && advice.sellZones.length > 0) {
                html += '<div>';
                html += '<p class="text-xs text-text-secondary mb-1">卖出区域</p>';
                advice.sellZones.forEach(zone => {
                    const strongClass = zone.strength === 'strong' ? 'font-semibold' : '';
                    html += `<div class="flex items-center justify-between py-0.5 ${strongClass}">
                        <span class="text-sm text-fall-red">${zone.label}</span>
                        <span class="text-sm font-mono text-fall-red">$${TechnicalAnalysis.formatPrice(zone.level)}</span>
                    </div>`;
                });
                html += '</div>';
            }

            // 量能因子对仓位执行的修正提示
            if (advice.note) {
                const noteCls = advice.bias === 'caution'
                    ? 'mt-2 p-2.5 rounded-lg bg-fall-red/10 text-xs text-fall-red leading-relaxed'
                    : (advice.bias === 'support'
                        ? 'mt-2 p-2.5 rounded-lg bg-rise-green/10 text-xs text-rise-green leading-relaxed'
                        : 'mt-2 p-2.5 rounded-lg bg-gray-50 text-xs text-text-secondary leading-relaxed');
                html += `<div class="${noteCls}">${advice.note}</div>`;
            }

            posAdviceEl.innerHTML = html || '<span class="text-text-secondary text-sm">暂无建议</span>';
        }

        // 量能分析
        this.renderVolumeAnalysis();

        // 预测准确率与历史记录
        this.renderAccuracyStats();
        this.renderPredictionHistory();

        // 信号明细列表
        const detailsEl = document.getElementById('signalDetailsList');
        if (detailsEl) {
            const triggeredSignals = this.getTriggeredSignalList();
            if (triggeredSignals.length === 0) {
                detailsEl.innerHTML = '<div class="text-sm text-text-secondary">暂无触发信号</div>';
            } else {
                detailsEl.innerHTML = triggeredSignals.map(sig => {
                    const isBuy = sig.type === 'buy';
                    return `
                        <div class="flex items-center justify-between p-3 rounded-xl bg-gray-50 cursor-pointer hover:bg-gray-100 transition-colors signal-detail-item"
                             data-signal="${sig.name}">
                            <div class="flex items-center gap-3">
                                <div class="w-8 h-8 rounded-lg flex items-center justify-center ${isBuy ? 'bg-rise-green/10' : 'bg-fall-red/10'}">
                                    <svg class="w-4 h-4 ${isBuy ? 'text-rise-green' : 'text-fall-red'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${isBuy ? 'M13 7h8m0 0v8m0-8l-8 8-4-4-6 6' : 'M13 17h8m0 0V9m0 8l-8-8-4 4-6-6'}"></path>
                                    </svg>
                                </div>
                                <div>
                                    <p class="text-sm font-medium text-text-primary">${sig.name}</p>
                                    <p class="text-xs text-text-tertiary">${sig.strengthText}信号</p>
                                </div>
                            </div>
                            <svg class="w-4 h-4 text-text-tertiary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path>
                            </svg>
                        </div>
                    `;
                }).join('');

                // 绑定点击事件
                detailsEl.querySelectorAll('.signal-detail-item').forEach(item => {
                    item.addEventListener('click', () => {
                        const sigName = item.dataset.signal;
                        const info = this.signalInfoMap[sigName];
                        if (info) {
                            this.showSignalDetail(sigName, 0, 0);
                        }
                    });
                });
            }
        }
    },

    // 渲染量能分析卡片
    renderVolumeAnalysis() {
        const analysis = this.state.volumeAnalysis;
        const metrics = analysis?.metrics;

        const fmtVol = (v) => (v || v === 0) ? TechnicalAnalysis.formatLargeNumber(v) : '--';

        // 量能因子评分标签
        const scoreTag = document.getElementById('volumeScoreTag');
        if (scoreTag) {
            const s = analysis?.score ?? 50;
            scoreTag.textContent = `量能因子 ${s}`;
            let cls = 'text-xs px-2 py-0.5 rounded-full font-medium ';
            if (s >= 60) cls += 'bg-rise-green/10 text-rise-green';
            else if (s >= 45) cls += 'bg-golden/10 text-golden';
            else cls += 'bg-fall-red/10 text-fall-red';
            scoreTag.className = cls;
        }

        const stateEl = document.getElementById('volPriceVolumeState');
        const listEl = document.getElementById('volumeSignalsList');

        if (!metrics) {
            if (stateEl) {
                stateEl.textContent = 'K线数据不足，暂无法计算量能';
                stateEl.className = 'p-3 rounded-xl bg-gray-50 text-sm text-text-secondary mb-2.5';
            }
            if (listEl) listEl.innerHTML = '';
            return;
        }

        // 量比
        const ratioEl = document.getElementById('volRatioValue');
        if (ratioEl) {
            ratioEl.textContent = metrics.ratio.toFixed(2);
            const ratioColor = metrics.ratio >= 1.2 ? 'text-rise-green'
                : (metrics.ratio < 0.8 ? 'text-fall-red' : 'text-text-primary');
            ratioEl.className = `text-lg font-bold tabular-nums ${ratioColor}`;
        }

        const curEl = document.getElementById('volCurrentValue');
        if (curEl) curEl.textContent = fmtVol(metrics.current);

        // 盘中预估量比（未完成K线按时间进度折算，周期刚开盘时不可靠）
        const liveEl = document.getElementById('volLiveRatioValue');
        if (liveEl) {
            if (metrics.liveRatio === null || metrics.liveRatio === undefined) {
                liveEl.textContent = '--';
                liveEl.className = 'text-lg font-bold tabular-nums text-text-tertiary';
            } else {
                liveEl.textContent = metrics.liveRatio.toFixed(2);
                const liveColor = metrics.liveRatio >= 1.2 ? 'text-rise-green'
                    : (metrics.liveRatio < 0.8 ? 'text-fall-red' : 'text-text-primary');
                liveEl.className = `text-lg font-bold tabular-nums ${liveColor}`;
            }
        }

        const avgEl = document.getElementById('volAvg20Value');
        if (avgEl) avgEl.textContent = fmtVol(metrics.avg20);

        // 量价配合状态
        const stateMap = {
            confirm:   { text: '量价齐升：上涨有量能支撑，趋势相对健康', cls: 'p-3 rounded-xl bg-rise-green/10 text-sm text-rise-green mb-2.5' },
            diverge:   { text: '缩量上涨：量能未跟进，警惕上攻乏力与顶背离', cls: 'p-3 rounded-xl bg-fall-red/10 text-sm text-fall-red mb-2.5' },
            panic:     { text: '放量下跌：抛压沉重，短线需控制风险', cls: 'p-3 rounded-xl bg-fall-red/10 text-sm text-fall-red mb-2.5' },
            exhausted: { text: '缩量回调：抛压有所衰竭，可关注企稳反弹', cls: 'p-3 rounded-xl bg-rise-green/10 text-sm text-rise-green mb-2.5' },
            neutral:   { text: '量价关系中性，量能未给出明确方向', cls: 'p-3 rounded-xl bg-gray-50 text-sm text-text-secondary mb-2.5' },
        };
        const stateInfo = stateMap[metrics.priceVolumeState] || stateMap.neutral;
        if (stateEl) {
            stateEl.textContent = stateInfo.text;
            stateEl.className = stateInfo.cls;
        }

        // 量能明细
        if (listEl) {
            const signals = analysis.signals || [];
            if (signals.length === 0) {
                listEl.innerHTML = '<p class="text-sm text-text-secondary">量能平稳，无显著信号</p>';
            } else {
                listEl.innerHTML = signals.map(sig => {
                    let iconBg = 'bg-gray-100 text-text-secondary';
                    let textCls = 'text-text-secondary';
                    if (sig.bias === 'bull') { iconBg = 'bg-rise-green/10 text-rise-green'; textCls = 'text-rise-green'; }
                    else if (sig.bias === 'bear') { iconBg = 'bg-fall-red/10 text-fall-red'; textCls = 'text-fall-red'; }

                    return `
                        <div class="flex items-start gap-3 p-3 rounded-xl bg-gray-50">
                            <div class="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${iconBg}">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>
                                </svg>
                            </div>
                            <span class="text-sm ${textCls} leading-relaxed">${sig.text}</span>
                        </div>
                    `;
                }).join('');
            }
        }
    },

    // 渲染预测准确率
    renderAccuracyStats() {
        const coinId = this.state.currentCoin;
        const tf = this.state.currentTimeframe;
        const stats = PredictionTracker.getStats(coinId, tf);
        const coin = this.getCoinInfo(coinId);
        const tfLabel = this.getTimeframeConfig(tf).label;

        const CIRC = 213.6; // 2πr, r = 34

        const scopeEl = document.getElementById('accuracyScope');
        if (scopeEl) {
            scopeEl.textContent = `${coin.symbol} · ${tfLabel} · 累计 ${stats.total} 次`;
        }

        // 准确率圆环
        const ring = document.getElementById('accuracyRing');
        const pct = stats.accuracy;
        if (ring) {
            if (pct === null) {
                // 还没有完成复盘的预测，用中性灰而不是红色，避免误读为「准确率差」
                ring.setAttribute('stroke-dashoffset', String(CIRC));
                ring.setAttribute('stroke', '#e0e3e8');
            } else {
                const bounded = Math.max(0, Math.min(100, pct));
                ring.setAttribute('stroke-dashoffset', String(CIRC * (1 - bounded / 100)));
                ring.setAttribute('stroke', bounded >= 60 ? '#089981' : (bounded >= 45 ? '#f0b90b' : '#f23645'));
            }
        }

        const valEl = document.getElementById('accuracyValue');
        if (valEl) {
            if (pct === null) {
                valEl.textContent = '--';
                valEl.className = 'text-lg font-bold tabular-nums text-text-tertiary';
            } else {
                valEl.textContent = pct.toFixed(0) + '%';
                valEl.className = `text-lg font-bold tabular-nums ${pct >= 60 ? 'text-rise-green' : (pct >= 45 ? 'text-golden' : 'text-fall-red')}`;
            }
        }

        // 方向准确率（只看多空，排除观望）
        const dirEl = document.getElementById('dirAccuracyValue');
        if (dirEl) {
            if (stats.directionalAccuracy === null) {
                dirEl.textContent = '--';
                dirEl.className = 'text-base font-bold tabular-nums text-text-tertiary';
            } else {
                const a = stats.directionalAccuracy;
                dirEl.textContent = `${a.toFixed(0)}%`;
                dirEl.className = `text-base font-bold tabular-nums ${a >= 60 ? 'text-rise-green' : (a >= 45 ? 'text-golden' : 'text-fall-red')}`;
            }
        }

        const resolvedEl = document.getElementById('resolvedCount');
        if (resolvedEl) {
            resolvedEl.textContent = stats.pending > 0
                ? `${stats.resolved} / ${stats.total}`
                : String(stats.resolved);
            resolvedEl.className = 'text-base font-bold tabular-nums text-text-primary';
        }

        const pctText = (c, t) => (t === 0 ? '--' : `${Math.round(c / t * 100)}%`);
        const bullEl = document.getElementById('bullAccuracy');
        if (bullEl) {
            const t = pctText(stats.bullCorrect, stats.bullTotal);
            bullEl.textContent = t === '--' ? '--' : `${t} (${stats.bullCorrect}/${stats.bullTotal})`;
            bullEl.className = 'text-base font-bold tabular-nums text-rise-green';
        }

        const bearEl = document.getElementById('bearAccuracy');
        if (bearEl) {
            const t = pctText(stats.bearCorrect, stats.bearTotal);
            bearEl.textContent = t === '--' ? '--' : `${t} (${stats.bearCorrect}/${stats.bearTotal})`;
            bearEl.className = 'text-base font-bold tabular-nums text-fall-red';
        }
    },

    // 渲染历史预测记录
    renderPredictionHistory() {
        const listEl = document.getElementById('predictionHistoryList');
        if (!listEl) return;

        const records = PredictionTracker.getHistory(this.state.currentCoin, this.state.currentTimeframe, 20);

        const countEl = document.getElementById('historyCount');
        if (countEl) {
            countEl.textContent = records.length ? `最近 ${records.length} 条` : '';
        }

        if (records.length === 0) {
            listEl.innerHTML = '<p class="text-sm text-text-secondary leading-relaxed">暂无预测记录。产生方向性预测后会自动记录，等复盘窗口结束再回来核对结果。</p>';
            return;
        }

        listEl.innerHTML = records.map(r => {
            const isHold = r.signalType === 'hold';
            const isBuy = r.signalType === 'buy' || r.signalType === 'strong_buy';
            const dirCls = isHold ? 'text-golden' : (isBuy ? 'text-rise-green' : 'text-fall-red');
            const dirBg = isHold ? 'bg-golden/10' : (isBuy ? 'bg-rise-green/10' : 'bg-fall-red/10');

            // 复盘结果标签
            let resultHtml;
            if (r.correct === null) {
                const left = Math.max(0, r.resolveAt - Date.now());
                resultHtml = `<span class="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-text-tertiary whitespace-nowrap">待复盘 · ${this.formatCountdown(left)}</span>`;
            } else {
                resultHtml = `<span class="text-[11px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${r.correct ? 'bg-rise-green/10 text-rise-green' : 'bg-fall-red/10 text-fall-red'}">${r.correct ? '判断正确' : '判断错误'}</span>`;
            }

            const chg = r.changePct === null
                ? '--'
                : `${r.changePct >= 0 ? '+' : ''}${(r.changePct * 100).toFixed(2)}%`;
            const chgCls = r.changePct === null ? 'text-text-tertiary' : (r.changePct >= 0 ? 'text-rise-green' : 'text-fall-red');

            return `
                <div class="p-3 rounded-xl bg-gray-50">
                    <div class="flex items-center justify-between gap-2 mb-2">
                        <div class="flex items-center gap-2 min-w-0">
                            <span class="text-xs px-1.5 py-0.5 rounded ${dirBg} ${dirCls} flex-shrink-0">${isBuy ? '看多' : (isHold ? '观望' : '看空')}</span>
                            <span class="text-sm font-semibold ${dirCls} truncate">${r.signalText}</span>
                            <span class="text-xs text-text-tertiary whitespace-nowrap">评分 ${r.score ?? '--'}</span>
                        </div>
                        ${resultHtml}
                    </div>
                    <div class="flex items-center justify-between text-xs gap-2">
                        <span class="text-text-tertiary whitespace-nowrap">${this.formatPredictionTime(r.predictedAt)}</span>
                        <span class="text-text-secondary tabular-nums whitespace-nowrap">
                            $${TechnicalAnalysis.formatPrice(r.price)}
                            <span class="text-text-tertiary mx-0.5">→</span>
                            ${r.evalPrice ? '$' + TechnicalAnalysis.formatPrice(r.evalPrice) : '--'}
                            <span class="${chgCls} font-medium ml-1">${chg}</span>
                        </span>
                    </div>
                </div>
            `;
        }).join('');
    },

    // 复盘倒计时文案
    formatCountdown(ms) {
        const min = Math.floor(ms / 60000);
        if (min < 60) return `${Math.max(1, min)} 分钟后`;
        const h = Math.floor(min / 60);
        if (h < 24) return `${h} 小时后`;
        return `${Math.floor(h / 24)} 天后`;
    },

    // 预测记录时间格式化
    formatPredictionTime(ts) {
        const d = new Date(ts);
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },

    // 获取已触发的信号列表（基于最近的K线）
    getTriggeredSignalList() {
        const signals = [];
        const ind = this.state.indicators;
        if (!ind) return signals;

        const seen = new Set();

        // 检查MACD
        if (ind.macd && ind.macd.macd && ind.macd.signal) {
            const len = ind.macd.macd.length;
            if (len >= 2) {
                const last = ind.macd.macd[len - 1];
                const prev = ind.macd.macd[len - 2];
                const lastSig = ind.macd.signal[len - 1];
                const prevSig = ind.macd.signal[len - 2];
                if (prev <= prevSig && last > lastSig) {
                    signals.push({ name: 'MACD金叉', type: 'buy', strengthText: '中等' });
                    seen.add('MACD金叉');
                } else if (prev >= prevSig && last < lastSig) {
                    signals.push({ name: 'MACD死叉', type: 'sell', strengthText: '中等' });
                    seen.add('MACD死叉');
                }
            }
        }

        // 检查KDJ
        if (ind.kdj && ind.kdj.k && ind.kdj.d) {
            const len = ind.kdj.k.length;
            if (len >= 2) {
                const lastK = ind.kdj.k[len - 1];
                const prevK = ind.kdj.k[len - 2];
                const lastD = ind.kdj.d[len - 1];
                const prevD = ind.kdj.d[len - 2];
                if (prevK <= prevD && lastK > lastD) {
                    if (lastK < 30 && lastD < 30) {
                        signals.push({ name: 'KDJ超卖金叉', type: 'buy', strengthText: '强' });
                    } else {
                        signals.push({ name: 'KDJ金叉', type: 'buy', strengthText: '中等' });
                    }
                } else if (prevK >= prevD && lastK < lastD) {
                    if (lastK > 70 && lastD > 70) {
                        signals.push({ name: 'KDJ超买死叉', type: 'sell', strengthText: '强' });
                    } else {
                        signals.push({ name: 'KDJ死叉', type: 'sell', strengthText: '中等' });
                    }
                }
            }
        }

        // RSI
        if (ind.rsi !== null && ind.rsi !== undefined) {
            if (ind.rsi > 70) {
                signals.push({ name: 'RSI超买回落', type: 'sell', strengthText: '强' });
            } else if (ind.rsi < 30) {
                signals.push({ name: 'RSI超卖回升', type: 'buy', strengthText: '强' });
            }
        }

        // 均线
        if (ind.ma7 && ind.ma25) {
            const len = ind.ma7.length;
            if (len >= 2) {
                const lastMa7 = ind.ma7[len - 1];
                const prevMa7 = ind.ma7[len - 2];
                const lastMa25 = ind.ma25[len - 1];
                const prevMa25 = ind.ma25[len - 2];
                if (prevMa7 <= prevMa25 && lastMa7 > lastMa25) {
                    signals.push({ name: '均线金叉', type: 'buy', strengthText: '中等' });
                } else if (prevMa7 >= prevMa25 && lastMa7 < lastMa25) {
                    signals.push({ name: '均线死叉', type: 'sell', strengthText: '中等' });
                }
            }
        }

        return signals;
    },


    // 保存联网添加的币种元数据
    saveCoinMeta() {
        try {
            localStorage.setItem('cryptoPulse_coinMeta', JSON.stringify(this.state.coinMeta));
        } catch (e) { /* 忽略存储失败 */ }
    },

    loadCoinMeta() {
        try {
            const saved = JSON.parse(localStorage.getItem('cryptoPulse_coinMeta') || '{}');
            this.state.coinMeta = saved || {};
        } catch (e) {
            this.state.coinMeta = {};
        }
    },

    // 补齐币种元数据（从目录拉取的币种需落盘，否则切换后读不到）
    ensureCoinMeta(coinId) {
        const fromPopular = this.popularCoins.find(c => c.id === coinId);
        const fromCatalog = this.state.coinCatalog.find(c => c.coinId === coinId);
        if (!fromPopular && fromCatalog) {
            this.state.coinMeta[coinId] = {
                id: coinId,
                coinId: coinId,
                symbol: fromCatalog.symbol,
                name: fromCatalog.name,
                binanceSymbol: fromCatalog.binanceSymbol
            };
            this.saveCoinMeta();
        }
    },

    /**
     * 写入自选列表（不切换币种、不关闭弹窗）
     * @returns {boolean} 是否成功写入（已存在视为成功，超出上限返回 false）
     */
    registerWatchlist(coinId) {
        this.ensureCoinMeta(coinId);

        if (this.state.watchlist.includes(coinId)) return true;

        const targetSymbol = this.getBinanceSymbol(coinId);
        if (targetSymbol && this.state.watchlist.some(
            id => id !== coinId && this.getBinanceSymbol(id) === targetSymbol
        )) {
            return true;
        }

        if (this.state.watchlist.length >= 15) {
            this.showToast('自选最多添加 15 个币种');
            return false;
        }

        this.state.watchlist.push(coinId);
        this.saveWatchlist();
        this.loadWatchlistQuotes();
        return true;
    },

    /**
     * 点击列表中的星星：加入/移出自选，但不切换当前查看的币种
     */
    toggleSymbolWatchlist(coinId, binanceSymbol) {
        const existingId = this.findWatchlistIdBySymbol(binanceSymbol);

        if (existingId) {
            if (this.state.watchlist.length <= 1) {
                this.showToast('至少保留一个自选币种');
                return;
            }
            this.removeFromWatchlist(existingId, existingId === this.state.currentCoin);
            this.showToast('已移出自选');
        } else {
            if (!this.registerWatchlist(coinId)) return;
            this.renderCoinSelectorList();
            this.updateFavoriteButton();
            this.showToast('已加入自选');
        }
    },

    // 添加到自选并切换过去（列表整行点击）
    async addToWatchlist(coinId) {
        this.ensureCoinMeta(coinId);

        const targetSymbol = this.getBinanceSymbol(coinId);
        if (targetSymbol) {
            const duplicated = this.state.watchlist.find(
                id => id !== coinId && this.getBinanceSymbol(id) === targetSymbol
            );
            if (duplicated) {
                this.hideCoinSelectorModal();
                this.switchCoin(duplicated);
                return;
            }
        }

        if (this.state.watchlist.includes(coinId)) {
            this.hideCoinSelectorModal();
            this.switchCoin(coinId);
            return;
        }

        if (!this.registerWatchlist(coinId)) return;

        this.renderCoinSelectorList();
        this.updateFavoriteButton();

        this.hideCoinSelectorModal();
        await this.switchCoin(coinId);
    },

    // 从自选移除
    // @param {boolean} keepCurrent - 为 true 时即使移除的是当前币种也不跳转
    removeFromWatchlist(coinId, keepCurrent = false) {
        if (this.state.watchlist.length <= 1) return;

        const index = this.state.watchlist.indexOf(coinId);
        if (index > -1) {
            this.state.watchlist.splice(index, 1);

            delete this.state.watchlistQuotes[coinId];
            if (!this.popularCoins.find(c => c.id === coinId)) {
                delete this.state.coinMeta[coinId];
                this.saveCoinMeta();
            }

            if (!keepCurrent && coinId === this.state.currentCoin) {
                this.state.currentCoin = this.state.watchlist[0];
                this.loadCoinData(this.state.currentCoin);
            }

            this.saveWatchlist();
            this.renderCoinSelectorList();
            this.updateFavoriteButton();
        }
    },

    // 显示/隐藏加载状态
    showLoading(show) {
        const overlay = document.getElementById('loadingOverlay');
        if (show) {
            overlay.classList.remove('hidden');
            overlay.classList.add('flex');
        } else {
            overlay.classList.add('hidden');
            overlay.classList.remove('flex');
        }
    },

    // 自动刷新
    startAutoRefresh() {
        // 每30秒刷新一次价格、K线和自选行情
        setInterval(() => {
            this.loadPriceData(this.state.currentCoin);
            this.loadCandleData(this.state.currentCoin);
            this.loadWatchlistQuotes();
        }, 30000);

        // 每5分钟刷新一次新闻
        setInterval(() => {
            this.loadNews(this.state.currentCoin);
        }, 300000);
    }
};

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    CryptoPulseApp.init();
});
