/**
 * 图表渲染模块
 * 使用 Lightweight Charts 渲染K线图、均线、成交量等
 */

const ChartManager = {
    chart: null,
    candlestickSeries: null,
    volumeSeries: null,
    ma7Series: null,
    ma25Series: null,
    ma99Series: null,
    resistanceLines: [],
    supportLines: [],
    container: null,

    /**
     * 初始化图表
     * @param {string} containerId - 容器ID
     */
    init(containerId) {
        this.container = document.getElementById(containerId);
        if (!this.container) return;

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

        return this.chart;
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
        
        // 自动缩放
        this.chart.timeScale().fitContent();
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
        // 清除旧的线
        this.clearSupportResistanceLines();
        
        if (!this.candlestickSeries || !levels) return;
        
        // 压力位（红色）
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
        
        // 支撑位（绿色）
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
        
        this.candlestickSeries.setMarkers(markers);
    },

    /**
     * 清除标记点
     */
    clearMarkers() {
        if (!this.candlestickSeries) return;
        this.candlestickSeries.setMarkers([]);
    },

    /**
     * 切换时间周期
     * @param {string} timeframe - 时间周期
     */
    changeTimeframe(timeframe) {
        // 时间周期切换由 app.js 处理数据获取
        // 这里只需要清除现有数据
        this.clearSupportResistanceLines();
        this.clearMarkers();
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
