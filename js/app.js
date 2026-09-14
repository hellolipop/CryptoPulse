/**
 * CryptoPulse - 主应用逻辑
 * 负责数据获取、状态管理、UI更新和用户交互
 */

const CryptoPulseApp = {
    // 状态
    state: {
        currentCoin: 'bitcoin',
        currentTimeframe: 24, // 小时数
        watchlist: ['bitcoin', 'ethereum', 'binancecoin', 'solana', 'ripple'],
        coinInfo: {},
        priceData: null,
        candleData: [],
        indicators: {},
        newsList: [],
        signal: null,
        isLoading: false,
        lastUpdate: null,
        showSignalMarkers: true
    },

    // 币安 API 基础地址
    binanceApiBase: 'https://data-api.binance.vision/api/v3',

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

    // 获取币安交易对符号
    getBinanceSymbol(coinId) {
        const coin = this.popularCoins.find(c => c.id === coinId);
        return coin ? coin.binanceSymbol : null;
    },

    // 初始化
    async init() {
        this.loadWatchlist();
        this.bindEvents();
        this.initChart();
        this.renderCoinTabs();
        await this.loadCoinData(this.state.currentCoin);
        this.startAutoRefresh();
    },

    // 绑定事件
    bindEvents() {
        // 刷新按钮
        document.getElementById('refreshBtn').addEventListener('click', () => {
            this.loadCoinData(this.state.currentCoin, true);
        });

        // 新闻刷新
        document.getElementById('refreshNewsBtn').addEventListener('click', () => {
            this.loadNews(this.state.currentCoin);
        });

        // 时间周期切换
        document.querySelectorAll('.timeframe-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.timeframe-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                const tf = parseInt(e.target.dataset.tf);
                this.state.currentTimeframe = tf;
                this.loadCandleData(this.state.currentCoin);
            });
        });

        // MA显示切换
        document.getElementById('showMA').addEventListener('change', (e) => {
            ChartManager.toggleMA(e.target.checked);
        });

        // 成交量显示切换
        document.getElementById('showVolume').addEventListener('change', (e) => {
            ChartManager.toggleVolume(e.target.checked);
        });

        // 买卖信号显示切换
        document.getElementById('showSignals').addEventListener('change', (e) => {
            this.state.showSignalMarkers = e.target.checked;
            if (e.target.checked) {
                this.addSwingMarkers();
            } else {
                ChartManager.clearMarkers();
            }
        });

        // 重置视图按钮
        document.getElementById('resetViewBtn').addEventListener('click', () => {
            ChartManager.resetView();
        });

        // 更多指标折叠面板
        const toggleMoreBtn = document.getElementById('toggleMoreIndicators');
        if (toggleMoreBtn) {
            toggleMoreBtn.addEventListener('click', () => {
                const panel = document.getElementById('moreIndicatorsPanel');
                const arrow = document.getElementById('moreIndicatorsArrow');
                if (panel) {
                    panel.classList.toggle('hidden');
                    if (arrow) {
                        arrow.classList.toggle('rotate-180');
                    }
                }
            });
        }

        // 添加币种按钮
        const addCoinBtn = document.getElementById('addCoinBtn');
        if (addCoinBtn) {
            addCoinBtn.addEventListener('click', () => {
                this.showAddCoinModal();
            });
        }

        // 关闭模态框
        const closeModalBtn = document.getElementById('closeModalBtn');
        if (closeModalBtn) {
            closeModalBtn.addEventListener('click', () => {
                this.hideAddCoinModal();
            });
        }

        // 点击模态框外部关闭
        const addCoinModal = document.getElementById('addCoinModal');
        if (addCoinModal) {
            addCoinModal.addEventListener('click', (e) => {
                if (e.target.id === 'addCoinModal') {
                    this.hideAddCoinModal();
                }
            });
        }

        // 搜索币种
        const searchCoinInput = document.getElementById('searchCoinInput');
        if (searchCoinInput) {
            searchCoinInput.addEventListener('input', (e) => {
                this.searchCoins(e.target.value);
            });
        }

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
    },

    // 初始化图表
    initChart() {
        ChartManager.init('chartContainer');
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
        
        const currentCoin = localStorage.getItem('cryptoPulse_currentCoin');
        if (currentCoin && this.state.watchlist.includes(currentCoin)) {
            this.state.currentCoin = currentCoin;
        }
    },

    // 保存自选列表
    saveWatchlist() {
        localStorage.setItem('cryptoPulse_watchlist', JSON.stringify(this.state.watchlist));
        localStorage.setItem('cryptoPulse_currentCoin', this.state.currentCoin);
    },

    // 渲染币种标签
    renderCoinTabs() {
        const container = document.getElementById('coinTabs');
        container.innerHTML = '';

        this.state.watchlist.forEach(coinId => {
            const coinInfo = this.getCoinInfo(coinId);
            const isActive = coinId === this.state.currentCoin;
            
            const tab = document.createElement('div');
            tab.className = `coin-tab flex items-center gap-2 px-4 py-2 rounded-xl border border-crypto-border bg-crypto-card cursor-pointer flex-shrink-0 ${isActive ? 'active' : ''}`;
            tab.innerHTML = `
                <div class="w-6 h-6 rounded-full bg-gradient-to-br from-crypto-purple to-crypto-blue flex items-center justify-center text-xs font-bold text-white">
                    ${coinInfo.symbol.charAt(0)}
                </div>
                <div>
                    <p class="text-sm font-semibold">${coinInfo.symbol}</p>
                    <p class="text-xs text-gray-400">${coinInfo.name}</p>
                </div>
                ${this.state.watchlist.length > 1 ? `
                <button class="remove-coin ml-1 text-gray-500 hover:text-crypto-red transition-colors" data-coin="${coinId}">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                </button>
                ` : ''}
            `;
            
            tab.addEventListener('click', (e) => {
                if (!e.target.closest('.remove-coin')) {
                    this.switchCoin(coinId);
                }
            });
            
            container.appendChild(tab);
        });

        // 绑定删除按钮事件
        document.querySelectorAll('.remove-coin').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const coinId = btn.dataset.coin;
                this.removeFromWatchlist(coinId);
            });
        });
    },

    // 获取币种信息
    getCoinInfo(coinId) {
        return this.popularCoins.find(c => c.id === coinId) || {
            id: coinId,
            symbol: coinId.toUpperCase().slice(0, 4),
            name: coinId,
            image: '?'
        };
    },

    // 切换币种
    async switchCoin(coinId) {
        if (coinId === this.state.currentCoin) return;
        this.state.currentCoin = coinId;
        this.saveWatchlist();
        this.renderCoinTabs();
        await this.loadCoinData(coinId);
    },

    // 加载币种数据
    async loadCoinData(coinId, forceRefresh = false) {
        if (this.state.isLoading && !forceRefresh) return;

        this.state.isLoading = true;
        this.showLoading(true);

        try {
            await Promise.all([
                this.loadPriceData(coinId),
                this.loadCandleData(coinId),
                this.loadNews(coinId),
                this.loadFearGreedIndex(),
                this.loadDerivativesData(coinId)
            ]);

            this.state.lastUpdate = new Date();
            this.updateLastUpdateTime();

            // 所有数据加载完成后，重新计算综合信号
            this.updateSignal();
        } catch (error) {
            console.error('加载数据失败:', error);
        } finally {
            this.state.isLoading = false;
            this.showLoading(false);
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
                total_volume: parseFloat(data.quoteVolume),
                market_cap: 0, // 币安24小时接口不提供市值
            };

            this.updatePriceUI();

        } catch (error) {
            console.error('获取价格数据失败:', error);
            // 回退到模拟数据
            this.useMockPriceData(coinId);
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
            total_volume: basePrice * 500000,
            market_cap: basePrice * 20000000,
        };
        
        this.updatePriceUI();
    },

    // 获取币安K线间隔参数
    getBinanceInterval(hours) {
        if (hours <= 1) return { interval: '1m', limit: 200 };
        if (hours <= 24) return { interval: '15m', limit: 200 }; // 200根15分钟K线 = 50小时
        if (hours <= 168) return { interval: '1h', limit: 200 }; // 200根1小时K线 = 8.3天
        return { interval: '4h', limit: 200 }; // 200根4小时K线 = 33.3天
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

            // 转换数据格式：币安返回 [开仓时间, 开, 高, 低, 收, 成交量, 平仓时间, 成交额, ...]
            const candleData = data.map(item => ({
                time: Math.floor(item[0] / 1000), // 毫秒转秒
                open: parseFloat(item[1]),
                high: parseFloat(item[2]),
                low: parseFloat(item[3]),
                close: parseFloat(item[4]),
                volume: parseFloat(item[5]),
            }));

            this.state.candleData = candleData;
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
            // 使用模拟数据
            this.useMockFearGreedIndex();
        }
    },

    // 使用模拟恐惧贪婪指数
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

    // 加载衍生品数据（资金费率、OI）
    async loadDerivativesData(coinId) {
        const binanceSymbol = this.getBinanceSymbol(coinId);
        if (!binanceSymbol) {
            this.useMockDerivativesData(coinId);
            return;
        }

        try {
            // 尝试从币安期货API获取资金费率
            const response = await fetch(
                `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${binanceSymbol}`,
                { signal: AbortSignal.timeout(5000) }
            );

            if (!response.ok) throw new Error('Futures API error');

            const data = await response.json();

            this.state.derivatives = {
                fundingRate: parseFloat(data.lastFundingRate) * 100, // 转为百分比
                nextFundingTime: data.nextFundingTime,
                openInterest: null // OI需要单独接口
            };

            // 尝试获取OI
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

    // 使用模拟衍生品数据
    useMockDerivativesData(coinId) {
        const basePrices = {
            'bitcoin': 78000, 'ethereum': 3500, 'binancecoin': 580,
            'solana': 145, 'ripple': 0.52, 'cardano': 0.45,
            'dogecoin': 0.12, 'polkadot': 7.2,
        };
        const basePrice = basePrices[coinId] || 100;

        // 模拟资金费率（通常在 -0.05% 到 +0.1% 之间）
        const fundingRate = (Math.random() - 0.3) * 0.1;

        // 模拟OI（基于价格估算）
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
        // 确保至少有100根K线，以便计算所有技术指标
        const candleCount = Math.max(100, this.state.currentTimeframe);
        const candleData = [];
        let price = basePrice;
        
        const now = Math.floor(Date.now() / 1000);
        // 每根K线的时间间隔（秒）
        const totalSeconds = this.state.currentTimeframe * 3600;
        const interval = totalSeconds / candleCount;
        
        for (let i = candleCount - 1; i >= 0; i--) {
            const time = now - i * interval;
            const volatility = 0.02; // 2% 波动
            const trend = Math.sin(i / 20) * 0.005; // 趋势
            
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

        // 计算各指标
        const ma7 = TechnicalAnalysis.calculateSMA(closes, 7);
        const ma25 = TechnicalAnalysis.calculateSMA(closes, 25);
        const ma200 = TechnicalAnalysis.calculateSMA(closes, 200);
        const rsi = TechnicalAnalysis.calculateRSI(closes, 14);
        const macd = TechnicalAnalysis.calculateMACD(closes);
        const bollinger = TechnicalAnalysis.calculateBollingerBands(closes, 20);
        const vwap = TechnicalAnalysis.calculateVWAP(highs, lows, closes, volumes);
        const obv = TechnicalAnalysis.calculateOBV(closes, volumes);
        const stochRSI = TechnicalAnalysis.calculateStochasticRSI(closes);
        const kdj = TechnicalAnalysis.calculateKDJ(highs, lows, closes);
        const supportResistance = TechnicalAnalysis.calculateSupportResistance(highs, lows, closes, currentPrice);

        // 计算 AHR999
        const lastMA200 = ma200[ma200.length - 1];
        const ahr999 = TechnicalAnalysis.calculateAHR999(currentPrice, lastMA200);

        this.state.indicators = {
            ma7,
            ma25,
            ma200,
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
            currentPrice
        };

        this.updateIndicatorsUI();
    },

    // 更新图表
    updateChart() {
        if (!this.state.candleData || this.state.candleData.length === 0) return;
        
        // 更新K线
        ChartManager.updateCandlestickData(this.state.candleData);
        
        // 更新均线
        const timeData = this.state.candleData.map(d => d.time);
        ChartManager.updateMAData(timeData, this.state.indicators.ma7, this.state.indicators.ma25);
        
        // 绘制支撑压力位
        if (this.state.indicators.supportResistance) {
            ChartManager.drawSupportResistance(this.state.indicators.supportResistance);
        }
        
        // 添加高低点标记
        this.addSwingMarkers();
    },

    // 添加高低点标记
    addSwingMarkers() {
        if (!this.state.candleData || this.state.candleData.length < 10) return;
        if (!this.state.showSignalMarkers) return;

        const markers = [];
        const data = this.state.candleData;
        const ind = this.state.indicators;

        // 寻找局部高点和低点
        for (let i = 5; i < data.length - 5; i++) {
            // 局部高点
            if (data[i].high >= data[i-1].high && data[i].high >= data[i-2].high &&
                data[i].high >= data[i-3].high && data[i].high >= data[i+1].high &&
                data[i].high >= data[i+2].high && data[i].high >= data[i+3].high) {
                markers.push({
                    time: data[i].time,
                    position: 'aboveBar',
                    color: '#ef4444',
                    shape: 'arrowDown',
                    text: '高点'
                });
            }

            // 局部低点
            if (data[i].low <= data[i-1].low && data[i].low <= data[i-2].low &&
                data[i].low <= data[i-3].low && data[i].low <= data[i+1].low &&
                data[i].low <= data[i+2].low && data[i].low <= data[i+3].low) {
                markers.push({
                    time: data[i].time,
                    position: 'belowBar',
                    color: '#10b981',
                    shape: 'arrowUp',
                    text: '低点'
                });
            }
        }

        // 添加技术指标买卖信号标记
        const signalMarkers = this.generateSignalMarkers(data, ind);
        markers.push(...signalMarkers);

        // 按时间排序
        markers.sort((a, b) => a.time - b.time);

        ChartManager.addMarkers(markers);
    },

    // 生成技术指标买卖信号标记
    generateSignalMarkers(data, ind) {
        const markers = [];
        if (!data || data.length < 30) return markers;

        const closes = data.map(d => d.close);
        const len = closes.length;

        // === MACD 金叉死叉信号 ===
        if (ind.macd && ind.macd.macd && ind.macd.signal) {
            const macdLine = ind.macd.macd;
            const signalLine = ind.macd.signal;

            for (let i = 1; i < Math.min(macdLine.length, len); i++) {
                if (macdLine[i] === null || signalLine[i] === null) continue;
                if (macdLine[i-1] === null || signalLine[i-1] === null) continue;

                // MACD 金叉（买入）
                if (macdLine[i-1] <= signalLine[i-1] && macdLine[i] > signalLine[i]) {
                    markers.push({
                        time: data[i].time,
                        position: 'belowBar',
                        color: '#22c55e',
                        shape: 'arrowUp',
                        text: 'MACD金叉'
                    });
                }

                // MACD 死叉（卖出）
                if (macdLine[i-1] >= signalLine[i-1] && macdLine[i] < signalLine[i]) {
                    markers.push({
                        time: data[i].time,
                        position: 'aboveBar',
                        color: '#f97316',
                        shape: 'arrowDown',
                        text: 'MACD死叉'
                    });
                }
            }
        }

        // === KDJ 金叉死叉信号 ===
        if (ind.kdj && ind.kdj.k && ind.kdj.d) {
            const kLine = ind.kdj.k;
            const dLine = ind.kdj.d;

            for (let i = 1; i < Math.min(kLine.length, len); i++) {
                if (kLine[i] === null || dLine[i] === null) continue;
                if (kLine[i-1] === null || dLine[i-1] === null) continue;

                // KDJ 超卖区金叉（强买入）
                if (kLine[i] < 30 && dLine[i] < 30 &&
                    kLine[i-1] <= dLine[i-1] && kLine[i] > dLine[i]) {
                    markers.push({
                        time: data[i].time,
                        position: 'belowBar',
                        color: '#15803d',
                        shape: 'arrowUp',
                        text: 'KDJ超卖金叉'
                    });
                }
                // KDJ 金叉
                else if (kLine[i-1] <= dLine[i-1] && kLine[i] > dLine[i]) {
                    markers.push({
                        time: data[i].time,
                        position: 'belowBar',
                        color: '#4ade80',
                        shape: 'arrowUp',
                        text: 'KDJ金叉'
                    });
                }

                // KDJ 超买区死叉（强卖出）
                if (kLine[i] > 70 && dLine[i] > 70 &&
                    kLine[i-1] >= dLine[i-1] && kLine[i] < dLine[i]) {
                    markers.push({
                        time: data[i].time,
                        position: 'aboveBar',
                        color: '#b91c1c',
                        shape: 'arrowDown',
                        text: 'KDJ超买死叉'
                    });
                }
                // KDJ 死叉
                else if (kLine[i-1] >= dLine[i-1] && kLine[i] < dLine[i]) {
                    markers.push({
                        time: data[i].time,
                        position: 'aboveBar',
                        color: '#fb923c',
                        shape: 'arrowDown',
                        text: 'KDJ死叉'
                    });
                }
            }
        }

        // === RSI 超买超卖信号 ===
        const rsiLine = TechnicalAnalysis.calculateRSI(closes, 14);
        for (let i = 1; i < Math.min(rsiLine.length, len); i++) {
            if (rsiLine[i] === null) continue;

            // RSI 从超卖区回升（买入）
            if (rsiLine[i-1] !== null && rsiLine[i-1] < 30 && rsiLine[i] >= 30) {
                markers.push({
                    time: data[i].time,
                    position: 'belowBar',
                    color: '#059669',
                    shape: 'arrowUp',
                    text: 'RSI超卖回升'
                });
            }

            // RSI 从超买区回落（卖出）
            if (rsiLine[i-1] !== null && rsiLine[i-1] > 70 && rsiLine[i] <= 70) {
                markers.push({
                    time: data[i].time,
                    position: 'aboveBar',
                    color: '#dc2626',
                    shape: 'arrowDown',
                    text: 'RSI超买回落'
                });
            }
        }

        // === MA 均线交叉信号 ===
        if (ind.ma7 && ind.ma25) {
            const ma7 = ind.ma7;
            const ma25 = ind.ma25;

            for (let i = 1; i < Math.min(ma7.length, len); i++) {
                if (ma7[i] === null || ma25[i] === null) continue;
                if (ma7[i-1] === null || ma25[i-1] === null) continue;

                // MA7 上穿 MA25（金叉，买入）
                if (ma7[i-1] <= ma25[i-1] && ma7[i] > ma25[i]) {
                    markers.push({
                        time: data[i].time,
                        position: 'belowBar',
                        color: '#16a34a',
                        shape: 'arrowUp',
                        text: '均线金叉'
                    });
                }

                // MA7 下穿 MA25（死叉，卖出）
                if (ma7[i-1] >= ma25[i-1] && ma7[i] < ma25[i]) {
                    markers.push({
                        time: data[i].time,
                        position: 'aboveBar',
                        color: '#ea580c',
                        shape: 'arrowDown',
                        text: '均线死叉'
                    });
                }
            }
        }

        // === 布林带突破信号 ===
        if (ind.bollingerBands && ind.bollingerBands.upper && ind.bollingerBands.lower) {
            const upper = ind.bollingerBands.upper;
            const lower = ind.bollingerBands.lower;

            for (let i = 1; i < Math.min(upper.length, len); i++) {
                if (upper[i] === null || lower[i] === null) continue;

                // 价格触及下轨后回升（买入）
                if (data[i-1].low <= lower[i-1] && data[i].close > lower[i]) {
                    markers.push({
                        time: data[i].time,
                        position: 'belowBar',
                        color: '#0d9488',
                        shape: 'arrowUp',
                        text: '布林下轨反弹'
                    });
                }

                // 价格触及上轨后回落（卖出）
                if (data[i-1].high >= upper[i-1] && data[i].close < upper[i]) {
                    markers.push({
                        time: data[i].time,
                        position: 'aboveBar',
                        color: '#c2410c',
                        shape: 'arrowDown',
                        text: '布林上轨回落'
                    });
                }
            }
        }

        // === StochRSI 信号 ===
        if (ind.stochRSI && ind.stochRSI.k && ind.stochRSI.d) {
            const stochK = ind.stochRSI.k;
            const stochD = ind.stochRSI.d;

            for (let i = 1; i < Math.min(stochK.length, len); i++) {
                if (stochK[i] === null || stochD[i] === null) continue;
                if (stochK[i-1] === null || stochD[i-1] === null) continue;

                // StochRSI 超卖区金叉
                if (stochK[i] < 20 && stochD[i] < 20 &&
                    stochK[i-1] <= stochD[i-1] && stochK[i] > stochD[i]) {
                    markers.push({
                        time: data[i].time,
                        position: 'belowBar',
                        color: '#047857',
                        shape: 'arrowUp',
                        text: 'StochRSI超卖金叉'
                    });
                }

                // StochRSI 超买区死叉
                if (stochK[i] > 80 && stochD[i] > 80 &&
                    stochK[i-1] >= stochD[i-1] && stochK[i] < stochD[i]) {
                    markers.push({
                        time: data[i].time,
                        position: 'aboveBar',
                        color: '#991b1b',
                        shape: 'arrowDown',
                        text: 'StochRSI超买死叉'
                    });
                }
            }
        }

        // 去重：同一根K线只保留一个最强信号
        const uniqueMarkers = new Map();
        for (const marker of markers) {
            const key = `${marker.time}_${marker.position}`;
            if (!uniqueMarkers.has(key)) {
                uniqueMarkers.set(key, marker);
            } else {
                // 保留更强的信号（文字越长通常描述越详细）
                const existing = uniqueMarkers.get(key);
                if (marker.text.length > existing.text.length) {
                    uniqueMarkers.set(key, marker);
                }
            }
        }
        const dedupedMarkers = Array.from(uniqueMarkers.values());

        // 只保留最近的信号标记（避免图表太乱）
        // 买入信号最近4个，卖出信号最近4个
        const buySignals = dedupedMarkers.filter(m => m.position === 'belowBar').slice(-5);
        const sellSignals = dedupedMarkers.filter(m => m.position === 'aboveBar').slice(-5);

        return [...buySignals, ...sellSignals];
    },

    // 更新价格UI
    updatePriceUI() {
        const info = this.state.coinInfo;
        if (!info) return;

        // 币种名称
        const coin = this.popularCoins.find(c => c.id === this.state.currentCoin);
        if (coin) {
            const coinNameEl = document.getElementById('coinNameLarge');
            const coinSymbolEl = document.getElementById('coinSymbolLarge');
            const coinIconEl = document.getElementById('coinIconLarge');
            if (coinNameEl) coinNameEl.textContent = coin.name;
            if (coinSymbolEl) coinSymbolEl.textContent = coin.symbol + '/USDT';
            if (coinIconEl) coinIconEl.textContent = coin.image || coin.symbol.charAt(0);
        }

        // 当前价格
        document.getElementById('currentPrice').textContent = '$' + TechnicalAnalysis.formatPrice(info.current_price);

        // 价格变化
        const changePercent = info.price_change_percentage_24h;
        const isPositive = changePercent >= 0;

        const priceChangeText = document.getElementById('priceChangeText');
        if (priceChangeText) {
            priceChangeText.textContent = `24H ${isPositive ? '+' : ''}$${TechnicalAnalysis.formatPrice(info.price_change_24h)} (${isPositive ? '+' : ''}${changePercent.toFixed(2)}%)`;
            priceChangeText.className = `text-sm sm:text-base mt-1 ${isPositive ? 'text-crypto-green' : 'text-crypto-red'}`;
        }

        const priceChangeBadge = document.getElementById('priceChangeBadge');
        if (priceChangeBadge) {
            priceChangeBadge.textContent = `${isPositive ? '+' : ''}${changePercent.toFixed(2)}%`;
            priceChangeBadge.className = `ml-auto px-3 py-1.5 rounded-full text-sm font-semibold ${isPositive ? 'bg-crypto-green/10 text-crypto-green' : 'bg-crypto-red/10 text-crypto-red'}`;
        }

        // 24H最高/最低
        const highEl = document.getElementById('high24h');
        if (highEl) highEl.textContent = '$' + TechnicalAnalysis.formatPrice(info.high_24h);
        const lowEl = document.getElementById('low24h');
        if (lowEl) lowEl.textContent = '$' + TechnicalAnalysis.formatPrice(info.low_24h);

        // 24H成交量
        const volEl = document.getElementById('volume24h');
        if (volEl) volEl.textContent = '$' + TechnicalAnalysis.formatLargeNumber(info.total_volume);
    },

    // 设置状态徽章文本和样式
    setStatusBadge(elementId, text, color) {
        const el = document.getElementById(elementId);
        if (!el) return;
        el.textContent = text;
        let bgClass = 'bg-gray-700/50';
        let textClass = 'text-gray-400';
        if (color === 'green') {
            bgClass = 'bg-crypto-green/10';
            textClass = 'text-crypto-green';
        } else if (color === 'red') {
            bgClass = 'bg-crypto-red/10';
            textClass = 'text-crypto-red';
        } else if (color === 'gold') {
            bgClass = 'bg-crypto-gold/10';
            textClass = 'text-crypto-gold';
        } else if (color === 'blue') {
            bgClass = 'bg-crypto-blue/10';
            textClass = 'text-crypto-blue';
        }
        el.className = `text-xs px-1.5 py-0.5 rounded ${bgClass} ${textClass}`;
    },

    // 更新技术指标UI
    updateIndicatorsUI() {
        const ind = this.state.indicators;
        const currentPrice = ind.currentPrice;

        // RSI
        const rsiValue = ind.rsi;
        const rsiEl = document.getElementById('rsiValue');
        const rsiBar = document.getElementById('rsiBar');

        if (rsiValue !== null && rsiValue !== undefined && !isNaN(rsiValue)) {
            rsiEl.textContent = rsiValue.toFixed(1);
            const rsiColor = SignalGenerator.getRSIColor(rsiValue);
            rsiEl.style.color = rsiColor;
            rsiBar.style.width = rsiValue + '%';
            rsiBar.style.backgroundColor = rsiColor;
            // RSI状态徽章
            let rsiStatus = '中性';
            let rsiStatusColor = 'gold';
            if (rsiValue > 70) { rsiStatus = '超买'; rsiStatusColor = 'red'; }
            else if (rsiValue < 30) { rsiStatus = '超卖'; rsiStatusColor = 'green'; }
            this.setStatusBadge('rsiStatus', rsiStatus, rsiStatusColor);
        } else {
            rsiEl.textContent = '--';
        }

        // MACD
        const macdValue = ind.macd?.value;
        const macdSignal = ind.macd?.signal;
        const macdEl = document.getElementById('macdValue');
        const macdSignalEl = document.getElementById('macdSignal');

        if (typeof macdValue === 'number' && !isNaN(macdValue)) {
            macdEl.textContent = macdValue.toFixed(4);
            macdEl.className = `text-xl font-bold ${macdValue > 0 ? 'text-crypto-green' : 'text-crypto-red'}`;
            // MACD状态
            if (macdSignal && typeof macdSignal[macdSignal.length - 1] === 'number') {
                const lastMacd = macdValue;
                const lastSignal = macdSignal[macdSignal.length - 1];
                let macdStatus = '中性';
                let macdColor = 'gold';
                if (lastMacd > lastSignal && lastMacd > 0) { macdStatus = '金叉多头'; macdColor = 'green'; }
                else if (lastMacd > lastSignal) { macdStatus = '金叉'; macdColor = 'green'; }
                else if (lastMacd < lastSignal && lastMacd < 0) { macdStatus = '死叉空头'; macdColor = 'red'; }
                else if (lastMacd < lastSignal) { macdStatus = '死叉'; macdColor = 'red'; }
                this.setStatusBadge('macdStatus', macdStatus, macdColor);
            }
        } else {
            macdEl.textContent = '--';
        }

        if (typeof macdSignal === 'number') {
            macdSignalEl.textContent = `信号: ${macdSignal.toFixed(4)}`;
        } else if (Array.isArray(macdSignal) && macdSignal[macdSignal.length - 1] !== null) {
            macdSignalEl.textContent = `信号: ${macdSignal[macdSignal.length - 1].toFixed(4)}`;
        } else {
            macdSignalEl.textContent = '--';
        }

        // KDJ
        const kdj = ind.kdj;
        const kdjKEl = document.getElementById('kdjKValue');
        const kdjDJEl = document.getElementById('kdjDJValue');
        if (kdj && kdj.k && kdj.k[kdj.k.length - 1] !== null) {
            const lastK = kdj.k[kdj.k.length - 1];
            const lastD = kdj.d[kdj.d.length - 1];
            const lastJ = kdj.j[kdj.j.length - 1];
            kdjKEl.textContent = lastK.toFixed(1);
            kdjKEl.className = `text-xl font-bold ${lastK > 80 ? 'text-crypto-red' : lastK < 20 ? 'text-crypto-green' : 'text-white'}`;
            kdjDJEl.textContent = `D: ${lastD?.toFixed(1) || '--'}  J: ${lastJ?.toFixed(1) || '--'}`;
            // KDJ状态
            let kdjStatus = '中性';
            let kdjColor = 'gold';
            if (lastK > 80 && lastD > 80) { kdjStatus = '超买'; kdjColor = 'red'; }
            else if (lastK < 20 && lastD < 20) { kdjStatus = '超卖'; kdjColor = 'green'; }
            else if (lastK > lastD) { kdjStatus = '偏多'; kdjColor = 'green'; }
            else { kdjStatus = '偏空'; kdjColor = 'red'; }
            this.setStatusBadge('kdjStatus', kdjStatus, kdjColor);
        } else {
            kdjKEl.textContent = '--';
            kdjDJEl.textContent = 'D: -- J: --';
        }

        // 均线排列
        this.updateMAAlignment(ind);

        // 布林带
        const boll = ind.bollingerBands;
        if (boll && boll.upper && boll.lower) {
            const lastUpper = boll.upper[boll.upper.length - 1];
            const lastLower = boll.lower[boll.lower.length - 1];
            const upperShort = document.getElementById('bollUpperShort');
            const lowerShort = document.getElementById('bollLowerShort');
            if (upperShort && lastUpper) upperShort.textContent = '上: $' + TechnicalAnalysis.formatPrice(lastUpper);
            if (lowerShort && lastLower) lowerShort.textContent = '下: $' + TechnicalAnalysis.formatPrice(lastLower);
            // 布林带状态
            let bollStatus = '中性';
            let bollColor = 'gold';
            if (currentPrice >= lastUpper) { bollStatus = '突破上轨'; bollColor = 'red'; }
            else if (currentPrice <= lastLower) { bollStatus = '跌破下轨'; bollColor = 'green'; }
            else {
                const position = (currentPrice - lastLower) / (lastUpper - lastLower);
                if (position > 0.7) { bollStatus = '偏强'; bollColor = 'green'; }
                else if (position < 0.3) { bollStatus = '偏弱'; bollColor = 'red'; }
            }
            this.setStatusBadge('bollStatus', bollStatus, bollColor);
        }

        // AHR999
        const ahr = ind.ahr999;
        const ahrEl = document.getElementById('ahr999Value');
        const ahrZoneEl = document.getElementById('ahr999Zone');
        if (ahr && ahr.value !== null && !isNaN(ahr.value)) {
            ahrEl.textContent = ahr.value.toFixed(3);
            ahrZoneEl.textContent = this.getAHR999ZoneText(ahr.zone);
            let ahrColor = 'gold';
            if (ahr.zone === 'deep_value') ahrColor = 'green';
            else if (ahr.zone === 'accumulation') ahrColor = 'blue';
            else if (ahr.zone === 'overheated') ahrColor = 'red';
            ahrEl.className = `text-xl font-bold ${ahrColor === 'green' ? 'text-crypto-green' : ahrColor === 'blue' ? 'text-crypto-blue' : ahrColor === 'red' ? 'text-crypto-red' : 'text-crypto-gold'}`;
            this.setStatusBadge('ahrStatus', this.getAHR999ZoneText(ahr.zone), ahrColor);
        } else {
            ahrEl.textContent = '--';
            ahrZoneEl.textContent = '--';
        }

        // 更多指标（折叠面板内）
        // Stochastic RSI
        const stochK = ind.stochRSI?.k;
        const stochD = ind.stochRSI?.d;
        const stochEl = document.getElementById('stochRSIValue');
        const stochSignalEl = document.getElementById('stochRSISignal');
        if (stochK && stochK[stochK.length - 1] !== null) {
            const lastK = stochK[stochK.length - 1];
            const lastD = stochD?.[stochD.length - 1];
            stochEl.textContent = lastK.toFixed(1);
            stochEl.className = `text-lg font-bold ${lastK > 80 ? 'text-crypto-red' : lastK < 20 ? 'text-crypto-green' : 'text-white'}`;
            if (lastD !== null && lastD !== undefined) {
                stochSignalEl.textContent = `D: ${lastD.toFixed(1)}`;
            }
            let stochStatus = '中性';
            let stochColor = 'gold';
            if (lastK > 80) { stochStatus = '超买'; stochColor = 'red'; }
            else if (lastK < 20) { stochStatus = '超卖'; stochColor = 'green'; }
            else if (lastK > lastD) { stochStatus = '偏多'; stochColor = 'green'; }
            else { stochStatus = '偏空'; stochColor = 'red'; }
            this.setStatusBadge('stochRSIStatus', stochStatus, stochColor);
        } else {
            stochEl && (stochEl.textContent = '--');
        }

        // VWAP
        const vwapEl = document.getElementById('vwapValue');
        const vwapPosEl = document.getElementById('vwapPosition');
        const vwap = ind.vwap;
        if (vwap && vwap[vwap.length - 1]) {
            const lastVWAP = vwap[vwap.length - 1];
            vwapEl.textContent = '$' + TechnicalAnalysis.formatPrice(lastVWAP);
            const above = currentPrice > lastVWAP;
            vwapPosEl.textContent = above ? '价格在上方' : '价格在下方';
            vwapPosEl.className = `text-xs ${above ? 'text-crypto-green' : 'text-crypto-red'}`;
            this.setStatusBadge('vwapStatus', above ? '偏多' : '偏空', above ? 'green' : 'red');
        } else {
            vwapEl && (vwapEl.textContent = '--');
        }

        // OBV趋势
        const obvTrendEl = document.getElementById('obvTrend');
        const obv = ind.obv;
        if (obv && obv.length >= 10) {
            const recent = obv.slice(-10);
            const rising = recent[recent.length - 1] > recent[0];
            obvTrendEl.textContent = rising ? '上升 ↑' : '下降 ↓';
            obvTrendEl.className = `text-lg font-bold ${rising ? 'text-crypto-green' : 'text-crypto-red'}`;
            this.setStatusBadge('obvStatus', rising ? '流入' : '流出', rising ? 'green' : 'red');
        } else {
            obvTrendEl && (obvTrendEl.textContent = '--');
        }

        // MA200
        const ma200El = document.getElementById('ma200Value');
        const ma200 = ind.ma200;
        if (ma200 && ma200[ma200.length - 1]) {
            const lastMA200 = ma200[ma200.length - 1];
            ma200El.textContent = '$' + TechnicalAnalysis.formatPrice(lastMA200);
            const above = currentPrice > lastMA200;
            ma200El.className = `text-lg font-bold ${above ? 'text-crypto-green' : 'text-crypto-red'}`;
            this.setStatusBadge('ma200Status', above ? '牛市' : '熊市', above ? 'green' : 'red');
        } else {
            ma200El && (ma200El.textContent = '--');
        }

        // MA7 / MA25 完整值
        const ma7Full = document.getElementById('ma7ValueFull');
        const ma25Full = document.getElementById('ma25ValueFull');
        const ma7 = ind.ma7;
        const ma25 = ind.ma25;
        if (ma7Full && ma7 && ma7[ma7.length - 1]) {
            ma7Full.textContent = '$' + TechnicalAnalysis.formatPrice(ma7[ma7.length - 1]);
        }
        if (ma25Full && ma25 && ma25[ma25.length - 1]) {
            ma25Full.textContent = '$' + TechnicalAnalysis.formatPrice(ma25[ma25.length - 1]);
        }

        // 支撑压力位
        const sr = ind.supportResistance;
        if (sr) {
            const r2El = document.getElementById('resistance2');
            const r1El = document.getElementById('resistance1');
            const cpEl = document.getElementById('currentPriceLevel');
            const s1El = document.getElementById('support1');
            const s2El = document.getElementById('support2');
            if (r2El) r2El.textContent = '$' + TechnicalAnalysis.formatPrice(sr.resistance2);
            if (r1El) r1El.textContent = '$' + TechnicalAnalysis.formatPrice(sr.resistance1);
            if (cpEl) cpEl.textContent = '$' + TechnicalAnalysis.formatPrice(ind.currentPrice);
            if (s1El) s1El.textContent = '$' + TechnicalAnalysis.formatPrice(sr.support1);
            if (s2El) s2El.textContent = '$' + TechnicalAnalysis.formatPrice(sr.support2);
        }
    },

    // 获取 AHR999 区域文本
    getAHR999ZoneText(zone) {
        const zoneMap = {
            'deep_value': '深度价值区',
            'accumulation': '积累区间',
            'overheated': '过热区',
            'neutral': '中性'
        };
        return zoneMap[zone] || '--';
    },

    // 更新均线排列状态
    updateMAAlignment(ind) {
        const maAlignmentText = document.getElementById('maAlignmentText');
        const maStatusBadge = document.getElementById('maStatus');
        const ma7Short = document.getElementById('ma7ValueShort');
        if (!ind.ma7 || !ind.ma25) return;

        const ma7 = ind.ma7[ind.ma7.length - 1];
        const ma25 = ind.ma25[ind.ma25.length - 1];
        const ma200 = ind.ma200?.[ind.ma200.length - 1];
        const price = ind.currentPrice;

        if (!ma7 || !ma25) return;

        let alignment = '';
        let statusColor = 'gold';

        if (price > ma7 && ma7 > ma25) {
            if (ma200 && ma25 > ma200) {
                alignment = '多头排列';
                statusColor = 'green';
            } else {
                alignment = '短期多头';
                statusColor = 'green';
            }
        } else if (price < ma7 && ma7 < ma25) {
            if (ma200 && ma25 < ma200) {
                alignment = '空头排列';
                statusColor = 'red';
            } else {
                alignment = '短期空头';
                statusColor = 'red';
            }
        } else {
            alignment = '震荡整理';
            statusColor = 'gold';
        }

        if (maAlignmentText) {
            maAlignmentText.textContent = alignment;
            const colorClass = statusColor === 'green' ? 'text-crypto-green' : statusColor === 'red' ? 'text-crypto-red' : 'text-crypto-gold';
            maAlignmentText.className = `text-base font-bold ${colorClass}`;
        }

        this.setStatusBadge('maStatus', alignment, statusColor);

        if (ma7Short) {
            ma7Short.textContent = 'MA7: $' + TechnicalAnalysis.formatPrice(ma7);
        }
    },

    // 更新恐惧贪婪指数UI
    updateFearGreedUI() {
        const fng = this.state.fearGreedIndex;
        if (!fng) return;

        const valueEl = document.getElementById('fngValue');
        const classEl = document.getElementById('fngClassification');
        const circleEl = document.getElementById('fngCircle');

        valueEl.textContent = fng.value;
        classEl.textContent = this.translateFNGClassification(fng.classification);

        // 更新圆环进度
        const circumference = 2 * Math.PI * 35; // ~220
        const offset = circumference - (fng.value / 100) * circumference;
        circleEl.style.strokeDashoffset = offset;

        // 颜色
        let color = '#fbbf24'; // 黄色
        if (fng.value < 25) color = '#ef4444'; // 红 - 极度恐惧
        else if (fng.value < 46) color = '#f97316'; // 橙 - 恐惧
        else if (fng.value < 55) color = '#fbbf24'; // 黄 - 中性
        else if (fng.value < 75) color = '#84cc16'; // 浅绿 - 贪婪
        else color = '#10b981'; // 绿 - 极度贪婪

        circleEl.style.stroke = color;
        classEl.style.color = color;
    },

    // 翻译 FNG 分类
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

    // 更新衍生品数据UI
    updateDerivativesUI() {
        const deriv = this.state.derivatives;
        if (!deriv) return;

        // 资金费率
        const frEl = document.getElementById('fundingRate');
        const frDescEl = document.getElementById('fundingRateDesc');
        const frStatusEl = document.getElementById('fundingRateStatus');
        if (deriv.fundingRate !== null && deriv.fundingRate !== undefined) {
            frEl.textContent = deriv.fundingRate.toFixed(4) + '%';
            frEl.className = `text-lg font-bold ${deriv.fundingRate > 0 ? 'text-crypto-green' : 'text-crypto-red'}`;

            let frStatus = '正常';
            let frStatusColor = 'gold';
            if (deriv.fundingRate > 0.1) {
                frStatus = '过高';
                frStatusColor = 'red';
                if (frDescEl) {
                    frDescEl.textContent = '多头拥挤，警惕轧空';
                    frDescEl.className = 'text-xs text-crypto-red';
                }
            } else if (deriv.fundingRate < -0.05) {
                frStatus = '负费率';
                frStatusColor = 'green';
                if (frDescEl) {
                    frDescEl.textContent = '空头拥挤，关注轧空';
                    frDescEl.className = 'text-xs text-crypto-green';
                }
            } else {
                if (frDescEl) {
                    frDescEl.textContent = '费率正常';
                    frDescEl.className = 'text-xs text-gray-500';
                }
            }
            this.setStatusBadge('fundingRateStatus', frStatus, frStatusColor);
        }

        // OI
        const oiEl = document.getElementById('openInterest');
        const oiTrendEl = document.getElementById('oiTrend');
        if (deriv.openInterest) {
            oiEl.textContent = TechnicalAnalysis.formatLargeNumber(deriv.openInterest);
            if (oiTrendEl) oiTrendEl.textContent = '未平仓合约';
        }
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
        }
    },

    // 渲染新闻
    renderNews() {
        const container = document.getElementById('newsList');
        const newsList = this.state.newsList;
        
        if (!newsList || newsList.length === 0) {
            container.innerHTML = '<p class="text-gray-400 text-sm col-span-full text-center py-8">暂无新闻数据</p>';
            return;
        }
        
        // 更新情感标签
        const newsScore = NewsAnalyzer.calculateNewsScore(newsList);
        const badge = document.getElementById('newsSentimentBadge');
        if (newsScore.label === 'positive') {
            badge.textContent = `情绪偏多 ${newsScore.score}分`;
            badge.className = 'text-xs px-2 py-0.5 rounded-full bg-crypto-green/20 text-crypto-green';
        } else if (newsScore.label === 'negative') {
            badge.textContent = `情绪偏空 ${newsScore.score}分`;
            badge.className = 'text-xs px-2 py-0.5 rounded-full bg-crypto-red/20 text-crypto-red';
        } else {
            badge.textContent = `情绪中性 ${newsScore.score}分`;
            badge.className = 'text-xs px-2 py-0.5 rounded-full bg-gray-600/50 text-gray-300';
        }
        
        container.innerHTML = newsList.slice(0, 6).map((news, index) => {
            const sentimentStyle = NewsAnalyzer.getSentimentStyle(news.sentimentLabel);
            return `
                <div class="news-card bg-crypto-card rounded-xl border border-crypto-border p-4 cursor-pointer hover:border-crypto-purple/50 transition-all" data-news-index="${index}">
                    <div class="flex items-start justify-between gap-2 mb-2">
                        <span class="text-xs text-gray-400">${news.source}</span>
                        <span class="tip-tag ${sentimentStyle.className}">${sentimentStyle.text}</span>
                    </div>
                    <h4 class="text-sm font-medium mb-2 line-clamp-2 text-gray-100">${news.title}</h4>
                    <p class="text-xs text-gray-400 line-clamp-2 mb-2">${news.description || ''}</p>
                    <p class="text-xs text-gray-500">${NewsAnalyzer.formatTime(news.publishedAt)}</p>
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

        // 标题
        document.getElementById('newsDetailTitle').textContent = news.title;
        document.getElementById('newsDetailCategory').textContent = news.source || '资讯';
        document.getElementById('newsDetailSource').textContent = news.source || '未知来源';
        document.getElementById('newsDetailTime').textContent = NewsAnalyzer.formatTime(news.publishedAt);

        // 摘要
        document.getElementById('newsDetailSummary').textContent = news.description || news.title || '暂无摘要';

        // 原文链接
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
        const sentimentStyle = NewsAnalyzer.getSentimentStyle(sentimentLabel);

        const sentLabelEl = document.getElementById('newsDetailSentimentLabel');
        sentLabelEl.textContent = sentimentStyle.text;
        sentLabelEl.className = `text-xs px-2 py-0.5 rounded-full font-medium ${sentimentStyle.className}`;

        const sentBarEl = document.getElementById('newsDetailSentimentBar');
        sentBarEl.style.width = sentimentScore + '%';
        if (sentimentLabel === 'positive') {
            sentBarEl.className = 'h-full bg-crypto-green rounded-full transition-all';
        } else if (sentimentLabel === 'negative') {
            sentBarEl.className = 'h-full bg-crypto-red rounded-full transition-all';
        } else {
            sentBarEl.className = 'h-full bg-crypto-gold rounded-full transition-all';
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
                `<span class="text-xs px-2 py-0.5 rounded-full bg-crypto-purple/10 text-crypto-purple">${kw}</span>`
            ).join('');
        } else if (keywordsContainer) {
            keywordsContainer.innerHTML = '<span class="text-xs text-gray-500">无</span>';
        }

        // 显示弹窗
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        document.body.style.overflow = 'hidden';
    },

    // 隐藏资讯详情
    hideNewsDetail() {
        const modal = document.getElementById('newsDetailModal');
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            document.body.style.overflow = '';
        }
    },

    // 更新信号
    updateSignal() {
        const ind = this.state.indicators;

        // 技术面评分（包含所有技术指标）
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

        // 消息面评分
        const newsScoreResult = NewsAnalyzer.calculateNewsScore(this.state.newsList);

        // 情绪面评分（恐惧贪婪指数）
        const sentimentScore = this.calculateSentimentScore();

        // 衍生品面评分
        const derivativesScore = this.calculateDerivativesScore();

        // 综合评分：技术面50% + 消息面15% + 情绪面20% + 衍生品面15%
        const totalScore = Math.round(
            techScoreResult.score * 0.5 +
            newsScoreResult.score * 0.15 +
            sentimentScore * 0.2 +
            derivativesScore * 0.15
        );

        const signal = SignalGenerator.generateSignal(
            { ...techScoreResult, score: techScoreResult.score },
            { ...newsScoreResult, score: newsScoreResult.score },
            {
                supportResistance: ind.supportResistance,
                currentPrice: ind.currentPrice,
                sentimentScore,
                derivativesScore,
                totalScore,
                breakdown: {
                    technical: techScoreResult.score,
                    news: newsScoreResult.score,
                    sentiment: sentimentScore,
                    derivatives: derivativesScore
                }
            }
        );

        this.state.signal = signal;
        this.state.signal.totalScore = totalScore;
        this.renderSignal();
    },

    // 计算情绪面评分
    calculateSentimentScore() {
        const fng = this.state.fearGreedIndex;
        if (!fng || fng.value === null || fng.value === undefined) return 50;

        // 恐惧贪婪指数直接映射到 0-100 分
        // 极度恐惧(0-25) = 高分(买入机会)，极度贪婪(75-100) = 低分(卖出信号)
        const score = 100 - fng.value;

        // 但要考虑极端情况：过度恐惧可能还会跌，过度贪婪可能还会涨
        // 所以用更温和的映射
        let adjustedScore = 50;
        if (fng.value < 20) adjustedScore = 75; // 极度恐惧 - 偏多
        else if (fng.value < 40) adjustedScore = 65; // 恐惧 - 偏多
        else if (fng.value < 50) adjustedScore = 55; // 轻度恐惧 - 微多
        else if (fng.value < 60) adjustedScore = 45; // 轻度贪婪 - 微空
        else if (fng.value < 80) adjustedScore = 35; // 贪婪 - 偏空
        else adjustedScore = 25; // 极度贪婪 - 偏空

        return adjustedScore;
    },

    // 计算衍生品面评分
    calculateDerivativesScore() {
        const deriv = this.state.derivatives;
        if (!deriv || deriv.fundingRate === null || deriv.fundingRate === undefined) return 50;

        let score = 50;

        // 资金费率分析
        const fr = deriv.fundingRate;
        if (fr > 0.1) {
            score -= 20; // 费率过高，多头拥挤，风险大
        } else if (fr > 0.05) {
            score -= 10; // 费率偏高
        } else if (fr < -0.05) {
            score += 15; // 负费率，空头拥挤，可能反弹
        } else if (fr < 0) {
            score += 5; // 轻微负费率
        }

        return Math.max(0, Math.min(100, score));
    },

    // 渲染信号
    renderSignal() {
        const signal = this.state.signal;
        if (!signal) return;

        // 信号卡片
        const signalCard = document.getElementById('signalCard');
        const signalIcon = document.getElementById('signalIcon');
        const signalText = document.getElementById('signalText');
        const signalDesc = document.getElementById('signalDesc');
        const signalGlow = document.getElementById('signalGlow');
        const signalStrength = document.getElementById('signalStrength');

        signalIcon.className = `w-14 h-14 sm:w-16 sm:h-16 mx-auto mb-3 rounded-2xl flex items-center justify-center`;

        let signalColor = 'crypto-gold';
        let signalBg = 'crypto-gold/10';
        let strengthText = '中性';

        if (signal.type === 'strong_buy') {
            signalColor = 'crypto-green';
            signalBg = 'crypto-green/15';
            strengthText = '强烈买入';
        } else if (signal.type === 'buy') {
            signalColor = 'crypto-green';
            signalBg = 'crypto-green/10';
            strengthText = '买入';
        } else if (signal.type === 'strong_sell') {
            signalColor = 'crypto-red';
            signalBg = 'crypto-red/15';
            strengthText = '强烈卖出';
        } else if (signal.type === 'sell') {
            signalColor = 'crypto-red';
            signalBg = 'crypto-red/10';
            strengthText = '卖出';
        } else {
            strengthText = '观望';
        }

        signalIcon.classList.add(`bg-${signalBg}`);
        signalText.className = `text-2xl sm:text-3xl font-bold text-${signalColor}`;
        signalGlow.className = `absolute top-0 left-0 w-full h-1 bg-${signalColor}`;
        signalStrength.textContent = strengthText;
        signalStrength.className = `text-xs px-2 py-0.5 rounded-full bg-${signalBg} text-${signalColor} font-medium`;

        signalIcon.innerHTML = SignalGenerator.getSignalIcon(signal.type);
        signalText.textContent = signal.text;
        signalDesc.textContent = signal.desc;

        // 综合评分 + 进度条
        const totalScore = signal.totalScore ?? 50;
        document.getElementById('totalScore').textContent = totalScore;
        document.getElementById('totalScore').className = `text-lg sm:text-xl font-bold ${SignalGenerator.getScoreColor(totalScore)}`;
        document.getElementById('totalScoreBar').style.width = `${totalScore}%`;

        // 四维评分
        document.getElementById('techScore').textContent = signal.techScore;
        document.getElementById('techScore').className = `text-sm font-bold ${SignalGenerator.getScoreColor(signal.techScore)}`;

        document.getElementById('newsScore').textContent = signal.newsScore;
        document.getElementById('newsScore').className = `text-sm font-bold ${SignalGenerator.getScoreColor(signal.newsScore)}`;

        const sentimentScore = signal.breakdown?.sentiment ?? 50;
        document.getElementById('sentimentScore').textContent = sentimentScore;
        document.getElementById('sentimentScore').className = `text-sm font-bold ${SignalGenerator.getScoreColor(sentimentScore)}`;

        const derivScore = signal.breakdown?.derivatives ?? 50;
        document.getElementById('derivScore').textContent = derivScore;
        document.getElementById('derivScore').className = `text-sm font-bold ${SignalGenerator.getScoreColor(derivScore)}`;

        // 技术面评分徽章
        const techScoreBadge = document.getElementById('techScoreBadge');
        if (techScoreBadge) {
            techScoreBadge.textContent = signal.techScore + ' 分';
            techScoreBadge.className = `text-xs px-2.5 py-1 rounded-full font-medium ${SignalGenerator.getScoreBg(signal.techScore)} ${SignalGenerator.getScoreColor(signal.techScore)}`;
        }

        // 操作建议
        const actionTipsEl = document.getElementById('actionTips');
        actionTipsEl.innerHTML = signal.actionTips.map(tip => {
            let tipClass = 'text-gray-300';
            if (tip.type === 'buy') tipClass = 'text-crypto-green';
            if (tip.type === 'sell') tipClass = 'text-crypto-red';
            if (tip.type === 'watch') tipClass = 'text-crypto-gold';

            return `
                <div class="flex items-start gap-2 text-sm ${tipClass}">
                    <span>${tip.icon}</span>
                    <span>${tip.text}</span>
                </div>
            `;
        }).join('');

        // 仓位建议
        const posAdviceEl = document.getElementById('positionAdvice');
        if (posAdviceEl && signal.positionAdvice) {
            const advice = signal.positionAdvice;
            let html = '';

            // 买入区域
            if (advice.buyZones && advice.buyZones.length > 0) {
                html += '<div class="mb-2">';
                html += '<p class="text-xs text-crypto-green/70 mb-1">买入区域</p>';
                advice.buyZones.forEach(zone => {
                    const strongClass = zone.strength === 'strong' ? 'font-semibold' : '';
                    html += `<div class="flex items-center justify-between py-0.5 ${strongClass}">
                        <span class="text-xs text-crypto-green">${zone.label}</span>
                        <span class="text-xs font-mono text-crypto-green">$${TechnicalAnalysis.formatPrice(zone.level)}</span>
                    </div>`;
                });
                html += '</div>';
            }

            // 卖出区域
            if (advice.sellZones && advice.sellZones.length > 0) {
                html += '<div>';
                html += '<p class="text-xs text-crypto-red/70 mb-1">卖出区域</p>';
                advice.sellZones.forEach(zone => {
                    const strongClass = zone.strength === 'strong' ? 'font-semibold' : '';
                    html += `<div class="flex items-center justify-between py-0.5 ${strongClass}">
                        <span class="text-xs text-crypto-red">${zone.label}</span>
                        <span class="text-xs font-mono text-crypto-red">$${TechnicalAnalysis.formatPrice(zone.level)}</span>
                    </div>`;
                });
                html += '</div>';
            }

            posAdviceEl.innerHTML = html || '<span class="text-gray-500 text-xs">暂无建议</span>';
        }
    },

    // 显示添加币种模态框
    showAddCoinModal() {
        const modal = document.getElementById('addCoinModal');
        modal.classList.remove('hidden');
        modal.classList.add('flex', 'modal-enter');
        
        // 初始显示热门币种
        this.searchCoins('');
    },

    // 隐藏添加币种模态框
    hideAddCoinModal() {
        const modal = document.getElementById('addCoinModal');
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        
        document.getElementById('searchCoinInput').value = '';
    },

    // 搜索币种
    searchCoins(query) {
        const container = document.getElementById('coinSearchResults');
        query = query.toLowerCase();
        
        const filtered = this.popularCoins.filter(coin => 
            coin.name.toLowerCase().includes(query) ||
            coin.symbol.toLowerCase().includes(query) ||
            coin.id.toLowerCase().includes(query)
        ).slice(0, 10);
        
        if (filtered.length === 0) {
            container.innerHTML = '<p class="text-gray-400 text-sm text-center py-4">未找到相关币种</p>';
            return;
        }
        
        container.innerHTML = filtered.map(coin => {
            const isInWatchlist = this.state.watchlist.includes(coin.id);
            return `
                <div class="flex items-center justify-between p-2 rounded-lg hover:bg-crypto-dark cursor-pointer transition-colors" 
                     onclick="CryptoPulseApp.addToWatchlist('${coin.id}')">
                    <div class="flex items-center gap-3">
                        <div class="w-8 h-8 rounded-full bg-gradient-to-br from-crypto-purple to-crypto-blue flex items-center justify-center text-sm font-bold text-white">
                            ${coin.symbol.charAt(0)}
                        </div>
                        <div>
                            <p class="text-sm font-medium">${coin.name}</p>
                            <p class="text-xs text-gray-400">${coin.symbol}</p>
                        </div>
                    </div>
                    ${isInWatchlist ? 
                        '<span class="text-xs text-crypto-green">已添加</span>' : 
                        '<span class="text-xs text-crypto-blue">+ 添加</span>'
                    }
                </div>
            `;
        }).join('');
    },

    // 添加到自选
    addToWatchlist(coinId) {
        if (this.state.watchlist.includes(coinId)) return;
        if (this.state.watchlist.length >= 10) {
            alert('自选最多添加10个币种');
            return;
        }
        
        this.state.watchlist.push(coinId);
        this.saveWatchlist();
        this.renderCoinTabs();
        this.searchCoins(document.getElementById('searchCoinInput').value);
    },

    // 从自选移除
    removeFromWatchlist(coinId) {
        if (this.state.watchlist.length <= 1) return;
        
        const index = this.state.watchlist.indexOf(coinId);
        if (index > -1) {
            this.state.watchlist.splice(index, 1);
            
            // 如果删除的是当前选中的，切换到第一个
            if (coinId === this.state.currentCoin) {
                this.state.currentCoin = this.state.watchlist[0];
                this.loadCoinData(this.state.currentCoin);
            }
            
            this.saveWatchlist();
            this.renderCoinTabs();
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

    // 更新最后更新时间
    updateLastUpdateTime() {
        const el = document.getElementById('lastUpdate');
        if (el && this.state.lastUpdate) {
            el.textContent = this.state.lastUpdate.toLocaleTimeString('zh-CN');
        }
    },

    // 自动刷新
    startAutoRefresh() {
        // 每30秒刷新一次价格和信号
        setInterval(() => {
            this.loadPriceData(this.state.currentCoin);
            this.loadCandleData(this.state.currentCoin);
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
