/**
 * 图表渲染模块
 * 使用 Lightweight Charts v3 渲染K线图、均线、成交量等
 */

const ChartManager = {
    chart: null,
    candlestickSeries: null,
    volumeSeries: null,
    ma7Series: null,
    ma25Series: null,
    resistanceLines: [],
    supportLines: [],
    container: null,
    _isFirstLoad: true,
    _isAtLatest: true, // 用户是否正在查看最新K线（视图在最右端）
    _lastTime: 0, // 最新数据的时间戳
    _firstTime: 0, // 最早数据的时间戳

    /**
     * 初始化图表
     * @param {string} containerId - 容器ID
     */
    init(containerId) {
        this.container = document.getElementById(containerId);
        if (!this.container) return;

        try {
            // 创建图表
            this.chart = LightweightCharts.createChart(this.container, {
                layout: {
                    background: { color: '#1e293b' },
                    textColor: '#94a3b8',
                },
                grid: {
                    vertLines: { color: 'rgba(51, 65, 85, 0.5)' },
                    horzLines: { color: 'rgba(51, 65, 85, 0.5)' },
                },
                crosshair: {
                    mode: LightweightCharts.CrosshairMode.Normal,
                    vertLine: {
                        color: '#64748b',
                        width: 1,
                        style: 2,
                    },
                    horzLine: {
                        color: '#64748b',
                        width: 1,
                        style: 2,
                    },
                },
                rightPriceScale: {
                    borderColor: '#334155',
                    scaleMargins: {
                        top: 0.1,
                        bottom: 0.2,
                    },
                },
                timeScale: {
                    borderColor: '#334155',
                    timeVisible: true,
                    secondsVisible: false,
                },
                // 中国大陆时区时间格式化
                localization: {
                    timeFormatter: (businessDayOrTimestamp) => {
                        const date = new Date((businessDayOrTimestamp) * 1000);
                        // 使用中国大陆时区（UTC+8）
                        const options = {
                            hour: '2-digit',
                            minute: '2-digit',
                            hour12: false,
                            timeZone: 'Asia/Shanghai'
                        };
                        return date.toLocaleTimeString('zh-CN', options);
                    },
                    dateFormatter: (businessDayOrTimestamp) => {
                        const date = new Date((businessDayOrTimestamp) * 1000);
                        const options = {
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                            timeZone: 'Asia/Shanghai'
                        };
                        return date.toLocaleDateString('zh-CN', options);
                    },
                },
                handleScroll: true,
                handleScale: true,
            });

            // 创建K线系列
            this.candlestickSeries = this.chart.addCandlestickSeries({
                upColor: '#10b981',
                downColor: '#ef4444',
                borderDownColor: '#ef4444',
                borderUpColor: '#10b981',
                wickDownColor: '#ef4444',
                wickUpColor: '#10b981',
            });

            // 创建成交量系列
            this.volumeSeries = this.chart.addHistogramSeries({
                color: '#8b5cf6',
                priceFormat: {
                    type: 'volume',
                },
                priceScaleId: '',
                scaleMargins: {
                    top: 0.8,
                    bottom: 0,
                },
            });

            // 创建MA7均线
            this.ma7Series = this.chart.addLineSeries({
                color: '#f59e0b',
                lineWidth: 1,
                priceLineVisible: false,
                lastValueVisible: false,
            });

            // 创建MA25均线
            this.ma25Series = this.chart.addLineSeries({
                color: '#3b82f6',
                lineWidth: 1,
                priceLineVisible: false,
                lastValueVisible: false,
            });

            // 响应式调整
            this.handleResize();
            window.addEventListener('resize', () => this.handleResize());

            // 跟踪用户视图位置（币安式行为）
            // 用户滚动/缩放后，判断是否仍在查看最新K线
            this.chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
                if (!range || !this._lastTime) return;
                // 检查用户是否滚动到了最右端（查看最新数据）
                // 如果可见范围的右端时间 >= 最新K线时间减去2根K线的时间间隔，视为在看最新
                // 简化处理：距离最新时间小于5%的时间范围视为接近最新
                const totalRange = this._lastTime - this._firstTime || 1;
                const distanceFromEnd = this._lastTime - range.to;
                const ratio = distanceFromEnd / totalRange;
                this._isAtLatest = ratio < 0.02; // 距离末尾小于2%的时间范围视为在看最新
            });

            return this.chart;
        } catch (e) {
            console.error('图表初始化失败:', e);
            return null;
        }
    },

    /**
     * 处理窗口大小变化
     */
    handleResize() {
        if (!this.chart || !this.container) return;
        
        const width = this.container.clientWidth;
        const height = this.container.clientHeight;
        this.chart.applyOptions({ width, height });
    },

    /**
     * 更新K线数据
     * @param {Array} data - K线数据 [{time, open, high, low, close, volume}]
     */
    updateCandlestickData(data) {
        if (!this.candlestickSeries || !data || data.length === 0) return;

        const candleData = data.map(d => ({
            time: d.time,
            open: d.open,
            high: d.high,
            low: d.low,
            close: d.close,
        }));

        this.candlestickSeries.setData(candleData);

        // 更新成交量
        if (this.volumeSeries) {
            const volumeData = data.map(d => ({
                time: d.time,
                value: d.volume,
                color: d.close >= d.open ? 'rgba(16, 185, 129, 0.5)' : 'rgba(239, 68, 68, 0.5)',
            }));
            this.volumeSeries.setData(volumeData);
        }

        // 记录最新/最早数据时间，用于视图位置判断
        this._firstTime = data[0].time;
        this._lastTime = data[data.length - 1].time;

        // 币安式行为：
        // 1. 首次加载：自动缩放到全部数据
        // 2. 后续更新：
        //    - 如果用户正在查看最新K线（视图在最右端）：跟随最新K线
        //    - 如果用户在查看历史数据（向左滚动过）：保持不动，绝不打扰
        if (this._isFirstLoad) {
            this.chart.timeScale().fitContent();
            this._isFirstLoad = false;
            this._isAtLatest = true;
        } else if (this._isAtLatest) {
            // 用户在看最新数据，滚动到最新一根K线（保持跟随）
            this.chart.timeScale().scrollToRealTime();
        }
        // else: 用户在看历史数据，完全保持当前视图不动
    },

    /**
     * 更新均线数据
     * @param {Array} timeData - 时间数据
     * @param {Array} ma7Data - MA7数据
     * @param {Array} ma25Data - MA25数据
     */
    updateMAData(timeData, ma7Data, ma25Data) {
        if (this.ma7Series && ma7Data) {
            const data = timeData.map((time, i) => ({
                time: time,
                value: ma7Data[i],
            })).filter(d => d.value !== null && d.value !== undefined);
            this.ma7Series.setData(data);
        }
        
        if (this.ma25Series && ma25Data) {
            const data = timeData.map((time, i) => ({
                time: time,
                value: ma25Data[i],
            })).filter(d => d.value !== null && d.value !== undefined);
            this.ma25Series.setData(data);
        }
    },

    /**
     * 显示/隐藏均线
     * @param {boolean} show - 是否显示
     */
    toggleMA(show) {
        if (this.ma7Series) {
            this.ma7Series.applyOptions({ visible: show });
        }
        if (this.ma25Series) {
            this.ma25Series.applyOptions({ visible: show });
        }
    },

    /**
     * 显示/隐藏成交量
     * @param {boolean} show - 是否显示
     */
    toggleVolume(show) {
        if (this.volumeSeries) {
            this.volumeSeries.applyOptions({ visible: show });
        }
    },

    /**
     * 绘制支撑压力位线
     * @param {Object} levels - 支撑压力位 { resistance1, resistance2, support1, support2 }
     */
    drawSupportResistance(levels) {
        this.clearSupportResistanceLines();
        
        if (!this.candlestickSeries || !levels) return;
        
        // 压力位（红色虚线）
        if (levels.resistance1) {
            const line = this.candlestickSeries.createPriceLine({
                price: levels.resistance1,
                color: 'rgba(239, 68, 68, 0.6)',
                lineWidth: 1,
                lineStyle: 2,
                axisLabelVisible: true,
                title: '压力1',
            });
            this.resistanceLines.push(line);
        }
        
        if (levels.resistance2) {
            const line = this.candlestickSeries.createPriceLine({
                price: levels.resistance2,
                color: 'rgba(239, 68, 68, 0.8)',
                lineWidth: 1,
                lineStyle: 1,
                axisLabelVisible: true,
                title: '压力2',
            });
            this.resistanceLines.push(line);
        }
        
        // 支撑位（绿色虚线）
        if (levels.support1) {
            const line = this.candlestickSeries.createPriceLine({
                price: levels.support1,
                color: 'rgba(16, 185, 129, 0.6)',
                lineWidth: 1,
                lineStyle: 2,
                axisLabelVisible: true,
                title: '支撑1',
            });
            this.supportLines.push(line);
        }
        
        if (levels.support2) {
            const line = this.candlestickSeries.createPriceLine({
                price: levels.support2,
                color: 'rgba(16, 185, 129, 0.8)',
                lineWidth: 1,
                lineStyle: 1,
                axisLabelVisible: true,
                title: '支撑2',
            });
            this.supportLines.push(line);
        }
    },

    /**
     * 清除支撑压力位线
     */
    clearSupportResistanceLines() {
        if (!this.candlestickSeries) return;
        
        this.resistanceLines.forEach(line => {
            this.candlestickSeries.removePriceLine(line);
        });
        this.supportLines.forEach(line => {
            this.candlestickSeries.removePriceLine(line);
        });
        
        this.resistanceLines = [];
        this.supportLines = [];
    },

    /**
     * 添加标记点（高低点提示）
     * @param {Array} markers - 标记点数组 [{time, position, color, shape, text}]
     */
    addMarkers(markers) {
        if (!this.candlestickSeries || !markers || markers.length === 0) return;
        
        try {
            if (typeof this.candlestickSeries.setMarkers === 'function') {
                this.candlestickSeries.setMarkers(markers);
            }
        } catch (e) {
            console.warn('设置标记失败:', e);
        }
    },

    /**
     * 清除标记点
     */
    clearMarkers() {
        try {
            if (this.candlestickSeries && typeof this.candlestickSeries.setMarkers === 'function') {
                this.candlestickSeries.setMarkers([]);
            }
        } catch (e) {
            // 忽略错误
        }
    },

    /**
     * 切换时间周期
     * @param {string} timeframe - 时间周期
     */
    changeTimeframe(timeframe) {
        this.clearSupportResistanceLines();
        this.clearMarkers();
        this._isFirstLoad = true; // 切换周期后首次加载自动缩放
        this._isAtLatest = true;
    },

    /**
     * 重置视图（缩放到全部数据）
     */
    resetView() {
        if (this.chart) {
            this.chart.timeScale().fitContent();
            this._isAtLatest = true;
        }
    },

    /**
     * 销毁图表
     */
    destroy() {
        if (this.chart) {
            this.chart.remove();
            this.chart = null;
        }
        this.candlestickSeries = null;
        this.volumeSeries = null;
        this.ma7Series = null;
        this.ma25Series = null;
        this.resistanceLines = [];
        this.supportLines = [];
    }
};
