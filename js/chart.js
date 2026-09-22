/**
 * 图表渲染模块 - 币安白色主题
 * 使用 Lightweight Charts v3 渲染K线图、均线、成交量等
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
    _isFirstLoad: true,
    _isAtLatest: true,
    _lastTime: 0,
    _firstTime: 0,
    _markers: [],
    _onMarkerClick: null,

    /**
     * 初始化图表 - 白色主题（币安风格）
     */
    init(containerId) {
        this.container = document.getElementById(containerId);
        if (!this.container) return;

        try {
            this.chart = LightweightCharts.createChart(this.container, {
                layout: {
                    background: { color: '#ffffff' },
                    textColor: '#848e9c',
                    fontSize: 11,
                },
                grid: {
                    vertLines: { color: 'rgba(240, 243, 248, 0.8)' },
                    horzLines: { color: 'rgba(240, 243, 248, 0.8)' },
                },
                crosshair: {
                    mode: LightweightCharts.CrosshairMode.Normal,
                    vertLine: {
                        color: '#b2b5bd',
                        width: 1,
                        style: 2,
                        labelBackgroundColor: '#4a4f5c',
                    },
                    horzLine: {
                        color: '#b2b5bd',
                        width: 1,
                        style: 2,
                        labelBackgroundColor: '#4a4f5c',
                    },
                },
                rightPriceScale: {
                    borderColor: '#f0f3f8',
                    scaleMargins: {
                        top: 0.08,
                        bottom: 0.2,
                    },
                },
                timeScale: {
                    borderColor: '#f0f3f8',
                    timeVisible: true,
                    secondsVisible: false,
                },
                // 中国大陆时区时间格式化
                localization: {
                    timeFormatter: (businessDayOrTimestamp) => {
                        const date = new Date((businessDayOrTimestamp) * 1000);
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
                            year: '2-digit',
                            month: '2-digit',
                            day: '2-digit',
                            timeZone: 'Asia/Shanghai'
                        };
                        return date.toLocaleDateString('zh-CN', options).replace(/\//g, '-');
                    },
                },
                handleScroll: true,
                handleScale: true,
            });

            // K线系列 - 币安风格红绿
            this.candlestickSeries = this.chart.addCandlestickSeries({
                upColor: '#089981',
                downColor: '#f23645',
                borderDownColor: '#f23645',
                borderUpColor: '#089981',
                wickDownColor: '#f23645',
                wickUpColor: '#089981',
            });

            // 成交量系列
            this.volumeSeries = this.chart.addHistogramSeries({
                color: '#8b5cf6',
                priceFormat: {
                    type: 'volume',
                },
                priceScaleId: '',
                scaleMargins: {
                    top: 0.82,
                    bottom: 0,
                },
            });

            // MA7均线 - 黄色（币安EMA7色）
            this.ma7Series = this.chart.addLineSeries({
                color: '#f0b90b',
                lineWidth: 1.5,
                priceLineVisible: false,
                lastValueVisible: false,
            });

            // MA25均线 - 紫色（币安EMA25色）
            this.ma25Series = this.chart.addLineSeries({
                color: '#8e5cf6',
                lineWidth: 1.5,
                priceLineVisible: false,
                lastValueVisible: false,
            });

            // MA99均线 - 蓝色（币安EMA99色）
            this.ma99Series = this.chart.addLineSeries({
                color: '#3b82f6',
                lineWidth: 1.5,
                priceLineVisible: false,
                lastValueVisible: false,
            });

            // 响应式调整
            this.handleResize();
            window.addEventListener('resize', () => this.handleResize());

            // 跟踪用户视图位置
            this.chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
                if (!range || !this._lastTime) return;
                const totalRange = this._lastTime - this._firstTime || 1;
                const distanceFromEnd = this._lastTime - range.to;
                const ratio = distanceFromEnd / totalRange;
                this._isAtLatest = ratio < 0.02;
            });

            // 绑定图表点击事件
            this.chart.subscribeClick((param) => {
                this._handleChartClick(param);
            });

            return this.chart;
        } catch (e) {
            console.error('图表初始化失败:', e);
            return null;
        }
    },

    handleResize() {
        if (!this.chart || !this.container) return;
        const width = this.container.clientWidth;
        const height = this.container.clientHeight;
        this.chart.applyOptions({ width, height });
    },

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

        if (this.volumeSeries) {
            const volumeData = data.map(d => ({
                time: d.time,
                value: d.volume,
                color: d.close >= d.open ? 'rgba(8, 153, 129, 0.45)' : 'rgba(242, 54, 69, 0.45)',
            }));
            this.volumeSeries.setData(volumeData);
        }

        this._firstTime = data[0].time;
        this._lastTime = data[data.length - 1].time;

        if (this._isFirstLoad) {
            this.chart.timeScale().fitContent();
            this._isFirstLoad = false;
            this._isAtLatest = true;
        } else if (this._isAtLatest) {
            this.chart.timeScale().scrollToRealTime();
        }
    },

    updateMAData(timeData, ma7Data, ma25Data, ma99Data) {
        const createSeriesData = (maData) => {
            if (!maData) return [];
            return timeData.map((time, i) => ({
                time: time,
                value: maData[i],
            })).filter(d => d.value !== null && d.value !== undefined);
        };

        if (this.ma7Series && ma7Data) {
            this.ma7Series.setData(createSeriesData(ma7Data));
        }
        if (this.ma25Series && ma25Data) {
            this.ma25Series.setData(createSeriesData(ma25Data));
        }
        if (this.ma99Series && ma99Data) {
            this.ma99Series.setData(createSeriesData(ma99Data));
        }
    },

    toggleMA(show) {
        if (this.ma7Series) this.ma7Series.applyOptions({ visible: show });
        if (this.ma25Series) this.ma25Series.applyOptions({ visible: show });
        if (this.ma99Series) this.ma99Series.applyOptions({ visible: show });
    },

    toggleVolume(show) {
        if (this.volumeSeries) {
            this.volumeSeries.applyOptions({ visible: show });
        }
    },

    drawSupportResistance(levels) {
        this.clearSupportResistanceLines();
        if (!this.candlestickSeries || !levels) return;

        if (levels.resistance1) {
            const line = this.candlestickSeries.createPriceLine({
                price: levels.resistance1,
                color: 'rgba(242, 54, 69, 0.6)',
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
                color: 'rgba(242, 54, 69, 0.8)',
                lineWidth: 1,
                lineStyle: 1,
                axisLabelVisible: true,
                title: '压力2',
            });
            this.resistanceLines.push(line);
        }

        if (levels.support1) {
            const line = this.candlestickSeries.createPriceLine({
                price: levels.support1,
                color: 'rgba(8, 153, 129, 0.6)',
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
                color: 'rgba(8, 153, 129, 0.8)',
                lineWidth: 1,
                lineStyle: 1,
                axisLabelVisible: true,
                title: '支撑2',
            });
            this.supportLines.push(line);
        }
    },

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

    addMarkers(markers) {
        if (!this.candlestickSeries || !markers || markers.length === 0) return;
        this._markers = markers;
        try {
            if (typeof this.candlestickSeries.setMarkers === 'function') {
                this.candlestickSeries.setMarkers(markers);
            }
        } catch (e) {
            console.warn('设置标记失败:', e);
        }
    },

    clearMarkers() {
        this._markers = [];
        try {
            if (this.candlestickSeries && typeof this.candlestickSeries.setMarkers === 'function') {
                this.candlestickSeries.setMarkers([]);
            }
        } catch (e) { /* 忽略 */ }
    },

    /**
     * 清空图上全部行情数据（K线 / 成交量 / 均线 / 支撑压力 / 买卖点标注）。
     *
     * 行情取不到时用它。不能只靠 updateCandlestickData([]) ——
     * 那个方法遇到空数组会直接 return，图上会留着上一次（甚至上一个币种）
     * 的曲线，看上去「数据还在」，实际已经和当前标的无关了。
     */
    clearCandlestickData() {
        try {
            if (this.candlestickSeries) this.candlestickSeries.setData([]);
            if (this.volumeSeries) this.volumeSeries.setData([]);
            if (this.ma7Series) this.ma7Series.setData([]);
            if (this.ma25Series) this.ma25Series.setData([]);
            if (this.ma99Series) this.ma99Series.setData([]);
        } catch (e) {
            console.warn('清空图表数据失败:', e.message);
        }
        this.clearSupportResistanceLines();
        this.clearMarkers();
    },

    changeTimeframe(timeframe) {
        this.clearSupportResistanceLines();
        this.clearMarkers();
        this._isFirstLoad = true;
        this._isAtLatest = true;
    },

    resetView() {
        if (this.chart) {
            this.chart.timeScale().fitContent();
            this._isAtLatest = true;
        }
    },

    setMarkerClickCallback(callback) {
        this._onMarkerClick = callback;
    },

    _handleChartClick(param) {
        if (!this._onMarkerClick || !this._markers || this._markers.length === 0) return;
        if (!param || !param.time) return;

        const clickTime = param.time;
        const clickPrice = param.point?.y;
        const matched = this._markers.find(m => m.time === clickTime);
        if (matched) {
            this._onMarkerClick(matched.text, clickPrice, clickTime);
        }
    },

    destroy() {
        if (this.chart) {
            this.chart.remove();
            this.chart = null;
        }
        this.candlestickSeries = null;
        this.volumeSeries = null;
        this.ma7Series = null;
        this.ma25Series = null;
        this.ma99Series = null;
        this.resistanceLines = [];
        this.supportLines = [];
    }
};
