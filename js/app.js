/**
 * CryptoPulse - 主应用逻辑（币安白色主题版）
 * 负责数据获取、状态管理、UI更新和用户交互
 */

/**
 * 买卖点提醒配图（base64）的长度上限。
 *
 * 服务端 /api/notify 的请求体上限是 2MB，base64 又把图放大约三分之一，
 * 所以这里留出足够余量。真实的一张图约几十 KB，离上限很远；
 * 定这个上限是为了万一画布实现变了、图炸大时，宁可只发文字，
 * 也不能让整封提醒因为一张图被服务端拒掉。
 */
const NOTIFY_CHART_MAX_BASE64 = 1200 * 1024;

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
        // candleData 属于哪个币种、哪个周期。
        //
        // 复盘必须靠它核对标的，不能用 currentCoin / currentTimeframe：
        // 那两个是「用户现在选中什么」，而 candleData 是「上一次取数拿回来什么」，
        // 切币或切周期之后、新数据回来之前，两者并不一致。
        candleMeta: null,
        indicators: {},
        newsList: [],
        signal: null,
        isLoading: false,
        lastUpdate: null,
        showSignalMarkers: true,
        showMA: true,
        showVolume: true,
        sensitivity: 'balanced', // 信号灵敏度档位：conservative | balanced | sensitive
        coinCatalog: [],        // 联网获取的币安全量交易对
        catalogLoaded: false,
        catalogLoading: false,
        stockCatalog: [],       // 币安 USDT-M 合约里的美股标的（TradFi）
        stockCatalogLoaded: false,
        stockCatalogLoading: false,
        stockQuotes: {},        // 美股列表行情 { binanceSymbol: {price, changePercent} }
        stockDepthNotice: null, // 当前美股标的的历史深度提示（合约上线晚，K线不够）
        coinMeta: {},           // 联网添加的币种元数据 { coinId: {id, symbol, name, binanceSymbol} }
        cgSearchResults: [],    // 搜索里来自 CoinGecko 的候选（币安未收录）
        cgCandleMeta: null,     // 当前 CoinGecko 币种的K线口径（粒度/成交量是否估算）
        watchlistQuotes: {},    // 自选币种行情 { coinId: {price, changePercent} }
        marketTab: 'watchlist', // 币种选择器内的分类：watchlist | hot | all | defi | meme | usstock
        coinListLimit: 50,      // 列表模式显示条数
        coinListQuotes: {},      // 列表模式行情缓存 { binanceSymbol: {price, changePercent} }
        usdtToCnyRate: 7.25,    // USDT兑人民币汇率（估算）
        paperGate: 'funding',   // 模拟盘闸门：off 不过滤 | funding 费率闸门
        tradeMode: 'paper',     // 交易页模式：paper 模拟盘 | live 币安测试网
        fundingHistory: null,   // 资金费率历史缓存 { coinId, fetchedAt, list }
        fundingPercentile: null,// 逐根K线的资金费率滚动分位
        /**
         * 实时行情取不到时的记录：{ coinId, price, klines }
         * price / klines 为 null 表示该项正常，否则是给用户看的原因文案。
         * 只要有一项非空，界面就按「行情不可用」渲染 —— 见 applyQuoteUnavailable。
         */
        quoteUnavailable: null,
        /**
         * 新闻取不到时的原因文案；正常时为 null。
         * 用来区分「新闻源暂时挂了」与「这个币确实没有相关报道」——
         * 两者都表现为空列表，但该给用户的提示完全不同。
         */
        newsUnavailable: null,
        /**
         * 衍生品数据取不到时的原因文案；正常时为 null。
         * 资金费率缺失会让衍生品因子退化成常数 50，评分里必须剔除，
         * 界面上也要把这一格显示成「—」而不是一个看似中性的 50。
         */
        derivativesUnavailable: null,
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

    // 图上「还没收盘的K线」标注用的前缀。
    // 生成与解析都走这一个常量：此前两处各写一遍字面量，一旦改动不一致
    // 就会出现「点标注没反应」这种静默故障（signalInfoMap 查不到就 return）。
    pendingPrefix: '待确认·',

    // 信号详细解释字典
    signalInfoMap: {
        '强烈买入': {
            type: 'buy',
            strength: 'strong',
            strengthText: '强',
            desc: '多因子综合评分达到当前档位的强烈买入阈值，技术面、量能与情绪面形成共振，是力度最强的看多结论。',
            condition: '综合评分 ≥ 强烈买入阈值：MACD 处于多头、均线多头排列、价格站上 MA25、KDJ 金叉、RSI 未超买、量价配合良好等多项条件同时成立。',
            advice: '可考虑分批建仓，仓位相应提高。若后续出现量能萎缩或价格跌破 MA25，需及时减仓。'
        },
        '买入': {
            type: 'buy',
            strength: 'medium',
            strengthText: '中等',
            desc: '多因子综合评分达到买入阈值但未到强烈买入，多头因素占优，趋势偏多但力度中等。',
            condition: '综合评分 ≥ 买入阈值且 < 强烈买入阈值：多数技术指标偏多，量能或情绪面提供配合。',
            advice: '可轻仓试探性建仓，逢回调分批加仓；同时设好止损，避免在压力位附近追高。'
        },
        '卖出': {
            type: 'sell',
            strength: 'medium',
            strengthText: '中等',
            desc: '多因子综合评分跌破卖出阈值但未到强烈卖出，空头因素占优，需要控制仓位。',
            condition: '综合评分 ≤ 卖出阈值且 > 强烈卖出阈值：多数技术指标转空，或出现放量下跌、跌破关键支撑。',
            advice: '建议降低仓位，跌破关键支撑位需果断止损；等指标修复后再重新评估。'
        },
        '强烈卖出': {
            type: 'sell',
            strength: 'strong',
            strengthText: '强',
            desc: '多因子综合评分跌破当前档位的强烈卖出阈值，空头因素集中，属于力度最强的看空结论。',
            condition: '综合评分 ≤ 强烈卖出阈值：MACD 空头、均线空头排列、价格跌破 MA25、KDJ 死叉、RSI 超买回落、放量下跌等多项条件共振。',
            advice: '建议大幅减仓或离场观望，等待缩量企稳、指标出现修复信号后再评估重新介入。'
        },
        'MA3/MA7短期金叉': {
            type: 'buy',
            strength: 'medium',
            strengthText: '中等',
            desc: '3周期均线上穿7周期均线，是最短周期的均线交叉，能比长周期均线更早反映价格动能的转向。',
            condition: 'MA3 从下方向上穿越 MA7，说明最近几根K线的重心开始上移。',
            advice: '领先型信号，出现早但持续性弱于长周期交叉。建议配合量能与趋势指标一起判断，避免频繁反向。'
        },
        'MA3/MA7短期死叉': {
            type: 'sell',
            strength: 'medium',
            strengthText: '中等',
            desc: '3周期均线下穿7周期均线，短期动能转弱的早期提示，反应速度快于长周期均线。',
            condition: 'MA3 从上方向下穿越 MA7，说明最近几根K线的重心开始下移。',
            advice: '领先型信号，适合作为减仓预警。若长周期趋势仍向上，可先降低仓位而非清仓。'
        },
        '短期动量转强': {
            type: 'buy',
            strength: 'medium',
            strengthText: '中等',
            desc: '3周期动量指标（ROC）转正且超过自适应阈值，说明短线上行速度正在加快。',
            condition: 'N周期动量超过「近50根K线平均波动幅度 × 0.6」的阈值，该阈值会随市场波动自动调整。',
            advice: '动量类信号见效快、滞后低，但反转也快。适合用于把握入场时机，方向判断仍需趋势指标配合。'
        },
        '短期动量转弱': {
            type: 'sell',
            strength: 'medium',
            strengthText: '中等',
            desc: '3周期动量指标（ROC）转负且超过自适应阈值，说明短线下行速度正在加快。',
            condition: 'N周期动量低于「近50根K线平均波动幅度 × 0.6」的负阈值。',
            advice: '低滞后的风险预警，出现后应检查仓位与止损位，不必等到趋势指标确认再行动。'
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
    //   现货：价格与K线走公开行情镜像；合约：股票标的与衍生品走 fapi
    //
    // 美股为什么要单独一个 base：实测币安现货 exchangeInfo 共 3705 个交易对，
    // 其中股票标的 **0 个** —— 美股只在 USDT-M 合约市场（fapi）上线。
    binanceApiBase: 'https://data-api.binance.vision/api/v3',
    futuresApiBase: 'https://fapi.binance.com/fapi/v1',

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
     * 信号灵敏度档位
     *
     * 档位同时作用于两处，保证 K 线标注与实时信号口径一致：
     *   1) K线买卖点标注的因子权重与最小间隔
     *   2) 实时综合信号的分类阈值
     *
     * 档位越低（保守）→ 阈值越高、趋势项权重越大 → 信号少、滞后大、假信号少；
     * 档位越高（灵敏）→ 阈值越低、领先项权重越大 → 信号多、滞后小、假信号多。
     */
    sensitivityPresets: {
        conservative: {
            key: 'conservative',
            label: '保守',
            desc: '趋势项权重最高、阈值最严，信号最少、滞后最大，但假信号最少，适合波段操作。',
            thresholds: { strongBuy: 74, buy: 63, sell: 37, strongSell: 26 },
            minGap: 6,
            // 实测值：2023-09-01 ~ 2026-08-31，BTC+ETH 各约 3 年，信号后 6 根K线的方向命中率，
            // 已计双边 10bp 成本。零假设（混合买卖信号下瞎猜）= 50%。
            //
            // 顶层 hit/lead/netBp/n 是 **BTC+ETH 合并**后的值，界面主行显示的就是它；
            // symbols 下保留各标单单列 —— 合并会把差异平均掉：日线上 BTC 扣费后 −3.7bp
            // 而 ETH −20.7bp，只显示合并值等于把这个风险藏起来。
            //
            // 合并口径：命中率与扣费收益按信号数加权；中位滞后由两边原始 lead 序列
            // 重新求中位数（中位数不是可加统计量，两个中位数取平均没有统计含义）。
            // 复现：`node research/backtest.js`，取输出第一部分的 `BTC+ETH/` 行。
            //
            // 2026-09-23 重算：此前这里存的是**单标的 BTC**、且来自 2026-09-16 一次中间运行，
            // 09-21 修正 buildROC 未来函数后没有同步，日线一度相差 4.2pp（47.4% vs 51.57%）。
            statsByTf: {
                '1': {
                    hit: 48.02, lead: -3, netBp: -21.8, n: 4459,
                    symbols: { BTC: { hit: 48.23, netBp: -21.3, n: 2237 }, ETH: { hit: 47.79, netBp: -22.2, n: 2222 } },
                },
                '4': {
                    hit: 47.06, lead: -3, netBp: -39.2, n: 1122,
                    symbols: { BTC: { hit: 46.48, netBp: -38.9, n: 568 }, ETH: { hit: 47.65, netBp: -39.4, n: 554 } },
                },
                '24': {
                    hit: 46.89, lead: -4, netBp: -20.2, n: 177,
                    symbols: { BTC: { hit: 43.01, netBp: -56.9, n: 93 }, ETH: { hit: 51.19, netBp: 20.5, n: 84 } },
                },
            },
            weights: {
                macdPos: 6, macdHist: 5, maCross: 6, priceMa25: 5,
                maFast: 4, momentum: 5, kdj: 6, stoch: 3,
                rsiScale: 0.9, boll: 5, volume: 6,
            },
        },
        balanced: {
            key: 'balanced',
            label: '均衡',
            desc: '信号数量与滞后折中，默认档位。',
            thresholds: { strongBuy: 70, buy: 58, sell: 42, strongSell: 30 },
            minGap: 2,
            // 实测值，口径同保守档（顶层为 BTC+ETH 合并，symbols 为单标的）
            statsByTf: {
                '1': {
                    hit: 48.29, lead: -2, netBp: -21.0, n: 7987,
                    symbols: { BTC: { hit: 48.33, netBp: -21.4, n: 4024 }, ETH: { hit: 48.25, netBp: -20.6, n: 3963 } },
                },
                '4': {
                    hit: 48.82, lead: -2, netBp: -30.3, n: 1956,
                    symbols: { BTC: { hit: 48.04, netBp: -30.1, n: 945 }, ETH: { hit: 49.55, netBp: -30.3, n: 1011 } },
                },
                '24': {
                    hit: 48.25, lead: -2, netBp: -12.1, n: 315,
                    symbols: { BTC: { hit: 51.57, netBp: -3.7, n: 159 }, ETH: { hit: 44.87, netBp: -20.7, n: 156 } },
                },
            },
            weights: {
                macdPos: 5, macdHist: 5, maCross: 4, priceMa25: 3,
                maFast: 7, momentum: 8, kdj: 6, stoch: 5,
                rsiScale: 0.8, boll: 4, volume: 6,
            },
        },
        sensitive: {
            key: 'sensitive',
            label: '灵敏',
            desc: '领先因子权重最高、阈值最松，信号最多也最早，但假信号最多。',
            thresholds: { strongBuy: 66, buy: 54, sell: 46, strongSell: 34 },
            minGap: 1,
            // 实测值，口径同保守档（顶层为 BTC+ETH 合并，symbols 为单标的）
            statsByTf: {
                '1': {
                    hit: 48.12, lead: -2, netBp: -20.7, n: 9879,
                    symbols: { BTC: { hit: 47.60, netBp: -22.2, n: 5002 }, ETH: { hit: 48.66, netBp: -19.2, n: 4877 } },
                },
                '4': {
                    hit: 48.10, lead: -2, netBp: -30.5, n: 2418,
                    symbols: { BTC: { hit: 48.18, netBp: -28.5, n: 1179 }, ETH: { hit: 48.02, netBp: -32.5, n: 1239 } },
                },
                '24': {
                    hit: 47.93, lead: -2, netBp: -33.5, n: 411,
                    symbols: { BTC: { hit: 50.25, netBp: -27.0, n: 199 }, ETH: { hit: 45.75, netBp: -39.7, n: 212 } },
                },
            },
            weights: {
                macdPos: 4, macdHist: 5, maCross: 3, priceMa25: 2,
                maFast: 9, momentum: 10, kdj: 7, stoch: 7,
                rsiScale: 0.7, boll: 3, volume: 6,
            },
        },
    },

    /**
     * 取当前灵敏度档位配置
     * @returns {Object} 档位配置对象
     */
    getSensitivity() {
        return this.sensitivityPresets[this.state.sensitivity] || this.sensitivityPresets.balanced;
    },

    /**
     * 取某档位在「当前所选周期」下的实测数据
     *
     * 各周期表现差异极大（小时级基本无效、日线略好但仍不过关），
     * 用一个笼统的命中率糊过去会误导判断，所以必须跟着当前周期显示。
     *
     * @param {string} key - 档位 key
     * @returns {{hit:number|null, lead:number|null, netBp:number|null, n:number}}
     */
    getSensitivityStats(key) {
        const preset = this.sensitivityPresets[key] || this.sensitivityPresets.balanced;
        const tf = String(this.state.currentTimeframe);
        const s = preset.statsByTf && preset.statsByTf[tf];
        return s || { hit: null, lead: null, netBp: null, n: 0 };
    },

    /**
     * 模拟盘信号闸门
     *
     * 买卖点自身没有优势（实测命中率约 48%、扣费后单笔 −16.8bp、累计约 −97%），
     * 所以不让它独自决定开仓，而是叠加一个口径独立的因子当闸门：
     * 只有资金费率不处于极端拥挤时才允许成交
     * （多头拥挤时不追多，空头拥挤时不追空）。
     *
     * 实测（BTC/ETH，2023-09~2026-08，1小时，已扣双边 20bp；下方数字为两币均值）：
     *   不过滤  ：1997 轮 · 胜率 28.1% · 单笔 −16.9bp · 累计约 −97%
     *   费率闸门： 128 轮 · 胜率 51.1% · 单笔 +18.3bp · 累计 +2.4% ~ +8.4%
     * 注意：这是把「必亏」拉回「大致打平」，不是把它变成赚钱策略。
     *
     * 2026-09-21 用修正未来函数后的代码重跑（见 research/README.md 方案二），
     * 结论方向不变；另外该闸门只在 1 小时上成立，4 小时/日线不适用。
     */
    paperGates: {
        off: {
            key: 'off',
            label: '不过滤',
            desc: '买卖点全部执行，不加任何额外条件。',
            stats: { trips: 1997, win: 28.1, perTrip: -16.9, total: '约 -97%' },
        },
        funding: {
            key: 'funding',
            label: '费率闸门',
            desc: '只在资金费率不拥挤时执行：买入需费率分位 ≤33%，卖出需 ≥67%。',
            stats: { trips: 128, win: 51.1, perTrip: 18.3, total: '+2.4% ~ +8.4%' },
        },
    },

    getPaperGate() {
        return this.paperGates[this.state.paperGate] || this.paperGates.off;
    },

    /**
     * 切换闸门并立即按新规则重算模拟账户
     */
    setPaperGate(key) {
        if (!this.paperGates[key] || this.state.paperGate === key) return;
        this.state.paperGate = key;
        this.saveUIState();

        if (PaperTrader.isEnabled(this.state.currentCoin)) {
            this.syncPaperAccount();
        }
        this.renderPaperTab();
        this.showToast(`闸门已切换为「${this.getPaperGate().label}」`);
    },

    /**
     * 拉取资金费率历史（按币种缓存 10 分钟）
     *
     * 闸门需要的是「信号发生当时」的拥挤度，所以必须拿到历史序列，
     * 不能只看当前这一期费率。
     */
    async ensureFundingHistory(coinId) {
        const cached = this.state.fundingHistory;
        if (cached && cached.coinId === coinId && (Date.now() - cached.fetchedAt) < 600000) {
            return cached.list;
        }

        const binanceSymbol = this.getBinanceSymbol(coinId);
        if (!binanceSymbol) return null;

        try {
            // 必须带超时。这条请求在 loadCandleData 里被 await（且在该函数的
            // try/catch 之外），而 fapi 在部分网络下是被阻断的 —— 裸 fetch 会
            // 一直挂着不 settle，于是 loadCoinData 的 Promise.allSettled 永不返回、
            // 加载遮罩永远不消失。实测症状：K线已画出、界面却卡在「加载中」，
            // 而控制台一句报错都没有（因为请求既没成功也没失败）。
            const resp = await fetch(
                `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${binanceSymbol}&limit=500`,
                { signal: AbortSignal.timeout(15000) }
            );
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const arr = await resp.json();
            if (!Array.isArray(arr) || arr.length < 60) throw new Error('样本不足');

            const list = arr
                .map(x => ({ t: Math.floor(Number(x.fundingTime) / 1000), rate: parseFloat(x.fundingRate) }))
                .filter(x => isFinite(x.t) && isFinite(x.rate))
                .sort((a, b) => a.t - b.t);

            this.state.fundingHistory = { coinId, fetchedAt: Date.now(), list };
            return list;
        } catch (e) {
            console.warn('[闸门] 资金费率历史获取失败:', e.message);
            return null;
        }
    },

    /**
     * 逐根K线计算资金费率的滚动分位（90 天窗口）
     *
     * 只用该K线开盘之前已结算的费率，避免把未来信息算进闸门。
     */
    computeFundingPercentile() {
        const hist = this.state.fundingHistory;
        const candles = this.state.candleData;

        if (!hist || !hist.list || !candles || !candles.length) {
            this.state.fundingPercentile = null;
            return null;
        }

        const list = hist.list;
        const windowSec = 90 * 24 * 3600;
        const out = new Array(candles.length).fill(NaN);
        let j = 0;

        for (let i = 0; i < candles.length; i++) {
            // 注意：应用内的K线字段是 time（秒），不是 t
            const ct = candles[i].time;
            if (!isFinite(ct)) continue;

            while (j + 1 < list.length && list[j + 1].t <= ct) j++;
            if (!(list[j] && list[j].t <= ct)) continue;

            const cur = list[j].rate;
            const from = ct - windowSec;
            const win = [];
            for (let k = j; k >= 0; k--) {
                if (list[k].t < from) break;
                win.push(list[k].rate);
            }
            if (win.length < 30) continue;

            win.sort((a, b) => a - b);
            let below = 0;
            for (const v of win) if (v <= cur) below++;
            out[i] = below / win.length;
        }

        this.state.fundingPercentile = out;
        return out;
    },

    /**
     * 构造闸门判定函数
     *
     * 拿不到拥挤度时一律拒绝开仓——宁可错过，也不在信息缺失时下注。
     * 返回 null 表示不过滤。
     */
    buildPaperGateFilter() {
        const gate = this.getPaperGate();
        if (gate.key === 'off') return null;

        const pct = this.state.fundingPercentile;
        if (!pct) return null;

        return (m) => {
            // 买卖点序列里的下标字段是 index（与回测脚本里的 i 不同名）
            const idx = (m.index !== undefined) ? m.index : m.i;
            const p = pct[idx];
            if (!isFinite(p)) return false;
            return m.side === 'buy' ? p <= 0.33 : p >= 0.67;
        };
    },

    /**
     * 渲染闸门选择器与实测说明
     */
    renderPaperGate() {
        const host = document.getElementById('paperGateControl');
        if (!host) return;

        const cur = this.getPaperGate();
        host.querySelectorAll('.gate-btn').forEach(btn => {
            const on = btn.dataset.gate === cur.key;
            btn.className = 'gate-btn flex-1 py-1.5 rounded-md text-[11px] transition-colors ' +
                (on ? 'bg-white text-text-primary font-semibold shadow-sm' : 'text-text-secondary');
        });

        const info = document.getElementById('paperGateInfo');
        if (info) {
            const s = cur.stats;
            const per = (s.perTrip > 0 ? '+' : '') + s.perTrip + 'bp';
            info.textContent = `${cur.desc}　实测 ${s.trips} 轮 · 胜率 ${s.win}% · 单笔 ${per} · 累计 ${s.total}`;
        }
    },

    /**
     * 切换灵敏度档位
     *
     * 会同时重算 K 线买卖点标注与实时综合信号，保证两处口径一致。
     * 切换不写入预测记录，避免来回切换污染准确率统计。
     *
     * @param {string} key - conservative | balanced | sensitive
     */
    applySensitivity(key) {
        if (!this.sensitivityPresets[key]) return;
        if (this.state.sensitivity === key) return;

        this.state.sensitivity = key;
        this.renderSensitivity();
        this.saveUIState();

        // 重算K线买卖点标注（权重与最小间隔随档位变化）
        this.addSignalMarkers();

        // 重算实时信号（分类阈值随档位变化）
        if (this.state.indicators && this.state.indicators.macd) {
            this.updateSignal(true);
        }

        const p = this.getSensitivity();
        const st = this.getSensitivityStats(p.key);
        const tfLabel = this.getTimeframeConfig(this.state.currentTimeframe).label;
        this.showToast(st.hit === null
            ? `已切换为「${p.label}」`
            : `已切换为「${p.label}」：${tfLabel}实测命中率 ${st.hit}%，中位滞后 ${Math.abs(st.lead)} 根`);
    },

    /**
     * 渲染灵敏度档位的选中态、说明文案与当前生效阈值
     */
    renderSensitivity() {
        const preset = this.getSensitivity();

        document.querySelectorAll('#sensitivityControl .sens-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.sensitivity === preset.key);
        });

        const descEl = document.getElementById('sensitivityDesc');
        if (descEl) descEl.textContent = preset.desc;

        const thEl = document.getElementById('sensitivityThresholds');
        if (thEl) {
            const t = preset.thresholds;
            thEl.textContent = `买入≥${t.buy}　卖出≤${t.sell}`;
        }

        this.renderSensitivityStats(preset.key);
    },

    /**
     * 渲染三档实测对比表（跟随当前所选周期）
     *
     * 数据来自 research/backtest.js 的三年回测，直接把真实成绩标在界面上，
     * 避免用一个好看的旧数字让人误以为信号可用。
     *
     * @param {string} activeKey - 当前档位
     */
    renderSensitivityStats(activeKey) {
        const host = document.getElementById('sensitivityStats');
        if (!host) return;

        const keys = ['conservative', 'balanced', 'sensitive'];
        const tfLabel = this.getTimeframeConfig(this.state.currentTimeframe).label;
        // 单标的单元格：该标的的命中率 / 扣费后收益
        const symCell = (s, name) => {
            const d = s.symbols && s.symbols[name];
            if (!d) return '--';
            return `${d.hit.toFixed(1)}% / ${d.netBp.toFixed(1)}bp`;
        };

        const rows = [
            { label: '信号数', unit: '个', get: s => s.n },
            { label: '命中率', unit: '%', get: s => (s.hit === null ? '--' : s.hit) },
            { label: '中位滞后', unit: '根', get: s => (s.lead === null ? '--' : Math.abs(s.lead)) },
            { label: '扣费后', unit: 'bp', get: s => (s.netBp === null ? '--' : s.netBp) },
            // 上四行是 BTC+ETH 合并值；下面两行保留单标的 ——
            // 合并会把两个标的的差异平均掉，而日线上两者差 20bp，不该被藏起来
            {
                label: 'BTC 命中/扣费', unit: '', get: s => symCell(s, 'BTC'),
                redWhen: s => !!(s.symbols && s.symbols.BTC && s.symbols.BTC.netBp < 0),
            },
            {
                label: 'ETH 命中/扣费', unit: '', get: s => symCell(s, 'ETH'),
                redWhen: s => !!(s.symbols && s.symbols.ETH && s.symbols.ETH.netBp < 0),
            },
        ];

        const baseHit = this.getSensitivityStats('balanced').hit;

        const head = keys.map(k => {
            const p = this.sensitivityPresets[k];
            const on = k === activeKey;
            return `<th class="py-1 font-normal ${on ? 'text-golden' : 'text-text-tertiary'}">${p.label}</th>`;
        }).join('');

        const body = rows.map(row => {
            const cells = keys.map(k => {
                const s = this.getSensitivityStats(k);
                const on = k === activeKey;
                let cls = on ? 'text-text-primary font-semibold' : 'text-text-secondary';

                // 命中率：低于瞎猜水平(50%)标红，不做好看的着色
                if (row.label === '命中率' && s.hit !== null && baseHit !== null) {
                    cls = s.hit >= 50 ? 'text-text-primary' : 'text-fall-red';
                }
                // 扣费后期望为负，一律标红
                if (row.label === '扣费后' && s.netBp !== null && s.netBp < 0) {
                    cls = 'text-fall-red';
                }
                // 单标的一行同理：该标的扣费后为负就标红
                if (row.redWhen && row.redWhen(s)) {
                    cls = 'text-fall-red';
                }

                return `<td class="py-0.5 text-center tabular-nums ${cls}">${row.get(s)}<span class="text-[9px] ml-0.5">${row.unit}</span></td>`;
            }).join('');

            return `<tr class="border-t border-border-light">
                <td class="py-0.5 pl-1 text-text-tertiary">${row.label}</td>
                ${cells}
            </tr>`;
        }).join('');

        host.innerHTML = `
            <div class="rounded-lg border border-border-light overflow-hidden">
                <table class="w-full text-[10px]">
                    <thead>
                        <tr class="bg-gray-50">
                            <th class="py-1 pl-1 text-left font-normal text-text-tertiary">${tfLabel}实测</th>
                            ${head}
                        </tr>
                    </thead>
                    <tbody>${body}</tbody>
                </table>
            </div>
            <p class="text-[9px] text-text-tertiary mt-1 leading-tight">
                ${tfLabel}：BTC+ETH 2023-09~2026-08 回测（前四行为两标的合并值，末两行为单标的），
                判据为信号后 6 根K线的方向命中率，已计双边 10bp 成本。
                三档命中率都在 50% 附近或以下（即瞎猜水平），扣费后期望为负；信号中位滞后 2~3 根K线。
                注意日线上 BTC 与 ETH 差别明显（扣费后 −3.7bp / −20.7bp），合并值会把这个差异平均掉。
                结论：该信号不具备可盈利的提前预测力，仅供形态参考。
            </p>
        `;
    },

    // ==================== 模拟自动交易 ====================

    /**
     * 初始化模拟交易：绑定交互并渲染
     */
    initPaper() {
        const toggle = document.getElementById('paperToggle');
        if (toggle) {
            toggle.addEventListener('click', () => this.togglePaperTrade());
        }

        // 闸门切换
        const gateHost = document.getElementById('paperGateControl');
        if (gateHost) {
            gateHost.addEventListener('click', (e) => {
                const btn = e.target.closest('.gate-btn');
                if (btn && btn.dataset.gate) this.setPaperGate(btn.dataset.gate);
            });
            this.renderPaperGate();
        }

        const saveTotal = document.getElementById('paperSaveTotalBtn');
        if (saveTotal) {
            saveTotal.addEventListener('click', () => this.savePaperTotal());
        }

        const totalInput = document.getElementById('paperTotalCapital');
        if (totalInput) {
            totalInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this.savePaperTotal();
            });
        }

        const saveAlloc = document.getElementById('paperSaveAllocBtn');
        if (saveAlloc) {
            saveAlloc.addEventListener('click', () => this.savePaperAllocation());
        }

        const allocInput = document.getElementById('paperAllocInput');
        if (allocInput) {
            allocInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this.savePaperAllocation();
            });
        }

        const resetBtn = document.getElementById('paperResetBtn');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                const coin = this.getCoinInfo(this.state.currentCoin);
                if (!confirm(`确定重置 ${coin.symbol} 的模拟账户？成交记录与持仓都会清空，资金回到配额值。`)) return;

                PaperTrader.reset(this.state.currentCoin);
                this.renderPaperTab();
                this.showToast(`${coin.symbol} 模拟账户已重置`);
            });
        }

        const clearBtn = document.getElementById('paperClearBtn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                const coin = this.getCoinInfo(this.state.currentCoin);
                if (!confirm(`确定取消 ${coin.symbol} 的配额？该币种的开关、成交记录与持仓都会清除。`)) return;

                PaperTrader.clearAllocation(this.state.currentCoin);
                this.renderPaperTab();
                this.showToast(`已取消 ${coin.symbol} 的配额`);
            });
        }

        // ---- 后端同步 ----
        const syncUrl = document.getElementById('paperSyncUrl');
        const syncAccount = document.getElementById('paperSyncAccount');
        const syncCfg = PaperTrader.getSyncConfig();
        if (syncUrl) syncUrl.value = syncCfg.url || '';
        if (syncAccount) syncAccount.value = syncCfg.account || 'default';

        const syncSaveBtn = document.getElementById('paperSyncSaveBtn');
        if (syncSaveBtn) {
            syncSaveBtn.addEventListener('click', async () => {
                const res = PaperTrader.setSyncConfig(
                    syncUrl ? syncUrl.value : '',
                    syncAccount ? syncAccount.value.trim() : ''
                );
                if (!res.ok) {
                    this.showToast(res.message);
                    return;
                }

                const cfg = PaperTrader.getSyncConfig();
                if (syncUrl) syncUrl.value = cfg.url;
                if (syncAccount) syncAccount.value = cfg.account;

                if (!cfg.url) {
                    this.renderPaperSync();
                    this.showToast('已关闭后端同步');
                    return;
                }

                // 存完立刻探一次后端：地址填错了要当场知道，而不是等下一次自动推送
                await PaperTrader.pullFromBackend();
                PaperTrader.schedulePush();
                this.renderPaperSync();
                this.showToast(PaperTrader.sync.status === 'ok' ? '后端已连接' : '连接失败，见下方状态');
            });
        }

        const syncPushBtn = document.getElementById('paperSyncPushBtn');
        if (syncPushBtn) {
            syncPushBtn.addEventListener('click', async () => {
                if (!PaperTrader.getSyncConfig().url) {
                    this.showToast('请先填写后端地址并保存');
                    return;
                }
                const r = await PaperTrader.pushToBackend();
                this.renderPaperSync();
                this.showToast(r ? '已同步到后端' : '同步失败：' + PaperTrader.sync.message);
            });
        }

        // PaperTrader 在后台完成同步后会回调这里刷新角标
        PaperTrader.onSyncChange = () => this.renderPaperSync();
        this.renderPaperSync();

        // 启动时拉一次后端。不 await —— 拉不到就用本机数据，界面不该等它。
        PaperTrader.initSync().catch(() => {});

        this.renderPaperTab();
    },

    /**
     * 渲染后端同步状态。
     *
     * 角标四种状态：未启用（灰）/ 同步中（灰）/ 已连接（绿）/ 未连接（红）。
     * 连不上时把启动命令一起写在提示里 —— 这个功能唯一的失败原因就是服务没起。
     */
    renderPaperSync() {
        const tag = document.getElementById('paperSyncTag');
        if (!tag) return;

        const s = PaperTrader.sync || { status: 'off', message: '', lastSyncAt: null };
        const labels = { off: '未启用', ok: '已连接', syncing: '同步中', error: '未连接' };

        tag.textContent = labels[s.status] || s.status;
        tag.className = 'text-[10px] px-1.5 py-0.5 rounded-full ' + (
            s.status === 'ok' ? 'bg-green-100 text-rise-green'
                : s.status === 'error' ? 'bg-red-100 text-fall-red'
                    : 'bg-gray-200 text-text-secondary');

        const hint = document.getElementById('paperSyncHint');
        if (!hint) return;

        const cfg = PaperTrader.getSyncConfig();
        const parts = [];

        if (!cfg.url) {
            parts.push('未启用。启动服务后把 http://127.0.0.1:8788 填到上面并保存');
            parts.push('启动命令：node server/store.js');
        } else {
            if (s.message) parts.push(s.message);
            if (s.lastSyncAt) {
                const d = new Date(s.lastSyncAt);
                parts.push('最后同步 ' + (isNaN(d.getTime()) ? s.lastSyncAt
                    : [d.getHours(), d.getMinutes(), d.getSeconds()]
                        .map(n => String(n).padStart(2, '0')).join(':')));
            }
            parts.push(`${cfg.url} · 账号 ${cfg.account}`);
        }

        hint.textContent = parts.filter(Boolean).join('　·　');
    },

    /**
     * 切换当前币种的独立运行开关
     */
    togglePaperTrade() {
        const coinId = this.state.currentCoin;
        const coin = this.getCoinInfo(coinId);
        const on = !PaperTrader.isEnabled(coinId);

        const res = PaperTrader.setEnabled(coinId, on, this.state.currentTimeframe);
        if (!res.ok) {
            this.showToast(res.message);
            const input = document.getElementById('paperAllocInput');
            if (input) input.focus();
            return;
        }

        if (on) {
            // 开启后立刻回放一次，把「开启之后才成交的买卖点」补上。
            //
            // 注意这里不是「把历史上出现过的信号都补记」—— PaperTrader.setEnabled
            // 会把 enabledAt 设成此刻，而回放只认成交时刻晚于 enabledAt 的点。
            // 所以刚开启时账户通常还是空的，得等下一个买卖点收盘成交。
            this.syncPaperAccount();
        }

        this.renderPaperTab();
        const tfLabel = this.getTimeframeConfig(this.state.currentTimeframe).label;
        this.showToast(on
            ? `${coin.symbol} 已开始模拟：${tfLabel}的信号收盘后，按下一根开盘价成交`
            : `${coin.symbol} 已停止模拟`);
    },

    /**
     * 保存总资金
     */
    savePaperTotal() {
        const input = document.getElementById('paperTotalCapital');
        if (!input) return;

        const raw = input.value;
        if (raw === '') {
            this.showToast('请填写总资金');
            return;
        }

        const res = PaperTrader.setTotalCapital(raw);
        if (!res.ok) {
            this.showToast(res.message);
            input.value = PaperTrader.getTotalCapital();
            return;
        }

        this.renderPaperTab();
        this.showToast(`总资金已设为 ${PaperTrader.formatAmount(raw)} USDT`);
    },

    /**
     * 保存当前币种的配额
     *
     * 配额变化会重置该币种账户，已有成交记录时先确认再执行。
     */
    savePaperAllocation() {
        const input = document.getElementById('paperAllocInput');
        if (!input) return;

        const coinId = this.state.currentCoin;
        const coin = this.getCoinInfo(coinId);
        const raw = input.value;

        if (raw === '') {
            this.showToast('请填写配额金额');
            return;
        }

        const existing = PaperTrader.getAccount(coinId).trades.length;
        const changed = PaperTrader.getAllocation(coinId) !== Number(raw);
        if (existing > 0 && changed) {
            const ok = confirm(`修改配额会重置 ${coin.symbol} 的模拟账户，现有 ${existing} 笔成交记录将被清空。确定继续？`);
            if (!ok) {
                input.value = PaperTrader.getAllocation(coinId) || '';
                return;
            }
        }

        const res = PaperTrader.setAllocation(coinId, raw);
        if (!res.ok) {
            this.showToast(res.message);
            return;
        }

        this.renderPaperTab();
        this.showToast(res.reset
            ? `${coin.symbol} 配额已设为 ${PaperTrader.formatAmount(raw)} USDT，账户已重置`
            : `${coin.symbol} 配额未变化`);
    },

    /**
     * 解析某币种的最新价，用于计算持仓市值
     * 拿不到价格时返回 0，由 PaperTrader 退化为该账户最后一笔成交价。
     *
     * 注意：必须校验行情归属的币种。行情是异步写入的，切币瞬间
     * state.coinInfo 可能仍是上一个币种的数据，若不校验就会用错价格，
     * 导致收益率算出天文数字。
     *
     * @param {string} coinId
     * @returns {number}
     */
    resolvePaperPrice(coinId) {
        if (!coinId) return 0;

        // 当前正在查看的币种用实时价（需确认该行情确实属于这个币种）
        const info = this.state.coinInfo;
        if (coinId === this.state.currentCoin && info && info.id === coinId) {
            const p = Number(info.current_price);
            if (isFinite(p) && p > 0) return p;
        }

        // 自选行情缓存（同样校验币种，避免串价）
        const q = this.state.watchlistQuotes && this.state.watchlistQuotes[coinId];
        if (q && q.coinId === coinId) {
            const p = Number(q.price);
            if (isFinite(p) && p > 0) return p;
        }

        return 0;
    },

    /**
     * 渲染模拟交易页：总资金账户 + 当前币种账户 + 币种概览 + 成交记录
     */
    renderPaperTab() {
        const coinId = this.state.currentCoin;
        const price = this.resolvePaperPrice(coinId);

        this.renderPaperGate();

        const portfolio = PaperTrader.getPortfolio(id => this.resolvePaperPrice(id));
        const m = PaperTrader.getMetrics(coinId, price);

        this.renderPaperPortfolio(portfolio);
        this.renderPaperCoinAccount(m);
        this.renderPaperCoinList(portfolio);
        this.renderPaperTrades(m.trades);
    },

    /**
     * 渲染总资金账户
     */
    renderPaperPortfolio(p) {
        const runningEl = document.getElementById('paperRunningCount');
        if (runningEl) {
            const on = p.runningCount > 0;
            runningEl.textContent = on ? `运行中 ${p.runningCount} 个` : '全部停止';
            runningEl.className = on
                ? 'text-[10px] px-1.5 py-0.5 rounded-full bg-rise-green/10 text-rise-green font-medium'
                : 'text-[10px] px-1.5 py-0.5 rounded-full bg-gray-200 text-text-secondary';
        }

        const eqEl = document.getElementById('paperPortfolioEquity');
        if (eqEl) {
            eqEl.textContent = p.equity.toLocaleString('en-US', { maximumFractionDigits: 2 });
        }

        const retEl = document.getElementById('paperPortfolioReturn');
        if (retEl) {
            if (p.allocated > 0) {
                retEl.textContent = this.formatSignedPct(p.totalReturn);
                retEl.className = `text-sm font-semibold tabular-nums ${this.pnlClass(p.totalReturn)}`;
            } else {
                retEl.textContent = '--';
                retEl.className = 'text-sm font-semibold tabular-nums text-text-tertiary';
            }
        }

        this.setText('paperPortfolioHint', p.allocated > 0
            ? `已配额 ${PaperTrader.formatAmount(p.allocated)} USDT 的合计盈亏 · 占 ${(p.usedRatio * 100).toFixed(1)}%`
            : '尚未给任何币种分配配额');

        this.setText('paperAllocated', PaperTrader.formatAmount(p.allocated));
        this.setText('paperIdle', PaperTrader.formatAmount(p.idle));
        this.setText('paperCoinCount', `${p.coinCount} 个`);

        // 总资金输入框：正在输入时不同步，避免打断
        const input = document.getElementById('paperTotalCapital');
        if (input && document.activeElement !== input) {
            input.value = p.totalCapital;
        }
    },

    /**
     * 渲染当前币种的独立账户
     */
    renderPaperCoinAccount(m) {
        const coinId = this.state.currentCoin;
        const coin = this.getCoinInfo(coinId);
        const allocation = PaperTrader.getAllocation(coinId);
        const enabled = PaperTrader.isEnabled(coinId);

        this.setText('paperScope', `${coin.symbol}/USDT`);

        // 状态标签：未配额 / 运行中 / 已停止
        const tag = document.getElementById('paperStatusTag');
        if (tag) {
            if (!allocation) {
                tag.textContent = '未配额';
                tag.className = 'text-[10px] px-1.5 py-0.5 rounded-full bg-gray-200 text-text-secondary';
            } else if (enabled) {
                tag.textContent = '运行中';
                tag.className = 'text-[10px] px-1.5 py-0.5 rounded-full bg-rise-green/10 text-rise-green font-medium';
            } else {
                tag.textContent = '已停止';
                tag.className = 'text-[10px] px-1.5 py-0.5 rounded-full bg-gray-200 text-text-secondary';
            }
        }

        // 成交依据就是图上当前周期标注的买卖点，切周期会按新周期重算。
        // 执行时点必须写清楚：图上正在走的那根K线上的信号只是「待确认」，
        // 要等它收盘才成立，成交价取下一根K线的开盘价。
        const stratTf = PaperTrader.getAccount(coinId).strategyTimeframe;
        const hasTf = stratTf !== undefined && stratTf !== null;
        this.setText('paperStrategyTf', (enabled && hasTf)
            ? `按 ${this.getTimeframeConfig(stratTf).label} 的K线买卖点成交 · 图上「待确认」的信号要等收盘后才执行`
            : '开启后按当前所选周期成交 · 信号收盘成立后，按下一根K线开盘价成交');

        // 开关外观
        const toggle = document.getElementById('paperToggle');
        if (toggle) {
            toggle.classList.toggle('bg-rise-green', enabled);
            toggle.classList.toggle('bg-gray-200', !enabled);
            toggle.setAttribute('aria-checked', enabled ? 'true' : 'false');
        }

        const knob = document.getElementById('paperToggleKnob');
        if (knob) {
            knob.style.transform = enabled ? 'translateX(20px)' : 'translateX(0)';
        }

        // 配额输入框
        // 同一币种刷新时不动输入框，避免打断正在输入的内容；
        // 但切换币种必须强制同步，否则上一个币种填的数字会留在框里，
        // 用户一点「应用」就会把金额配到错误的币种上。
        const coinChanged = this._paperRenderedCoin !== coinId;
        this._paperRenderedCoin = coinId;

        const allocInput = document.getElementById('paperAllocInput');
        if (allocInput && (coinChanged || document.activeElement !== allocInput)) {
            allocInput.value = allocation > 0 ? allocation : '';
            if (coinChanged) allocInput.blur();
        }

        const available = Math.max(
            0,
            PaperTrader.getTotalCapital() - PaperTrader.getAllocatedTotal(coinId)
        );
        this.setText('paperAllocHint', allocation > 0
            ? `当前配额 ${PaperTrader.formatAmount(allocation)} USDT · 还可调配 ${PaperTrader.formatAmount(available)} USDT`
            : `本币尚未配额 · 最多可分配 ${PaperTrader.formatAmount(available)} USDT`);

        // 资产与收益
        this.setText('paperEquity', m.equity.toLocaleString('en-US', { maximumFractionDigits: 2 }));
        this.setText('paperCash', m.cash.toLocaleString('en-US', { maximumFractionDigits: 2 }));

        const retEl = document.getElementById('paperTotalReturn');
        if (retEl) {
            if (m.initialCapital > 0) {
                retEl.textContent = this.formatSignedPct(m.totalReturn);
                retEl.className = `text-sm font-semibold tabular-nums ${this.pnlClass(m.totalReturn)}`;
            } else {
                retEl.textContent = '--';
                retEl.className = 'text-sm font-semibold tabular-nums text-text-tertiary';
            }
        }

        // 持仓状态
        const posEl = document.getElementById('paperPositionText');
        if (posEl) {
            posEl.textContent = m.holding
                ? `持仓 ${m.holdings.toFixed(6)} · 浮盈 ${this.formatSignedPct(m.unrealizedPct)}`
                : '空仓';
        }

        // 同期买入持有
        const holdEl = document.getElementById('paperHoldReturn');
        if (holdEl) {
            if (m.holdReturn === null) {
                holdEl.textContent = '--';
                holdEl.className = 'text-sm font-semibold tabular-nums mt-0.5 text-text-tertiary';
            } else {
                holdEl.textContent = this.formatSignedPct(m.holdReturn);
                holdEl.className = `text-sm font-semibold tabular-nums mt-0.5 ${this.pnlClass(m.holdReturn)}`;
            }
        }

        // 相对超额
        const exEl = document.getElementById('paperExcess');
        if (exEl) {
            if (m.excessReturn === null) {
                exEl.textContent = '--';
                exEl.className = 'text-sm font-semibold tabular-nums mt-0.5 text-text-tertiary';
            } else {
                exEl.textContent = this.formatSignedPct(m.excessReturn);
                exEl.className = `text-sm font-semibold tabular-nums mt-0.5 ${this.pnlClass(m.excessReturn)}`;
            }
        }

        // 四格统计
        this.setText('paperRoundTrips', String(m.roundTrips));

        const winEl = document.getElementById('paperWinRate');
        if (winEl) {
            if (m.winRate === null) {
                winEl.textContent = '--';
                winEl.className = 'text-sm font-semibold mt-0.5 text-text-tertiary';
            } else {
                winEl.textContent = `${(m.winRate * 100).toFixed(0)}%`;
                winEl.className = `text-sm font-semibold mt-0.5 ${m.winRate >= 0.5 ? 'text-rise-green' : 'text-fall-red'}`;
            }
        }

        const reEl = document.getElementById('paperRealized');
        if (reEl) {
            reEl.textContent = m.roundTrips ? this.formatSignedUsd(m.realized) : '--';
            reEl.className = `text-sm font-semibold mt-0.5 ${m.roundTrips ? this.pnlClass(m.realized) : 'text-text-tertiary'}`;
        }

        const ddEl = document.getElementById('paperMaxDd');
        if (ddEl) {
            ddEl.textContent = m.trades.length ? `${(m.maxDrawdown * 100).toFixed(1)}%` : '--';
            ddEl.className = 'text-sm font-semibold mt-0.5 text-text-primary';
        }
    },

    /**
     * 渲染已配额币种列表（点击可切换币种）
     */
    renderPaperCoinList(portfolio) {
        const host = document.getElementById('paperCoinList');
        if (!host) return;

        if (!portfolio.items.length) {
            host.innerHTML = `<p class="py-6 text-center text-xs text-text-tertiary leading-relaxed">
                还没有为任何币种分配配额。<br>在上方填写金额并应用，即可开始独立模拟。
            </p>`;
            return;
        }

        host.innerHTML = portfolio.items.map(it => {
            const coin = this.getCoinInfo(it.coinId);
            const active = it.coinId === this.state.currentCoin;
            const dot = it.enabled
                ? '<span class="w-1.5 h-1.5 rounded-full bg-rise-green flex-shrink-0"></span>'
                : '<span class="w-1.5 h-1.5 rounded-full bg-gray-300 flex-shrink-0"></span>';

            const meta = [`配额 ${PaperTrader.formatAmount(it.allocation)}`];
            if (it.holding) meta.push('持仓中');
            if (it.roundTrips) meta.push(`${it.roundTrips} 轮`);

            return `
                <button data-paper-coin="${it.coinId}" class="w-full py-2.5 flex items-center justify-between gap-3 text-left ${active ? 'bg-golden/5' : ''}">
                    <div class="flex items-center gap-2 min-w-0">
                        ${dot}
                        <div class="min-w-0">
                            <p class="text-xs font-medium truncate ${active ? 'text-golden' : ''}">${coin.symbol}/USDT</p>
                            <p class="text-[10px] text-text-tertiary mt-0.5 tabular-nums truncate">${meta.join(' · ')}</p>
                        </div>
                    </div>
                    <div class="text-right flex-shrink-0">
                        <p class="text-xs tabular-nums font-medium">${it.equity.toLocaleString('en-US', { maximumFractionDigits: 0 })}</p>
                        <p class="text-[10px] tabular-nums mt-0.5 ${this.pnlClass(it.totalReturn)}">${this.formatSignedPct(it.totalReturn)}</p>
                    </div>
                </button>
            `;
        }).join('');

        host.querySelectorAll('[data-paper-coin]').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.paperCoin;
                if (id === this.state.currentCoin) return;
                this.switchCoin(id);
            });
        });
    },

    /**
     * 渲染买卖记录列表
     */
    renderPaperTrades(trades) {
        const host = document.getElementById('paperTradeList');
        if (!host) return;

        const countEl = document.getElementById('paperTradeCount');
        if (countEl) countEl.textContent = trades.length ? `共 ${trades.length} 笔` : '';

        if (!trades.length) {
            const coinId = this.state.currentCoin;
            const enabled = PaperTrader.isEnabled(coinId);
            const allocation = PaperTrader.getAllocation(coinId);

            let emptyText;
            if (!allocation) {
                emptyText = '本币尚未配额，先在上方填写金额并应用';
            } else if (enabled) {
                // 说清为什么可能「开着却一笔都没有」：信号要等收盘，且成交价取下一根开盘
                emptyText = '已开启，暂无成交。信号要等该K线收盘才成立，按下一根K线开盘价成交，等下一次方向变化';
            } else {
                emptyText = '本币已停止运行，打开开关后开始记录';
            }

            host.innerHTML = `<p class="py-6 text-center text-xs text-text-tertiary leading-relaxed">${emptyText}</p>`;
            return;
        }

        host.innerHTML = trades.slice().reverse().map(t => {
            const isBuy = t.side === 'buy';
            const sideCls = isBuy
                ? 'text-rise-green bg-rise-green/10'
                : 'text-fall-red bg-fall-red/10';

            const amount = t.amount.toLocaleString('en-US', { maximumFractionDigits: 2 });

            // 账户按币种记账，同一币种可能被不同周期的信号触发，标注出来便于分辨
            const tfLabel = (t.timeframe !== undefined && t.timeframe !== null)
                ? this.getTimeframeConfig(t.timeframe).label
                : '';
            // 成交时刻 = 信号K线收盘 = 下一根K线开盘，比图上箭头所在的那根K线晚一格。
            // 两个时间都列出来，免得看记录时以为「成交时间和图上箭头对不上」。
            const whenText = (typeof t.signalTime === 'number' && t.signalTime !== t.time)
                ? `信号 ${this.formatPredictionTime(t.signalTime)} → 成交 ${this.formatPredictionTime(t.time)}`
                : this.formatPredictionTime(t.time);
            const meta = [
                whenText,
                tfLabel,
                t.signalText || '--'
            ].filter(Boolean).join(' · ');

            // 卖出才有已实现盈亏
            const pnlHtml = (!isBuy && typeof t.pnl === 'number')
                ? `<p class="text-[10px] mt-0.5 ${this.pnlClass(t.pnl)}">${this.formatSignedUsd(t.pnl)}</p>`
                : '';

            return `
                <div class="py-2.5 flex items-start justify-between gap-3">
                    <div class="flex items-start gap-2 min-w-0">
                        <span class="text-[10px] px-1.5 py-0.5 rounded ${sideCls} flex-shrink-0 mt-0.5">${isBuy ? '买入' : '卖出'}</span>
                        <div class="min-w-0">
                            <p class="text-xs font-medium tabular-nums">$${TechnicalAnalysis.formatPrice(t.price)}</p>
                            <p class="text-[10px] text-text-tertiary mt-0.5 truncate">${meta}</p>
                        </div>
                    </div>
                    <div class="text-right flex-shrink-0">
                        <p class="text-xs tabular-nums">${amount}</p>
                        ${pnlHtml}
                    </div>
                </div>
            `;
        }).join('');
    },

    /**
     * 盈亏配色：正绿负红
     */
    pnlClass(v) {
        if (v > 0) return 'text-rise-green';
        if (v < 0) return 'text-fall-red';
        return 'text-text-secondary';
    },

    /**
     * 带符号百分比
     */
    formatSignedPct(v) {
        if (v === null || v === undefined || !isFinite(v)) return '--';
        return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;
    },

    /**
     * 带符号金额
     */
    formatSignedUsd(v) {
        if (v === null || v === undefined || !isFinite(v)) return '--';
        const abs = Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
        return `${v >= 0 ? '+' : '-'}$${abs}`;
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
                    this.tagTokenizedStocks();
                    return;
                }
            } catch (e) { /* 忽略缓存损坏 */ }
        }

        this.state.catalogLoading = true;

        try {
            // 全量币种目录体积很大（约 8MB），超时给得比其它请求宽松；
            // 即便超时失败也没关系 —— 目录有本地缓存，只是这次不刷新。
            const resp = await fetch(`${this.binanceApiBase}/exchangeInfo`, { signal: AbortSignal.timeout(45000) });
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
            this.tagTokenizedStocks();

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
        // 美股走合约市场，不能塞进现货的批量行情请求里：
        // 一个现货接口不认识的交易对会让整批请求失败，其它币种也一起拿不到价格。
        const stockSymbols = this.state.watchlist
            .filter(id => this.isStock(id))
            .map(id => this.getBinanceSymbol(id))
            .filter(Boolean);
        const symbols = this.state.watchlist
            .filter(id => !this.isStock(id))
            .map(id => this.getBinanceSymbol(id))
            .filter(Boolean);

        if (stockSymbols.length > 0) this.loadWatchlistStockQuotes(stockSymbols);
        if (symbols.length === 0) return;

        try {
            const query = encodeURIComponent(JSON.stringify(symbols));
            const resp = await fetch(`${this.binanceApiBase}/ticker/24hr?symbols=${query}`, { signal: AbortSignal.timeout(15000) });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();

            const quotes = {};
            const arr = Array.isArray(data) ? data : [data];
            arr.forEach(t => {
                const coinId = this.state.watchlist.find(id => this.getBinanceSymbol(id) === t.symbol);
                if (coinId) {
                    quotes[coinId] = {
                        coinId,
                        price: parseFloat(t.lastPrice),
                        changePercent: parseFloat(t.priceChangePercent)
                    };
                }
            });
            // 合并而不是覆盖：自选里可能同时有现货币种与美股，
            // 直接赋值会把另一边的行情抹掉，界面上表现为「刚才还有价格，刷一下就没了」。
            this.state.watchlistQuotes = Object.assign({}, this.state.watchlistQuotes, quotes);
            // 若币种选择器打开，同步刷新
            const modal = document.getElementById('coinSelectorModal');
            if (modal && !modal.classList.contains('hidden')) {
                this.renderCoinSelectorList();
            }
        } catch (e) {
            console.warn('自选行情加载失败:', e.message);
        }
    },

    /**
     * 自选里的美股行情。
     * 走合约的全量快照后在本地筛，理由见 loadStockQuotes。
     */
    async loadWatchlistStockQuotes(symbols) {
        if (typeof Stocks === 'undefined' || !symbols.length) return;
        try {
            const map = await Stocks.allTickers();
            const patch = {};
            const listQuotes = {};
            symbols.forEach(sym => {
                const t = map[sym];
                if (!t) return;
                const coinId = this.state.watchlist.find(id => this.getBinanceSymbol(id) === sym);
                if (!coinId) return;
                patch[coinId] = {
                    coinId,
                    price: t.current_price,
                    changePercent: t.price_change_percentage_24h,
                };
                listQuotes[sym] = {
                    price: t.current_price,
                    changePercent: t.price_change_percentage_24h,
                    quoteVolume: t.quote_volume,
                };
            });
            this.state.watchlistQuotes = Object.assign({}, this.state.watchlistQuotes, patch);
            this.state.stockQuotes = Object.assign({}, this.state.stockQuotes, listQuotes);

            const modal = document.getElementById('coinSelectorModal');
            if (modal && !modal.classList.contains('hidden')) {
                this.renderCoinSelectorList();
            }
        } catch (e) {
            console.warn('美股自选行情加载失败:', e.message);
        }
    },

    // 初始化
    async init() {
        // 任一子系统出错都不应拖垮整个应用：逐个隔离，出错的记下来继续往下走
        const step = (name, fn) => {
            try { fn(); }
            catch (e) {
                this._initErrors = this._initErrors || [];
                this._initErrors.push(name + ': ' + e.message);
                console.error(`[初始化] ${name} 失败:`, e);
            }
        };

        step('loadCoinMeta', () => this.loadCoinMeta());
        step('loadWatchlist', () => this.loadWatchlist());
        step('loadUIState', () => this.loadUIState());
        step('bindEvents', () => this.bindEvents());
        step('initChart', () => this.initChart());
        step('initTabs', () => this.initTabs());
        step('applyUIState', () => this.applyUIState());
        // 无存档时也要渲染一次，保证灵敏度控件有选中态
        step('renderSensitivity', () => this.renderSensitivity());
        // 模拟交易：恢复开关与账户展示
        step('initPaper', () => this.initPaper());
        // 币安测试网交易：绑定交互（密钥不落地，刷新即失效）
        step('initBinance', () => this.initBinance());
        // 推送邮箱设置：地址按账号隔离，等登录后再由 auth.js 重渲染一次
        step('initMailNotify', () => this.initMailNotify());

        // 后台联网拉取币种目录与自选行情
        this.loadCoinCatalog();
        this.loadWatchlistQuotes();
        await this.loadCoinData(this.state.currentCoin);
        this.updateFavoriteButton();
        this.saveUIState();
        this.startAutoRefresh();

        // 首屏就绪后，再去结算「界面没在看的币种」的预测。不 await：它要发若干次
        // 请求（每次最多 8 组），不该拖慢启动；内部有节流与并发保护，失败只记日志。
        this.reviewPendingPredictions();
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

        // 行情提示条上的「重试」：重新拉一次当前币种的价格与K线。
        // 传参与顶部刷新按钮保持一致 —— loadCoinData 的第二个参数目前没有被函数体
        // 使用（属既有约定），这里不另起一套写法，免得两处行为分叉。
        const dataNoticeRetry = document.getElementById('dataNoticeRetry');
        if (dataNoticeRetry) {
            dataNoticeRetry.addEventListener('click', () => {
                this.loadCoinData(this.state.currentCoin, true);
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
                // 实测数据按周期差异很大，切换周期后要同步刷新档位对比表
                this.renderSensitivityStats(this.state.sensitivity);
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
                // 同时去 CoinGecko 找币安没收录的币种
                this.searchCoinGeckoInto(e.target.value);
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

        // 信号灵敏度档位切换
        document.querySelectorAll('#sensitivityControl .sens-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.applySensitivity(btn.dataset.sensitivity);
            });
        });

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
        // 悬停说明只给「待确认」用。已成立的信号点一下就有完整弹窗，
        // 若每个标注都弹气泡，看图时反而一直被挡住。
        ChartManager.setMarkerHoverProvider((marker) => this.markerHoverTip(marker));
    },

    // ===== Tab 切换 =====
    initTabs() {
        // 底部主导航
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
        });

        // 交易页的两种模式
        const modeCtrl = document.getElementById('tradeModeControl');
        if (modeCtrl) {
            modeCtrl.addEventListener('click', (e) => {
                const btn = e.target.closest('.trade-mode-btn');
                if (btn && btn.dataset.mode) this.setTradeMode(btn.dataset.mode);
            });
        }

        // 初始高亮（switchTab 在同值时提前返回，所以要手动点亮一次）
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === this.state.currentTab);
        });
        const actionBar = document.getElementById('quoteActionBar');
        if (actionBar) actionBar.classList.toggle('hidden', this.state.currentTab !== 'quote');
        this.renderTradePane();
    },

    switchTab(tabName) {
        // 兼容旧的 'paper' 取值：模拟盘现在是「交易」里的一个模式
        if (tabName === 'paper') tabName = 'trade';
        if (!tabName) return;
        if (tabName === this.state.currentTab) {
            // 同标签再点一次：滚回顶部（主流交互习惯）
            window.scrollTo({ top: 0, behavior: 'smooth' });
            return;
        }
        this.state.currentTab = tabName;
        this.saveUIState();

        // 底部主导航高亮
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabName);
        });

        // 面板显示：「交易」复用 tab-paper 容器
        const panelId = tabName === 'trade' ? 'tab-paper' : 'tab-' + tabName;
        document.querySelectorAll('.tab-panel').forEach(panel => {
            panel.classList.add('hidden');
        });
        const targetPanel = document.getElementById(panelId);
        if (targetPanel) targetPanel.classList.remove('hidden');

        // 买入/卖出操作条只在行情页出现，避免与主导航抢空间
        const actionBar = document.getElementById('quoteActionBar');
        if (actionBar) actionBar.classList.toggle('hidden', tabName !== 'quote');

        if (tabName === 'quote') {
            setTimeout(() => ChartManager.handleResize?.(), 50);
        }
        if (tabName === 'trade') {
            this.renderTradePane();
            this.renderPaperTab();
        }
    },

    /**
     * 渲染交易页的两种模式：模拟盘 / 币安测试网
     */
    renderTradePane() {
        const mode = this.state.tradeMode || 'paper';
        const paper = document.getElementById('tradePanePaper');
        const live = document.getElementById('tradePaneBinance');
        if (paper) paper.classList.toggle('hidden', mode !== 'paper');
        if (live) live.classList.toggle('hidden', mode !== 'live');

        document.querySelectorAll('#tradeModeControl .trade-mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });

        const hint = document.getElementById('tradeModeHint');
        if (hint) {
            hint.textContent = mode === 'live'
                ? '币安测试网：真实下单接口、真实撮合，但全部是虚拟资金，不涉及真实资产。'
                : '模拟盘：按历史K线回放信号，不下任何真实订单。';
        }

        // 美股在合约市场，现货测试网这条链路接不了，提前讲清楚
        const stockNotice = document.getElementById('tradeStockNotice');
        if (stockNotice) stockNotice.classList.toggle('hidden', !this.currentIsStock());

        if (mode === 'live') this.renderBinancePanel();
    },

    setTradeMode(mode) {
        if (mode !== 'paper' && mode !== 'live') return;
        this.state.tradeMode = mode;
        this.saveUIState();
        this.renderTradePane();
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
            sensitivity: this.state.sensitivity,
            paperGate: this.state.paperGate,
            tradeMode: this.state.tradeMode,
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

            // 信号灵敏度档位（只恢复状态并渲染，不触发重算，
            // 此时指标尚未加载，重算会在加载完成后自然生效）
            if (saved.sensitivity && this.sensitivityPresets[saved.sensitivity]) {
                this.state.sensitivity = saved.sensitivity;
            }
            this.renderSensitivity();

            // 模拟盘闸门（只恢复状态并渲染，资金费率历史在K线加载后才有）
            if (saved.paperGate && this.paperGates[saved.paperGate]) {
                this.state.paperGate = saved.paperGate;
            }
            this.renderPaperGate();

            // 交易页模式（模拟盘 / 币安测试网）
            if (saved.tradeMode === 'paper' || saved.tradeMode === 'live') {
                this.state.tradeMode = saved.tradeMode;
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
        // 美股要标出「币安合约」：它不是现货，交易方式与加密现货不同
        if (coin.market === 'futures') {
            const name = coin.name && coin.name !== coin.symbol ? coin.name + ' · ' : '';
            return name + '币安合约 ' + (coin.symbol || '') + '/USDT';
        }
        // 现货的代币化股票要单独说明：它不是加密币，而且与合约版不是同一个市场
        if (coin.tokenized) {
            return '币安现货代币化股票 · 与「' + (coin.tokenizedUnderlying || '') +
                '」同标的（合约版历史更长、流动性更好）';
        }
        if (coin.name && coin.name !== coin.symbol && coin.name !== coin.coinId) {
            return coin.name;
        }
        return (coin.symbol || coin.coinId || '') + '/USDT';
    },

    // ===== 币种选择器 =====

    // 行内可局部更新的片段，抽成常量。
    // 这是必须的：整块重建与局部打补丁会写同一段标记，若两处各写一份，
    // 以后改样式很容易只改了其中一处，出现「重建后是对的、打补丁后是错的」这种错位。
    COIN_ROW_STAR_BAR: '<span data-role="star-bar" class="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-6 rounded-r-full bg-golden"></span>',
    COIN_ROW_ACTIVE_TAG: '<span data-role="active-tag" class="text-[10px] px-1 py-px rounded bg-golden/15 text-golden">当前</span>',

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
        this.loadStockCatalog();
        this.loadWatchlistQuotes();
    },

    hideCoinSelectorModal() {
        const modal = document.getElementById('coinSelectorModal');
        if (!modal) return;
        modal.classList.add('hidden');
        document.body.style.overflow = '';

        const input = document.getElementById('coinSearchInput');
        if (input) input.value = '';

        // 收起 CoinGecko 结果块，并让在途请求作废
        this.state.cgSearchResults = [];
        this._cgSearchToken = (this._cgSearchToken || 0) + 1;
        this.renderCgSearchResults();
    },

    // 切换币种选择器内的分类
    switchCoinCategory(cat) {
        if (!cat || cat === this.state.marketTab) return;
        this.state.marketTab = cat;
        this.state.coinListLimit = 50;
        this.updateCoinCategoryButtons();
        this.saveUIState();
        this.renderCoinSelectorList();

        // 美股目录不在现货 exchangeInfo 里，需要单独拉一次合约目录
        if (cat === 'usstock') {
            this.loadStockCatalog().then(() => {
                this.renderCoinSelectorList();
                this.loadStockQuotes();
            });
        }
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
        // 美股是独立市场（币安 USDT-M 合约的 TradFi 板块），
        // 不能混进现货目录里一起排，否则「全部」会被一百多个股票代码淹没。
        if (cat === 'usstock') {
            return this.state.stockCatalog.length
                ? this.state.stockCatalog
                : [];
        }

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
            // 搜索不再受当前分类限制。
            //
            // 选择器默认停在「自选」，而原来的写法是「先在当前分类里筛，再按关键词过滤」，
            // 于是自选里没有的币种永远搜不到 —— 输入一个自己有持仓但没加自选的币种，
            // 结果是一片空白，看起来就像搜索坏了。搜索符号时用户的预期是全库匹配。
            //
            // 美股同理：在现货分类下输入 AAPL 也应该能搜到，
            // 否则用户得先猜到「切到美股分类才能搜」。
            pool = this.state.coinCatalog && this.state.coinCatalog.length
                ? this.state.coinCatalog.concat(this.state.stockCatalog || [])
                : pool;
            pool = pool.filter(c =>
                (c.symbol || '').toLowerCase().includes(q) ||
                (c.name || '').toLowerCase().includes(q) ||
                (c.coinId || '').toLowerCase().includes(q)
            );
        }

        const shown = pool.slice(0, this.state.coinListLimit);

        if (shown.length === 0) {
            // 美股分类首屏：目录还没回来时要说明「正在加载」，
            // 而不是套用通用空结果文案（那句「没有找到匹配「」的币种」在这里毫无意义）。
            if (this.state.marketTab === 'usstock' && !q) {
                container.innerHTML = `<div class="py-10 px-6 text-center">
                    <p class="text-sm text-text-secondary">${this.state.stockCatalogLoading ? '正在加载美股目录…' : '暂时没有取到美股目录'}</p>
                    <p class="text-xs text-text-tertiary mt-2 leading-relaxed">
                        美股标的来自<strong>币安 USDT-M 合约</strong>（TradFi 板块），不在现货交易对里，
                        需要单独拉一次合约目录。
                    </p>
                </div>`;
                // 空结果占位不是行列表，作废签名，避免下次误判为「行集没变」
                this._coinSelectorRowSetSignature = null;
                return;
            }

            // 空结果要区分「搜错了」和「这个币根本不在数据范围内」，
            // 否则用户无法判断是搜索有问题还是币种没收录。
            const total = (this.state.coinCatalog && this.state.coinCatalog.length) || 0;
            const stockTotal = (this.state.stockCatalog && this.state.stockCatalog.length) || 0;
            const kw = this.esc ? this.esc(q) : q;
            container.innerHTML = `<div class="py-10 px-6 text-center">
                <p class="text-sm text-text-secondary">没有找到匹配「${kw}」的币种</p>
                <p class="text-xs text-text-tertiary mt-2 leading-relaxed">
                    搜索范围是<strong>币安现货 USDT 交易对</strong>${total ? `（当前覆盖 ${total} 个）` : ''}
                    与<strong>币安合约里的美股标的</strong>${stockTotal ? `（${stockTotal} 个，见「美股」分类）` : ''}。
                    只在其它交易所上线的币种（例如 GWEI/ETHGas 仅见于 HTX、BitMart、Upbit）不在这个范围内，
                    因此搜不到属于数据范围限制，并非搜索故障。
                </p>
                <p class="text-xs text-text-tertiary mt-1.5">也可以直接输入完整符号：BTC、ETH、SOL、AAPL</p>
            </div>`;
            // 同上：没有任何行可选，签名必须作废
            this._coinSelectorRowSetSignature = null;
            return;
        }

        // 行情缺失的批量补拉。
        // filter(Boolean) 不能省：CoinGecko 币种没有币安交易对，binanceSymbol 为 null，
        // 混进请求里会让整个批量行情接口报错，连累其它币种也拿不到价格。
        // 美股同理：它在合约市场，现货批量行情接口认不出这些交易对。
        const pending = this._listQuotePending || (this._listQuotePending = new Set());
        const missing = shown
            .filter(c => c.binanceSymbol && c.market !== 'futures' &&
                !this.state.coinListQuotes[c.binanceSymbol] && !pending.has(c.binanceSymbol))
            .map(c => c.binanceSymbol);
        if (missing.length > 0) {
            this.loadCoinListQuotes(missing);
        }
        // 美股走合约的全量快照，一次请求覆盖整个分类
        if (shown.some(c => c.market === 'futures') &&
            !Object.keys(this.state.stockQuotes || {}).length) {
            this.loadStockQuotes();
        }

        // 渲染分两层：行集没变就只打补丁，行集变了才整块重建。
        //
        // 这是「点不中」问题的根治手段，不是性能优化。整块 innerHTML 重建会把
        // 用户正指着的那一行一起销毁重建，如果这恰好发生在 mousedown 与 mouseup
        // 之间，浏览器算出来的 click 目标就不再是同一个节点，click 事件根本不会
        // 派发 —— 用户看到的就是「移上去闪一下，然后点不中」。
        //
        // 原来有两条路径会周期性踩到这一帧：行情刷新（30 秒一次的自选刷新、
        // 补拉列表行情、美股快照），以及勾星标 / 切币种这类行级状态变化。
        // 现在它们分别落到 patchCoinSelectorQuotes 与 patchCoinSelectorRowState，
        // 都只改自己那几个节点。于是弹窗打开后行节点不再被替换，窗口从根上消失。
        //
        // 补丁失败（返回 false）时**必须**退回整块重建：那是防止界面停在过期内容
        // 的最后一道保险，宁可多重建一次，也不能让用户看到错的数据。
        const signature = this.coinSelectorRowSetSignature(shown, q);
        if (signature === this._coinSelectorRowSetSignature) {
            if (this.patchCoinSelectorQuotes(shown) && this.patchCoinSelectorRowState(shown)) {
                return;
            }
        }
        this._coinSelectorRowSetSignature = signature;

        container.innerHTML = shown.map(coin => {
            const isActive = coin.coinId === this.state.currentCoin;
            const inWatchlist = this.isSymbolInWatchlist(coin.binanceSymbol);
            const isStockRow = coin.market === 'futures';

            // 优先用自选行情，其次用列表行情；美股在 stockQuotes 里
            let quote = this.state.watchlistQuotes[coin.coinId];
            if (!quote) quote = this.state.coinListQuotes[coin.binanceSymbol];
            if (!quote) quote = this.state.stockQuotes[coin.binanceSymbol];
            const hasQuote = !!quote;
            const up = hasQuote ? quote.changePercent >= 0 : true;

            return `
                <div class="coin-selector-item relative flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50 transition-colors ${isActive ? 'bg-golden/5' : ''}"
                     data-coin-id="${coin.coinId}" data-symbol="${coin.binanceSymbol}">
                    ${inWatchlist ? this.COIN_ROW_STAR_BAR : ''}
                    <button class="coin-star-btn flex-shrink-0 p-0.5 rounded transition-transform active:scale-90"
                            data-coin-id="${coin.coinId}" data-symbol="${coin.binanceSymbol}"
                            title="${inWatchlist ? '取消自选' : '加入自选'}" aria-label="${inWatchlist ? '取消自选' : '加入自选'}">
                        <svg class="w-4 h-4 ${inWatchlist ? 'text-golden' : 'text-gray-300'}" fill="${inWatchlist ? 'currentColor' : 'none'}" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"></path>
                        </svg>
                    </button>
                    <div class="flex items-center gap-3 min-w-0 flex-1">
                        <div data-role="avatar" class="w-8 h-8 rounded-full ${inWatchlist ? 'bg-golden/10' : 'bg-gray-100'} flex items-center justify-center text-sm font-bold text-text-primary flex-shrink-0">
                            ${coin.symbol.charAt(0)}
                        </div>
                        <div class="min-w-0">
                            <div class="flex items-center gap-1.5" data-role="tags">
                                <span class="text-sm font-semibold text-text-primary">${coin.symbol}</span>
                                ${isStockRow ? '<span class="text-[10px] px-1 py-px rounded bg-blue-50 text-blue-600">合约</span>' : (coin.tokenized ? '<span class="text-[10px] px-1 py-px rounded bg-amber-50 text-amber-600">代币</span>' : '')}
                                ${isActive ? this.COIN_ROW_ACTIVE_TAG : ''}
                            </div>
                            <p class="text-xs text-text-secondary truncate">${this.getCoinSubtitle(coin)}</p>
                        </div>
                    </div>
                    <div class="text-right flex-shrink-0">
                        <p class="text-sm font-medium tabular-nums text-text-primary" data-role="price">${hasQuote ? this.formatWatchPrice(quote.price) : '--'}</p>
                        <p class="text-xs tabular-nums ${!hasQuote ? 'text-text-tertiary' : (up ? 'text-rise-green' : 'text-fall-red')}" data-role="change">${hasQuote ? (up ? '+' : '') + quote.changePercent.toFixed(2) + '%' : '--'}</p>
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

    // 行集签名：只收录「有哪些行、按什么顺序、写死在结构里的静态内容是什么」。
    //
    // 签名里只允许两类东西，多一个字段都会让局部更新退化回整块重建：
    //   1. 决定行集合与顺序的：分类、搜索词、显示条数、行数、每行的 coinId；
    //   2. 渲染时写死在结构里的静态内容：symbol（含首字母头像）、name、
    //      market、tokenized、tokenizedUnderlying（副标题与标签）。
    //
    // 「行情」和「行级可变状态」（是否自选、是否当前币）**故意不进签名** ——
    // 它们各有 patch 方法就地去改节点；进了签名就等于每次行情刷新、每次勾星标
    // 都要整块重建，那正是要根治的问题。
    // 反过来，若以后渲染里新引入一个会变的字段，必须同步加进签名或写进 patch，
    // 否则会出现「数据变了、界面没变」的幽灵 bug。
    coinSelectorRowSetSignature(shown, q) {
        const head = [this.state.marketTab, q, this.state.coinListLimit, shown.length].join('|');
        const rows = shown.map(c => [
            c.coinId, c.symbol, c.name, c.market,
            c.tokenized ? 1 : 0, c.tokenizedUnderlying || ''
        ].join('~'));
        return head + '||' + rows.join('|');
    },

    // 只更新每行的价格与涨跌幅文本节点，返回是否全部命中。
    //
    // 返回 false 表示当前 DOM 与 shown 对不上（例如列表此刻显示的是空结果、
    // 或结构被别的路径改过），调用方必须退回整块重建 —— 这个返回值是安全网：
    // 宁可多重建一次，也不能让界面停在过期内容上。
    patchCoinSelectorQuotes(shown) {
        const container = document.getElementById('coinSelectorList');
        if (!container) return false;

        // 按 data-coin-id 建索引，而不是拼选择器：币种 id 来自远端目录，
        // 拼进 querySelector 既要转义又有注入风险，直接比 dataset 更稳。
        const rows = new Map();
        container.querySelectorAll('.coin-selector-item').forEach(el => {
            rows.set(el.dataset.coinId, el);
        });
        if (rows.size !== shown.length) return false;

        for (const coin of shown) {
            const row = rows.get(coin.coinId);
            const priceEl = row && row.querySelector('[data-role="price"]');
            const changeEl = row && row.querySelector('[data-role="change"]');
            if (!priceEl || !changeEl) return false;

            // 行情取值顺序必须与整块重建时完全一致，否则这两条路径会显示出不同的价格
            let quote = this.state.watchlistQuotes[coin.coinId];
            if (!quote) quote = this.state.coinListQuotes[coin.binanceSymbol];
            if (!quote) quote = this.state.stockQuotes[coin.binanceSymbol];

            if (quote) {
                const up = quote.changePercent >= 0;
                priceEl.textContent = this.formatWatchPrice(quote.price);
                changeEl.textContent = (up ? '+' : '') + quote.changePercent.toFixed(2) + '%';
                changeEl.className = `text-xs tabular-nums ${up ? 'text-rise-green' : 'text-fall-red'}`;
            } else {
                priceEl.textContent = '--';
                changeEl.textContent = '--';
                changeEl.className = 'text-xs tabular-nums text-text-tertiary';
            }
        }
        return true;
    },

    // 就地更新「行级可变状态」：是否自选（左侧金条 / 星标 / 头像底色）与
    // 是否当前币（行底色 /「当前」标签）。返回 false 同样表示要退回整块重建。
    //
    // 这两个字段原来都在签名里，于是勾一下星标、切一下币种就要把整个列表重建一遍 ——
    // 而它们的共同点是「行的集合与顺序压根没变，只是某几行自己长什么样变了」，
    // 完全可以只动对应节点。
    //
    // 注意「自选」分类是例外：在那里取消自选会让该行从列表里消失，属于行集合变了，
    // 会由签名变化走整块重建，不经过这里 —— 这是正确的，不是遗漏。
    patchCoinSelectorRowState(shown) {
        const container = document.getElementById('coinSelectorList');
        if (!container) return false;

        const rows = new Map();
        container.querySelectorAll('.coin-selector-item').forEach(el => {
            rows.set(el.dataset.coinId, el);
        });
        if (rows.size !== shown.length) return false;

        for (const coin of shown) {
            const row = rows.get(coin.coinId);
            if (!row) return false;

            const starBtn = row.querySelector('.coin-star-btn');
            const avatar = row.querySelector('[data-role="avatar"]');
            const tags = row.querySelector('[data-role="tags"]');
            if (!starBtn || !avatar || !tags) return false;

            // ---- 是否自选 ----
            const inWatchlist = this.isSymbolInWatchlist(coin.binanceSymbol);

            // 左侧金条：要就插入、不要就移除，插入位置与重建模板一致（作为首个子节点）
            const starBar = row.querySelector('[data-role="star-bar"]');
            if (inWatchlist && !starBar) {
                row.insertAdjacentHTML('afterbegin', this.COIN_ROW_STAR_BAR);
            } else if (!inWatchlist && starBar) {
                starBar.remove();
            }

            const label = inWatchlist ? '取消自选' : '加入自选';
            starBtn.title = label;
            starBtn.setAttribute('aria-label', label);

            const starSvg = starBtn.querySelector('svg');
            if (starSvg) {
                starSvg.setAttribute('fill', inWatchlist ? 'currentColor' : 'none');
                starSvg.classList.toggle('text-golden', inWatchlist);
                starSvg.classList.toggle('text-gray-300', !inWatchlist);
            }
            avatar.classList.toggle('bg-golden/10', inWatchlist);
            avatar.classList.toggle('bg-gray-100', !inWatchlist);

            // ---- 是否当前币 ----
            const isActive = coin.coinId === this.state.currentCoin;
            row.classList.toggle('bg-golden/5', isActive);

            // 「当前」标签在重建模板里位于标签容器末尾，这里也追加到末尾，保持顺序一致
            const activeTag = tags.querySelector('[data-role="active-tag"]');
            if (isActive && !activeTag) {
                tags.insertAdjacentHTML('beforeend', this.COIN_ROW_ACTIVE_TAG);
            } else if (!isActive && activeTag) {
                activeTag.remove();
            }
        }
        return true;
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

        let changed = 0;
        for (const chunk of chunks) {
            try {
                const query = encodeURIComponent(JSON.stringify(chunk));
                const resp = await fetch(`${this.binanceApiBase}/ticker/24hr?symbols=${query}`, { signal: AbortSignal.timeout(15000) });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                const arr = Array.isArray(data) ? data : [data];
                arr.forEach(t => {
                    const next = {
                        price: parseFloat(t.lastPrice),
                        changePercent: parseFloat(t.priceChangePercent)
                    };
                    const prev = this.state.coinListQuotes[t.symbol];
                    // 只统计「真的变了」的，价格没动就不必重建 DOM
                    if (!prev || prev.price !== next.price || prev.changePercent !== next.changePercent) changed++;
                    this.state.coinListQuotes[t.symbol] = next;
                });
            } catch (e) {
                console.warn('列表行情加载失败:', e.message);
            } finally {
                chunk.forEach(s => pending.delete(s));
            }
        }

        // 只有真拿到新行情才重建列表 —— 这不是优化，是必须的。
        //
        // renderCoinSelectorList 在行情缺失时会调用本函数，而本函数若无条件回调
        // render，取数失败时就形成「render → 取数失败 → render → 取数失败」的
        // 无限循环：每次 render 都重新发起一次注定失败的请求，失败后又立刻 render。
        // 实测（把 ticker 请求打桩成必失败）会把主线程占满，连页面导航都超时。
        //
        // 用户侧的表现就是「点列表时闪烁、点不中」—— 因为正在被点的行被反复销毁
        // 重建，mousedown 与 mouseup 落在两个不同节点上，click 根本不会触发。
        if (!changed) return;

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

        // 美股在合约目录里，source 要标成 stock，否则会被当成现货去请求
        const fromStock = (this.state.stockCatalog || []).find(c => c.coinId === coinId);
        if (fromStock) this.addCoinFromStock(fromStock);

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

        const fromStock = (this.state.stockCatalog || []).find(c => c.coinId === coinId);
        if (fromStock) return fromStock;

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

    // ==================== 数据源路由（币安现货 / 币安合约美股 / CoinGecko）====================

    /**
     * 判断某个币种走哪个数据源。
     *
     *   binance   —— 币安现货 USDT 交易对（默认）
     *   stock     —— 币安 USDT-M 合约里的股票标的，价格与K线要换 futuresApiBase
     *   coingecko —— 币安没有收录的币种（例如 GWEI/ETHGas）
     */
    getDataSource(coinId) {
        const meta = this.state.coinMeta[coinId];
        if (meta && meta.source === 'stock' && meta.binanceSymbol) return 'stock';
        if (meta && meta.source === 'coingecko' && meta.cgId) return 'coingecko';
        return 'binance';
    },

    isStock(coinId) {
        return this.getDataSource(coinId) === 'stock';
    },

    /**
     * 交易市场：现货还是合约。
     * 现货接口（ticker / klines / 批量行情）不能混进合约标的——
     * 一个不存在的交易对会让整批请求失败，连累其它币种也拿不到行情。
     */
    getMarket(coinId) {
        return this.isStock(coinId) ? 'futures' : 'spot';
    },

    // 当前查看的美股标的是不是合约标的（供顶部提示条判断）
    currentIsStock() {
        return this.isStock(this.state.currentCoin);
    },

    /**
     * 把合约目录里的美股标的登记到本地，之后就能像普通币种一样搜索与切换。
     * source 标成 stock，路由据此改走合约接口。
     */
    addCoinFromStock(entry) {
        if (!entry || !entry.binanceSymbol) return null;
        const coinId = entry.coinId || String(entry.symbol || '').toLowerCase();
        this.state.coinMeta[coinId] = {
            id: coinId,
            coinId: coinId,
            symbol: entry.symbol,
            name: entry.name || entry.symbol,
            binanceSymbol: entry.binanceSymbol,
            source: 'stock',
            market: 'futures',
            underlyingType: entry.underlyingType || '',
            marketLabel: entry.marketLabel || '美股',
            onboardDate: entry.onboardDate || 0,
            stepSize: entry.stepSize,
            minNotional: entry.minNotional,
        };
        this.saveCoinMeta();
        return coinId;
    },

    /**
     * 拉取合约目录并筛出美股标的。
     * 识别靠 underlyingType 字段（EQUITY），不是硬编码名单，
     * 币安上新股票时这边不用改。
     */
    async loadStockCatalog(force = false) {
        if (this.state.stockCatalogLoading) return this.state.stockCatalog;
        if (this.state.stockCatalogLoaded && !force) return this.state.stockCatalog;
        if (typeof Stocks === 'undefined') return [];

        // 先读缓存（24 小时有效），避免每次打开选择器都打一次 exchangeInfo
        if (!force) {
            try {
                const cached = JSON.parse(localStorage.getItem('cryptoPulse_stockCatalog_v1') || 'null');
                if (cached && cached.ts && Date.now() - cached.ts < 24 * 3600 * 1000 && cached.list?.length) {
                    this.state.stockCatalog = this.sortStockCatalog(cached.list);
                    this.state.stockCatalogLoaded = true;
                    this.tagTokenizedStocks();
                    return this.state.stockCatalog;
                }
            } catch (e) { /* 忽略缓存损坏 */ }
        }

        this.state.stockCatalogLoading = true;
        try {
            const list = await Stocks.loadCatalog();
            this.state.stockCatalog = this.sortStockCatalog(list);
            this.state.stockCatalogLoaded = true;
            this.tagTokenizedStocks();
            localStorage.setItem('cryptoPulse_stockCatalog_v1',
                JSON.stringify({ ts: Date.now(), list: this.state.stockCatalog }));
            console.log(`[美股目录] 合约市场筛出 ${this.state.stockCatalog.length} 个美股标的`);

            if (this.state.marketTab === 'usstock') this.renderCoinSelectorList();
            return this.state.stockCatalog;
        } catch (e) {
            console.warn('[美股目录] 获取失败:', e.message);
            this.state.stockCatalogLoaded = true;
            return this.state.stockCatalog;
        } finally {
            this.state.stockCatalogLoading = false;
        }
    },

    /**
     * 给现货目录里的「代币化股票」打标。
     *
     * 币安现货也有美股（代码是原代码 + B，如 AAPLB），但它和普通币种在
     * exchangeInfo 里字段完全一样，没法靠字段区分；而单纯「以 B 结尾」
     * 会把 BNB / SHIB / ARB / CKB / TRB 一起误伤。
     * 所以用合约那边的美股名单反查配对，认出来的打 tokenized 标记，
     * 列表里显示为「代币」并标明这是现货，避免被当成同一只股票的另一个代码。
     *
     * 这个方法幂等，目录或美股名单任一就绪后调用都安全。
     */
    tagTokenizedStocks() {
        if (typeof Stocks === 'undefined') return;
        const catalog = this.state.coinCatalog;
        if (!catalog || !catalog.length) return;
        if (!this.state.stockCatalog || !this.state.stockCatalog.length) return;

        const set = Stocks.tokenizedBaseSet(this.state.stockCatalog.map(c => c.symbol));
        catalog.forEach(c => {
            const sym = String(c.symbol || '').toUpperCase();
            if (!set.has(sym)) { c.tokenized = false; return; }
            const underlying = sym.slice(0, -1);
            c.tokenized = true;
            c.tokenizedUnderlying = underlying;
            // 中文名沿用原标的，并显式标注「代币化」，避免被误读成同名加密币
            c.name = (Stocks.NAMES[underlying] || underlying) + '（代币化）';
        });
    },

    /**
     * 美股排序：有行情就按成交额从大到小（流动性优先），
     * 没行情时按标的简称排，保证顺序稳定不跳。
     */
    sortStockCatalog(list) {
        const q = this.state.stockQuotes || {};
        return list.slice().sort((a, b) => {
            const qa = q[a.binanceSymbol] ? q[a.binanceSymbol].quoteVolume : 0;
            const qb = q[b.binanceSymbol] ? q[b.binanceSymbol].quoteVolume : 0;
            if (qa !== qb) return qb - qa;
            return (a.symbol || '').localeCompare(b.symbol || '');
        });
    },

    /**
     * 批量拉取美股行情。
     *
     * 实测 fapi/v1/ticker/24hr 带 symbols（复数）参数时并不按列表过滤、会返回全量，
     * 所以这里直接取全量快照在本地筛，一次请求覆盖整个美股分类，比依赖那个参数可靠。
     */
    async loadStockQuotes() {
        if (typeof Stocks === 'undefined') return;
        if (this._stockQuotePending) return;
        this._stockQuotePending = true;
        try {
            const map = await Stocks.allTickers();
            const quotes = {};
            (this.state.stockCatalog || []).forEach(c => {
                const t = map[c.binanceSymbol];
                if (t) {
                    quotes[c.binanceSymbol] = {
                        price: t.current_price,
                        changePercent: t.price_change_percentage_24h,
                        quoteVolume: t.quote_volume,
                    };
                }
            });
            this.state.stockQuotes = quotes;

            // 与 loadCoinListQuotes 同理：一条行情都没拿到就不要回调 render。
            //
            // renderCoinSelectorList 见到 stockQuotes 为空就会再调本函数，
            // 所以无条件 render 会成环：render → 取数（空）→ render → 取数（空）…
            // 在「美股」分类下会把页面卡死。美股行情取不到时（目录为空、
            // 或 allTickers 返回空）正是这条路径。
            if (!Object.keys(quotes).length) return;

            this.state.stockCatalog = this.sortStockCatalog(this.state.stockCatalog);

            const modal = document.getElementById('coinSelectorModal');
            if (modal && !modal.classList.contains('hidden')) this.renderCoinSelectorList();
        } catch (e) {
            console.warn('[美股行情] 获取失败:', e.message);
        } finally {
            this._stockQuotePending = false;
        }
    },

    /**
     * 把 CoinGecko 的币种登记到本地，之后就能像普通币种一样被搜索与切换。
     * binanceSymbol 显式置为 null，表示它不在币安 —— getBinanceSymbol 据此返回空。
     */
    addCoinFromCoinGecko(cg) {
        if (!cg || !cg.id) return null;
        const coinId = String(cg.symbol || cg.id).toLowerCase();
        this.state.coinMeta[coinId] = {
            id: coinId,
            symbol: (cg.symbol || '').toUpperCase(),
            name: cg.name || cg.symbol || coinId,
            binanceSymbol: null,
            source: 'coingecko',
            cgId: cg.id,
            cgRank: cg.rank || null,
            image: cg.thumb || '',
        };
        this.saveCoinMeta();
        return coinId;
    },

    /**
     * 把应用内的周期映射到 CoinGecko 的档位。
     *
     * CoinGecko 的粒度由 days 决定、不能自由指定 interval：
     *   1 天 → 30 分钟；3~30 天 → 4 小时；31 天以上 → 4 天。
     * 所以只能就近取档，界面上会如实标出实际粒度。
     */
    getCgTimeframe(tf) {
        const map = { '0.25': 1, '0.5': 1, '1': 7, '4': 30, '24': 365, '168': 365 };
        const days = map[String(tf)] || 7;
        return CoinGecko.TIMEFRAMES.find(t => t.days === days) || CoinGecko.TIMEFRAMES[1];
    },

    /**
     * 用 CoinGecko 加载币种数据。
     *
     * 与币安路径的差异直接决定界面要标注什么：
     *   - 粒度由 days 决定，不能像币安那样自由选 interval
     *   - OHLC 端点不含成交量，只能用 market_chart 按时间窗近似补
     *   - 没有资金费率 / 持仓量 / 多空比
     * 因此这里只产出「价格 + K线 + 技术指标」，不产出综合买卖信号。
     */
    async loadCoinDataFromCoinGecko(coinId, token) {
        const meta = this.state.coinMeta[coinId];
        const cgId = meta && meta.cgId;
        if (!cgId) throw new Error('缺少 CoinGecko 币种 ID');

        const tfCfg = this.getCgTimeframe(this.state.currentTimeframe);

        const [mkt, built] = await Promise.all([
            CoinGecko.market(cgId),
            CoinGecko.buildCandles(cgId, tfCfg.days),
        ]);

        if (token !== this._loadToken) return;
        if (this.state.currentCoin !== coinId) return;
        if (!mkt) throw new Error('CoinGecko 未返回该币种行情');

        this.state.coinInfo = {
            id: coinId,
            symbol: (mkt.symbol || '').toUpperCase(),
            name: mkt.name || coinId,
            image: mkt.image || '',
            current_price: mkt.current_price,
            price_change_24h: mkt.price_change_24h,
            price_change_percentage_24h: mkt.price_change_percentage_24h,
            high_24h: mkt.high_24h,
            low_24h: mkt.low_24h,
            market_cap: mkt.market_cap,
            total_volume: mkt.total_volume,
            ath: mkt.ath,
            atl: mkt.atl,
            circulating_supply: mkt.circulating_supply,
            total_supply: mkt.total_supply,
            market_cap_rank: mkt.market_cap_rank,
            price_change_percentage_1h: mkt.price_change_percentage_1h_in_currency,
            price_change_percentage_7d: mkt.price_change_percentage_7d_in_currency,
            price_change_percentage_30d: mkt.price_change_percentage_30d_in_currency,
            source: 'coingecko',
        };

        this.state.candleData = built.candles;
        // 这一路刻意不声明K线身份：CoinGecko 的粒度由时间跨度决定（30分钟/4小时/4天），
        // 与应用的 1h/4h/24h 不是一回事，拿它复盘会算错复盘窗口。
        // 这类币种本来也不产生综合信号、不记录预测，所以置空不影响任何记录。
        this.state.candleMeta = null;
        this.state.candleSource = 'coingecko';
        this.state.cgCandleMeta = {
            granularity: built.granularity,
            volumeApprox: built.volumeApprox,
            label: built.label,
            bars: built.candles.length,
        };
        // 显式清空，避免沿用上一个币种残留的衍生品数据
        this.state.derivatives = null;
        this.state.fundingRate = null;
        this.state.volumeAnalysis = null;

        this.updatePriceUI();

        // 图表不画买卖点：这个数据源下成交量是估算的、又缺衍生品，
        // 画出来的买卖点会让人误以为可以照做。
        const prevMarkers = this.state.showSignalMarkers;
        this.state.showSignalMarkers = false;
        this.calculateIndicators();
        this.updateChart();
        this.state.showSignalMarkers = prevMarkers;

        this.renderCgNotice(true);
        this.renderStockNotice();
        this.renderCgSignalState();
    },

    /**
     * 只刷新 CoinGecko 币种的价格与市值（供 30 秒自动刷新使用）。
     * K线不刷：CoinGecko 的 OHLC 本身有 15 分钟缓存，刷了也不会变。
     */
    async refreshCgPrice(coinId) {
        const meta = this.state.coinMeta[coinId];
        if (!meta || !meta.cgId) return;
        try {
            CoinGecko.invalidateMarkets(meta.cgId);
            const mkt = await CoinGecko.market(meta.cgId);
            if (!mkt) return;
            if (this.state.currentCoin !== coinId) return;

            this.state.coinInfo = Object.assign({}, this.state.coinInfo, {
                current_price: mkt.current_price,
                price_change_24h: mkt.price_change_24h,
                price_change_percentage_24h: mkt.price_change_percentage_24h,
                high_24h: mkt.high_24h,
                low_24h: mkt.low_24h,
                market_cap: mkt.market_cap,
                total_volume: mkt.total_volume,
            });
            this.updatePriceUI();
        } catch (e) {
            // 自动刷新失败就静默跳过，不打扰用户
        }
    },

    /**
     * 美股提示条。
     *
     * 必须说明三件事，否则用户会照着加密币的直觉用错：
     *   1) 这是**合约**不是现货，交易方式不同；
     *   2) 24 小时连续交易（实测K线覆盖全部 24 个小时位，没有休市缺口）；
     *   3) 历史深度很浅 —— 合约 2026 年才上线，日线约 166 根、周线约 24 根。
     */
    renderStockNotice() {
        const el = document.getElementById('stockNotice');
        const tradeNote = document.getElementById('tradeStockNotice');
        const show = this.currentIsStock();
        // 两处都要跟着切换：顶部说明条 + 交易页里「美股不能在这里下单」的提示。
        // 放在同一个方法里，避免切币种时漏掉其中一个。
        if (tradeNote) tradeNote.classList.toggle('hidden', !show);
        if (!el) return;
        el.classList.toggle('hidden', !show);
        if (!show) return;

        const body = document.getElementById('stockNoticeBody');
        if (!body) return;

        const bars = (this.state.candleData || []).length;
        const tfLabel = this.getTimeframeConfig(this.state.currentTimeframe).label;
        const depth = this.state.stockDepthNotice;
        const parts = [
            `数据来自 <strong>${typeof Stocks !== 'undefined' ? Stocks.SOURCE_LABEL : '币安 USDT-M 合约'}</strong>（美股永续合约，24 小时连续交易，非现货）。`,
            `当前 ${tfLabel} 共 <strong>${bars}</strong> 根K线。`,
        ];
        if (depth) parts.push(`<span class="text-amber-700">${depth}</span>`);
        parts.push('加密市场的恐慌贪婪指数与加密新闻对个股不适用，因此综合评分只由<strong>技术面 + 量能</strong>两项构成（权重 2:1）。');
        // 币安现货其实也有代币化股票，不说清楚的话用户在搜索里看到 AAPLB 会困惑
        parts.push('<span class="block mt-1">币安现货另有<strong>代币化股票</strong>（代码带 B 后缀，如 AAPLB）。'
            + '实测同一只苹果：现货日线 52 根、24h 成交额 203 万美元，合约日线 166 根、成交额 5408 万美元，'
            + '所以这里统一用合约标的；现货那批在搜索结果里仍可见，已标「代币」。</span>');
        body.innerHTML = parts.join('');
    },

    /**
     * CoinGecko 币种的顶部提示条。
     * 说明数据来源、实际粒度、以及哪些因子缺失。
     */
    renderCgNotice(show) {
        const el = document.getElementById('cgNotice');
        if (!el) return;
        el.classList.toggle('hidden', !show);
        if (!show) return;

        const m = this.state.cgCandleMeta || {};
        const body = document.getElementById('cgNoticeBody');
        if (body) {
            body.innerHTML = [
                `K线粒度 <strong>${this.esc(m.granularity || '--')}</strong>（CoinGecko 的粒度由时间跨度决定，不能自由指定），`,
                `成交量 ${m.volumeApprox ? '由市值接口按时间窗<strong>估算</strong>' : '<strong>缺失</strong>'}。`,
                '缺少资金费率、持仓量、多空比，因此<strong>不给出综合买卖信号</strong>，只提供技术指标。',
            ].join('');
        }
    },

    /**
     * CoinGecko 币种的信号卡：只报技术面，不给综合买卖结论。
     *
     * 综合信号是 技术40% + 量能20% + 情绪16% + 消息12% + 衍生品12%。
     * 这类币种缺两项、量能还是估算的，硬凑一个分值出来看着权威、实际不可比，
     * 所以这里宁可显示「数据受限」。
     */
    renderCgSignalState() {
        const ind = this.state.indicators;
        if (!ind) return;

        const scoreEl = document.getElementById('signalMainText');
        const descEl = document.getElementById('signalMainDesc');
        const scoreTextEl = document.getElementById('signalScoreText');
        const barEl = document.getElementById('signalScoreBar');
        const tagEl = document.getElementById('signalStrengthTag');
        const iconEl = document.getElementById('signalMainIcon');

        if (scoreEl) {
            scoreEl.textContent = '数据受限';
            scoreEl.className = 'text-xl font-bold text-text-secondary';
        }
        if (tagEl) {
            tagEl.textContent = 'CoinGecko';
            tagEl.className = 'text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 font-medium';
        }
        if (descEl) {
            descEl.textContent = '该币种不在币安现货，缺少衍生品与可靠成交量数据，不给出综合买卖信号';
        }
        if (scoreTextEl) scoreTextEl.textContent = '仅技术面';
        if (barEl) {
            barEl.style.width = '0%';
            barEl.className = 'h-full rounded-full bg-gray-200';
        }
        if (iconEl) {
            iconEl.className = 'w-14 h-14 rounded-2xl flex items-center justify-center bg-gray-100 flex-shrink-0';
        }
    },

    // 加载币种数据
    async loadCoinData(coinId, forceRefresh = false) {
        const token = ++this._loadToken;
        this.state.isLoading = true;

        // 遮罩延迟 200ms 再出现：正常几百毫秒完成的切换根本不会闪遮罩，
        // 体感上就是「点一下立刻切过去」；只有真的变慢时才用遮罩挡住半成品界面。
        clearTimeout(this._loadingTimer);
        this._loadingTimer = setTimeout(() => {
            if (token === this._loadToken && this.state.isLoading) this.showLoading(true);
        }, 200);

        // 币安没收录的币种走 CoinGecko：粒度与可用因子都不同，单独一条路径
        if (this.getDataSource(coinId) === 'coingecko') {
            try {
                await this.loadCoinDataFromCoinGecko(coinId, token);
                this.state.lastUpdate = new Date();
                this.loadFearGreedIndex();
            } catch (e) {
                console.error('CoinGecko 加载失败:', e);
                if (token === this._loadToken && this.state.currentCoin === coinId) {
                    this.showToast('CoinGecko 加载失败：' + e.message);
                }
            } finally {
                if (token === this._loadToken) {
                    clearTimeout(this._loadingTimer);
                    this.state.isLoading = false;
                    this.showLoading(false);
                }
            }
            // 新闻与币种无关，照常在后台补
            this.loadNews(coinId).catch(() => {});
            return;
        }

        // 回到币安币种时收起 CoinGecko 的提示条
        this.renderCgNotice(false);
        // 美股：显示 / 收起合约市场的说明条
        this.state.stockDepthNotice = null;
        this.renderStockNotice();

        // 换币种时先清掉上一个币种的「行情不可用」记录与提示条，
        // 否则新币种会顶着上一个币种的失败提示，或者反过来把提示吞掉
        this.state.quoteUnavailable = null;
        this.renderDataNotice(false);

        try {
            // 关键路径只等「价格 + K线」——这两项决定首屏能看到什么。
            //
            // 之前这里把 5 个加载器放在同一条等待链上，遮罩要等最慢的那个才消失。
            // 实测各加载器耗时：价格 245ms、K线 293ms、恐慌指数 432ms、衍生品 1101ms、
            // 新闻 5609ms。于是切币种要盯着遮罩等 5.6 秒，而用户真正想看的行情
            // 其实 300 毫秒就绪了。
            await Promise.allSettled([
                this.loadPriceData(coinId),
                this.loadCandleData(coinId),
            ]);

            if (token !== this._loadToken) return;
            if (this.state.currentCoin !== coinId) return;

            this.state.lastUpdate = new Date();
            this.updateSignal();
        } catch (error) {
            console.error('加载数据失败:', error);
        } finally {
            if (token === this._loadToken) {
                clearTimeout(this._loadingTimer);
                this.state.isLoading = false;
                this.showLoading(false);
            }
        }

        // 非关键路径：放在遮罩之外后台补齐，拿到后再刷新一次信号
        this.loadDeferredData(coinId, token);
    },

    /**
     * 后台补齐非关键数据（恐慌指数 / 衍生品 / 新闻）。
     * 这三项都要打外部接口，其中新闻最慢；放在遮罩之外，
     * 用户可以立刻看行情，分析结果到了再自动更新。
     */
    async loadDeferredData(coinId, token) {
        this.setAnalysisPending(true);
        try {
            // 美股只补衍生品。
            //
            // 另外两个因子对个股是**错的**，不能凑数：
            //   - 恐慌贪婪指数是加密市场的指标，跟苹果股价没有关系；
            //   - 新闻源全是加密资讯，拿它们给个股打消息分会得到一个纯噪声的分数。
            // 因此股票跳过这两项，综合评分里也相应去掉这两个权重（见 updateSignal）。
            if (this.isStock(coinId)) {
                this.state.newsList = [];
                this._newsReady = true;
                this.renderNews();
                await Promise.allSettled([this.loadDerivativesData(coinId)]);
            } else {
                await Promise.allSettled([
                    this.loadFearGreedIndex(),
                    this.loadDerivativesData(coinId),
                    this.loadNews(coinId),
                ]);
            }
        } finally {
            if (token !== this._loadToken) return;
            if (this.state.currentCoin !== coinId) return;
            this.setAnalysisPending(false);
            this.updateSignal();
        }
    },

    /**
     * 因子尚未齐全时给出明确的「分析中」状态。
     * 否则用户会看到一个只基于价格与K线的半成品结论，并误以为那就是最终结果。
     */
    setAnalysisPending(pending) {
        const el = document.getElementById('signalPendingTag');
        if (el) el.classList.toggle('hidden', !pending);
    },

    // ==================== 行情不可用状态 ====================
    //
    // 背景：以前现货价格/K线拉取失败会调用 useMockPriceData / useMockCandleData，
    // 用内置基准价 × 随机数写进 state.coinInfo，界面上不做任何标记。
    // 结果是价格、涨跌幅、K线、指标、综合信号一整套都照常显示，
    // 但全是编的 —— 这比直接报错更糟，因为从界面上看不出来。
    //
    // 同一个项目里另外两条路径早就不是这么做的：
    //   - 美股（loadStockPriceData）写明「失败时不降级成模拟数据」；
    //   - CoinGecko 币种会显示「数据受限」，并列出缺了哪些因子。
    // 只有现货这条在偷偷造数，现在改成与它们一致：如实说取不到。

    /**
     * 把取数异常翻译成用户看得懂、且能据以行动的原因。
     *
     * `TypeError: Failed to fetch` 是最常见的一种，它其实打包了多种情况
     * （断网 / DNS 污染 / 代理或防火墙拦截 / CORS），所以文案要把这些列出来，
     * 而不是笼统写一句「网络错误」让用户无从下手。
     */
    quoteFailureReason(error) {
        const msg = (error && error.message) ? String(error.message) : '';
        // 超时（AbortSignal.timeout / AbortController）必须单独说清楚是「等太久」，
        // 否则界面会把 "signal timed out" 这类内部措辞直接摆给用户看。
        if (/timed out|timeout|abort/i.test(msg)) {
            return '请求超时（网络太慢或链路被阻断，已放弃等待）';
        }
        if (/Failed to fetch|NetworkError|Load failed|ERR_/i.test(msg)) {
            return '网络请求被中断或拦截（可能断网、DNS 解析被污染，或代理与防火墙拦了 data-api.binance.vision）';
        }
        if (/HTTP \d{3}/i.test(msg)) {
            return '币安接口返回错误：' + msg;
        }
        return msg || '未知错误';
    },

    /** 标记某一项行情取不到（part: 'price' | 'klines'） */
    markQuoteFailed(coinId, part, reason) {
        if (this.state.currentCoin !== coinId) return;

        const cur = this.state.quoteUnavailable;
        const rec = (cur && cur.coinId === coinId)
            ? cur
            : { coinId: coinId, price: null, klines: null };
        rec[part] = reason || '请求失败';
        this.state.quoteUnavailable = rec;

        this.applyQuoteUnavailable(rec);
    },

    /** 标记某一项恢复正常；两项都好了才收起提示条 */
    markQuoteOk(coinId, part) {
        const rec = this.state.quoteUnavailable;
        if (!rec || rec.coinId !== coinId) return;

        rec[part] = null;
        if (!rec.price && !rec.klines) {
            this.state.quoteUnavailable = null;
            this.renderDataNotice(false);
        } else {
            this.applyQuoteUnavailable(rec);
        }
    },

    /**
     * 按「行情不可用」重画界面。
     *
     * 关键：按部件分别处理，不能一律清空。
     * 曾经这里无条件清掉 coinInfo，结果是「价格恢复了、K线还没恢复」时，
     * 刚取到的价格又被抹掉 —— 表现为点重试后价格闪一下又变回 --。
     */
    applyQuoteUnavailable(rec) {
        if (rec.price) {
            // 价格取不到：清掉数值，避免留着上一个币种的价格
            this.state.coinInfo = null;
            this.clearPriceUI();
        }

        if (rec.klines) {
            // K线取不到：指标无从计算，图表也不能留着上一次的曲线
            this.state.candleData = [];
            this.state.candleMeta = null;
            this.state.indicators = null;
            if (typeof ChartManager !== 'undefined') {
                ChartManager.clearCandlestickData();
            }
        }

        const failed = [];
        if (rec.price) failed.push('实时价格（' + rec.price + '）');
        if (rec.klines) failed.push('K线（' + rec.klines + '）');
        this.renderDataNotice(true, failed.join('；'));

        // 只要有一项缺，综合信号就没有可信输入，统一按不可用显示
        this.renderUnavailableSignalState();
    },

    /**
     * 价格区清空。
     *
     * 必须真的清掉：切币种时若新币种取不到，界面上会留着上一个币种的价格，
     * 用户很容易把它当成当前币种的行情。
     */
    clearPriceUI() {
        this.setText('currentPrice', '--');
        this.setText('cnyPrice', '≈ ¥--');
        this.setText('high24h', '$--');
        this.setText('low24h', '$--');
        this.setText('volume24h', '--');
        this.setText('quoteVolume24h', '$--');

        const priceEl = document.getElementById('currentPrice');
        if (priceEl) priceEl.className = 'text-3xl font-bold text-text-tertiary tabular-nums';

        const cnyEl = document.getElementById('cnyPrice');
        if (cnyEl) cnyEl.className = 'text-sm text-text-tertiary';

        const badge = document.getElementById('priceChangeBadge');
        if (badge) {
            badge.textContent = '--';
            badge.className = 'text-xs font-medium px-2 py-0.5 rounded bg-gray-100 text-text-tertiary';
        }

        const topPrice = document.getElementById('topCoinPrice');
        if (topPrice) {
            topPrice.textContent = '--';
            topPrice.className = 'coin-header-price muted';
        }
        const topChange = document.getElementById('topCoinChange');
        if (topChange) {
            topChange.textContent = '--';
            topChange.className = 'coin-header-change neutral';
        }
    },

    /** 行情不可用提示条：给出原因与重试入口 */
    renderDataNotice(show, reason) {
        const el = document.getElementById('dataNotice');
        if (!el) return;
        el.classList.toggle('hidden', !show);
        if (!show) return;

        const body = document.getElementById('dataNoticeBody');
        if (!body) return;

        body.innerHTML = [
            reason ? this.esc(reason) + '。' : '',
            '这一屏不会再用随机数顶替行情 —— 那样你会看到一份看着完整、实际是编的分析结果。',
            '价格、K线与综合信号暂不可用，请确认网络或代理后点「重试」。',
        ].join('');
    },

    /** 行情不可用时的信号卡状态 */
    renderUnavailableSignalState() {
        const scoreEl = document.getElementById('signalMainText');
        const descEl = document.getElementById('signalMainDesc');
        const scoreTextEl = document.getElementById('signalScoreText');
        const barEl = document.getElementById('signalScoreBar');
        const tagEl = document.getElementById('signalStrengthTag');
        const iconEl = document.getElementById('signalMainIcon');

        if (scoreEl) {
            scoreEl.textContent = '数据不可用';
            scoreEl.className = 'text-xl font-bold text-text-secondary';
        }
        if (tagEl) {
            tagEl.textContent = '未取到数据';
            tagEl.className = 'text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 font-medium';
        }
        if (descEl) {
            descEl.textContent = '实时行情没能取到，暂不生成买卖信号。点上方「重试」重新拉取。';
        }
        if (scoreTextEl) scoreTextEl.textContent = '--';
        if (barEl) {
            barEl.style.width = '0%';
            barEl.className = 'h-full rounded-full bg-gray-200';
        }
        if (iconEl) {
            iconEl.className = 'w-14 h-14 rounded-2xl flex items-center justify-center bg-gray-100 flex-shrink-0';
        }
    },

    // 加载价格数据（币安 API）
    async loadPriceData(coinId) {
        // CoinGecko 币种走自己的价格接口，不能落到下面任何一条兜底路径上
        if (this.getDataSource(coinId) === 'coingecko') {
            await this.refreshCgPrice(coinId);
            return;
        }

        const binanceSymbol = this.getBinanceSymbol(coinId);
        if (!binanceSymbol) {
            this.markQuoteFailed(coinId, 'price', '该币种没有对应的币安现货交易对');
            return;
        }

        // 美股在 USDT-M 合约市场，报价要换 fapi 端点
        if (this.isStock(coinId)) {
            await this.loadStockPriceData(coinId, binanceSymbol);
            return;
        }

        // try 只包住「取数」本身。后面解析与渲染若出错，那是程序问题，
        // 不该被报成「行情取不到」—— 那会给出完全错误的排查方向。
        let payload;
        try {
            const response = await fetch(
                `${this.binanceApiBase}/ticker/24hr?symbol=${binanceSymbol}`,
                // 带超时：这条是首屏关键路径，挂住会让加载遮罩一直不消失
                { signal: AbortSignal.timeout(15000) }
            );

            // 带上状态码：出问题时能直接看出是 4xx 还是 5xx，
            // 而不是一句没有信息量的「Binance API error」
            if (!response.ok) throw new Error('HTTP ' + response.status);

            payload = await response.json();
        } catch (error) {
            console.error('获取价格数据失败:', error);
            // 不再用随机数顶替。取不到就如实说取不到，理由交给界面展示。
            this.markQuoteFailed(coinId, 'price', this.quoteFailureReason(error));
            return;
        }

        if (this.state.currentCoin !== coinId) return;

        const coinInfo = this.getCoinInfo(coinId);
        this.state.coinInfo = {
            id: coinId,
            symbol: coinInfo.symbol,
            name: coinInfo.name,
            image: coinInfo.image || '',
            current_price: parseFloat(payload.lastPrice),
            price_change_24h: parseFloat(payload.priceChange),
            price_change_percentage_24h: parseFloat(payload.priceChangePercent),
            high_24h: parseFloat(payload.highPrice),
            low_24h: parseFloat(payload.lowPrice),
            open_24h: parseFloat(payload.openPrice),
            weighted_avg_price: parseFloat(payload.weightedAvgPrice),
            trade_count: parseInt(payload.count, 10),
            total_volume: parseFloat(payload.volume),       // 成交量（币数量）
            quote_volume: parseFloat(payload.quoteVolume),  // 成交额（USDT）
            market_cap: 0,
        };

        this.updatePriceUI();
        this.markQuoteOk(coinId, 'price');
    },

    /**
     * 美股（币安 USDT-M 合约）的报价。
     *
     * 走合约的 ticker/24hr，字段名与现货一致（实测键名完全相同），
     * 所以这里复用 Stocks.toPriceInfo 做映射，避免两套解析逻辑各错各的。
     *
     * 失败时**不降级成模拟数据**：美股没有内置的基准价，
     * 用随机数顶替只会让用户看到一条根本不存在的行情。
     */
    async loadStockPriceData(coinId, binanceSymbol) {
        try {
            const info = await Stocks.ticker(binanceSymbol);
            if (!info) throw new Error('合约行情为空');
            if (this.state.currentCoin !== coinId) return;

            const coinInfo = this.getCoinInfo(coinId);
            this.state.coinInfo = Object.assign({
                id: coinId,
                symbol: coinInfo.symbol,
                name: coinInfo.name,
                image: coinInfo.image || '',
            }, info);

            this.updatePriceUI();
        } catch (error) {
            console.error('获取美股行情失败:', error);
            if (this.state.currentCoin === coinId) {
                this.showToast('美股行情获取失败：' + error.message);
            }
        }
    },

    // 获取币安K线间隔参数
    getBinanceInterval(tf) {
        const { interval } = this.getTimeframeConfig(tf);
        return { interval, limit: 200 };
    },

    // 加载K线数据（币安 API）
    /**
     * 取一段币安现货K线（纯取数，不碰任何界面状态）
     *
     * 抽出来是为了让「看图时加载」与「后台扫描已开启交易的币种」共用同一套 URL 与
     * 解析。两处各写一遍的话，早晚出现一边改了另一边没改 —— 这类分叉是这一路
     * 修下来最常见的 bug 来源。
     *
     * @param {string} binanceSymbol - 交易对，如 ETHUSDT
     * @param {number} tf - 周期（小时数）
     * @returns {Promise<Array>} 解析后的K线；失败抛错，由调用方决定怎么处理
     */
    async fetchBinanceKlines(binanceSymbol, tf) {
        const { interval, limit } = this.getBinanceInterval(tf);
        const response = await fetch(
            `${this.binanceApiBase}/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`,
            // 带超时：这条是首屏关键路径，挂住会让加载遮罩一直不消失
            { signal: AbortSignal.timeout(15000) }
        );

        if (!response.ok) throw new Error('HTTP ' + response.status);

        const data = await response.json();

        return data.map(item => ({
            time: Math.floor(item[0] / 1000),
            open: parseFloat(item[1]),
            high: parseFloat(item[2]),
            low: parseFloat(item[3]),
            close: parseFloat(item[4]),
            volume: parseFloat(item[5]),
        }));
    },

    async loadCandleData(coinId) {
        // CoinGecko 币种的K线由 loadCoinDataFromCoinGecko 负责
        if (this.getDataSource(coinId) === 'coingecko') return;

        const binanceSymbol = this.getBinanceSymbol(coinId);
        if (!binanceSymbol) {
            this.markQuoteFailed(coinId, 'klines', '该币种没有对应的币安现货交易对');
            return;
        }

        // 美股走合约 K线接口
        if (this.isStock(coinId)) {
            await this.loadStockCandleData(coinId, binanceSymbol);
            return;
        }

        // 周期在取数前就定下来并一路用到底。中途切周期时，回来的这份数据属于旧
        // 周期，不能再当成新周期的K线用：K线本身没错，错的是贴给它的周期标签，
        // 而复盘窗口（几根K线）是按周期算的。
        const tf = this.state.currentTimeframe;

        // try 只包住「取数 + 解析」。后面的指标计算与渲染若出错，
        // 那是程序问题，不该报成「K线取不到」。
        let candleData;
        try {
            candleData = await this.fetchBinanceKlines(binanceSymbol, tf);
        } catch (error) {
            console.error('获取K线数据失败:', error);
            // 不再生成随机K线顶替。取不到就如实说取不到。
            this.markQuoteFailed(coinId, 'klines', this.quoteFailureReason(error));
            return;
        }

        // 切币或切周期后才回来的响应必须丢弃，否则会把新币种/新周期的K线
        // 覆盖成旧的。之前只挡了切币这一路，切周期是漏的。
        if (this.state.currentCoin !== coinId || this.state.currentTimeframe !== tf) return;

        this.state.candleData = candleData;
        // 记下这份K线的身份，复盘时用它核对标的与周期
        this.state.candleMeta = { coinId, timeframe: tf };
        this.state.candleSource = 'binance';
        this.evaluatePredictions();
        this.calculateIndicators();
        // 闸门需要按K线时间对齐的资金费率分位，必须在K线就绪后计算
        await this.ensureFundingHistory(coinId);
        this.computeFundingPercentile();
        this.updateChart();
        // 先销掉「不可用」标记再刷信号，否则 updateSignal 会走不可用分支
        this.markQuoteOk(coinId, 'klines');
        this.updateSignal();
    },

    /**
     * 美股（币安 USDT-M 合约）的K线。
     *
     * 与现货路径的关键差异是**历史深度**：
     * 美股合约 2026 年才上线，实测 AAPLUSDT 最早一根日线是 2026-04-06，
     * 日线只有 166 根、周线只有 24 根。所以：
     *   - 请求 limit 仍按现有口径（200），但实际能拿到多少就多少；
     *   - 拿到的根数如果不够算长期均线，明确记下来并在界面上提示，
     *     而不是让 MA200 静默变成空值、用户以为指标坏了。
     */
    async loadStockCandleData(coinId, binanceSymbol) {
        try {
            const tf = this.state.currentTimeframe;
            const { interval, limit } = this.getBinanceInterval(tf);
            const candleData = await Stocks.klines(binanceSymbol, interval, limit);

            // 切币或切周期后才回来的响应必须丢弃（同 loadCandleData）
            if (this.state.currentCoin !== coinId || this.state.currentTimeframe !== tf) return;

            if (!candleData.length) throw new Error('合约K线为空');

            this.state.candleData = candleData;
            this.state.candleMeta = { coinId, timeframe: tf };
            this.state.candleSource = 'stock';
            // 窗口降级规则在 technical.js 里，这里按同一规则算出实际窗口再生成文案，
            // 保证「界面显示的窗口」和「评分实际用的窗口」永远是同一个
            this.state.stockDepthNotice = Stocks.depthWarning(
                tf, candleData.length,
                TechnicalAnalysis.pickLongMAWindow(candleData.length)
            );
            this.renderStockNotice();

            this.evaluatePredictions();
            this.calculateIndicators();
            // 闸门按K线时间对齐费率分位；美股费率历史偏短，样本不够时闸门会自动不过滤
            await this.ensureFundingHistory(coinId);
            this.computeFundingPercentile();
            this.updateChart();
            this.updateSignal();

        } catch (error) {
            console.error('获取美股K线失败:', error);
            // 与行情一致：不用模拟K线顶替，美股没有可参照的合成基准
            if (this.state.currentCoin === coinId) {
                this.showToast('美股K线获取失败：' + error.message);
            }
        }
    },

    // 加载恐惧贪婪指数
    async loadFearGreedIndex() {
        try {
            // 带超时：它在 loadDeferredData 的 Promise.allSettled 里，
            // 挂住会让这个 allSettled 永不落地，信号就一直停在「分析中」
            const response = await fetch('https://api.alternative.me/fng/?limit=1', { signal: AbortSignal.timeout(15000) });
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
            this.setDerivativesUnavailable('该币种没有对应的币安合约交易对');
            return;
        }

        try {
            const response = await fetch(
                `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${binanceSymbol}`,
                { signal: AbortSignal.timeout(5000) }
            );

            if (!response.ok) throw new Error('HTTP ' + response.status);

            const data = await response.json();

            this.state.derivatives = {
                fundingRate: parseFloat(data.lastFundingRate) * 100,
                nextFundingTime: data.nextFundingTime,
                openInterest: null
            };
            this.state.derivativesUnavailable = null;

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
                // 持仓量取不到不影响资金费率，保持 null
                console.warn('获取OI失败:', e.message);
            }

            this.updateDerivativesUI();

        } catch (error) {
            console.error('获取衍生品数据失败:', error);
            this.setDerivativesUnavailable(this.quoteFailureReason(error));
        }
    },

    /**
     * 标记衍生品数据取不到。
     *
     * 为什么不再造数：原来失败时会用 `(Math.random()-0.3)*0.1` 生成资金费率、
     * 再用随机数生成持仓量，还带一个从头到尾没有任何地方读取的 isMock 标记。
     * 资金费率是 calculateDerivativesScore 的唯一输入，随机值直接决定
     * 12% 权重的衍生品因子 —— 而这个因子要衡量的是「杠杆是否拥挤」，
     * 塞随机数等于给出一个随机的结论，且界面上看不出来。
     *
     * 现在置空：界面显示「—」并注明原因，评分里把这一项剔除、按剩余权重重算。
     */
    setDerivativesUnavailable(reason) {
        this.state.derivatives = null;
        this.state.derivativesUnavailable = reason || '取不到资金费率';
        this.updateDerivativesUI();
    },

    /**
     * 计算技术指标
     *
     * @param {Array} [candles] - 要计算的K线；省略则用当前显示的那份
     * @param {Object} [opts] - { commit:false } 表示「只算、不落地」。
     *        后台扫描其他币种时用它：要的是算出来的指标，不能把界面正在用的那份覆盖掉。
     * @returns {Object} 指标对象
     */
    calculateIndicators(candles, opts) {
        const data = candles || this.state.candleData;
        const commit = !opts || opts.commit !== false;
        const closes = data.map(d => d.close);
        const highs = data.map(d => d.high);
        const lows = data.map(d => d.low);
        const volumes = data.map(d => d.volume);
        const currentPrice = closes[closes.length - 1];

        const ma3 = TechnicalAnalysis.calculateSMA(closes, 3);
        const ma7 = TechnicalAnalysis.calculateSMA(closes, 7);
        const ma25 = TechnicalAnalysis.calculateSMA(closes, 25);
        const ma99 = TechnicalAnalysis.calculateSMA(closes, 99);
        const ma200 = TechnicalAnalysis.calculateSMA(closes, 200);

        // 长期均线（大趋势线）。
        //
        // 标的可能比 200 根K线还年轻：实测币安美股合约 2026-04-06 才上线，
        // 日线只有 166 根、周线只有 24 根。带 startTime 回溯、换 indexPriceKlines/
        // markPriceKlines 都取不到更早的数据（实测前者 167 根、后两者 170 根），
        // 因为这是**标的年龄**的限制，不是取数方式的问题 —— 再怎么补也补不出
        // 200 天前的成交记录。
        //
        // 所以这里按可用根数选出最长可用的窗口（200→150→120→99→60），
        // 拿它做大趋势判断，并把实际窗口如实标到界面上；
        // 连 60 都撑不住时（美股周线 24 根）才真的放弃这一项。
        const longWindow = TechnicalAnalysis.pickLongMAWindow(closes.length);
        const longMA = {
            window: longWindow,
            series: longWindow === null ? null
                : longWindow === 200 ? ma200
                    : TechnicalAnalysis.calculateSMA(closes, longWindow),
            substituted: longWindow !== null && longWindow !== 200,
            bars: closes.length,
        };

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

        // 3周期动量及其自适应死区
        // 死区取近50根K线平均波动幅度的0.6倍，使不同周期都有合理的灵敏度
        const roc = this.buildROC(closes, 3, 50, 0.6);

        // 计算成交量MA
        const volMa5 = TechnicalAnalysis.calculateSMA(volumes, 5);
        const volMa10 = TechnicalAnalysis.calculateSMA(volumes, 10);

        const indicators = {
            ma3,
            ma7,
            ma25,
            ma99,
            ma200,
            longMA,
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
            roc,
            supportResistance,
            volMa5,
            volMa10,
            currentPrice
        };

        // 只算不落地：调用方要的是返回值，不能碰界面状态
        if (!commit) return indicators;

        this.state.indicators = indicators;

        this.updateIndicatorsUI();
        this.updateQuickInfoBar();
        this.updateVolumeInfo();
        this.updateInfoTab();
        return indicators;
    },

    /**
     * 计算 N 周期动量（ROC）及其自适应死区
     *
     * 死区取近 window 根K线涨幅绝对值的均值乘以 factor，
     * 这样不同周期、不同币种都能自动获得合适的灵敏度阈值。
     *
     * 返回值里同时给出两个死区：
     *   scale        —— 只看「最后 window 根」，用于判断当前这一根
     *   scaleSeries  —— 逐根死区，第 i 根只用 [i-window+1, i] 的数据，
     *                   用于判断历史K线（K线上的买卖点标注与模拟盘回放）
     *
     * 为什么必须分开：判断「当前这一根」时两者数值相同（取样窗口都落在末尾），
     * 但一旦拿末尾的常数去套历史K线，历史信号就偷看了它之后 50 根K线的波动 ——
     * 这是未来函数。实测（ETH 200 根K线）会让 1 小时回放的每轮收益从 0.384%
     * 虚高到 0.535%、累计虚高约 1.8 个百分点，4 小时虚高约 0.5 个百分点。
     * 实时综合信号（calculateTechnicalScore）只用当前这一根，不受影响。
     *
     * @param {Array} closes - 收盘价序列
     * @param {number} period - 动量周期
     * @param {number} window - 自适应取样窗口
     * @param {number} factor - 死区系数
     * @returns {{value: number, scale: number, series: Array, scaleSeries: Array}}
     */
    buildROC(closes, period = 3, window = 50, factor = 0.6) {
        const n = closes.length;
        const series = new Array(n).fill(null);
        for (let i = period; i < n; i++) {
            series[i] = closes[i] / closes[i - period] - 1;
        }

        // 用取样窗口内的平均绝对波动作为死区基准
        let sum = 0;
        let count = 0;
        for (let i = Math.max(period, n - 1 - window); i < n; i++) {
            if (series[i] !== null) {
                sum += Math.abs(series[i]);
                count++;
            }
        }
        const scale = count ? (sum / count) * factor : 0.005;

        // 逐根死区：第 i 根只吃 [i-window, i] 的数据，不含未来。
        // 区间取法与上面的全局版完全一致，只是把「末尾」换成第 i 根 ——
        // 这样 scaleSeries[n-1] 恒等于 scale，判断当前这一根时两者不分叉。
        const scaleSeries = new Array(n).fill(null);
        for (let i = 0; i < n; i++) {
            let s = 0;
            let c = 0;
            for (let k = Math.max(period, i - window); k <= i; k++) {
                if (series[k] !== null) {
                    s += Math.abs(series[k]);
                    c++;
                }
            }
            scaleSeries[i] = c ? (s / c) * factor : 0.005;
        }

        return {
            value: series[n - 1],
            scale,
            series,
            scaleSeries,
        };
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
     * 计算K线上的买卖点序列
     *
     * 逐根K线用已算好的指标序列合成综合分，再按阈值归类为
     * 强烈买入 / 买入 / 强烈卖出 / 卖出，其余一律不产生信号。
     * 只在多空方向真正切换时落一个点。
     *
     * 权重与阈值由灵敏度档位提供，档位越低越偏重趋势项（滞后大但稳），
     * 档位越高越偏重领先项（滞后小但假信号多）。
     * 均衡档实测（BTC 200根K线）日线中位滞后 4→2 根、4小时 5→3 根，
     * 同时后续5根的方向命中率不降反升。
     *
     * 这里是图上买卖点标注与模拟交易的共同数据源：
     * 两边都从这一个序列取值，保证「图上看到的」和「模拟做出来的」永远一致。
     *
     * @param {Array} data - K线数据
     * @param {Object} ind - 技术指标
     * @param {Object} [preset] - 灵敏度档位，缺省取当前档位
     * @returns {Array} [{ index, time, price, label, side, strong, score }]
     */
    buildSignalSeries(data, ind, preset) {
        const series = [];
        if (!data || data.length < 30 || !ind) return series;

        const p = preset || this.getSensitivity();
        const W = p.weights;
        const TH = p.thresholds;
        const MIN_GAP = p.minGap;

        const len = data.length;
        const closes = data.map(d => d.close);
        const volumes = data.map(d => d.volume);

        const macdLine = (ind.macd && ind.macd.macd) || [];
        const signalLine = (ind.macd && ind.macd.signal) || [];
        const histLine = (ind.macd && ind.macd.histogram) || [];
        const kLine = (ind.kdj && ind.kdj.k) || [];
        const dLine = (ind.kdj && ind.kdj.d) || [];
        const ma3 = ind.ma3 || [];
        const ma7 = ind.ma7 || [];
        const ma25 = ind.ma25 || [];
        const stochK = (ind.stochRSI && ind.stochRSI.k) || [];
        const stochD = (ind.stochRSI && ind.stochRSI.d) || [];
        const upper = (ind.bollingerBands && ind.bollingerBands.upper) || [];
        const lower = (ind.bollingerBands && ind.bollingerBands.lower) || [];
        const rocSeries = (ind.roc && ind.roc.series) || [];
        const rocScale = (ind.roc && ind.roc.scale) || 0.005;
        // 逐根死区（无未来函数）。老调用方只给 roc.scale 时退回单一常数，
        // 但那条路径会让历史信号偷看未来，实测会虚高收益，只作兼容保留。
        const rocScaleSeries = (ind.roc && ind.roc.scaleSeries) || null;
        const rsiLine = TechnicalAnalysis.calculateRSI(closes, 14);

        const classify = (v) => {
            if (v >= TH.strongBuy) return '强烈买入';
            if (v >= TH.buy) return '买入';
            if (v <= TH.strongSell) return '强烈卖出';
            if (v <= TH.sell) return '卖出';
            return null;
        };

        const sideOf = (label) => {
            if (!label) return null;
            return label.indexOf('买入') > -1 ? 'buy' : 'sell';
        };

        let prevSide = null; // 'buy' | 'sell' | null
        let lastIdx = -99;

        for (let i = 1; i < len; i++) {
            // MACD 尚未就绪的K线无法合成评分
            if (macdLine[i] == null || signalLine[i] == null) {
                prevSide = null;
                continue;
            }

            let score = 50;

            // MACD 位置与柱体动能
            score += macdLine[i] > signalLine[i] ? W.macdPos : -W.macdPos;
            if (histLine[i] != null && histLine[i - 1] != null) {
                score += histLine[i] > histLine[i - 1] ? W.macdHist : -W.macdHist;
            }

            // 均线排列与价格相对位置（趋势确认，滞后较大）
            if (ma7[i] != null && ma25[i] != null) {
                score += ma7[i] > ma25[i] ? W.maCross : -W.maCross;
            }
            if (ma25[i] != null) {
                score += closes[i] > ma25[i] ? W.priceMa25 : -W.priceMa25;
            }

            // 领先因子：MA3/MA7 交叉
            if (ma3[i] != null && ma7[i] != null) {
                score += ma3[i] > ma7[i] ? W.maFast : -W.maFast;
            }

            // 领先因子：3周期动量（死区随波动自适应）
            const roc = rocSeries[i];
            if (roc != null) {
                const sc = (rocScaleSeries && rocScaleSeries[i] != null)
                    ? rocScaleSeries[i]
                    : rocScale;
                if (roc > sc) score += W.momentum;
                else if (roc < -sc) score -= W.momentum;
            }

            // 领先因子：StochRSI 方向
            if (stochK[i] != null && stochD[i] != null) {
                score += stochK[i] > stochD[i] ? W.stoch : -W.stoch;
            }

            // KDJ 动能方向
            if (kLine[i] != null && dLine[i] != null) {
                score += kLine[i] > dLine[i] ? W.kdj : -W.kdj;
            }

            // RSI 超买超卖
            const r = rsiLine[i];
            if (r != null) {
                if (r < 30) score += 10 * W.rsiScale;
                else if (r < 45) score += 3 * W.rsiScale;
                else if (r > 70) score -= 10 * W.rsiScale;
                else if (r > 55) score -= 3 * W.rsiScale;
            }

            // 布林带位置
            if (upper[i] != null && lower[i] != null) {
                if (closes[i] < lower[i]) score += W.boll;
                else if (closes[i] > upper[i]) score -= W.boll;
            }

            // 量价配合
            const priceUp = closes[i] > closes[i - 1];
            const volUp = volumes[i] > volumes[i - 1];
            if (priceUp && volUp) score += W.volume;
            else if (!priceUp && volUp) score -= W.volume;

            score = Math.max(0, Math.min(100, score));

            const label = classify(score);
            const side = sideOf(label);

            // 中性区间既不标注也不改变已有方向，避免评分在阈值附近抖动时反复重置
            if (!side) continue;
            // 只在多空方向真正切换时落点；同一方向内的强弱变化（买入↔强烈买入）不重复标注
            if (side === prevSide) continue;
            if (i - lastIdx < MIN_GAP) continue; // 间隔过近的翻转忽略，方向也不更新

            prevSide = side;

            series.push({
                index: i,
                time: data[i].time,
                price: closes[i],
                label,
                side,
                strong: label.indexOf('强烈') === 0,
                score,
            });

            lastIdx = i;
        }

        return series;
    },

    /**
     * 生成K线上的买卖点标注
     *
     * 直接由 buildSignalSeries 的结果转换而来，与模拟交易同源。
     * 只保留最近的标记，小屏不至于糊成一片；
     * 上限设为40：灵敏档信号较多（约30个），过低会把它裁到和均衡档一样多。
     *
     * 正在走形的那根K线（最后一根）还没收盘，它上面的信号随时可能翻掉甚至消失，
     * 模拟盘也明确不执行它 —— 实测这就是「图上看到箭头、模拟却没动作」的主因。
     * 所以这里给它浅色 + 「待确认」前缀，与已成立的信号区分开。
     */
    generateSignalMarkers(data, ind) {
        const lastIndex = data.length - 1;

        return this.buildSignalSeries(data, ind).map(s => {
            const pending = s.index === lastIndex;
            const solid = s.side === 'buy' ? '#089981' : '#f23645';
            const faded = s.side === 'buy' ? '#7fd4bb' : '#f8a0a8';

            return {
                time: s.time,
                position: s.side === 'buy' ? 'belowBar' : 'aboveBar',
                color: pending ? faded : solid,
                shape: s.side === 'buy' ? 'arrowUp' : 'arrowDown',
                text: pending ? `${this.pendingPrefix}${s.label}` : s.label,
                size: pending ? 1 : (s.strong ? 2 : 1),
            };
        }).slice(-40);
    },

    /**
     * 图表标注的悬停说明内容。
     *
     * 只给「待确认」标注返回内容，其余返回 null（即不弹气泡）。
     * 因为「待确认」的实际含义从标注本身看不出来，而它恰好最容易被误读 ——
     * 看上去像「已经卖了」，其实还没成立，模拟盘也不会执行。
     * 已成立的信号点一下就有完整弹窗，所以不需要悬停再来一遍。
     *
     * @param {Object} marker - 图上命中的标注
     * @returns {{title: string, lines: string[], hint: string}|null}
     */
    markerHoverTip(marker) {
        const text = String((marker && marker.text) || '');
        if (text.indexOf(this.pendingPrefix) !== 0) return null;

        const label = text.slice(this.pendingPrefix.length);
        const isBuy = marker.shape === 'arrowUp';
        return {
            title: text,
            lines: [
                '信号落在还没收盘的这根K线上，随时可能翻转或消失。',
                `要等它收盘才成立，届时按下一根K线开盘价${isBuy ? '买入' : '卖出'}。`,
                '模拟盘不执行待确认的信号。',
            ],
            hint: `点击可查看「${label}」的完整说明`,
        };
    },

    /**
     * 搜索里的 CoinGecko 分支：找出币安没收录的币种（例如 GWEI）。
     *
     * 只在关键词长度 ≥2 时触发；结果按符号与币安目录去重，
     * 避免同一个币出现两遍分不清来源。请求失败（含限频）静默处理，
     * 不能因为第二个数据源出问题就把币安的结果也拖没。
     */
    async searchCoinGeckoInto(query) {
        const q = String(query || '').trim();
        if (q.length < 2) {
            this.state.cgSearchResults = [];
            this.renderCgSearchResults();
            return;
        }

        // 注意要用 (x || 0) + 1：直接 ++ 一个 undefined 会得到 NaN，
        // 而 NaN !== NaN 恒为真，会导致下面的「丢弃过期结果」判断永远提前返回。
        const token = (this._cgSearchToken || 0) + 1;
        this._cgSearchToken = token;

        let list = [];
        try {
            list = await CoinGecko.search(q);
        } catch (e) {
            console.warn('[CoinGecko] 搜索失败:', e.message);
            return;
        }

        // 期间用户又改了关键词或关了弹窗，就丢弃这次结果
        if (token !== this._cgSearchToken) return;
        const modal = document.getElementById('coinSelectorModal');
        if (!modal || modal.classList.contains('hidden')) return;

        const have = new Set((this.state.coinCatalog || []).map(c => String(c.symbol || '').toUpperCase()));
        this.state.cgSearchResults = list
            .filter(c => c.symbol && !have.has(c.symbol))
            .slice(0, 8);
        this.renderCgSearchResults();
    },

    renderCgSearchResults() {
        const host = document.getElementById('cgSearchBlock');
        if (!host) return;
        const list = this.state.cgSearchResults || [];

        if (!list.length) {
            host.classList.add('hidden');
            host.innerHTML = '';
            return;
        }

        host.classList.remove('hidden');
        host.innerHTML =
            `<p class="px-3 pt-3 pb-1 text-[10px] text-text-tertiary">币安未收录，来自 CoinGecko：只提供行情与技术指标</p>` +
            list.map(c => `
                <button class="cg-result w-full text-left px-3 py-2.5 flex items-center justify-between gap-3"
                    data-cgid="${this.esc(c.id)}" data-symbol="${this.esc(c.symbol)}" data-name="${this.esc(c.name)}">
                    <span class="min-w-0">
                        <span class="flex items-center gap-1.5">
                            <span class="text-sm font-semibold">${this.esc(c.symbol)}</span>
                            <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600">CoinGecko</span>
                        </span>
                        <span class="block text-[11px] text-text-tertiary truncate">${this.esc(c.name)}${c.rank ? ' · 市值第 ' + Number(c.rank) : ''}</span>
                    </span>
                    <span class="text-[11px] text-blue-600 flex-shrink-0">查看</span>
                </button>`).join('');

        host.querySelectorAll('.cg-result').forEach(btn => {
            btn.addEventListener('click', () => this.selectCoinGeckoCoin({
                id: btn.dataset.cgid,
                symbol: btn.dataset.symbol,
                name: btn.dataset.name,
            }));
        });
    },

    /** 选中一个 CoinGecko 币种：登记元数据 → 加入自选 → 切换过去 */
    async selectCoinGeckoCoin(cg) {
        const coinId = this.addCoinFromCoinGecko(cg);
        if (!coinId) return;

        this.state.cgSearchResults = [];
        this._cgSearchToken = (this._cgSearchToken || 0) + 1;
        this.renderCgSearchResults();
        this.hideCoinSelectorModal();

        if (!this.state.watchlist.includes(coinId)) {
            this.registerWatchlist(coinId);
        }
        await this.switchCoin(coinId);
        this.showToast(`${cg.symbol} 数据来自 CoinGecko（币安未收录）`);
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

        const topPrice = document.getElementById('topCoinPrice');
        if (topPrice) {
            topPrice.textContent = TechnicalAnalysis.formatPrice(info.current_price);
            topPrice.className = `coin-header-price ${isPositive ? 'rise' : 'fall'}`;
        }
        const topChange = document.getElementById('topCoinChange');
        if (topChange) {
            topChange.textContent = `${isPositive ? '+' : ''}${changePercent.toFixed(2)}%`;
            topChange.className = `coin-header-change ${isPositive ? 'rise' : 'fall'}`;
            topChange.title = `24 小时涨跌幅 ${topChange.textContent}`;
        }

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
        const fr = deriv ? deriv.fundingRate : null;

        const frMiniEl = document.getElementById('fundingRateMini');
        if (!frMiniEl) return;

        if (Number.isFinite(fr)) {
            frMiniEl.textContent = fr.toFixed(4) + '%';
            frMiniEl.className = `text-lg font-bold tabular-nums ${fr > 0 ? 'text-rise-green' : 'text-fall-red'}`;
            frMiniEl.title = '';

            let frStatus = '正常';
            let frStatusColor = 'gold';
            if (fr > 0.1) {
                frStatus = '过高';
                frStatusColor = 'red';
            } else if (fr < -0.05) {
                frStatus = '负费率';
                frStatusColor = 'green';
            }
            this.setStatusBadge('fundingStatusMini', frStatus, frStatusColor);
        } else {
            // 取不到就清成 -- 并标出来。不能留着上一次的值 ——
            // 切币种时那会变成「拿 A 的资金费率显示成 B 的」。
            frMiniEl.textContent = '--';
            frMiniEl.className = 'text-lg font-bold tabular-nums text-text-tertiary';
            frMiniEl.title = this.state.derivativesUnavailable || '取不到资金费率';
            this.setStatusBadge('fundingStatusMini', '未取到', 'gray');
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

        // 长期均线（大趋势线）
        //
        // 窗口可能已经降级：标的比 200 根K线年轻时 MA200 不可得（实测币安美股
        // 合约日线只有 166 根），calculateIndicators 会改用最长可用窗口。
        // 这里必须把**实际用的是哪个窗口**显示出来，否则用户会以为看的是 MA200，
        // 拿一个 150 日均线的值去当 200 日牛熊线用。
        const lm = ind.longMA;
        const maLongLabel = document.getElementById('maLongLabel');
        const ma200El = document.getElementById('ma200Info');
        const maLongNote = document.getElementById('maLongNote');

        const lastLongMA = lm && lm.series && lm.series.length
            ? lm.series[lm.series.length - 1] : null;

        if (lastLongMA) {
            if (maLongLabel) maLongLabel.textContent = 'MA' + lm.window + ' 牛熊线';
            if (ma200El) {
                ma200El.textContent = '$' + TechnicalAnalysis.formatPrice(lastLongMA);
                ma200El.className = `text-base font-bold tabular-nums ${ind.currentPrice > lastLongMA ? 'text-rise-green' : 'text-fall-red'}`;
            }
            if (maLongNote) {
                maLongNote.textContent = lm.substituted
                    ? `${lm.bars} 根K线不足 200，MA200 不可得，此处改用 MA${lm.window}`
                    : '';
                maLongNote.classList.toggle('hidden', !lm.substituted);
            }
        } else {
            // 连最短的窗口都撑不住（例如美股周线只有 24 根）
            if (maLongLabel) maLongLabel.textContent = '长期均线';
            if (ma200El) {
                ma200El.textContent = '不可用';
                ma200El.className = 'text-base font-bold tabular-nums text-text-tertiary';
            }
            if (maLongNote) {
                const bars = (lm && lm.bars) || 0;
                maLongNote.textContent = `${bars} 根K线不足 60，长期均线不可得，大趋势项未参与评分`;
                maLongNote.classList.remove('hidden');
            }
        }

        // AHR999
        // 它是比特币专用的估值带（按 BTC 自身的历史增长曲线定标），对个股没有意义。
        // 个股上 ma200 取不到会让它一直是空值，这里直接写明「不适用」，
        // 而不是留一个让人以为「正在加载」的 --
        const ahrEl = document.getElementById('ahr999Info');
        if (ahrEl && this.currentIsStock()) {
            ahrEl.textContent = '不适用';
            ahrEl.className = 'text-base font-bold tabular-nums text-text-tertiary';
            ahrEl.title = 'AHR999 是比特币专用的估值指标，对个股不适用';
        } else if (ind.ahr999 && ind.ahr999.value !== null && !isNaN(ind.ahr999.value)) {
            this.setText('ahr999Info', ind.ahr999.value.toFixed(3));
        }

        // OI（持仓量）。取不到时显式清成 --，不要留着上一次的值 ——
        // 原来的写法是只在有值时 setText，于是切到取不到持仓量的币种时，
        // 界面上会继续显示上一个币种的持仓量。
        this.setText('oiInfo', (deriv && deriv.openInterest)
            ? TechnicalAnalysis.formatLargeNumber(deriv.openInterest)
            : '--');
    },

    setText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    },


    // 加载新闻
    async loadNews(coinId) {
        // 美股直接跳过：新闻源全是加密媒体，抓回来只会污染 state.newsList。
        // 综合评分那边虽然已经不计消息面，但没必要每 5 分钟白打三个外部接口。
        if (this.isStock(coinId || this.state.currentCoin)) {
            this.state.newsList = [];
            this.state.newsUnavailable = null;
            this._newsReady = true;
            this.renderNews();
            return;
        }
        try {
            const news = await NewsAnalyzer.fetchNews(coinId);
            this.state.newsList = news;
            // fetchNews 取不到内容时返回空数组、把原因写在 lastFailure 上。
            // 拿到非空内容就说明这次成功，清掉上一次的失败记录。
            this.state.newsUnavailable = news.length > 0
                ? null
                : (NewsAnalyzer.lastFailure || null);
            this.renderNews();
            this.updateSignal();
        } catch (error) {
            console.error('获取新闻失败:', error);
            // 异常也要落到界面上，否则用户看到的是「暂无新闻数据」，
            // 会以为抓取成功、只是真的没新闻
            this.state.newsList = [];
            this.state.newsUnavailable = (error && error.message) ? error.message : '请求失败';
            this.renderNews();
            this.updateSignal();
        } finally {
            // 无论成功或降级，标记新闻已就绪，此后才允许记录预测
            this._newsReady = true;
        }
    },

    /**
     * 资讯源名称列表，用于界面说明。
     *
     * 从 NewsAnalyzer 的实际配置里取，而不是在文案里手写一份 ——
     * 之前那段说明写死了「cryptocurrency.cv、币安公告、528btc」，
     * 换源之后就再也没对上过。文案跟着配置走，就不会再出现这种漂移。
     */
    newsSourceLabel() {
        if (typeof NewsAnalyzer === 'undefined') return '第三方资讯源';
        const names = ['cryptocurrency.cv'];
        (NewsAnalyzer.RSS_FEEDS || []).forEach(f => {
            if (f && f.label) names.push(f.label);
        });
        return names.join('、');
    },

    /**
     * 设置资讯区的情绪徽章。
     * 抽出来是因为它现在有五种状态（偏多/偏空/中性/不适用/未取到），
     * 每处都手写一遍文字与 className 很容易写岔。
     * @param {string} text
     * @param {string} cls - 颜色类（拼在基础类之后）
     */
    setNewsBadge(text, cls) {
        const badge = document.getElementById('newsSentimentBadge');
        if (!badge) return;
        badge.textContent = text;
        badge.className = 'text-xs px-2 py-0.5 rounded-full ' + cls;
    },

    // 渲染新闻（白色主题）
    renderNews() {
        const container = document.getElementById('newsList');
        const newsList = this.state.newsList;
        
        if (!container) return;

        // 美股：新闻源里根本没有个股资讯，这时候渲染「暂无新闻数据」会让用户
        // 以为是抓取失败，反复点刷新。所以直接说明这个板块对个股不适用。
        if (this.currentIsStock()) {
            this.setNewsBadge('不适用', 'bg-gray-100 text-text-secondary');
            container.innerHTML = `<div class="py-8 px-4 text-center">
                <p class="text-sm text-text-secondary">个股资讯暂未接入</p>
                <p class="text-xs text-text-tertiary mt-2 leading-relaxed">
                    当前的资讯源都是加密媒体（${this.newsSourceLabel()}），
                    对个股没有可用内容。与其拿加密新闻给个股凑一个情绪分，这里选择留空，
                    综合评分也不计入消息面（见顶部说明）。
                </p>
            </div>`;
            return;
        }

        if (!newsList || newsList.length === 0) {
            const reason = this.state.newsUnavailable;

            // 取不到就说取不到。不能写「暂无新闻数据」——
            // 那句话读起来像「这个币确实没什么可报道的」，会让用户以为抓取是成功的，
            // 从而把消息面 0 分当成真实结论。
            if (reason) {
                this.setNewsBadge('未取到', 'bg-amber-50 text-amber-700');
                container.innerHTML = `<div class="py-8 px-4 text-center">
                    <p class="text-sm text-text-secondary">新闻源暂时取不到内容</p>
                    <p class="text-xs text-text-tertiary mt-2 leading-relaxed">
                        ${this.esc(reason)}<br>
                        消息面暂不参与综合评分（因子面板里显示为「—」），点右上角「刷新」可重试。
                    </p>
                </div>`;
                return;
            }

            this.setNewsBadge('暂无', 'bg-gray-100 text-text-secondary');
            container.innerHTML = '<p class="text-text-secondary text-sm text-center py-8">暂无新闻数据</p>';
            return;
        }

        // 更新情感标签
        const newsScore = NewsAnalyzer.calculateNewsScore(newsList);
        if (newsScore.label === 'positive') {
            this.setNewsBadge(`情绪偏多 ${newsScore.score}分`, 'bg-rise-green/10 text-rise-green');
        } else if (newsScore.label === 'negative') {
            this.setNewsBadge(`情绪偏空 ${newsScore.score}分`, 'bg-fall-red/10 text-fall-red');
        } else {
            this.setNewsBadge(`情绪中性 ${newsScore.score}分`, 'bg-gray-100 text-text-secondary');
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

        // 图上「待确认」的标注文本带了前缀，查字典前必须去掉：
        // 字典的键是纯信号名，带前缀查不到，表现为「点上去没反应」。
        const raw = String(signalText || '');
        const pending = raw.indexOf(this.pendingPrefix) === 0;
        const signalName = pending ? raw.slice(this.pendingPrefix.length) : raw;

        const info = this.signalInfoMap[signalName];
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
        nameEl.textContent = signalName;

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

        // 待确认才显示那条说明。信号本身的解释是一样的，
        // 差别只在「成没成立」，所以复用同一个弹窗、只多一条提示。
        const pendingEl = document.getElementById('signalDetailPending');
        if (pendingEl) pendingEl.classList.toggle('hidden', !pending);

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
    updateSignal(skipTrack = false) {
        // CoinGecko 币种不出综合信号。
        // 放在这里统一拦截：新闻加载完、情绪指数回来时都会调 updateSignal，
        // 若只在加载路径上设一次，后到的调用会把「数据受限」重新覆盖成一个信号。
        if (this.getDataSource(this.state.currentCoin) === 'coingecko') {
            this.renderCgSignalState();
            return;
        }

        // 行情取不到时不出信号。
        // 同样放在这里统一拦截：新闻、恐慌指数回来时都会再调一次 updateSignal，
        // 不拦的话后到的调用会把「数据不可用」重新覆盖成一个看起来正常的信号。
        const uq = this.state.quoteUnavailable;
        if (uq && uq.coinId === this.state.currentCoin) {
            this.renderUnavailableSignalState();
            return;
        }

        const ind = this.state.indicators;

        const techScoreResult = TechnicalAnalysis.calculateTechnicalScore({
            rsi: ind.rsi,
            macd: ind.macd,
            ma3: ind.ma3,
            ma7: ind.ma7,
            ma25: ind.ma25,
            ma200: ind.ma200,
            // 大趋势用降级后的长期均线：窗口可能不是 200（标的太年轻），
            // 具体用哪个由 calculateIndicators 按可用根数决定
            longMA: ind.longMA,
            currentPrice: ind.currentPrice,
            bollingerBands: ind.bollingerBands,
            vwap: ind.vwap,
            obv: ind.obv,
            stochRSI: ind.stochRSI,
            kdj: ind.kdj,
            ahr999: ind.ahr999,
            roc: ind.roc
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
        //
        // 美股只保留前两项。剩下三项对个股不是「差一点」而是「根本不对」：
        //   - 恐慌贪婪指数衡量的是加密市场情绪，与苹果股价没有因果关系；
        //   - 新闻源全是加密资讯，给个股打出来的消息分是纯噪声；
        //   - 合约资金费率实测长期贴近 0（20 期样本绝对值均 < 0.035%），
        //     远低于 calculateDerivativesScore 的 0.05% 阈值，永远是 50 分，
        //     留着等于凭空给个股塞了一个常数项。
        //
        // 去掉三项后按剩余权重重新归一（技术面:量能 = 2:1），
        // 这样分值的量纲与加密币一致，阈值档位也还能沿用。
        const isStock = this.isStock(this.state.currentCoin);

        // 输入缺失的因子一律剔除并按剩余权重重算，而不是让它以常数 50 参与 ——
        // 界面上这些格子会显示「—」，若分值里还悄悄带着一个 50，
        // 用户按展示出来的因子根本复现不出这个总分（与美股剔除不适用因子同理）：
        //   - news 缺失：三个新闻源都没返回内容；
        //   - derivatives 缺失：fapi 取不到资金费率，calculateDerivativesScore
        //     在这种情况下恒定返回 50，那不是「中性」而是「没有输入」。
        const newsAvailable = !isStock && (this.state.newsList || []).length > 0;
        const derivAvailable = !isStock && this.hasFundingRate();

        const rawWeights = isStock
            ? { technical: 40, volume: 20, sentiment: 0, news: 0, derivatives: 0 }
            : {
                technical: 40, volume: 20, sentiment: 16,
                news: newsAvailable ? 12 : 0,
                derivatives: derivAvailable ? 12 : 0,
            };
        const wSum = rawWeights.technical + rawWeights.volume + rawWeights.sentiment +
            rawWeights.news + rawWeights.derivatives;

        const totalScore = Math.round((
            techScoreResult.score * rawWeights.technical +
            volumeResult.score * rawWeights.volume +
            (isStock ? 0 : sentimentScore * rawWeights.sentiment) +
            (newsAvailable ? newsScoreResult.score * rawWeights.news : 0) +
            (derivAvailable ? derivativesScore * rawWeights.derivatives : 0)
        ) / wSum);

        const signal = SignalGenerator.generateSignal(
            { ...techScoreResult, score: techScoreResult.score },
            (isStock || !newsAvailable)
                ? { score: null, topNews: [], label: 'na', positiveCount: 0, negativeCount: 0 }
                : { ...newsScoreResult, score: newsScoreResult.score },
            {
                supportResistance: ind.supportResistance,
                currentPrice: ind.currentPrice,
                sentimentScore,
                derivativesScore,
                volumeScore: volumeResult.score,
                volumeMetrics: volumeResult.metrics,
                volumeSignals: volumeResult.signals,
                totalScore,
                isStock,
                thresholds: this.getSensitivity().thresholds,
                breakdown: {
                    technical: techScoreResult.score,
                    volume: volumeResult.score,
                    // 股票把不适用的因子显式标成 null，界面据此显示「—」，
                    // 而不是显示一个看似有意义的 50 分。新闻与衍生品取不到时同理。
                    news: (isStock || !newsAvailable) ? null : newsScoreResult.score,
                    sentiment: isStock ? null : sentimentScore,
                    derivatives: derivAvailable ? derivativesScore : null,
                }
            }
        );

        // generateSignal 内部是 `newsData.score || 50`，传 null 进去也会被兜成 50，
        // 所以这里显式改写回 null，界面才会显示「—」而不是一个假的 50 分。
        if (isStock || !newsAvailable) signal.newsScore = null;

        this.state.signal = signal;
        this.state.signal.totalScore = totalScore;

        // 记录本次预测（仅在方向变化或上一轮已复盘时才会新增）
        // 切换灵敏度档位时跳过记录，避免频繁切换污染准确率统计
        if (!skipTrack) {
            this.trackPrediction(signal, {
                // 算法版本：改因子后能按版本分组对比准确率，见 ALGORITHM-CHANGELOG.md
                algoVersion: SignalGenerator.ALGORITHM_VERSION,
                // 因子快照：把「当时各因子读到什么」一起留档。
                //
                // 只存最终评分的话，事后无法回答「是哪个因子把方向带偏了」，
                // 而那正是这份记录要服务的问题。所以这里把参与加权的每个分项得分、
                // 当时用的权重、技术面内部的子因子拆分、关键指标读数，
                // 以及费率闸门状态，全部原样存下来。
                factors: {
                    breakdown: {
                        technical: techScoreResult.score,
                        volume: volumeResult.score,
                        news: (isStock || !newsAvailable) ? null : newsScoreResult.score,
                        sentiment: isStock ? null : sentimentScore,
                        derivatives: derivAvailable ? derivativesScore : null,
                    },
                    // 权重会随数据可得性变化（缺失因子被剔除后重新归一），
                    // 不存下来就无法还原总分是怎么算出来的
                    weights: rawWeights,
                    // 技术面内部拆解：能区分是 RSI 判错了还是均线判错了
                    technicalBreakdown: techScoreResult.breakdown || null,
                    volumeMetrics: volumeResult.metrics || null,
                    indicators: this.snapshotIndicators(ind),
                    sensitivity: this.state.sensitivity,
                    thresholds: this.getSensitivity().thresholds,
                    // 费率闸门：信号成立但被闸门拦下时，这里能看出原因
                    fundingPercentile: this.state.fundingPercentile,
                    gate: this.state.paperGate || null,
                    inputsAvailable: { news: newsAvailable, derivatives: derivAvailable, isStock: !!isStock },
                },
                criteria: {
                    directionThreshold: PredictionTracker.directionThreshold,
                    holdThreshold: PredictionTracker.holdThreshold,
                    horizonMs: PredictionTracker.getHorizonMs(
                        this.getTimeframeConfig(this.state.currentTimeframe).seconds
                    ),
                },
            });
        }

        // 买卖点会随灵敏度档位、K线周期变化，每次都重放一遍模拟账户
        this.syncPaperAccount();

        this.renderSignal();
        this.renderPredictTab();
        // 持仓市值随价格变动，每次信号刷新时同步模拟账户
        this.renderPaperTab();
    },

    /**
     * 按当前币种的K线买卖点回放模拟账户
     *
     * 与图上的买卖点标注同源（都取自 buildSignalSeries），
     * 因此不会再出现「图上标了买入、模拟却没有任何动作」的情况。
     *
     * 只回放已收盘的K线：最后一根是正在走的那根，信号会随价格摆动，
     * 拿它成交会让记录反复出现又消失。图上给这类信号标了「待确认」。
     *
     * 成交价不是信号K线自己的收盘价，而是它收盘之后、下一根K线的开盘价：
     * 信号要等收盘才成立，按收盘价成交等于要求同一瞬间完成下单。
     */
    syncPaperAccount() {
        if (typeof PaperTrader === 'undefined') return;

        const coinId = this.state.currentCoin;
        if (!PaperTrader.isEnabled(coinId)) return;
        if (PaperTrader.getAllocation(coinId) <= 0) return;

        const data = this.state.candleData;
        if (!data || data.length < 31) return;

        const prevAcc = PaperTrader.getAccount(coinId);
        const prevLast = prevAcc.trades.length
            ? prevAcc.trades[prevAcc.trades.length - 1].id
            : null;

        // 去掉正在走形的最后一根K线
        const closed = data.slice(0, data.length - 1);
        let series = this.buildSignalSeries(closed, this.state.indicators);

        // 闸门：买卖点负责触发，独立因子决定这次要不要真的成交
        const allow = this.buildPaperGateFilter();
        if (allow) series = series.filter(s => allow(s));

        // 成交口径：信号K线收盘后、按下一根K线的开盘价成交。
        //
        // 为什么不按信号K线自己的收盘价成交：信号要等那根K线走完才成立，
        // 按它的收盘价成交等于要求你在信号成立的同一瞬间完成下单。
        // 实测（ETH）两个价差 0.00bp、最差 0.12bp，所以改口径不改变结论，
        // 但口径本身站得住。
        //
        // 这里统一算出成交时刻与成交价再交给 PaperTrader：
        // series 的 index 就是 data 的下标（closed 是 data 的前缀），
        // 所以下一根K线就是 data[index + 1]，只有一个地方定义成交价。
        series = series
            // 最后一根已收盘K线的下一根就是正在走的那根，它的开盘价是
            // 已经确定的真实价（就是信号成立那一刻的价），可以成交。
            // 真取不到下一根的（理论上不会）直接跳过，不能拿信号价顶上。
            .filter(s => data[s.index + 1])
            .map(s => ({
                ...s,
                execTime: data[s.index + 1].time,
                execPrice: data[s.index + 1].open,
            }));

        const acc = PaperTrader.replay(coinId, series, this.state.currentTimeframe);
        if (!acc || !acc.trades.length) return;

        // 只有真的产生了新的买卖点才提示
        const last = acc.trades[acc.trades.length - 1];
        if (last.id === prevLast) return;

        const coin = this.getCoinInfo(coinId);
        this.showToast(
            `${coin.symbol} 模拟${last.side === 'buy' ? '买入' : '卖出'} @ $${TechnicalAnalysis.formatPrice(last.price)}`
        );
    },

    // ==================== 买卖点邮件提醒 ====================

    /**
     * 已开启交易、且能算出买卖点的币种
     *
     * 「已开启交易」= 在模拟盘里开启了且有配额 —— 这类币种图上标注的K线买卖点
     * 就是它的成交依据，也正是要提醒的内容。
     *
     * 两种情况排除：
     *   - 没有 strategyTimeframe：账户从未在某个周期上运行过，没有周期就算不出买卖点；
     *   - CoinGecko 来源的币种：取不到K线（看图时也不会给它们标买卖点）。
     */
    paperScanTargets() {
        if (typeof PaperTrader === 'undefined') return [];
        const accounts = (PaperTrader.load() || {}).accounts || {};
        const targets = [];
        Object.keys(accounts).forEach(coinId => {
            if (!PaperTrader.isEnabled(coinId)) return;
            if (PaperTrader.getAllocation(coinId) <= 0) return;
            const tf = PaperTrader.getAccount(coinId).strategyTimeframe;
            if (tf === undefined || tf === null) return;
            if (this.getDataSource(coinId) === 'coingecko') return;
            targets.push({ coinId, timeframe: tf });
        });
        return targets;
    },

    /**
     * 取某个币种在指定周期上的K线（供后台扫描用）
     * @returns {Promise<Array|null>} 取不到返回 null
     */
    async fetchCandlesFor(coinId, tf) {
        const binanceSymbol = this.getBinanceSymbol(coinId);
        if (!binanceSymbol) return null;
        if (this.isStock(coinId)) {
            const { interval, limit } = this.getBinanceInterval(tf);
            const candles = await Stocks.klines(binanceSymbol, interval, limit);
            return (candles && candles.length) ? candles : null;
        }
        return await this.fetchBinanceKlines(binanceSymbol, tf);
    },

    /**
     * 扫描「已开启交易」的币种，出现新的K线买卖点时发邮件提醒
     *
     * 口径与 syncPaperAccount 完全一致：去掉正在走形的最后一根K线，只用已收盘的
     * 算买卖点。正在走的那根信号会随价格摆动，拿它提醒就会出现「刚发出去就没了」。
     *
     * 刻意**不**调用 PaperTrader.replay：这里只负责提醒，不该趁用户没看某个币的
     * 时候替他把成交记录写进去。账户仍然只在你查看该币种时、按当时周期回放，
     * 而回放是纯重算，所以两边不会打架。
     *
     * 一个已知取舍：资金费率闸门是按「界面上那个币」的费率分位算的，后台扫描
     * 拿不到其他币种的分位，因此这里不做闸门过滤，只在邮件里如实标注闸门状态。
     * 闸门默认关闭，此时与图上的买卖点完全一致。
     */
    async notifyPaperSignals() {
        if (typeof PaperTrader === 'undefined' || typeof PredictionTracker === 'undefined') return;
        if (this._paperScanRunning) return;   // 上一轮没跑完就跳过，避免叠加
        if (!PredictionTracker.getSyncConfig().url) return;
        // 未登录不发：服务端那条接口要鉴权，否则同一局域网里谁都能让这台机器发邮件
        if (!PredictionTracker.getAuthSession().token) return;

        const targets = this.paperScanTargets();
        if (!targets.length) return;

        this._paperScanRunning = true;
        try {
            for (const t of targets) {
                try {
                    await this.scanPaperTarget(t);
                } catch (e) {
                    // 单个币种失败不影响其他币种；后台任务不打扰用户，只记日志
                    console.warn(`[提醒] ${t.coinId} 扫描失败:`, e.message);
                }
            }
        } finally {
            this._paperScanRunning = false;
        }
    },

    async scanPaperTarget(t) {
        const candles = await this.fetchCandlesFor(t.coinId, t.timeframe);
        if (!candles || candles.length < 31) return;

        // 与 syncPaperAccount 同一步：只取已收盘的K线。
        // 「已确认」的定义就是这一步 —— 正在走形的那根不参与，它的信号随时会翻，
        // 拿它发提醒就会出现「邮件刚发出去、那个点就没了」。
        const closed = candles.slice(0, candles.length - 1);
        // commit:false —— 这是给别的币种算指标，不能覆盖界面上那份
        const indicators = this.calculateIndicators(closed, { commit: false });
        const series = this.buildSignalSeries(closed, indicators);

        const marker = series[series.length - 1];
        if (!marker) return;

        // 只提醒「刚出现在最新那根已收盘K线上」的买卖点。
        //
        // series 里最后一个买卖点未必是新的：信号只在多空方向翻转时落点，一根 4 小时
        // K线上没有翻转，最后那个点就还停在几根K线之前。刚打开页面时若不加这道判断，
        // 会把一个几天前的买卖点当成「刚发生」发出去 —— 邮件里还写着「按下一根K线开盘价
        // 成交」，等于让人照着一个几天前的价位去下单。
        //
        // 代价是页面关着的那段时间里出现的买卖点不会补发，这与「必须开着页面才会提醒」
        // 是同一件事的两面，已在 README 里写明。
        //
        // 能走到这里，说明这个买卖点所在的K线**已经收盘**，也就是「已确认」——
        // 它不会再变，可以当成交依据，也才值得发一封邮件。
        if (marker.index !== closed.length - 1) return;

        // 同一个买卖点只提醒一次。服务端也会按 markerTime 去重，这里先挡一道，
        // 免得每轮扫描都白发一次请求、日志也刷屏。
        const seen = this._notifiedMarkers || (this._notifiedMarkers = {});
        const slot = `${t.coinId}|${t.timeframe}`;
        if (seen[slot] === marker.time) return;

        const info = this.getCoinInfo(t.coinId);
        const binanceSymbol = this.getBinanceSymbol(t.coinId) || '';
        const next = candles[marker.index + 1];

        // 买卖点本身只给 side 与「是否强烈」，档位由这两个组合出来
        const signalType = marker.strong
            ? (marker.side === 'buy' ? 'strong_buy' : 'strong_sell')
            : marker.side;

        // 含「正在走形那根」的指标与标注：配图与「待确认」判断共用这一份
        const view = this.markerChartView(candles);

        // 配图：这个买卖点所属币种、周期的K线，标注与界面同源
        const chart = this.buildMarkerChart(t, candles, marker, view);

        // 未收盘那根K线上的信号。它不单独发提醒（上面已经挡掉了），但要随这封邮件
        // 一起标成「待确认」并说清它不算数 —— 收信人会在图里看到一个浅色箭头，
        // 不说明白就会被当成又一个刚出现的买卖点。
        const pending = this.pendingSignalOf(view, candles);

        const result = await this.postNotice({
            coinId: t.coinId,
            // 币种简称优先用目录里的，取不到就从交易对里去掉 USDT
            coinSymbol: (info && info.symbol) || binanceSymbol.replace(/USDT$/, '') || t.coinId,
            timeframe: t.timeframe,
            signalType,
            signalText: marker.label,
            score: marker.score,
            price: marker.price,
            // 这个买卖点所在K线的时间（秒），服务端按它做「同一点不重复发」的去重
            markerTime: marker.time,
            // 成交口径：该K线收盘后、按下一根K线的开盘价成交（与模拟盘一致）
            execTime: next ? next.time : null,
            execPrice: next ? next.open : null,
            predictedAt: Date.now(),
            sensitivity: this.state.sensitivity,
            actionTip: this.paperTipFor(signalType, marker.score, marker.price),
            algoVersion: (typeof SignalGenerator !== 'undefined' && SignalGenerator.ALGORITHM_VERSION) || null,
            gate: this.getPaperGate().key,
            source: 'paper-marker',
            // 未收盘那根K线上的信号（可能没有，那就是 null）。服务端会把它标成
            // 「待确认」并写明不作为成交依据，与正文「本提醒只发已确认的信号」配对。
            pendingSignal: pending,
            // 没有配图时给 null，服务端按纯文字发
            chart: chart ? { base64: chart.base64, width: chart.width, height: chart.height } : null,
        });

        // 服务端已有定论（发出去了，或明确不会再发）就不再重试；
        // 传输失败（返回 null）不记，下一轮扫描会再试一次。
        if (result && (result.ok || result.skipped)) seen[slot] = marker.time;
    },

    /**
     * 含「正在走形那根K线」的指标、信号序列与标注
     *
     * 配图和「待确认」判断都要这一份 —— 界面上的画法也是这样（含未收盘那根），
     * 所以一次算好传下去，同一批K线不重复算两遍。
     *
     * @param {Array} candles - 完整K线（含最后一根未收盘的）
     * @returns {{ind:Object, series:Array, markers:Array}}
     */
    markerChartView(candles) {
        // commit:false —— 这是给别的币种算的，不能覆盖界面上那份
        const ind = this.calculateIndicators(candles, { commit: false });
        return {
            ind,
            series: this.buildSignalSeries(candles, ind),
            markers: this.generateSignalMarkers(candles, ind),
        };
    },

    /**
     * 正在走形那根K线上的「待确认」信号
     *
     * 这就是图上那个浅色箭头。它随价格摆动，随时可能翻转甚至消失，所以：
     * 既不作为成交依据，也不单独发提醒（提醒只发已收盘K线上已确认的买卖点）。
     * 但它会出现在邮件的配图里，必须把身份说清楚，不能让它冒充一个买卖点。
     *
     * 用 buildSignalSeries 而不是图上的标注来取：标注里的文案已经带了「待确认·」
     * 前缀，拿它当信号名会得到「待确认·买入」这种套娃的文案。
     *
     * @returns {{side:string,label:string,strong:boolean,price:number,time:number,score:number}|null}
     */
    pendingSignalOf(view, candles) {
        if (!view || !view.ind || !candles || !candles.length) return null;

        const series = view.series || this.buildSignalSeries(candles, view.ind);
        const last = series[series.length - 1];
        // 最近一个点不在最后一根K线上，说明正在走的这根上什么也没发生
        if (!last || last.index !== candles.length - 1) return null;

        return {
            side: last.side,
            label: last.label,
            strong: !!last.strong,
            price: last.price,
            time: last.time,
            score: last.score,
        };
    },

    /**
     * 为这次提醒画一张K线图，附在邮件里
     *
     * 用的是**这个买卖点所属**币种与周期的数据，不是界面上正在显示的那份 ——
     * 后台扫描时界面上很可能是别的币种，图不能张冠李戴。
     *
     * 均线与标注都取自「含正在走形那根」的完整序列，与界面上的画法一致，
     * 所以邮件里的箭头与页面上看到的是同一个点、同一个样子。
     * 也正因为含了未收盘那根，图里可能出现浅色箭头（待确认），图注必须交代清楚：
     * 深色箭头是本次已确认的买卖点，浅色那个还没成立、不是成交依据。
     *
     * 画不出来就返回 null（画布不可用、数据太少、图太大）。提醒本身不该因为配图失败而丢。
     *
     * @param {Object} t - 扫描目标 {coinId, timeframe}
     * @param {Array} candles - 完整K线（含未收盘那根）
     * @param {Object} marker - 本次已确认的买卖点
     * @param {Object} [view] - markerChartView 的结果，省去重复计算
     * @returns {{base64:string,width:number,height:number}|null}
     */
    buildMarkerChart(t, candles, marker, view) {
        if (typeof ChartSnapshot === 'undefined') return null;
        try {
            const info = this.getCoinInfo(t.coinId);
            const binanceSymbol = this.getBinanceSymbol(t.coinId) || '';
            const symbol = (info && info.symbol) || binanceSymbol.replace(/USDT$/, '') || t.coinId;
            const tfLabel = this.getTimeframeConfig(t.timeframe).label;

            const v = view || this.markerChartView(candles);
            const ind = v.ind;
            const pending = this.pendingSignalOf(v, candles);

            const shot = ChartSnapshot.render({
                candles,
                ma7: ind.ma7,
                ma25: ind.ma25,
                ma99: ind.ma99,
                markers: v.markers,
                focusTime: marker.time,
                title: `${symbol} · ${tfLabel}`,
                note: `本次买卖点（已确认）：${marker.label} · ${this.formatCandleTime(marker.time)} 收盘（北京时间）`,
                note2: pending
                    ? `浅色箭头＝待确认信号（${pending.label}，K线尚未收盘，不作为成交依据）`
                    : null,
            });
            if (!shot) return null;

            // 载荷要走 JSON POST，服务端请求体上限 2MB。超了就宁可只发文字，
            // 也不能让整封提醒因为一张图被丢掉。
            if (shot.base64.length > NOTIFY_CHART_MAX_BASE64) {
                console.warn(`[提醒] 配图过大（${Math.round(shot.base64.length / 1024)}KB），本次只发文字`);
                return null;
            }
            return shot;
        } catch (e) {
            console.warn('[提醒] 生成K线图失败:', e.message);
            return null;
        }
    },

    /** K线时间转北京时间文本，用于配图上的说明 */
    formatCandleTime(sec) {
        try {
            const d = new Date(sec * 1000);
            const p = n => String(n).padStart(2, '0');
            const parts = new Intl.DateTimeFormat('zh-CN', {
                timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
                day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
            }).formatToParts(d);
            const g = k => (parts.find(x => x.type === k) || {}).value || '';
            return `${g('year')}-${g('month')}-${g('day')} ${p(g('hour'))}:${p(g('minute'))}`;
        } catch (e) {
            return new Date(sec * 1000).toISOString();
        }
    },

    /**
     * 取某一档信号的仓位建议文案
     *
     * 直接问信号模块要，而不是在服务端再抄一份话术 —— 话术抄两份，改一处就会
     * 留下不一致。传最小输入是为了只让它产出「基于综合评分的仓位建议」那一条
     * （技术指标与消息面那几条诊断需要完整数据，这里没有，也不该在这里编）。
     *
     * 与邮件里取建议的规则相同：强烈买入的建议 type 是 'buy'、强烈卖出是 'sell'，
     * 取最后一个匹配项（前面那些是同方向的诊断，不是仓位建议）。
     *
     * @returns {string|null}
     */
    paperTipFor(signalType, score, price) {
        if (typeof SignalGenerator === 'undefined' || !SignalGenerator.generateActionTips) return null;
        try {
            const tips = SignalGenerator.generateActionTips(
                { signals: [] },
                { topNews: [], score: 50, positiveCount: 0, negativeCount: 0 },
                { currentPrice: price, supportResistance: null, breakdown: null },
                signalType,
                score
            ) || [];
            const want = signalType === 'strong_buy' ? 'buy'
                : (signalType === 'strong_sell' ? 'sell' : signalType);
            const hit = tips.filter(x => x.type === want);
            return hit.length ? hit[hit.length - 1].text : null;
        } catch (e) {
            // 建议文案取不到不该影响提醒本身
            return null;
        }
    },

    /**
     * 把一条提醒交给本地服务去发信
     *
     * 只负责传输，内容由调用方组装 —— 这样「什么算一个买卖点」与「邮件怎么发」
     * 各管一头，改一边不会牵动另一边。
     *
     * payload.force 用于「把同一条再发一次」：服务端已经支持，用来预览样式或
     * 确认收得到（比如刚配好邮箱时，最近那个买卖点其实已经错过了）。
     * 注意服务端的小时上限是绕不过的，force 只越过「同一点已发过」与冷却期。
     *
     * @returns {Promise<Object|null>} 服务端结论；传输失败返回 null
     */
    async postNotice(payload) {
        if (typeof PredictionTracker === 'undefined') return null;
        const cfg = PredictionTracker.getSyncConfig();
        const session = PredictionTracker.getAuthSession();
        if (!cfg || !cfg.url || !session || !session.token) return null;

        try {
            const body = { signal: payload };
            if (payload && payload.force) body.force = true;
            const resp = await fetch(`${cfg.url}/api/notify`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${session.token}`,
                },
                body: JSON.stringify(body),
                // 发信要连 SMTP 服务器并等对方接收完，比取行情慢，超时给宽一点
                signal: AbortSignal.timeout(30000),
            });
            let result = null;
            try { result = await resp.json(); } catch (e) { /* 非 JSON 就当没有 */ }
            if (result && result.ok) {
                console.log('[提醒] 邮件已发送:', result.subject);
            } else if (result && result.skipped) {
                console.log('[提醒] 未发送:', result.error);
            } else {
                console.warn('[提醒] 发送失败:', (result && result.error) || ('HTTP ' + resp.status));
            }
            return result;
        } catch (e) {
            console.warn('[提醒] 请求失败:', e.message);
            return null;
        }
    },

    // ==================== 推送邮箱设置（按账号隔离，必须本人验证） ====================
    //
    // 「提醒发到哪个邮箱」这个问题的答案不能由服务端猜、也不能由别人代填：
    // 每个账号填自己的地址，并且要证明那个地址真的能收到信 —— 做法是让服务端
    // 往该地址寄一个 6 位码，用户把码填回来。三件事都由这一小块串起来：
    // 填地址 → 发码 → 确认。后端实现见 server/store.js 的 /api/notify/email。
    //
    // 为什么不做「没填就用配置文件里那个 to」的兜底：那等于把某一个人的邮箱变成
    // 所有账号共用的收件箱 —— 谁注册一个账号都能往那个地址发信。宁可什么都不发。

    /**
     * 绑定「邮件提醒」区块的交互。等一帧后自己拉一次状态。
     */
    initMailNotify() {
        // 倒计时句柄与「正在确认」标记：都要在重新登录/重渲染时能被覆盖，所以放实例上
        this._mailCountdown = null;
        this._mailConfirming = false;
        this._mailInputDirty = false;
        this._mailState = null;
        this._mailToken = null;

        const on = (id, ev, fn) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener(ev, fn);
        };

        on('mailSendCodeBtn', 'click', () => this.mailRequestCode());
        on('mailConfirmBtn', 'click', () => this.mailConfirmCode());
        on('mailUnbindBtn', 'click', () => this.mailUnbind());

        const emailInput = document.getElementById('mailEmailInput');
        if (emailInput) {
            // 用户自己动过这个框就不再回写它：否则每次重渲染都会把他正在改的地址冲掉
            emailInput.addEventListener('input', () => { this._mailInputDirty = true; });
            emailInput.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); this.mailRequestCode(); }
            });
        }

        const codeInput = document.getElementById('mailCodeInput');
        if (codeInput) {
            // 只留数字并截到 6 位：验证码输入框里出现字母一定是误输入
            codeInput.addEventListener('input', () => {
                codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
            });
            codeInput.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); this.mailConfirmCode(); }
            });
        }

        this.renderMailNotify();
    },

    /**
     * 调后端「推送邮箱」接口。
     *
     * 复用「记录到后端」那套地址与登录令牌，所以后端地址只需要配一次；
     * 失败一律返回 {ok:false, error}，不抛 —— 调用方全都要把原因显示给用户。
     */
    async mailApi(method, path, body) {
        if (typeof PredictionTracker === 'undefined') return { ok: false, error: '未登录' };
        const cfg = PredictionTracker.getSyncConfig();
        const session = PredictionTracker.getAuthSession();
        if (!cfg || !cfg.url) return { ok: false, error: '还没配置后端地址：先在上面的「记录到后端」里填好并保存' };
        if (!session || !session.token) return { ok: false, error: '请先登录' };

        try {
            const resp = await fetch(`${cfg.url}/api/notify/email${path}`, {
                method,
                headers: Object.assign(
                    { Authorization: `Bearer ${session.token}` },
                    body ? { 'Content-Type': 'application/json' } : {}
                ),
                body: body ? JSON.stringify(body) : undefined,
                // 发验证码要等 SMTP 往返，比普通读写慢
                signal: AbortSignal.timeout(30000),
            });
            let data = null;
            try { data = await resp.json(); } catch (e) { /* 可能没有响应体 */ }
            if (!data || typeof data !== 'object') {
                return { ok: false, error: `后端返回异常（HTTP ${resp.status}）` };
            }
            return data;
        } catch (e) {
            return { ok: false, error: '连不上后端：' + e.message };
        }
    },

    /** 点「发送验证码」：把地址交给服务端，由服务端寄码 */
    async mailRequestCode() {
        const input = document.getElementById('mailEmailInput');
        const email = input ? input.value.trim() : '';
        if (!email) { this.mailSetHint('请先填写要接收提醒的邮箱地址', true); return; }

        const btn = document.getElementById('mailSendCodeBtn');
        if (btn) btn.disabled = true;

        const r = await this.mailApi('POST', '', { email });
        if (!r || !r.ok) {
            if (btn) btn.disabled = false;
            this.mailSetHint((r && r.error) || '发送失败', true);
            // 被冷却挡下时服务端会给出还要等多少秒，直接用它起倒计时，
            // 而不是让用户对着「请稍后再试」自己数
            if (r && r.retryAfterSec) this.mailStartCooldown(r.retryAfterSec);
            return;
        }

        this.mailShowCodeRow(true);
        const mins = Math.max(1, Math.round((r.expiresInSec || 600) / 60));
        this.mailSetHint(`验证码已发到 ${r.email}（${mins} 分钟内有效）。把 6 位数字填到下面并确认。`, false);
        this.mailStartCooldown(r.resendAfterSec || 60);
    },

    /** 点「确认」：把码交给服务端核验，通过后该地址才开始生效 */
    async mailConfirmCode() {
        if (this._mailConfirming) return;   // 连点两下不该打两次接口
        const input = document.getElementById('mailCodeInput');
        const code = input ? input.value.trim() : '';
        if (!/^\d{6}$/.test(code)) { this.mailSetHint('验证码是 6 位数字', true); return; }

        this._mailConfirming = true;
        try {
            const r = await this.mailApi('POST', '/confirm', { code });
            if (!r || !r.ok) {
                // 顺序要紧：先把状态拉回真实情况（码可能已经作废或过期，界面得跟着变），
                // 再把错误写上去。反过来的话重渲染会把错误提示冲掉，
                // 用户只看到「还没有推送邮箱」，完全看不出刚才哪一步错了。
                await this.renderMailNotify();
                this.mailSetHint((r && r.error) || '验证失败', true);
                return;
            }
            if (input) input.value = '';
            this.showToast(`推送邮箱已验证：${r.email}`);
            await this.renderMailNotify();
        } finally {
            this._mailConfirming = false;
        }
    },

    /** 解除绑定：之后不再发任何提醒，直到重新验证一个地址 */
    async mailUnbind() {
        const bound = this._mailState && this._mailState.email;
        if (bound && !confirm(`停止向 ${bound} 发送提醒？该地址的绑定会被清除。`)) return;

        const r = await this.mailApi('DELETE', '');
        if (!r || !r.ok) { this.mailSetHint((r && r.error) || '解除绑定失败', true); return; }

        const input = document.getElementById('mailEmailInput');
        if (input) input.value = '';
        this._mailInputDirty = false;
        this.showToast('已解除推送邮箱绑定');
        await this.renderMailNotify();
    },

    /**
     * 渲染推送邮箱状态。
     *
     * 五种状态，都必须区分开：未登录 / 后端没配发信账号 / 未设置 / 待验证 / 已启用。
     * 尤其「未登录」和「未设置」不能混为一谈 —— 前者点按钮会直接 401，
     * 而后者只要填个地址就行；混在一起的提示等于让人白试一次。
     */
    async renderMailNotify() {
        const tag = document.getElementById('mailTag');
        if (!tag) return;

        const session = (typeof PredictionTracker !== 'undefined') ? PredictionTracker.getAuthSession() : null;
        if (!session || !session.token) {
            this._mailState = null;
            this.mailSetTag('未登录', 'gray');
            this.mailSetControls(false);
            this.mailShowCodeRow(false);
            this.mailShowUnbindRow(false);
            this.mailSetHint('登录之后才能设置推送邮箱：地址按账号隔离，得先知道你是谁。', false);
            return;
        }

        const r = await this.mailApi('GET', '');
        if (!r || !r.ok) {
            this._mailState = null;
            this.mailSetTag('不可用', 'red');
            this.mailSetControls(false);
            this.mailShowCodeRow(false);
            this.mailShowUnbindRow(false);
            this.mailSetHint((r && r.error) || '读取推送邮箱设置失败', true);
            return;
        }

        this._mailState = r;

        // 回显完整地址（不脱敏）：这是他自己填的，脱敏只会让他看不出错在哪。
        // 换账号登录时强制回写一次，否则会把上一个账号的地址留在框里。
        const emailInput = document.getElementById('mailEmailInput');
        if (emailInput && (!this._mailInputDirty || this._mailToken !== session.token)) {
            const shown = r.email || (r.pending && r.pending.email) || '';
            if (emailInput.value !== shown) emailInput.value = shown;
        }
        this._mailToken = session.token;
        this._mailInputDirty = false;

        const pending = r.pending && r.pending.email ? r.pending : null;

        if (!r.smtpReady) {
            // 服务端的发信账号还没配好，验证码根本发不出去 —— 先说清楚，
            // 否则用户会一直点「发送验证码」并以为是自己填错了
            this.mailSetTag('发信未配置', 'red');
            this.mailSetControls(false);
            this.mailShowCodeRow(false);
            this.mailShowUnbindRow(!!r.email);
            this.mailSetHint('本机服务还没配置发信邮箱，验证码发不出去：' + (r.smtpReason || ''), true);
            return;
        }

        this.mailSetControls(true);
        this.mailShowCodeRow(!!pending);
        this.mailShowUnbindRow(!!r.email);

        const bound = document.getElementById('mailBoundText');
        if (bound) bound.textContent = r.email ? `当前：${r.email}` : '';

        if (r.verified && r.email && !pending) {
            this.mailSetTag('已启用', 'green');
            this.mailSetHint(`提醒会发到 ${r.email}。想换地址就填一个新的、再验证一次；解除绑定后不再发信。`, false);
            return;
        }

        if (pending) {
            this.mailSetTag(r.email ? '改绑待验证' : '待验证', 'amber');
            const mins = Math.max(1, Math.round(pending.expiresInSec / 60));
            const wait = pending.resendAfterSec > 0 ? `，${pending.resendAfterSec} 秒后可重发` : '';
            const tail = r.email
                ? `验证通过前仍会发到 ${r.email}。`
                : '验证通过后才会开始发提醒。';
            this.mailSetHint(`验证码已发到 ${pending.email}（约 ${mins} 分钟内有效${wait}）。${tail}`, false);
            if (pending.resendAfterSec > 0) this.mailStartCooldown(pending.resendAfterSec);
            return;
        }

        this.mailSetTag('未设置', 'gray');
        this.mailSetHint('还没有推送邮箱，所以现在收不到任何提醒。填一个你自己的地址，点「发送验证码」，再把收到的 6 位数字填回来。', false);
    },

    /** 发码后的倒计时。按钮上的秒数是最直观的「还要等多久」 */
    mailStartCooldown(seconds) {
        const btn = document.getElementById('mailSendCodeBtn');
        if (!btn) return;
        clearInterval(this._mailCountdown);

        let left = Math.max(1, Math.round(Number(seconds) || 0));
        const tick = () => {
            if (left <= 0) {
                clearInterval(this._mailCountdown);
                this._mailCountdown = null;
                btn.disabled = false;
                btn.textContent = '发送验证码';
                return;
            }
            btn.disabled = true;
            btn.textContent = `${left} 秒后可重发`;
            left--;
        };
        tick();
        this._mailCountdown = setInterval(tick, 1000);
    },

    mailSetTag(text, tone) {
        const el = document.getElementById('mailTag');
        if (!el) return;
        el.textContent = text;
        el.className = 'text-[10px] px-1.5 py-0.5 rounded-full ' + (
            tone === 'green' ? 'bg-green-100 text-rise-green'
                : tone === 'red' ? 'bg-red-100 text-fall-red'
                    : tone === 'amber' ? 'bg-amber-100 text-amber-700'
                        : 'bg-gray-200 text-text-secondary');
    },

    mailSetHint(text, isError) {
        const el = document.getElementById('mailHint');
        if (!el) return;
        el.textContent = text || '--';
        el.className = 'text-[10px] mt-1.5 leading-relaxed ' + (isError ? 'text-fall-red' : 'text-text-tertiary');
    },

    /** 开关一组控件。整体禁用比逐个藏起来更好懂：状态是「现在不能用」而不是「没有这回事」 */
    mailSetControls(enabled) {
        ['mailEmailInput', 'mailSendCodeBtn', 'mailCodeInput', 'mailConfirmBtn', 'mailUnbindBtn']
            .forEach(id => {
                const el = document.getElementById(id);
                if (el) el.disabled = !enabled;
            });
    },

    /**
     * 显示/隐藏一行控件。
     *
     * hidden 与 flex 都会写 display，Tailwind 里谁生效取决于样式表顺序，
     * 所以两个类必须一起切 —— 只切 hidden 会出现「藏不住」或「出来但不横排」。
     */
    mailToggleRow(id, show) {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('hidden', !show);
        el.classList.toggle('flex', !!show);
    },

    mailShowCodeRow(show) { this.mailToggleRow('mailCodeRow', show); },
    mailShowUnbindRow(show) { this.mailToggleRow('mailUnbindRow', show); },

    // ==================== 币安测试网交易 ====================

    /**
     * 把任意文本转义后再插入 DOM。
     * 交易所返回的数据、用户输入都可能含特殊字符，直接拼进 innerHTML 就是 XSS 入口。
     */
    esc(v) {
        return String(v === undefined || v === null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    initBinance() {
        this._bnSide = 'BUY';
        this._bnPending = null;
        this._bnBalances = {};
        this._bnOpenOrders = [];

        const on = (id, ev, fn) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener(ev, fn);
        };

        on('bnConnectBtn', 'click', () => this.bnConnect());
        on('bnClearKeyBtn', 'click', () => this.bnClearKeys());
        on('bnDisconnectBtn', 'click', () => this.bnDisconnect());
        on('bnRefreshBtn', 'click', () => this.bnRefreshAccount());
        on('bnPreviewBtn', 'click', () => this.bnPreview());
        on('bnConfirmCancelBtn', 'click', () => this.bnCloseConfirm());
        on('bnConfirmBtn', 'click', () => this.bnSubmit());
        on('bnCancelAllBtn', 'click', () => this.bnCancelAll());
        on('bnKillBtn', 'click', () => this.bnKill());

        // 买卖方向
        document.querySelectorAll('.bn-side-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this._bnSide = btn.dataset.side;
                document.querySelectorAll('.bn-side-btn').forEach(b => {
                    b.classList.toggle('active', b.dataset.side === this._bnSide);
                });
                this.bnUpdatePreview();
            });
        });

        // 输入变化即时重算
        ['bnPrice', 'bnQty', 'bnType', 'bnSymbol'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', () => this.bnUpdatePreview());
        });

        document.querySelectorAll('.bn-side-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.side === 'BUY');
        });

        // 回填已保存的代理地址（代理地址不是机密，可以持久化）
        const proxyEl = document.getElementById('bnProxyInput');
        if (proxyEl && BinanceTestnet.getProxy()) proxyEl.value = BinanceTestnet.getProxy();
        if (BinanceTestnet.isProxyMode()) {
            BinanceTestnet.checkProxy().then(() => this.renderBinancePanel());
        }

        // 行情页的买入/卖出：切到交易页并预选方向，不直接下单
        const quick = (id, side) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', () => {
                this.setTradeMode('live');
                this.state.currentTab = null;   // 置空以强制走一次完整切换
                this.switchTab('trade');
                this._bnSide = side;
                document.querySelectorAll('.bn-side-btn').forEach(b => {
                    b.classList.toggle('active', b.dataset.side === side);
                });
                this.bnUpdatePreview();
            });
        };
        quick('quickBuyBtn', 'BUY');
        quick('quickSellBtn', 'SELL');
    },

    bnRenderSymbols() {
        const sel = document.getElementById('bnSymbol');
        if (!sel) return;
        // 美股不能进这个下拉框：这条链路是**现货**测试网，而美股只在合约市场。
        // 放进来只会让用户点一次、报一次错（现货接口上不存在 AAPLUSDT）。
        const list = (this.state.watchlist || [])
            .filter(id => !this.isStock(id))
            .map(id => ({
                id, sym: this.getBinanceSymbol(id), name: this.getCoinInfo(id).symbol,
            })).filter(x => x.sym);

        const cur = this.getBinanceSymbol(this.state.currentCoin);
        const keep = sel.value;
        sel.innerHTML = list.map(x =>
            `<option value="${this.esc(x.sym)}">${this.esc(x.name)}/${this.esc(x.sym.replace(x.name, ''))}</option>`
        ).join('');
        if (keep && list.some(x => x.sym === keep)) sel.value = keep;
        else if (cur && list.some(x => x.sym === cur)) sel.value = cur;
        else if (list.length) sel.value = list[0].sym;
    },

    renderBinancePanel() {
        const connected = BinanceTestnet.isConnected();
        const form = document.getElementById('bnConnectForm');
        const box = document.getElementById('bnConnectedBox');
        if (form) form.classList.toggle('hidden', connected);
        if (box) box.classList.toggle('hidden', !connected);

        ['bnOrderSection', 'bnOpenSection', 'bnHistorySection', 'bnKillSection'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.toggle('hidden', !connected);
        });

        const status = document.getElementById('bnStatus');
        if (status) {
            if (BinanceTestnet.isHalted()) {
                status.textContent = '已停止';
                status.className = 'text-[10px] px-1.5 py-0.5 rounded-full bg-fall-red/10 text-fall-red font-medium';
            } else if (connected) {
                status.textContent = '已连接';
                status.className = 'text-[10px] px-1.5 py-0.5 rounded-full bg-rise-green/10 text-rise-green font-medium';
            } else {
                status.textContent = '未连接';
                status.className = 'text-[10px] px-1.5 py-0.5 rounded-full bg-gray-200 text-text-secondary';
            }
        }

        if (connected) {
            this.bnRenderSymbols();
            this.bnUpdatePreview();
            this.bnRenderHistory();
        }
    },

    bnSetMessage(msg, kind) {
        const el = document.getElementById('bnMessage');
        if (!el) return;
        el.textContent = msg;
        el.className = 'text-[10px] mt-2 leading-tight ' +
            (kind === 'error' ? 'text-fall-red'
                : kind === 'ok' ? 'text-rise-green' : 'text-text-tertiary');
    },

    async bnConnect() {
        const el = document.getElementById('bnProxyInput');
        if (el) {
            const r = BinanceTestnet.setProxy(el.value);
            if (!r.ok) { this.bnSetMessage(r.message, 'error'); return; }
        }
        if (!BinanceTestnet.getProxy()) {
            this.bnSetMessage('请填写本地签名代理地址，例如 http://127.0.0.1:8787', 'error');
            return;
        }

        this.bnSetMessage('正在检查代理…');
        const h = await BinanceTestnet.checkProxy();

        if (!h.ok) {
            this.bnSetMessage(h.message || '代理不可用', 'error');
            this.renderBinancePanel();
            return;
        }
        if (!h.hasKeys) {
            this.bnSetMessage('代理已启动，但还没有配置测试网密钥。请用 BINANCE_KEY / BINANCE_SECRET 环境变量启动代理。', 'error');
            this.renderBinancePanel();
            return;
        }

        this.bnSetMessage(`已连接本地代理${h.host ? '（' + h.host + '）' : ''}。密钥保存在代理进程，浏览器未接触。`, 'ok');
        this.renderBinancePanel();
        await this.bnRefreshAccount();
        await this.bnLoadOrders();
    },

    bnClearKeys() {
        BinanceTestnet.setProxy('');
        const el = document.getElementById('bnProxyInput');
        if (el) el.value = '';
        this.bnSetMessage('已清除代理地址。');
        this.renderBinancePanel();
    },

    bnDisconnect() {
        BinanceTestnet.setProxy('');
        BinanceTestnet.clearCredentials();
        this._bnBalances = {};
        this._bnOpenOrders = [];
        const el = document.getElementById('bnProxyInput');
        if (el) el.value = '';
        this.bnSetMessage('已断开连接。', 'ok');
        this.renderBinancePanel();
    },

    /** 取余额表，返回 { USDT: free, BTC: free, ... } */
    bnExtractBalances(account) {
        const map = {};
        (account.balances || []).forEach(b => {
            const free = parseFloat(b.free || 0);
            if (free > 0) map[b.asset] = free;
        });
        return map;
    },

    async bnRefreshAccount() {
        if (!BinanceTestnet.isConnected()) return;
        try {
            const acc = await BinanceTestnet.getAccount();
            this._bnBalances = this.bnExtractBalances(acc);
            this.bnRenderAccount();
            this.bnUpdatePreview();
        } catch (e) {
            this.bnSetMessage('读取账户失败：' + e.message, 'error');
        }
    },

    bnRenderAccount() {
        const totalEl = document.getElementById('bnBalanceTotal');
        const detailEl = document.getElementById('bnBalanceDetail');
        if (!totalEl) return;

        const entries = Object.entries(this._bnBalances).sort((a, b) => b[1] - a[1]);
        const usdt = this._bnBalances.USDT || 0;
        totalEl.textContent = usdt.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' USDT';
        const others = entries.filter(([k]) => k !== 'USDT').slice(0, 4)
            .map(([k, v]) => `${k} ${v}`).join('　');
        detailEl.textContent = others ? '其他资产：' + others : '其他资产：无';
    },

    bnCurrentOrder() {
        const sel = document.getElementById('bnSymbol');
        const type = document.getElementById('bnType');
        const priceEl = document.getElementById('bnPrice');
        const qtyEl = document.getElementById('bnQty');
        return {
            symbol: sel ? sel.value : '',
            side: this._bnSide || 'BUY',
            type: type ? type.value : 'LIMIT',
            price: priceEl ? parseFloat(priceEl.value) : NaN,
            quantity: qtyEl ? parseFloat(qtyEl.value) : NaN,
        };
    },

    /** 市价单隐藏价格输入，限价单显示 */
    bnSyncTypeUI() {
        const type = document.getElementById('bnType');
        const priceEl = document.getElementById('bnPrice');
        const label = priceEl ? priceEl.closest('div') : null;
        if (!type || !label) return;
        const isMarket = type.value === 'MARKET';
        label.style.opacity = isMarket ? '0.45' : '1';
        if (priceEl) priceEl.disabled = isMarket;
    },

    bnUpdatePreview() {
        this.bnSyncTypeUI();
        const o = this.bnCurrentOrder();
        const notionalEl = document.getElementById('bnNotional');
        const feeEl = document.getElementById('bnFee');
        const availEl = document.getElementById('bnAvail');
        const hintEl = document.getElementById('bnRiskHint');

        const base = o.symbol ? o.symbol.replace('USDT', '') : '';
        const refPrice = this.state.coinInfo && this.state.coinInfo.current_price
            ? this.state.coinInfo.current_price : 0;
        const effPrice = o.type === 'LIMIT' ? o.price : refPrice;
        const notional = (o.quantity > 0 && effPrice > 0) ? o.quantity * effPrice : 0;

        if (notionalEl) notionalEl.textContent = notional > 0 ? notional.toFixed(2) + ' USDT' : '--';
        if (feeEl) feeEl.textContent = notional > 0 ? (notional * 0.001).toFixed(4) + ' USDT' : '--';

        if (availEl) {
            const v = o.side === 'BUY' ? (this._bnBalances.USDT || 0) : (this._bnBalances[base] || 0);
            availEl.textContent = `${v} ${o.side === 'BUY' ? 'USDT' : base}`;
        }

        if (hintEl) {
            const msgs = [];
            if (o.type === 'LIMIT' && refPrice > 0 && o.price > 0) {
                const dev = Math.abs(o.price / refPrice - 1);
                if (dev > 0.05) msgs.push(`限价偏离现价 ${(dev * 100).toFixed(1)}%`);
            }
            if (notional > BinanceTestnet.LIMITS.warnNotionalUSDT) {
                msgs.push(`单笔金额较大（${notional.toFixed(2)} USDT）`);
            }
            hintEl.textContent = msgs.length
                ? '注意：' + msgs.join('；') + '，确认时会要求再次核对。'
                : `单笔上限 ${BinanceTestnet.LIMITS.maxNotionalUSDT} USDT；限价偏差超 5% 会要求二次核对。`;
            hintEl.className = 'text-[10px] mt-2 leading-tight ' +
                (msgs.length ? 'text-amber-600' : 'text-text-tertiary');
        }
    },

    async bnPreview() {
        const o = this.bnCurrentOrder();
        if (!o.symbol) { this.showToast('请选择交易对'); return; }

        const base = o.symbol.replace('USDT', '');
        const refPrice = this.state.coinInfo && this.state.coinInfo.current_price
            ? this.state.coinInfo.current_price : 0;

        let v;
        try {
            v = await BinanceTestnet.validateOrder({
                symbol: o.symbol, side: o.side, type: o.type,
                price: o.price, quantity: o.quantity, refPrice,
                availableQuote: this._bnBalances.USDT || 0,
                availableBase: this._bnBalances[base] || 0,
            });
        } catch (e) {
            this.showToast('校验失败：' + e.message);
            return;
        }

        if (v.blocked || !v.ok) {
            this.showToast(v.errors[0] || '订单校验未通过');
            this.bnSetMessage(v.errors.join('；'), 'error');
            return;
        }

        this._bnPending = Object.assign({}, o, {
            quantity: v.normalizedQty, notional: v.notional, fee: v.fee,
            base, warnings: v.warnings, rules: v.rules,
        });
        this.bnShowConfirm();
    },

    bnShowConfirm() {
        const p = this._bnPending;
        const body = document.getElementById('bnConfirmBody');
        const modal = document.getElementById('bnConfirmModal');
        if (!p || !body || !modal) return;

        const row = (k, v, cls) =>
            `<div class="flex items-center justify-between text-xs">
                <span class="text-text-secondary">${this.esc(k)}</span>
                <span class="tabular-nums font-medium ${cls || ''}">${this.esc(v)}</span>
            </div>`;

        body.innerHTML = [
            row('交易对', p.symbol),
            row('方向', p.side === 'BUY' ? '买入' : '卖出',
                p.side === 'BUY' ? 'text-rise-green' : 'text-fall-red'),
            row('类型', p.type === 'LIMIT' ? '限价单 GTC' : '市价单'),
            p.type === 'LIMIT' ? row('价格', p.price + ' USDT') : '',
            row('数量', `${p.quantity} ${p.base}`),
            p.type === 'LIMIT' ? row('名义金额', p.notional.toFixed(2) + ' USDT') : '',
            row('预估手续费', p.fee.toFixed(4) + ' USDT'),
            p.warnings && p.warnings.length
                ? `<div class="rounded-lg bg-amber-50 px-3 py-2 mt-1">
                     <p class="text-[10px] text-amber-700 leading-tight">${this.esc(p.warnings.join('；'))}</p>
                   </div>` : '',
            `<p class="text-[10px] text-text-tertiary mt-1 leading-tight">
                这是币安<strong>测试网</strong>订单，使用虚拟资金，不影响真实资产。
             </p>`,
        ].join('');

        modal.classList.remove('hidden');
    },

    bnCloseConfirm() {
        const modal = document.getElementById('bnConfirmModal');
        if (modal) modal.classList.add('hidden');
        this._bnPending = null;
    },

    async bnSubmit() {
        const p = this._bnPending;
        if (!p) return;
        const btn = document.getElementById('bnConfirmBtn');
        if (btn) { btn.disabled = true; btn.textContent = '提交中…'; }

        try {
            const res = await BinanceTestnet.placeOrder({
                symbol: p.symbol, side: p.side, type: p.type,
                price: p.price, quantity: p.quantity,
            });
            this.bnCloseConfirm();
            this.showToast(`已提交：${p.side === 'BUY' ? '买入' : '卖出'} ${p.quantity} ${p.base}`);
            await this.bnLoadOrders();
            await this.bnRefreshAccount();
        } catch (e) {
            if (e.unknownState) {
                this.bnSetMessage('订单状态未知：' + e.message, 'error');
                this.bnCloseConfirm();
            } else {
                this.bnSetMessage('下单失败：' + e.message, 'error');
            }
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '确认下单'; }
        }
    },

    async bnLoadOrders() {
        if (!BinanceTestnet.isConnected()) return;
        const symEl = document.getElementById('bnSymbol');
        const symbol = symEl ? symEl.value : null;
        try {
            this._bnOpenOrders = await BinanceTestnet.getOpenOrders(symbol);
            this.bnRenderOpenOrders();
        } catch (e) {
            this.bnSetMessage('读取委托失败：' + e.message, 'error');
        }
        this.bnRenderHistory();
    },

    bnRenderOpenOrders() {
        const host = document.getElementById('bnOpenOrders');
        if (!host) return;
        const list = this._bnOpenOrders || [];
        if (!list.length) {
            host.innerHTML = `<p class="py-4 text-center text-[11px] text-text-tertiary">
                当前没有挂单。挂单会显示在这里，并可从这一处撤销。</p>`;
            return;
        }
        host.innerHTML = list.map(o => `
            <div class="py-2.5 flex items-center justify-between gap-3">
                <div class="min-w-0">
                    <div class="flex items-center gap-1.5">
                        <span class="text-[11px] font-medium ${o.side === 'BUY' ? 'text-rise-green' : 'text-fall-red'}">
                            ${o.side === 'BUY' ? '买入' : '卖出'}</span>
                        <span class="text-[11px] text-text-primary">${this.esc(o.symbol)}</span>
                        <span class="text-[10px] text-text-tertiary">${this.esc(o.type)}</span>
                    </div>
                    <p class="text-[10px] text-text-tertiary mt-0.5 tabular-nums">
                        价格 ${this.esc(o.price)}　数量 ${this.esc(o.origQty)}　已成交 ${this.esc(o.executedQty)}
                    </p>
                </div>
                <button class="bn-cancel-btn flex-shrink-0 px-3 py-2 rounded-lg bg-gray-100 text-[11px] text-text-secondary"
                    data-symbol="${this.esc(o.symbol)}" data-id="${this.esc(o.orderId)}">撤单</button>
            </div>`).join('');

        host.querySelectorAll('.bn-cancel-btn').forEach(btn => {
            btn.addEventListener('click', () => this.bnCancel(btn.dataset.symbol, btn.dataset.id));
        });
    },

    async bnCancel(symbol, orderId) {
        try {
            await BinanceTestnet.cancelOrder(symbol, orderId);
            this.showToast('已撤单');
            await this.bnLoadOrders();
        } catch (e) {
            this.bnSetMessage('撤单失败：' + e.message, 'error');
        }
    },

    async bnCancelAll() {
        const sel = document.getElementById('bnSymbol');
        const symbol = sel ? sel.value : null;
        if (!symbol) return;
        try {
            const res = await BinanceTestnet.cancelAllOrders(symbol);
            this.showToast(`已撤销 ${Array.isArray(res) ? res.length : 0} 笔挂单`);
            await this.bnLoadOrders();
        } catch (e) {
            this.bnSetMessage('批量撤单失败：' + e.message, 'error');
        }
    },

    async bnKill() {
        const sel = document.getElementById('bnSymbol');
        const symbol = sel ? sel.value : null;
        const r = await BinanceTestnet.killSwitch(symbol);
        this.bnSetMessage(
            r.error ? `已置为停止状态，但撤单失败：${r.error}`
                : `已紧急停止，撤销 ${r.cancelled} 笔挂单。请到币安 API 管理页撤销该密钥以彻底止血。`,
            r.error ? 'error' : 'ok');
        this.renderBinancePanel();
        await this.bnLoadOrders();
    },

    bnRenderHistory() {
        const host = document.getElementById('bnHistory');
        const countEl = document.getElementById('bnHistoryCount');
        if (!host) return;
        const list = BinanceTestnet.getJournal();
        if (countEl) countEl.textContent = list.length ? `共 ${list.length} 笔` : '';

        if (!list.length) {
            host.innerHTML = `<p class="py-4 text-center text-[11px] text-text-tertiary">
                还没有下单记录。每次真实下单都会记在这里，便于查历史。</p>`;
            return;
        }
        host.innerHTML = list.slice(0, 50).map(o => {
            const t = new Date(o.time);
            const time = t.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
            return `<div class="py-2.5">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-1.5">
                        <span class="text-[11px] font-medium ${o.side === 'BUY' ? 'text-rise-green' : 'text-fall-red'}">
                            ${o.side === 'BUY' ? '买入' : '卖出'}</span>
                        <span class="text-[11px]">${this.esc(o.symbol)}</span>
                        <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-text-secondary">${this.esc(o.status)}</span>
                    </div>
                    <span class="text-[10px] text-text-tertiary tabular-nums">${this.esc(time)}</span>
                </div>
                <p class="text-[10px] text-text-tertiary mt-0.5 tabular-nums">
                    ${this.esc(o.type)}　价格 ${this.esc(o.price)}　数量 ${this.esc(o.origQty)}　已成交 ${this.esc(o.executedQty)}
                </p>
            </div>`;
        }).join('');
    },

    /**
     * 展示「信号强度」与「历史实测命中率」。
     *
     * 为什么要把两个数并排：评分是 0~100 的相对强弱，非常容易被当成胜率。
     * 而多轮回测的结论是这套买卖点在统计上与抛硬币无法区分，
     * 所以必须把区间和样本量一起摊开，让人看到「强度高」并不等于「赢面大」。
     */
    renderSignalBenchmark(totalScore) {
        const scoreEl = document.getElementById('sigScorePct');
        const rateEl = document.getElementById('sigHitRate');
        const sampleEl = document.getElementById('sigHitSample');
        const noteEl = document.getElementById('sigHitNote');
        if (scoreEl) {
            scoreEl.textContent = isFinite(totalScore) ? Math.round(totalScore) + ' / 100' : '--';
        }

        let st = null;
        try {
            st = PredictionTracker.getStats(this.state.currentCoin, this.state.currentTimeframe);
        } catch (e) { st = null; }

        const n = st ? (st.directionalTotal || 0) : 0;
        if (!n) {
            if (rateEl) {
                rateEl.textContent = '样本不足';
                rateEl.className = 'text-sm font-bold tabular-nums text-text-tertiary';
            }
            if (sampleEl) sampleEl.textContent = '尚无已结算的方向性记录';
            if (noteEl) noteEl.textContent = '当前币种与周期还没有足够的已结算记录，积累后会自动显示。';
            return;
        }

        const p = st.directionalAccuracy / 100;
        const se = Math.sqrt(p * (1 - p) / n);
        const lo = Math.max(0, (p - 1.96 * se) * 100);
        const hi = Math.min(100, (p + 1.96 * se) * 100);

        if (rateEl) {
            rateEl.textContent = (p * 100).toFixed(1) + '%';
            // 只有区间完全落在 50% 之上或之下才上色，否则保持中性
            rateEl.className = 'text-sm font-bold tabular-nums ' +
                (lo > 50 ? 'text-rise-green' : hi < 50 ? 'text-fall-red' : 'text-text-primary');
        }
        if (sampleEl) {
            sampleEl.textContent = `N=${n}　95% 区间 ${lo.toFixed(1)}%~${hi.toFixed(1)}%`;
        }
        if (noteEl) {
            noteEl.textContent = (lo <= 50 && hi >= 50)
                ? '评分是信号强度，不等于胜率。当前命中率的 95% 区间跨过 50%，还无法与抛硬币区分。'
                : '评分是信号强度，不等于胜率。当前命中率区间未跨过 50%，但样本仍有限，需继续观察。';
        }
    },

    /**
     * 挑出要留档的指标读数。
     *
     * 不把整个 indicators 对象存进去：它带着大量中间序列（均线数组、布林带历史等），
     * 一条记录就能撑到几十 KB，150 条会把 localStorage 塞满。这里只留事后分析
     * 真正会用到的标量 —— 判断方向时各因子的读数就是这几个。
     *
     * @param {Object} ind - this.state.indicators
     * @returns {Object|null}
     */
    snapshotIndicators(ind) {
        if (!ind) return null;
        // 必须兼容数组。state.indicators 里这些指标存的是**整段序列**：
        //   - ma7 / ma25 / ma200 本身是数组
        //   - macd 的 macd/signal/histogram、kdj 的 k/d/j、stochRSI、bollingerBands
        //     每一项也都是数组（buildROC 同理，标量在 .value 上）
        // 只有 rsi / currentPrice / ahr999.value / roc.value 是标量。
        //
        // 这一点最初写错了（按标量取），结果 MACD、KDJ、均线全部记成 null ——
        // 而它们正是权重最高的几个因子，等于让整套因子留档在最关键处失效。
        const num = v => {
            const last = Array.isArray(v) ? v[v.length - 1] : v;
            return (typeof last === 'number' && isFinite(last)) ? last : null;
        };
        const macd = ind.macd || {};
        const kdj = ind.kdj || {};
        const stoch = ind.stochRSI || {};
        const boll = ind.bollingerBands || {};
        const roc = ind.roc || {};
        return {
            currentPrice: num(ind.currentPrice),
            rsi: num(ind.rsi),
            macd: {
                // ind.macd 上同时有 value（标量）和 macd（数组），两者是同一个数
                macd: num(macd.value !== undefined ? macd.value : macd.macd),
                signal: num(macd.signal),
                histogram: num(macd.histogram),
            },
            kdj: { k: num(kdj.k), d: num(kdj.d), j: num(kdj.j) },
            stochRSI: { k: num(stoch.k), d: num(stoch.d) },
            ma7: num(ind.ma7),
            ma25: num(ind.ma25),
            ma200: num(ind.ma200),
            bollinger: { upper: num(boll.upper), middle: num(boll.middle), lower: num(boll.lower) },
            ahr999: ind.ahr999 ? num(ind.ahr999.value) : null,
            roc: num(roc.value),
            // 死区基准也留档：roc 因子是「超过死区才算信号」，不记死区就无法解释它的读数
            rocScale: num(roc.scale),
        };
    },

    /**
     * 记录一次方向性预测
     *
     * @param {Object} signal - 信号对象
     * @param {Object} [extra] - { algoVersion, factors, criteria }：因子快照与复盘口径
     */
    trackPrediction(signal, extra) {
        if (!signal || !this.state.coinInfo) return;
        // coinInfo 必须是当前币种那一份。
        //
        // 原有防线是 applyQuoteUnavailable()：价格取不到时把 coinInfo 清成 null。
        // 但那条防线依赖 markQuoteFailed 被调用 —— 而请求挂住时（既不成功也不失败）
        // 它根本不会触发，coinInfo 就留着上一个币种的价格，被当成入场价记进预测，
        // 污染准确率统计。这里用 id 对齐，堵住这一类缺口。
        if (this.state.coinInfo.id !== this.state.currentCoin) return;
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
            algoVersion: (extra && extra.algoVersion) || null,
            factors: (extra && extra.factors) || null,
            criteria: (extra && extra.criteria) || null,
        });

        if (added) {
            console.log('[预测] 已记录:', signal.text, '@', price);
        }
    },

    /**
     * 用最新K线复盘到期的预测
     */
    evaluatePredictions() {
        // 用 candleMeta（这份K线自己的身份）而不是 currentCoin/currentTimeframe
        // （用户当前选中什么）。两者在切币/切周期之后、新数据回来之前并不一致，
        // 用后者会把旧的K线当成新标的的数据交给复盘。
        const meta = this.state.candleMeta;
        if (!meta) return;
        if (!this.state.candleData || this.state.candleData.length === 0) return;

        const updated = PredictionTracker.evaluate(
            this.state.candleData, meta.coinId, meta.timeframe
        );
        if (updated) {
            console.log('[预测] 有预测完成复盘');
        }

        // 顺手核对这个币已复盘的结论。在修复「用错标的复盘」之前写下的结论可能是
        // 错的，而 correct 一旦写入就永久生效，不会自己变对。首轮会改写那批记录，
        // 之后每次只是一遍本地比对（不产生写盘、不发请求），代价可以忽略。
        const fixed = PredictionTracker.verifyResolved(
            this.state.candleData, meta.coinId, meta.timeframe
        );
        if (fixed) {
            console.log(`[预测] 核对出 ${fixed} 条被用错标的复盘的记录，已按本标的K线修正`);
        }
    },

    /**
     * 为复盘取某个「币种 + 周期」的K线。
     *
     * 与界面取数的区别：这里不写任何 state、不触发渲染 —— 它服务的是「结算别的币种
     * 的预测」，那份数据不该覆盖用户正在看的图。
     *
     * @param {string} coinId
     * @param {number} timeframe
     * @param {number} oldestResolveAt - 该组最老的复盘时点，K线必须覆盖到它
     * @returns {Array|null} K线；取不到返回 null
     */
    async fetchCandlesForReview(coinId, timeframe, oldestResolveAt) {
        // CoinGecko 的粒度由时间跨度决定（30分钟/4小时/4天），与应用周期不是一回事，
        // 拿它复盘会算错复盘窗口，所以这一类直接不参与
        if (this.getDataSource(coinId) === 'coingecko') return null;

        const binanceSymbol = this.getBinanceSymbol(coinId);
        if (!binanceSymbol) return null;

        const { interval } = this.getBinanceInterval(timeframe);

        // 根数按要覆盖的时间跨度算：K线必须能覆盖到最老的那条记录，否则它永远结不了。
        // 下限沿用界面的 200 根，上限 1000 是币安单次请求的上限。
        const barMs = this.getTimeframeConfig(timeframe).seconds * 1000;
        const spanBars = Math.ceil((Date.now() - oldestResolveAt) / barMs) + 10;
        const limit = Math.min(1000, Math.max(200, spanBars));

        try {
            if (this.isStock(coinId)) {
                const rows = await Stocks.klines(binanceSymbol, interval, limit);
                return rows && rows.length ? rows : null;
            }
            const resp = await fetch(
                `${this.binanceApiBase}/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`,
                { signal: AbortSignal.timeout(15000) }
            );
            if (!resp.ok) throw new Error('HTTP ' + resp.status);

            const data = await resp.json();
            if (!Array.isArray(data) || !data.length) return null;
            return data.map(item => ({
                time: Math.floor(item[0] / 1000),
                open: parseFloat(item[1]),
                high: parseFloat(item[2]),
                low: parseFloat(item[3]),
                close: parseFloat(item[4]),
                volume: parseFloat(item[5]),
            }));
        } catch (e) {
            console.warn(`[预测复核] ${coinId}/${timeframe}h 取K线失败:`, e.message);
            return null;
        }
    },

    /** 用一份K线把某一组结算干净：先补未复盘的，再核对已复盘的 */
    reviewOneGroup(coinId, timeframe, candles) {
        if (!candles || !candles.length) return { evaluated: false, fixed: 0 };
        return {
            evaluated: PredictionTracker.evaluate(candles, coinId, timeframe),
            fixed: PredictionTracker.verifyResolved(candles, coinId, timeframe),
        };
    },

    /**
     * 批量复核：把界面没在看的那几个币种的预测也结算掉。
     *
     * 为什么需要它：复盘原先只在「切到那个币」时才发生，于是别的币种的预测一直挂在
     * 待复盘里 —— 实测待复盘的 30 条里，属于当前显示那个币的是 0 条。这里按
     * 「币种 + 周期」分组各取一次K线来结算。
     *
     * 每轮只处理若干组，避免一次打出十几个请求；剩下的靠 10 分钟节流慢慢追平。
     * 尽力而为：任何一组失败都不影响其他组，也不影响界面。
     *
     * @param {boolean} force - 忽略节流，立即跑一轮
     * @returns {Object} { fixed, evaluatedGroups, groupsLeft }
     */
    async reviewPendingPredictions(force) {
        if (typeof PredictionTracker === 'undefined') return { fixed: 0, evaluatedGroups: 0, groupsLeft: 0 };
        if (this._reviewRunning) return { fixed: 0, evaluatedGroups: 0, groupsLeft: 0 };

        const now = Date.now();
        const throttleMs = 10 * 60 * 1000;
        if (!force && this._lastReviewAt && now - this._lastReviewAt < throttleMs) {
            return { fixed: 0, evaluatedGroups: 0, groupsLeft: 0 };
        }

        const all = PredictionTracker.getReviewGroups();
        if (!all.length) return { fixed: 0, evaluatedGroups: 0, groupsLeft: 0 };

        // 当前显示的那一份已经有K线了，顺手用它，不必再发一次请求
        const meta = this.state.candleMeta;
        const isOnScreen = g => meta && g.coinId === meta.coinId && g.timeframe === meta.timeframe;
        const onScreen = all.filter(isOnScreen);
        const others = all.filter(g => !isOnScreen(g));

        const perRun = 8;
        const batch = others.slice(0, perRun);

        this._reviewRunning = true;
        let fixed = 0;
        let evaluatedGroups = 0;
        try {
            for (const g of onScreen) {
                if (!meta) break;
                const r = this.reviewOneGroup(meta.coinId, meta.timeframe, this.state.candleData);
                fixed += r.fixed;
                if (r.evaluated) evaluatedGroups++;
            }

            for (const g of batch) {
                const candles = await this.fetchCandlesForReview(g.coinId, g.timeframe, g.oldestResolveAt);
                if (!candles) continue;
                const r = this.reviewOneGroup(g.coinId, g.timeframe, candles);
                fixed += r.fixed;
                if (r.evaluated) evaluatedGroups++;
            }
        } catch (e) {
            console.warn('[预测复核] 本轮中断:', e.message);
        } finally {
            this._reviewRunning = false;
            this._lastReviewAt = Date.now();
        }

        const groupsLeft = Math.max(0, others.length - batch.length);
        if (evaluatedGroups || fixed) {
            console.log(`[预测复核] 本轮结算 ${evaluatedGroups} 组、修正 ${fixed} 条，剩余 ${groupsLeft} 组`);
        }
        return { fixed, evaluatedGroups, groupsLeft };
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

    /**
     * 资金费率是否可用。
     *
     * 取不到时 calculateDerivativesScore 会恒定返回 50 —— 那不是「中性」，
     * 是「没有输入」。必须把它从权重里剔除并按剩余权重重算，否则这个常数
     * 会以 12% 的权重把所有其它因子往 50 拉，而界面上这一格又会显示成「—」，
     * 用户按展示出来的因子复现不出总分。这与美股剔除同一因子的理由完全一致。
     */
    hasFundingRate() {
        const d = this.state.derivatives;
        return !!(d && Number.isFinite(d.fundingRate));
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
        // 美股额外标注「2 因子」：它的评分只由技术面与量能构成，
        // 与加密币的五因子分值不是同一口径，不标出来会被直接横向比较。
        if (signalStrengthTag) {
            signalStrengthTag.textContent = this.isStock(this.state.currentCoin)
                ? strengthText + ' · 2因子'
                : strengthText;
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

        this.renderSignalBenchmark(totalScore);

        // 五维评分 Mini
        const scoreColorOf = (v) => SignalGenerator.getScoreColor(v)
            .replace('crypto-', '').replace('green', 'rise-green').replace('red', 'fall-red').replace('gold', 'golden');

        // 因子值为 null 表示这个因子对该标的「不适用」（美股用不到加密情绪与加密新闻）。
        // 这时显示「—」并给出原因，而不是拿 50 分占位——那个 50 会被读成「中性」，
        // 用户会以为指标算过并且算出了中性。
        const setMini = (id, value, naReason) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (value === null || value === undefined) {
                el.textContent = '—';
                el.className = 'text-sm font-semibold mt-0.5 text-text-tertiary';
                el.title = naReason || '该因子不适用于当前标的';
            } else {
                el.textContent = value;
                el.className = `text-sm font-semibold mt-0.5 ${scoreColorOf(value)}`;
                el.title = '';
            }
        };

        setMini('techScoreMini', signal.techScore);
        setMini('volumeScoreMini', signal.breakdown?.volume ?? 50);
        setMini('sentimentScoreMini', signal.breakdown?.sentiment ?? null,
            '恐慌贪婪指数是加密市场指标，对个股不适用');
        setMini('newsScoreMini', signal.newsScore,
            this.currentIsStock()
                ? '当前资讯源只有加密资讯，对个股不适用'
                : '新闻源暂时取不到内容，该因子本次不参与评分');
        setMini('derivScoreMini', signal.breakdown?.derivatives ?? null,
            this.currentIsStock()
                ? '合约资金费率对美股长期贴近 0，该因子不可用'
                : '取不到资金费率（fapi.binance.com 不可达），该因子本次不参与评分');
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

        // 检查 MA3/MA7 短期交叉（领先因子）
        if (ind.ma3 && ind.ma7) {
            const len = Math.min(ind.ma3.length, ind.ma7.length);
            if (len >= 2) {
                const a1 = ind.ma3[len - 1], a0 = ind.ma3[len - 2];
                const b1 = ind.ma7[len - 1], b0 = ind.ma7[len - 2];
                if (a0 != null && b0 != null && a1 != null && b1 != null) {
                    if (a0 <= b0 && a1 > b1) {
                        signals.push({ name: 'MA3/MA7短期金叉', type: 'buy', strengthText: '中等' });
                        seen.add('MA3/MA7短期金叉');
                    } else if (a0 >= b0 && a1 < b1) {
                        signals.push({ name: 'MA3/MA7短期死叉', type: 'sell', strengthText: '中等' });
                        seen.add('MA3/MA7短期死叉');
                    }
                }
            }
        }

        // 检查 3周期动量（领先因子）
        if (ind.roc && ind.roc.value !== null && ind.roc.value !== undefined && !isNaN(ind.roc.value)) {
            const scale = ind.roc.scale || 0.005;
            if (ind.roc.value > scale) {
                signals.push({ name: '短期动量转强', type: 'buy', strengthText: '中等' });
                seen.add('短期动量转强');
            } else if (ind.roc.value < -scale) {
                signals.push({ name: '短期动量转弱', type: 'sell', strengthText: '中等' });
                seen.add('短期动量转弱');
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
        // 已经是 CoinGecko 币种就别覆盖，否则数据源路由会被改回币安
        const existing = this.state.coinMeta[coinId];
        if (existing && existing.source === 'coingecko') return;
        // 美股同理：被覆盖成没有 source 的元数据后会退回现货接口，价格直接变模拟数据
        if (existing && existing.source === 'stock') return;

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

        // 每5分钟刷新一次新闻，顺带跑一轮批量复核与买卖点扫描。
        // 复核自带 10 分钟节流，所以这里触发得比它密也无妨（多出来的是空调用）。
        setInterval(() => {
            this.loadNews(this.state.currentCoin);
            this.reviewPendingPredictions();
            // 扫一遍「已开启交易」的币种，出现新的K线买卖点时发邮件提醒。
            // 买卖点只在K线收盘时才可能变，5 分钟一次足够。
            this.notifyPaperSignals();
        }, 300000);

        // 启动后延迟跑一轮：等首屏数据与登录态就绪
        // （未登录时 notifyPaperSignals 会自己跳过，之后每5分钟那次再补上）
        setTimeout(() => this.notifyPaperSignals(), 25000);
    }
};

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    CryptoPulseApp.init();
});
