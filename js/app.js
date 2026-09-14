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

    // 主流币种列表
    popularCoins: [
        { id: 'bitcoin', symbol: 'BTC', name: '比特币', image: '₿' },
        { id: 'ethereum', symbol: 'ETH', name: '以太坊', image: 'Ξ' },
        { id: 'binancecoin', symbol: 'BNB', name: '币安币', image: 'B' },
        { id: 'solana', symbol: 'SOL', name: 'Solana', image: 'S' },
        { id: 'ripple', symbol: 'XRP', name: '瑞波币', image: 'X' },
        { id: 'cardano', symbol: 'ADA', name: '艾达币', image: 'A' },
        { id: 'dogecoin', symbol: 'DOGE', name: '狗狗币', image: 'D' },
        { id: 'polkadot', symbol: 'DOT', name: '波卡币', image: 'P' },
        { id: 'avalanche-2', symbol: 'AVAX', name: '雪崩币', image: 'A' },
        { id: 'chainlink', symbol: 'LINK', name: 'Chainlink', image: 'L' },
        { id: 'matic-network', symbol: 'MATIC', name: 'Polygon', image: 'M' },
        { id: 'litecoin', symbol: 'LTC', name: '莱特币', image: 'L' },
        { id: 'uniswap', symbol: 'UNI', name: 'Uniswap', image: 'U' },
        { id: 'cosmos', symbol: 'ATOM', name: 'Cosmos', image: 'C' },
        { id: 'stellar', symbol: 'XLM', name: '恒星币', image: 'X' },
    ],

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
                this.loadNews(coinId)
            ]);
            
            this.state.lastUpdate = new Date();
            this.updateLastUpdateTime();
        } catch (error) {
            console.error('加载数据失败:', error);
        } finally {
            this.state.isLoading = false;
            this.showLoading(false);
        }
    },

    // 加载价格数据
    async loadPriceData(coinId) {
        try {
            const response = await fetch(
                `https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&community_data=false&developer_data=false`
            );
            
            if (!response.ok) throw new Error('Price API error');
            
            const data = await response.json();
            
            this.state.coinInfo = {
                id: data.id,
                symbol: data.symbol.toUpperCase(),
                name: data.name,
                image: data.image?.large || '',
                current_price: data.market_data?.current_price?.usd || 0,
                price_change_24h: data.market_data?.price_change_24h || 0,
                price_change_percentage_24h: data.market_data?.price_change_percentage_24h || 0,
                high_24h: data.market_data?.high_24h?.usd || 0,
                low_24h: data.market_data?.low_24h?.usd || 0,
                total_volume: data.market_data?.total_volume?.usd || 0,
                market_cap: data.market_data?.market_cap?.usd || 0,
            };
            
            this.updatePriceUI();
            
        } catch (error) {
            console.error('获取价格数据失败:', error);
            // 使用模拟数据
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

    // 加载K线数据
    async loadCandleData(coinId) {
        try {
            const days = Math.ceil(this.state.currentTimeframe / 24);
            const response = await fetch(
                `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`
            );
            
            if (!response.ok) throw new Error('OHLC API error');
            
            const data = await response.json();
            
            // 转换数据格式
            const candleData = data.map(item => ({
                time: Math.floor(item[0] / 1000), // 毫秒转秒
                open: item[1],
                high: item[2],
                low: item[3],
                close: item[4],
                volume: 0 // CoinGecko OHLC 不包含成交量，后续用市场数据估算
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
        const rsi = TechnicalAnalysis.calculateRSI(closes, 14);
        const macd = TechnicalAnalysis.calculateMACD(closes);
        const bollinger = TechnicalAnalysis.calculateBollingerBands(closes, 20);
        const supportResistance = TechnicalAnalysis.calculateSupportResistance(highs, lows, closes, currentPrice);
        
        this.state.indicators = {
            ma7,
            ma25,
            rsi: rsi[rsi.length - 1],
            macd: {
                value: macd.macd[macd.macd.length - 1],
                signal: macd.signal[macd.signal.length - 1],
                histogram: macd.histogram[macd.histogram.length - 1],
                ...macd
            },
            bollingerBands: bollinger,
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
        
        // RSI
        const rsiValue = ind.rsi;
        const rsiEl = document.getElementById('rsiValue');
        const rsiBar = document.getElementById('rsiBar');
        
        if (rsiValue !== null && rsiValue !== undefined) {
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
        const techScoreResult = TechnicalAnalysis.calculateTechnicalScore({
            rsi: this.state.indicators.rsi,
            macd: this.state.indicators.macd,
            ma7: this.state.indicators.ma7,
            ma25: this.state.indicators.ma25,
            currentPrice: this.state.indicators.currentPrice,
            bollingerBands: this.state.indicators.bollingerBands
        });
        
        const newsScoreResult = NewsAnalyzer.calculateNewsScore(this.state.newsList);
        
        const signal = SignalGenerator.generateSignal(
            techScoreResult,
            newsScoreResult,
            {
                supportResistance: this.state.indicators.supportResistance,
                currentPrice: this.state.indicators.currentPrice
            }
        );
        
        this.state.signal = signal;
        this.renderSignal();
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
        document.getElementById('techScore').className = `text-lg font-semibold ${SignalGenerator.getScoreColor(signal.techScore)}`;
        
        document.getElementById('newsScore').textContent = signal.newsScore;
        document.getElementById('newsScore').className = `text-lg font-semibold ${SignalGenerator.getScoreColor(signal.newsScore)}`;
        
        document.getElementById('totalScore').textContent = signal.totalScore;
        document.getElementById('totalScore').className = `text-lg font-semibold ${SignalGenerator.getScoreColor(signal.totalScore)}`;
        
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
