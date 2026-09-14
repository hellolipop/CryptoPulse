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
        lastUpdate: null
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

        // 技术指标标签切换
        document.querySelectorAll('.indicator-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                document.querySelectorAll('.indicator-tab').forEach(t => {
                    t.classList.remove('text-crypto-gold', 'border-b-2', 'border-crypto-gold');
                    t.classList.add('text-gray-400');
                });
                e.target.classList.add('text-crypto-gold', 'border-b-2', 'border-crypto-gold');
                e.target.classList.remove('text-gray-400');

                const tabName = e.target.dataset.tab;
                document.querySelectorAll('.indicator-panel').forEach(p => p.classList.add('hidden'));
                document.getElementById('tab-' + tabName).classList.remove('hidden');
            });
        });

        // 添加币种按钮
        document.getElementById('addCoinBtn').addEventListener('click', () => {
            this.showAddCoinModal();
        });

        // 关闭模态框
        document.getElementById('closeModalBtn').addEventListener('click', () => {
            this.hideAddCoinModal();
        });

        // 点击模态框外部关闭
        document.getElementById('addCoinModal').addEventListener('click', (e) => {
            if (e.target.id === 'addCoinModal') {
                this.hideAddCoinModal();
            }
        });

        // 搜索币种
        document.getElementById('searchCoinInput').addEventListener('input', (e) => {
            this.searchCoins(e.target.value);
        });
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
        
        const markers = [];
        const data = this.state.candleData;
        
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
        
        // 只保留最近的几个标记
        const recentMarkers = markers.slice(-6);
        ChartManager.addMarkers(recentMarkers);
    },

    // 更新价格UI
    updatePriceUI() {
        const info = this.state.coinInfo;
        if (!info) return;
        
        // 当前价格
        document.getElementById('currentPrice').textContent = '$' + TechnicalAnalysis.formatPrice(info.current_price);
        
        // 价格变化
        const changeEl = document.getElementById('priceChange');
        const changePercent = info.price_change_percentage_24h;
        const isPositive = changePercent >= 0;
        changeEl.textContent = `${isPositive ? '+' : ''}${changePercent.toFixed(2)}% (${isPositive ? '+' : ''}$${TechnicalAnalysis.formatPrice(Math.abs(info.price_change_24h))})`;
        changeEl.className = `text-sm mt-1 ${isPositive ? 'text-crypto-green' : 'text-crypto-red'}`;
        
        // 24H最高/最低
        document.getElementById('high24h').textContent = '$' + TechnicalAnalysis.formatPrice(info.high_24h);
        document.getElementById('low24h').textContent = '$' + TechnicalAnalysis.formatPrice(info.low_24h);
        
        // 24H成交量
        document.getElementById('volume24h').textContent = '$' + TechnicalAnalysis.formatLargeNumber(info.total_volume);
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
            rsiEl.style.color = SignalGenerator.getRSIColor(rsiValue);
            rsiBar.style.width = rsiValue + '%';
            rsiBar.style.backgroundColor = SignalGenerator.getRSIColor(rsiValue);
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
            macdEl.className = `text-lg font-semibold ${macdValue > 0 ? 'text-crypto-green' : 'text-crypto-red'}`;
        } else {
            macdEl.textContent = '--';
        }

        if (typeof macdSignal === 'number' && !isNaN(macdSignal)) {
            macdSignalEl.textContent = `信号: ${macdSignal.toFixed(4)}`;
        } else {
            macdSignalEl.textContent = '--';
        }

        // Stochastic RSI
        const stochK = ind.stochRSI?.k;
        const stochD = ind.stochRSI?.d;
        const stochEl = document.getElementById('stochRSIValue');
        const stochSignalEl = document.getElementById('stochRSISignal');
        if (stochK && stochK[stochK.length - 1] !== null) {
            const lastK = stochK[stochK.length - 1];
            stochEl.textContent = lastK.toFixed(1);
            stochEl.className = `text-lg font-semibold ${lastK > 80 ? 'text-crypto-red' : lastK < 20 ? 'text-crypto-green' : 'text-white'}`;
        } else {
            stochEl.textContent = '--';
        }
        if (stochD && stochD[stochD.length - 1] !== null) {
            stochSignalEl.textContent = `D: ${stochD[stochD.length - 1].toFixed(1)}`;
        } else {
            stochSignalEl.textContent = '--';
        }

        // KDJ
        const kdj = ind.kdj;
        const kdjKEl = document.getElementById('kdjKValue');
        const kdjDJEl = document.getElementById('kdjDJValue');
        if (kdj && kdj.k && kdj.k[kdj.k.length - 1] !== null) {
            const lastK = kdj.k[kdj.k.length - 1];
            kdjKEl.textContent = lastK.toFixed(1);
            kdjKEl.className = `text-lg font-semibold ${lastK > 80 ? 'text-crypto-red' : lastK < 20 ? 'text-crypto-green' : 'text-white'}`;

            const lastD = kdj.d[kdj.d.length - 1];
            const lastJ = kdj.j[kdj.j.length - 1];
            kdjDJEl.textContent = `D: ${lastD?.toFixed(1) || '--'}  J: ${lastJ?.toFixed(1) || '--'}`;
        } else {
            kdjKEl.textContent = '--';
            kdjDJEl.textContent = 'D: -- J: --';
        }

        // 布林带
        const boll = ind.bollingerBands;
        if (boll && boll.upper && boll.lower) {
            const lastUpper = boll.upper[boll.upper.length - 1];
            const lastLower = boll.lower[boll.lower.length - 1];
            if (lastUpper) document.getElementById('bollUpper').textContent = '上: $' + TechnicalAnalysis.formatPrice(lastUpper);
            if (lastLower) document.getElementById('bollLower').textContent = '下: $' + TechnicalAnalysis.formatPrice(lastLower);
        }

        // AHR999
        const ahr = ind.ahr999;
        const ahrEl = document.getElementById('ahr999Value');
        const ahrZoneEl = document.getElementById('ahr999Zone');
        if (ahr && ahr.value !== null && !isNaN(ahr.value)) {
            ahrEl.textContent = ahr.value.toFixed(3);
            ahrZoneEl.textContent = this.getAHR999ZoneText(ahr.zone);
            ahrEl.className = `text-lg font-semibold ${ahr.zone === 'deep_value' ? 'text-crypto-green' : ahr.zone === 'accumulation' ? 'text-crypto-blue' : 'text-crypto-red'}`;
        } else {
            ahrEl.textContent = '--';
            ahrZoneEl.textContent = '--';
        }

        // MA7
        const ma7El = document.getElementById('ma7Value');
        const ma7 = ind.ma7;
        if (ma7 && ma7[ma7.length - 1]) {
            ma7El.textContent = '$' + TechnicalAnalysis.formatPrice(ma7[ma7.length - 1]);
        }

        // MA25
        const ma25El = document.getElementById('ma25Value');
        const ma25 = ind.ma25;
        if (ma25 && ma25[ma25.length - 1]) {
            ma25El.textContent = '$' + TechnicalAnalysis.formatPrice(ma25[ma25.length - 1]);
        }

        // MA200
        const ma200El = document.getElementById('ma200Value');
        const ma200 = ind.ma200;
        if (ma200 && ma200[ma200.length - 1]) {
            const lastMA200 = ma200[ma200.length - 1];
            ma200El.textContent = '$' + TechnicalAnalysis.formatPrice(lastMA200);
            const ma200Status = currentPrice > lastMA200 ? 'text-crypto-green' : 'text-crypto-red';
            ma200El.className = `text-lg font-semibold ${ma200Status}`;
        } else {
            ma200El.textContent = '--';
        }

        // 均线排列
        this.updateMAAlignment(ind);

        // VWAP
        const vwapEl = document.getElementById('vwapValue');
        const vwapPosEl = document.getElementById('vwapPosition');
        const vwap = ind.vwap;
        if (vwap && vwap[vwap.length - 1]) {
            const lastVWAP = vwap[vwap.length - 1];
            vwapEl.textContent = '$' + TechnicalAnalysis.formatPrice(lastVWAP);
            const above = currentPrice > lastVWAP;
            vwapPosEl.textContent = above ? '价格在VWAP上方' : '价格在VWAP下方';
            vwapPosEl.className = `text-xs ${above ? 'text-crypto-green' : 'text-crypto-red'}`;
        } else {
            vwapEl.textContent = '--';
            vwapPosEl.textContent = '--';
        }

        // OBV趋势
        const obvTrendEl = document.getElementById('obvTrend');
        const obv = ind.obv;
        if (obv && obv.length >= 10) {
            const recent = obv.slice(-10);
            const rising = recent[recent.length - 1] > recent[0];
            obvTrendEl.textContent = rising ? '上升 ↑' : '下降 ↓';
            obvTrendEl.className = `text-lg font-semibold ${rising ? 'text-crypto-green' : 'text-crypto-red'}`;
        } else {
            obvTrendEl.textContent = '--';
        }

        // 成交量
        const volEl = document.getElementById('volume24hInd');
        if (this.state.coinInfo?.total_volume) {
            volEl.textContent = '$' + TechnicalAnalysis.formatLargeNumber(this.state.coinInfo.total_volume);
        }

        // 支撑压力位
        const sr = ind.supportResistance;
        if (sr) {
            document.getElementById('resistance2').textContent = '$' + TechnicalAnalysis.formatPrice(sr.resistance2);
            document.getElementById('resistance1').textContent = '$' + TechnicalAnalysis.formatPrice(sr.resistance1);
            document.getElementById('currentPriceLevel').textContent = '$' + TechnicalAnalysis.formatPrice(ind.currentPrice);
            document.getElementById('support1').textContent = '$' + TechnicalAnalysis.formatPrice(sr.support1);
            document.getElementById('support2').textContent = '$' + TechnicalAnalysis.formatPrice(sr.support2);
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
        const container = document.getElementById('maAlignment');
        if (!container || !ind.ma7 || !ind.ma25) return;

        const ma7 = ind.ma7[ind.ma7.length - 1];
        const ma25 = ind.ma25[ind.ma25.length - 1];
        const ma200 = ind.ma200?.[ind.ma200.length - 1];
        const price = ind.currentPrice;

        if (!ma7 || !ma25) return;

        let alignment = '';
        let colorClass = 'text-gray-400';

        if (price > ma7 && ma7 > ma25) {
            if (ma200 && ma25 > ma200) {
                alignment = '多头排列（强势）';
                colorClass = 'text-crypto-green';
            } else {
                alignment = '短期多头';
                colorClass = 'text-crypto-green/70';
            }
        } else if (price < ma7 && ma7 < ma25) {
            if (ma200 && ma25 < ma200) {
                alignment = '空头排列（弱势）';
                colorClass = 'text-crypto-red';
            } else {
                alignment = '短期空头';
                colorClass = 'text-crypto-red/70';
            }
        } else {
            alignment = '均线交织（震荡）';
            colorClass = 'text-crypto-gold';
        }

        container.innerHTML = `<span class="px-2 py-1 bg-crypto-dark rounded ${colorClass}">${alignment}</span>`;
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
        if (deriv.fundingRate !== null && deriv.fundingRate !== undefined) {
            frEl.textContent = deriv.fundingRate.toFixed(4) + '%';
            frEl.className = `text-lg font-semibold ${deriv.fundingRate > 0 ? 'text-crypto-green' : 'text-crypto-red'}`;

            if (deriv.fundingRate > 0.1) {
                frDescEl.textContent = '多头拥挤，警惕轧空';
                frDescEl.className = 'text-xs text-crypto-red';
            } else if (deriv.fundingRate < -0.05) {
                frDescEl.textContent = '空头拥挤，关注轧空';
                frDescEl.className = 'text-xs text-crypto-green';
            } else {
                frDescEl.textContent = '费率正常';
                frDescEl.className = 'text-xs text-gray-500';
            }
        }

        // OI
        const oiEl = document.getElementById('openInterest');
        const oiTrendEl = document.getElementById('oiTrend');
        if (deriv.openInterest) {
            oiEl.textContent = TechnicalAnalysis.formatLargeNumber(deriv.openInterest);
            oiTrendEl.textContent = '未平仓合约';
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
        
        container.innerHTML = newsList.slice(0, 6).map(news => {
            const sentimentStyle = NewsAnalyzer.getSentimentStyle(news.sentimentLabel);
            return `
                <a href="${news.url}" target="_blank" class="news-card bg-crypto-card rounded-xl border border-crypto-border p-4 block hover:border-crypto-purple/50 transition-all">
                    <div class="flex items-start justify-between gap-2 mb-2">
                        <span class="text-xs text-gray-400">${news.source}</span>
                        <span class="tip-tag ${sentimentStyle.className}">${sentimentStyle.text}</span>
                    </div>
                    <h4 class="text-sm font-medium mb-2 line-clamp-2 text-gray-100">${news.title}</h4>
                    <p class="text-xs text-gray-400 line-clamp-2 mb-2">${news.description || ''}</p>
                    <p class="text-xs text-gray-500">${NewsAnalyzer.formatTime(news.publishedAt)}</p>
                </a>
            `;
        }).join('');
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
        
        signalIcon.className = `w-16 h-16 mx-auto mb-3 rounded-full flex items-center justify-center`;
        
        if (signal.type.includes('buy')) {
            signalCard.className = 'text-center py-4 signal-buy rounded-xl';
            signalIcon.classList.add('bg-crypto-green/20');
            signalText.className = 'text-xl font-bold text-crypto-green';
        } else if (signal.type.includes('sell')) {
            signalCard.className = 'text-center py-4 signal-sell rounded-xl';
            signalIcon.classList.add('bg-crypto-red/20');
            signalText.className = 'text-xl font-bold text-crypto-red';
        } else {
            signalCard.className = 'text-center py-4 signal-hold rounded-xl';
            signalIcon.classList.add('bg-crypto-gold/20');
            signalText.className = 'text-xl font-bold text-crypto-gold';
        }
        
        signalIcon.innerHTML = SignalGenerator.getSignalIcon(signal.type);
        signalText.textContent = signal.text;
        signalDesc.textContent = signal.desc;
        
        // 评分
        document.getElementById('techScore').textContent = signal.techScore;
        document.getElementById('techScore').className = `text-base font-semibold ${SignalGenerator.getScoreColor(signal.techScore)}`;

        document.getElementById('newsScore').textContent = signal.newsScore;
        document.getElementById('newsScore').className = `text-base font-semibold ${SignalGenerator.getScoreColor(signal.newsScore)}`;

        const sentimentScore = signal.breakdown?.sentiment ?? 50;
        document.getElementById('sentimentScore').textContent = sentimentScore;
        document.getElementById('sentimentScore').className = `text-base font-semibold ${SignalGenerator.getScoreColor(sentimentScore)}`;

        const derivScore = signal.breakdown?.derivatives ?? 50;
        document.getElementById('derivScore').textContent = derivScore;
        document.getElementById('derivScore').className = `text-base font-semibold ${SignalGenerator.getScoreColor(derivScore)}`;

        const totalScore = signal.totalScore ?? 50;
        document.getElementById('totalScore').textContent = totalScore;
        document.getElementById('totalScore').className = `text-2xl font-bold ${SignalGenerator.getScoreColor(totalScore)}`;
        
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
