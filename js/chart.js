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
    _onMarkerHover: null,
    _hoverTipEl: null,
    _hoverKey: null,

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

            // 标注悬停说明。
            // Lightweight Charts 的标注没有自己的事件，所以借十字光标判断
            // 「当前停在哪根K线上」，命中标注时再由上层决定要不要给说明
            // （目前只有「待确认」会给，其余标注点一下已有完整弹窗）。
            this._ensureHoverTip();
            this.chart.subscribeCrosshairMove((param) => {
                this._handleCrosshairMove(param);
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
        this._hideHoverTip();
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

    /**
     * 注册「标注悬停要显示什么」。
     *
     * 回调收到命中的标注对象，返回 {title, lines, hint} 就弹气泡，
     * 返回 null 表示这个标注不需要悬停说明 —— 语义判断留在上层，
     * 图表模块只负责把气泡画出来。
     */
    setMarkerHoverProvider(callback) {
        this._onMarkerHover = callback;
    },

    /** 建一次气泡，并确保容器是它的定位锚点 */
    _ensureHoverTip() {
        if (!this.container || this._hoverTipEl) return;
        // 容器默认是 static，那样绝对定位的气泡会跑到页面别处去
        if (getComputedStyle(this.container).position === 'static') {
            this.container.style.position = 'relative';
        }
        const tip = document.createElement('div');
        tip.className = 'chart-hover-tip';
        this.container.appendChild(tip);
        this._hoverTipEl = tip;
    },

    _handleCrosshairMove(param) {
        if (!param || !param.time || !this._onMarkerHover) {
            this._hideHoverTip();
            return;
        }
        const marker = (this._markers || []).find(m => m.time === param.time);
        if (!marker) {
            this._hideHoverTip();
            return;
        }

        let tip = null;
        try { tip = this._onMarkerHover(marker); } catch (e) { tip = null; }
        if (!tip) {
            this._hideHoverTip();
            return;
        }

        // 内容没变就只挪位置：十字光标一动就重建 DOM 是白费的
        const key = `${marker.time}|${tip.title || ''}`;
        if (key !== this._hoverKey) {
            this._hoverKey = key;
            this._fillHoverTip(tip);
        }
        this._placeHoverTip(param);
    },

    _fillHoverTip(tip) {
        const el = this._hoverTipEl;
        if (!el) return;
        el.textContent = '';

        const add = (text, className) => {
            const span = document.createElement('span');
            span.className = className;
            span.textContent = text;
            el.appendChild(span);
        };

        if (tip.title) add(tip.title, 'tip-title');
        (tip.lines || []).forEach(line => add(line, 'tip-line'));
        if (tip.hint) add(tip.hint, 'tip-hint');
    },

    _placeHoverTip(param) {
        const el = this._hoverTipEl;
        if (!el || !this.container) return;

        el.classList.add('is-visible');

        // 先让浏览器算出尺寸再定位，否则贴右/下边缘时会被裁掉
        const box = this.container.getBoundingClientRect();
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const point = param.point || { x: box.width / 2, y: box.height / 2 };
        const pad = 12;
        const edge = 4;
        const clamp = (v, max) => Math.max(edge, Math.min(v, Math.max(edge, max)));

        // 默认放在光标右上方；右侧不够就翻到左边，上方不够就翻到下方
        let left = point.x + pad;
        if (left + w > box.width - edge) left = point.x - pad - w;

        let top = point.y - h - pad;
        if (top < edge) top = point.y + pad;

        el.style.left = clamp(left, box.width - w - edge) + 'px';
        el.style.top = clamp(top, box.height - h - edge) + 'px';
    },

    _hideHoverTip() {
        this._hoverKey = null;
        if (this._hoverTipEl) this._hoverTipEl.classList.remove('is-visible');
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
        // 悬停气泡是我们自己加进容器的，chart.remove() 不管它，得自己收掉
        if (this._hoverTipEl && this._hoverTipEl.parentNode) {
            this._hoverTipEl.parentNode.removeChild(this._hoverTipEl);
        }
        this._hoverTipEl = null;
        this._hoverKey = null;
        this._markers = [];
    }
};

/**
 * 把K线画成一张可以直接塞进邮件的 PNG。
 *
 * 为什么不用上面那个 Lightweight Charts 实例截屏：
 *
 *   1. 发提醒时界面上显示的往往是**别的**币种。邮件里的图必须是「这个买卖点所属的
 *      那个标的、那个周期」，不能在别人的图上标个箭头。
 *   2. 更要紧的是：标签页不可见时浏览器会停掉 requestAnimationFrame，而
 *      Lightweight Charts 正是挂在 rAF 上绘制的。那种情况下 takeScreenshot()
 *      要么拿到空白，要么一直等不到绘制 —— 而邮件提醒最需要发挥作用的场景，
 *      恰恰就是你没在看页面的时候。
 *
 * 所以这里用普通 2D canvas 自己画：同步绘制，不依赖 rAF，画完就有内容。
 * 配色与界面那一套完全一致（涨 #089981 / 跌 #f23645、成交量同色 45% 透明、
 * MA7 #f0b90b、MA25 #8e5cf6、MA99 #3b82f6、买卖点箭头同涨跌色），
 * 让人在邮箱里看到的图与页面上看到的是同一个东西。
 */
const ChartSnapshot = {
    UP: '#089981',
    DOWN: '#f23645',
    MA7: '#f0b90b',
    MA25: '#8e5cf6',
    MA99: '#3b82f6',
    FONT: '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",-apple-system,"Helvetica Neue",sans-serif',

    /**
     * 渲染一张K线图
     *
     * @param {Object} o
     * @param {Array} o.candles - K线（含正在走形那根，与界面一致）
     * @param {Array} [o.ma7] [o.ma25] [o.ma99] - 均线，与 candles 同下标
     * @param {Array} [o.markers] - 与界面同源的标注（generateSignalMarkers 的输出）
     * @param {number} [o.focusTime] - 本次提醒所在K线的时间，会画一条竖线标出来
     * @param {string} [o.title] [o.note] - 标题与副标题
     * @param {string} [o.note2] - 第二行副标题（用来说明图上的「待确认」箭头）。
     *        有它时标题区自动加高，不会压到K线上。
     * @param {number} [o.bars] - 只画最近多少根。界面是 fitContent 全画，但 200 根挤在
     *        一张图里箭头会糊成一片，看不出位置；这里默认收窄到 90 根。
     * @returns {{base64:string,width:number,height:number}|null}
     */
    render(o) {
        const opt = o || {};
        const candles = opt.candles || [];
        if (candles.length < 2) return null;

        const W = opt.width || 960;
        const H = opt.height || 430;
        const note2 = opt.note2 || null;
        // 两行副标题要占两行的高度，否则第二行会盖在K线上
        const titleH = note2 ? 66 : 48;
        const padL = 14;
        const padR = 80;      // 右侧价格轴
        const padT = 12;
        const padB = 26;      // 底部时间轴

        const x0 = padL;
        const x1 = W - padR;
        const y0 = titleH + padT;
        const y1 = H - padB;

        // 成交量占底部 18%，价格区在上方
        const volTop = y1 - (y1 - y0) * 0.18;
        const priceTop = y0;
        const priceBottom = volTop - 6;

        const bars = Math.max(20, Math.min(opt.bars || 90, candles.length));
        const end = candles.length - 1;
        const start = end - bars + 1;
        const view = candles.slice(start, end + 1);

        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, H);
        ctx.textBaseline = 'middle';

        // ---- 纵向网格 + 右侧价格刻度 ----
        let hi = -Infinity;
        let lo = Infinity;
        view.forEach(c => { if (c.high > hi) hi = c.high; if (c.low < lo) lo = c.low; });
        [opt.ma7, opt.ma25, opt.ma99].forEach(arr => {
            if (!arr) return;
            for (let i = start; i <= end; i++) {
                const v = arr[i];
                if (v == null) continue;
                if (v > hi) hi = v;
                if (v < lo) lo = v;
            }
        });
        if (!isFinite(hi) || !isFinite(lo) || hi === lo) {
            hi = hi + (hi || 1) * 0.01;
            lo = lo - (lo || 1) * 0.01;
        }
        // 上下各留一点余量，免得最高/最低的影线贴边
        const span = hi - lo;
        hi += span * 0.06;
        lo -= span * 0.06;

        const priceY = v => priceBottom - (v - lo) / (hi - lo) * (priceBottom - priceTop);

        const slot = (x1 - x0) / bars;
        const cx = i => x0 + (i - start + 0.5) * slot;

        ctx.font = '11px ' + this.FONT;
        ctx.textAlign = 'right';
        ctx.strokeStyle = '#e8ecf3';
        ctx.lineWidth = 1;
        const ticks = 5;
        for (let t = 0; t <= ticks; t++) {
            const v = lo + (hi - lo) * t / ticks;
            const y = Math.round(priceY(v)) + 0.5;
            ctx.beginPath();
            ctx.moveTo(x0, y);
            ctx.lineTo(x1, y);
            ctx.stroke();
            ctx.fillStyle = '#848e9c';
            const label = TechnicalAnalysis.formatPrice(v);
            ctx.fillText(label, W - 8, y);
        }

        // ---- 成交量 ----
        let maxVol = 0;
        view.forEach(c => { if (c.volume > maxVol) maxVol = c.volume; });
        if (maxVol > 0) {
            const volH = y1 - volTop;
            const bodyW = Math.max(1, Math.floor(slot * 0.62));
            view.forEach((c, i) => {
                const h = Math.max(1, (c.volume / maxVol) * volH);
                ctx.fillStyle = c.close >= c.open ? 'rgba(8, 153, 129, 0.45)' : 'rgba(242, 54, 69, 0.45)';
                ctx.fillRect(Math.round(cx(start + i) - bodyW / 2), y1 - h, bodyW, h);
            });
        }

        // ---- 均线（先画，让K线压在上面）----
        const drawLine = (arr, color) => {
            if (!arr) return;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            let started = false;
            for (let i = start; i <= end; i++) {
                const v = arr[i];
                if (v == null) { started = false; continue; }
                const x = cx(i);
                const y = priceY(v);
                if (!started) { ctx.moveTo(x, y); started = true; }
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        };
        drawLine(opt.ma7, this.MA7);
        drawLine(opt.ma25, this.MA25);
        drawLine(opt.ma99, this.MA99);

        // ---- K线 ----
        const bodyW = Math.max(1, Math.floor(slot * 0.62));
        view.forEach((c, i) => {
            const x = cx(start + i);
            const up = c.close >= c.open;
            const color = up ? this.UP : this.DOWN;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            // 影线
            ctx.beginPath();
            const wx = Math.round(x) + 0.5;
            ctx.moveTo(wx, priceY(c.high));
            ctx.lineTo(wx, priceY(c.low));
            ctx.stroke();
            // 实体（开收相同也画一条细线，否则会看不见）
            const top = priceY(Math.max(c.open, c.close));
            const bottom = priceY(Math.min(c.open, c.close));
            ctx.fillStyle = color;
            ctx.fillRect(Math.round(x - bodyW / 2), Math.round(top), bodyW, Math.max(1, Math.round(bottom - top)));
        });

        // ---- 买卖点标注：与界面同源，形状/颜色/文案都照搬 ----
        const timeToIndex = {};
        candles.forEach((c, i) => { timeToIndex[c.time] = i; });
        (opt.markers || []).forEach(m => {
            const i = timeToIndex[m.time];
            if (i === undefined || i < start || i > end) return;
            const c = candles[i];
            const below = m.position === 'belowBar';
            const x = cx(i);
            const y = below ? priceY(c.low) + 9 : priceY(c.high) - 9;
            const dir = below ? 1 : -1;
            const s = m.size === 2 ? 7 : 5.5;

            ctx.fillStyle = m.color || (below ? this.UP : this.DOWN);
            ctx.beginPath();
            if (below) {
                ctx.moveTo(x, y);
                ctx.lineTo(x - s * 0.72, y + dir * s);
                ctx.lineTo(x + s * 0.72, y + dir * s);
            } else {
                ctx.moveTo(x, y);
                ctx.lineTo(x - s * 0.72, y + dir * s);
                ctx.lineTo(x + s * 0.72, y + dir * s);
            }
            ctx.closePath();
            ctx.fill();

            ctx.font = (m.size === 2 ? '700 11px ' : '600 10px ') + this.FONT;
            ctx.textAlign = 'center';
            const ty = below ? y + s + 8 : y - s - 8;
            ctx.fillText(m.text, Math.max(x0 + 24, Math.min(x1 - 24, x)), ty);
        });

        // ---- 本次提醒所在的那根K线：竖虚线标出来 ----
        const fi = opt.focusTime !== undefined ? timeToIndex[opt.focusTime] : undefined;
        if (fi !== undefined && fi >= start && fi <= end) {
            const x = Math.round(cx(fi)) + 0.5;
            ctx.save();
            ctx.setLineDash([4, 3]);
            ctx.strokeStyle = 'rgba(74, 79, 92, 0.55)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, priceTop);
            ctx.lineTo(x, y1);
            ctx.stroke();
            ctx.restore();
            const label = '本次买卖点（已确认）';
            ctx.font = '600 10px ' + this.FONT;
            const tw = ctx.measureText(label).width + 12;
            let bx = Math.min(Math.max(x - tw / 2, x0), x1 - tw);
            ctx.fillStyle = '#4a4f5c';
            ctx.fillRect(bx, priceTop + 2, tw, 16);
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.fillText(label, bx + tw / 2, priceTop + 10);
        }

        // ---- 底部时间轴 ----
        ctx.font = '11px ' + this.FONT;
        ctx.fillStyle = '#848e9c';
        ctx.textAlign = 'center';
        const fmt = t => {
            const d = new Date(t * 1000);
            const p = n => String(n).padStart(2, '0');
            return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
        };
        const step = Math.max(1, Math.floor(bars / 5));
        for (let i = start; i <= end; i += step) {
            ctx.fillText(fmt(candles[i].time), Math.max(x0 + 28, Math.min(x1 - 28, cx(i))), y1 + 13);
        }

        // ---- 标题区 ----
        ctx.textAlign = 'left';
        ctx.font = '700 15px ' + this.FONT;
        ctx.fillStyle = '#111827';
        ctx.fillText(opt.title || '', x0, 17);

        // 均线图例：颜色与图上那条线一致
        let lx = x0 + ctx.measureText(opt.title || '').width + 14;
        ctx.font = '11px ' + this.FONT;
        [['MA7', this.MA7], ['MA25', this.MA25], ['MA99', this.MA99]].forEach(([name, color]) => {
            ctx.fillStyle = color;
            ctx.fillRect(lx, 12, 12, 3);
            ctx.fillStyle = '#6b7280';
            ctx.fillText(name, lx + 16, 14);
            lx += 16 + ctx.measureText(name).width + 12;
        });

        if (opt.note) {
            ctx.font = '12px ' + this.FONT;
            ctx.fillStyle = '#6b7280';
            ctx.fillText(opt.note, x0, 35);
        }

        // 第二行专门说「待确认」那个浅色箭头。用琥珀色而不是灰色：
        // 这句是防误读的警告（它不是成交依据），不该和普通说明长得一样。
        if (note2) {
            ctx.font = '600 12px ' + this.FONT;
            ctx.fillStyle = '#b45309';
            ctx.fillText(note2, x0, 53);
        }

        ctx.strokeStyle = '#e8ecf3';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, titleH - 0.5);
        ctx.lineTo(W, titleH - 0.5);
        ctx.stroke();

        const base64 = canvas.toDataURL('image/png').split(',')[1] || '';
        if (!base64) return null;
        return { base64, width: W, height: H, bars };
    }
};
