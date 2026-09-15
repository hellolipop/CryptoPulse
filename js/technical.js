/**
 * 技术指标计算模块
 * 包含 MA、RSI、MACD、布林带、支撑压力位等计算
 */

const TechnicalAnalysis = {
    /**
     * 计算简单移动平均线 (SMA)
     * @param {Array} data - 价格数据数组
     * @param {number} period - 周期
     * @returns {Array} SMA 数组
     */
    calculateSMA(data, period) {
        const result = [];
        for (let i = 0; i < data.length; i++) {
            if (i < period - 1) {
                result.push(null);
            } else {
                let sum = 0;
                for (let j = 0; j < period; j++) {
                    sum += data[i - j];
                }
                result.push(sum / period);
            }
        }
        return result;
    },

    /**
     * 计算指数移动平均线 (EMA)
     * @param {Array} data - 价格数据数组
     * @param {number} period - 周期
     * @returns {Array} EMA 数组
     */
    calculateEMA(data, period) {
        const result = [];
        const multiplier = 2 / (period + 1);
        
        // 第一个 EMA 使用 SMA
        let sum = 0;
        for (let i = 0; i < period; i++) {
            sum += data[i];
            result.push(null);
        }
        let ema = sum / period;
        result[period - 1] = ema;
        
        for (let i = period; i < data.length; i++) {
            ema = (data[i] - ema) * multiplier + ema;
            result.push(ema);
        }
        return result;
    },

    /**
     * 计算相对强弱指标 (RSI)
     * @param {Array} data - 价格数据数组
     * @param {number} period - 周期，默认14
     * @returns {Array} RSI 数组
     */
    calculateRSI(data, period = 14) {
        const result = [];
        const gains = [];
        const losses = [];
        
        // 计算价格变化
        for (let i = 1; i < data.length; i++) {
            const change = data[i] - data[i - 1];
            gains.push(change > 0 ? change : 0);
            losses.push(change < 0 ? -change : 0);
        }
        
        // 前 period 个值为 null
        for (let i = 0; i < period; i++) {
            result.push(null);
        }
        
        // 计算第一个平均涨跌
        let avgGain = 0;
        let avgLoss = 0;
        for (let i = 0; i < period; i++) {
            avgGain += gains[i];
            avgLoss += losses[i];
        }
        avgGain /= period;
        avgLoss /= period;
        
        // 第一个 RSI 值
        if (avgLoss === 0) {
            result.push(100);
        } else {
            const rs = avgGain / avgLoss;
            result.push(100 - (100 / (1 + rs)));
        }
        
        // 计算后续 RSI
        for (let i = period; i < gains.length; i++) {
            avgGain = (avgGain * (period - 1) + gains[i]) / period;
            avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
            
            if (avgLoss === 0) {
                result.push(100);
            } else {
                const rs = avgGain / avgLoss;
                result.push(100 - (100 / (1 + rs)));
            }
        }
        
        return result;
    },

    /**
     * 计算 MACD
     * @param {Array} data - 价格数据数组
     * @param {number} fastPeriod - 快线周期，默认12
     * @param {number} slowPeriod - 慢线周期，默认26
     * @param {number} signalPeriod - 信号线周期，默认9
     * @returns {Object} { macd, signal, histogram }
     */
    calculateMACD(data, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        const fastEMA = this.calculateEMA(data, fastPeriod);
        const slowEMA = this.calculateEMA(data, slowPeriod);
        
        // 计算 MACD 线
        const macd = [];
        for (let i = 0; i < data.length; i++) {
            if (fastEMA[i] === null || slowEMA[i] === null) {
                macd.push(null);
            } else {
                macd.push(fastEMA[i] - slowEMA[i]);
            }
        }
        
        // 找到第一个有效 MACD 值的索引
        let firstValidIndex = 0;
        for (let i = 0; i < macd.length; i++) {
            if (macd[i] !== null) {
                firstValidIndex = i;
                break;
            }
        }
        
        // 提取有效 MACD 值计算信号线
        const validMacd = macd.slice(firstValidIndex);
        const signalEMA = this.calculateEMA(validMacd, signalPeriod);
        
        // 构建 signal 数组，与 macd 长度一致
        const signal = [];
        // 前面的位置填充 null
        for (let i = 0; i < firstValidIndex; i++) {
            signal.push(null);
        }
        // 添加 signal EMA 值
        for (let i = 0; i < signalEMA.length; i++) {
            signal.push(signalEMA[i]);
        }
        // 确保长度一致
        while (signal.length < macd.length) {
            signal.push(null);
        }
        if (signal.length > macd.length) {
            signal.length = macd.length;
        }
        
        // 计算柱状图
        const histogram = [];
        for (let i = 0; i < macd.length; i++) {
            if (macd[i] === null || signal[i] === null) {
                histogram.push(null);
            } else {
                histogram.push(macd[i] - signal[i]);
            }
        }
        
        return { macd, signal, histogram };
    },

    /**
     * 计算布林带
     * @param {Array} data - 价格数据数组
     * @param {number} period - 周期，默认20
     * @param {number} stdDev - 标准差倍数，默认2
     * @returns {Object} { upper, middle, lower }
     */
    calculateBollingerBands(data, period = 20, stdDev = 2) {
        const middle = this.calculateSMA(data, period);
        const upper = [];
        const lower = [];
        
        for (let i = 0; i < data.length; i++) {
            if (i < period - 1) {
                upper.push(null);
                lower.push(null);
            } else {
                // 计算标准差
                let sum = 0;
                for (let j = 0; j < period; j++) {
                    sum += Math.pow(data[i - j] - middle[i], 2);
                }
                const std = Math.sqrt(sum / period);
                
                upper.push(middle[i] + stdDev * std);
                lower.push(middle[i] - stdDev * std);
            }
        }
        
        return { upper, middle, lower };
    },

    /**
     * 计算支撑位和压力位
     * @param {Array} highData - 最高价数组
     * @param {Array} lowData - 最低价数组
     * @param {Array} closeData - 收盘价数组
     * @param {number} currentPrice - 当前价格
     * @returns {Object} { resistance1, resistance2, support1, support2 }
     */
    calculateSupportResistance(highData, lowData, closeData, currentPrice) {
        // 使用近期的 pivot point 方法
        const period = Math.min(20, highData.length);
        const startIdx = highData.length - period;
        
        let highSum = 0;
        let lowSum = 0;
        let closeSum = 0;
        
        for (let i = startIdx; i < highData.length; i++) {
            highSum += highData[i];
            lowSum += lowData[i];
            closeSum += closeData[i];
        }
        
        const avgHigh = highSum / period;
        const avgLow = lowSum / period;
        const avgClose = closeSum / period;
        
        // Pivot Point
        const pivot = (avgHigh + avgLow + avgClose) / 3;
        
        // 支撑压力位
        const resistance1 = 2 * pivot - avgLow;
        const resistance2 = pivot + (avgHigh - avgLow);
        const support1 = 2 * pivot - avgHigh;
        const support2 = pivot - (avgHigh - avgLow);
        
        // 找出近期高低点
        let recentHigh = Math.max(...highData.slice(startIdx));
        let recentLow = Math.min(...lowData.slice(startIdx));
        
        // 调整压力支撑位，使其更贴合实际
        const r1 = Math.max(resistance1, recentHigh * 0.98);
        const r2 = Math.max(resistance2, recentHigh * 1.02);
        const s1 = Math.min(support1, recentLow * 1.02);
        const s2 = Math.min(support2, recentLow * 0.98);
        
        return {
            resistance1: r1,
            resistance2: r2,
            support1: s1,
            support2: s2,
            pivot: pivot,
            recentHigh: recentHigh,
            recentLow: recentLow
        };
    },

    /**
     * 计算成交量加权平均价格 (VWAP)
     * @param {Array} highData - 最高价数组
     * @param {Array} lowData - 最低价数组
     * @param {Array} closeData - 收盘价数组
     * @param {Array} volumeData - 成交量数组
     * @returns {Array} VWAP 数组
     */
    calculateVWAP(highData, lowData, closeData, volumeData) {
        const result = [];
        let cumulativePV = 0;
        let cumulativeVolume = 0;
        
        for (let i = 0; i < closeData.length; i++) {
            const typicalPrice = (highData[i] + lowData[i] + closeData[i]) / 3;
            cumulativePV += typicalPrice * volumeData[i];
            cumulativeVolume += volumeData[i];
            
            if (cumulativeVolume === 0) {
                result.push(null);
            } else {
                result.push(cumulativePV / cumulativeVolume);
            }
        }
        
        return result;
    },

    /**
     * 计算能量潮 (OBV)
     * @param {Array} closeData - 收盘价数组
     * @param {Array} volumeData - 成交量数组
     * @returns {Array} OBV 数组
     */
    calculateOBV(closeData, volumeData) {
        const result = [];
        let obv = 0;
        
        for (let i = 0; i < closeData.length; i++) {
            if (i === 0) {
                obv = volumeData[i];
            } else {
                if (closeData[i] > closeData[i - 1]) {
                    obv += volumeData[i];
                } else if (closeData[i] < closeData[i - 1]) {
                    obv -= volumeData[i];
                }
                // 价格不变则OBV不变
            }
            result.push(obv);
        }
        
        return result;
    },

    /**
     * 计算随机RSI (Stochastic RSI)
     * @param {Array} data - 价格数据数组
     * @param {number} rsiPeriod - RSI周期，默认14
     * @param {number} stochPeriod - 随机周期，默认14
     * @param {number} kPeriod - %K平滑周期，默认3
     * @param {number} dPeriod - %D平滑周期，默认3
     * @returns {Object} { k, d }
     */
    calculateStochasticRSI(data, rsiPeriod = 14, stochPeriod = 14, kPeriod = 3, dPeriod = 3) {
        const rsi = this.calculateRSI(data, rsiPeriod);
        
        // 计算 Stochastic RSI
        const stochRSI = [];
        for (let i = 0; i < rsi.length; i++) {
            if (i < rsiPeriod + stochPeriod - 2) {
                stochRSI.push(null);
            } else {
                const periodRSI = rsi.slice(i - stochPeriod + 1, i + 1).filter(v => v !== null);
                if (periodRSI.length < 2) {
                    stochRSI.push(null);
                } else {
                    const minRSI = Math.min(...periodRSI);
                    const maxRSI = Math.max(...periodRSI);
                    const currentRSI = rsi[i];
                    if (maxRSI === minRSI) {
                        stochRSI.push(50);
                    } else {
                        stochRSI.push(((currentRSI - minRSI) / (maxRSI - minRSI)) * 100);
                    }
                }
            }
        }
        
        // 计算 %K (StochRSI的SMA)
        const k = this.calculateSMA(stochRSI.map(v => v === null ? NaN : v), kPeriod)
            .map(v => isNaN(v) ? null : v);
        
        // 计算 %D (%K的SMA)
        const d = this.calculateSMA(k.map(v => v === null ? NaN : v), dPeriod)
            .map(v => isNaN(v) ? null : v);
        
        return { k, d, stochRSI };
    },

    /**
     * 计算 KDJ 指标
     * @param {Array} highData - 最高价数组
     * @param {Array} lowData - 最低价数组
     * @param {Array} closeData - 收盘价数组
     * @param {number} n - RSV周期，默认9
     * @param {number} m1 - K平滑周期，默认3
     * @param {number} m2 - D平滑周期，默认3
     * @returns {Object} { k, d, j }
     */
    calculateKDJ(highData, lowData, closeData, n = 9, m1 = 3, m2 = 3) {
        // 计算 RSV (未成熟随机值)
        const rsv = [];
        for (let i = 0; i < closeData.length; i++) {
            if (i < n - 1) {
                rsv.push(null);
            } else {
                const periodHigh = Math.max(...highData.slice(i - n + 1, i + 1));
                const periodLow = Math.min(...lowData.slice(i - n + 1, i + 1));
                if (periodHigh === periodLow) {
                    rsv.push(50);
                } else {
                    rsv.push(((closeData[i] - periodLow) / (periodHigh - periodLow)) * 100);
                }
            }
        }
        
        // 计算 K 值 (RSV的EMA/SMA)
        const k = [];
        let prevK = 50;
        for (let i = 0; i < rsv.length; i++) {
            if (rsv[i] === null) {
                k.push(null);
            } else {
                const currentK = (prevK * (m1 - 1) + rsv[i]) / m1;
                k.push(currentK);
                prevK = currentK;
            }
        }
        
        // 计算 D 值 (K的EMA/SMA)
        const d = [];
        let prevD = 50;
        for (let i = 0; i < k.length; i++) {
            if (k[i] === null) {
                d.push(null);
            } else {
                const currentD = (prevD * (m2 - 1) + k[i]) / m2;
                d.push(currentD);
                prevD = currentD;
            }
        }
        
        // 计算 J 值
        const j = [];
        for (let i = 0; i < k.length; i++) {
            if (k[i] === null || d[i] === null) {
                j.push(null);
            } else {
                j.push(3 * k[i] - 2 * d[i]);
            }
        }
        
        return { k, d, j };
    },

    /**
     * 计算 AHR999 囤币指标
     * AHR999 = 当前价格 / 200日移动平均线
     * @param {number} currentPrice - 当前价格
     * @param {number} ma200 - 200日均线
     * @returns {Object} { value, zone }
     */
    calculateAHR999(currentPrice, ma200) {
        if (!ma200 || ma200 === 0) return { value: null, zone: 'unknown' };
        
        const value = currentPrice / ma200;
        let zone = 'neutral';
        let description = '';
        
        if (value < 0.45) {
            zone = 'deep_value';
            description = '深度价值区，历史罕见的买入机会';
        } else if (value < 1.2) {
            zone = 'accumulation';
            description = '核心积累区间，适合定投';
        } else {
            zone = 'overheated';
            description = '过热区，风险和回撤增加';
        }
        
        return { value, zone, description };
    },

    /**
     * 量能因子分析 (0-100)
     *
     * 从三个角度衡量量能对买卖信号的确认程度：
     *   1. 量比   —— 成交量相对20周期均量的倍数（放量/缩量）
     *   2. 量价配合 —— 价格方向与量能变化的组合关系
     *   3. 量能趋势 —— 近5周期均量相对前5周期的变化（资金流入/流出）
     *
     * 注意：K线数据最后一根是尚未走完的当前周期，成交量不完整，
     * 若直接参与比较会恒定为「缩量」。因此评分只使用已完成K线，
     * 未完成K线单独按时间进度折算为「盘中预估量比」。
     *
     * 评分基准 50 为中性，>50 偏多，<50 偏空。
     *
     * @param {Array} candleData - K线数据 [{time, open, high, low, close, volume}]
     * @param {number} intervalSeconds - 单根K线秒数（用于折算盘中量能）
     * @returns {Object} { score, signals, metrics }
     */
    analyzeVolume(candleData, intervalSeconds) {
        const empty = { score: 50, signals: [], metrics: null };
        if (!candleData || candleData.length < 21) return empty;

        // 剔除尚未走完的最后一根K线
        const closed = candleData.slice(0, -1);
        const volumes = closed.map(d => d.volume);
        const closes = closed.map(d => d.close);
        const n = volumes.length;

        const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

        const lastIdx = n - 1;
        const currentVol = volumes[lastIdx];
        const avg5 = mean(volumes.slice(-5));
        const avg10 = mean(volumes.slice(-10));
        const avg20 = mean(volumes.slice(-20));
        const prev5 = mean(volumes.slice(-10, -5));

        if (!avg20) return empty;

        // 量比：最近一根已完成K线相对20周期均量
        const ratio = currentVol / avg20;
        // 5周期均量相对20周期均量的水平
        const ratio5 = avg5 / avg20;
        // 近5根已完成K线的价格变化
        const refClose = closes[Math.max(0, lastIdx - 5)];
        const priceChangePct = refClose ? (closes[lastIdx] / refClose - 1) : 0;

        let score = 50;
        const signals = [];

        // 价格方向（量能信号的多空倾向需要结合价格方向）
        const priceUp = priceChangePct > 0.005;
        const priceDown = priceChangePct < -0.005;
        const volBias = priceUp ? 'bull' : (priceDown ? 'bear' : 'neutral');

        // ---------- 1. 量比：放量还是缩量 ----------
        if (ratio >= 2) {
            score += 12;
            signals.push({ type: 'volume', strength: 'strong', bias: volBias, text: `显著放量（量比 ${ratio.toFixed(2)}），资金关注度高` });
        } else if (ratio >= 1.5) {
            score += 7;
            signals.push({ type: 'volume', strength: 'medium', bias: volBias, text: `温和放量（量比 ${ratio.toFixed(2)}），交投转活跃` });
        } else if (ratio < 0.5) {
            score -= 8;
            signals.push({ type: 'volume', strength: 'medium', bias: 'neutral', text: `极度缩量（量比 ${ratio.toFixed(2)}），市场观望情绪浓` });
        } else if (ratio < 0.8) {
            score -= 4;
            signals.push({ type: 'volume', strength: 'weak', bias: 'neutral', text: `小幅缩量（量比 ${ratio.toFixed(2)}），交投清淡` });
        }

        // ---------- 2. 量价配合 ----------
        let priceVolumeState = 'neutral';

        if (priceUp && ratio >= 1.2) {
            // 价涨量增：最健康的上涨形态
            score += 12;
            priceVolumeState = 'confirm';
            signals.push({ type: 'volume', strength: 'strong', bias: 'bull', text: '量价齐升，上涨获量能确认，多头动能充足' });
        } else if (priceUp && ratio < 0.8) {
            // 价涨量缩：上涨乏力，警惕背离
            score -= 10;
            priceVolumeState = 'diverge';
            signals.push({ type: 'volume', strength: 'strong', bias: 'bear', text: '缩量上涨，量能未能跟进，上攻动能不足需防背离' });
        } else if (priceDown && ratio >= 1.2) {
            // 价跌量增：抛压沉重
            score -= 14;
            priceVolumeState = 'panic';
            signals.push({ type: 'volume', strength: 'strong', bias: 'bear', text: '放量下跌，抛压沉重，短线风险偏高' });
        } else if (priceDown && ratio < 0.8) {
            // 价跌量缩：抛压衰竭，可能是底部特征
            score += 6;
            priceVolumeState = 'exhausted';
            signals.push({ type: 'volume', strength: 'medium', bias: 'bull', text: '缩量回调，抛压有所衰竭，关注企稳信号' });
        }

        // ---------- 3. 量能趋势 ----------
        if (avg5 > prev5 * 1.15) {
            score += 6;
            signals.push({ type: 'volume', strength: 'weak', bias: 'bull', text: '近5周期量能持续放大，资金呈流入迹象' });
        } else if (avg5 < prev5 * 0.85) {
            score -= 6;
            signals.push({ type: 'volume', strength: 'weak', bias: 'bear', text: '近5周期量能持续萎缩，资金参与度下降' });
        }

        score = Math.max(0, Math.min(100, score));

        // ---------- 盘中量能节奏（按已过去的时间比例折算） ----------
        let liveRatio = null;
        if (intervalSeconds > 0) {
            const live = candleData[candleData.length - 1];
            const elapsed = Math.floor(Date.now() / 1000) - live.time;
            const progress = Math.min(1, Math.max(0.05, elapsed / intervalSeconds));
            if (progress < 0.95) {
                liveRatio = (live.volume / progress) / avg20;
                if (liveRatio >= 1.8) {
                    signals.push({
                        type: 'volume',
                        strength: 'medium',
                        bias: volBias,
                        text: `盘中量能明显放大，按当前节奏预估量比约 ${liveRatio.toFixed(2)}`
                    });
                }
            }
        }

        return {
            score: Math.round(score),
            signals,
            metrics: {
                current: currentVol,
                avg5,
                avg10,
                avg20,
                ratio,
                ratio5,
                priceChangePct,
                priceVolumeState,
                liveRatio,
            },
        };
    },

    /**
     * 计算技术面综合评分 (0-100) - 多因子版本
     * @param {Object} indicators - 技术指标数据
     * @returns {Object} { score, signals, breakdown }
     */
    calculateTechnicalScore(indicators) {
        let score = 50; // 中性分
        const signals = [];
        const breakdown = {};
        
        const { rsi, macd, ma7, ma25, ma200, currentPrice, bollingerBands, vwap, obv, stochRSI, kdj, ahr999 } = indicators;
        
        // RSI 分析 (权重: 15分)
        let rsiScore = 0;
        if (rsi !== null && rsi !== undefined && !isNaN(rsi)) {
            if (rsi < 20) {
                rsiScore = 15;
                signals.push({ type: 'buy', text: 'RSI极度超卖，强烈反弹预期', indicator: 'RSI', strength: 'strong' });
            } else if (rsi < 30) {
                rsiScore = 12;
                signals.push({ type: 'buy', text: 'RSI超卖，可能反弹', indicator: 'RSI', strength: 'medium' });
            } else if (rsi < 40) {
                rsiScore = 6;
                signals.push({ type: 'buy', text: 'RSI偏低，关注企稳', indicator: 'RSI', strength: 'weak' });
            } else if (rsi > 80) {
                rsiScore = -15;
                signals.push({ type: 'sell', text: 'RSI极度超买，强烈回调预期', indicator: 'RSI', strength: 'strong' });
            } else if (rsi > 70) {
                rsiScore = -12;
                signals.push({ type: 'sell', text: 'RSI超买，注意回调', indicator: 'RSI', strength: 'medium' });
            } else if (rsi > 60) {
                rsiScore = -4;
                signals.push({ type: 'sell', text: 'RSI偏高，谨慎追高', indicator: 'RSI', strength: 'weak' });
            } else {
                signals.push({ type: 'neutral', text: 'RSI处于中性区间', indicator: 'RSI', strength: 'none' });
            }
            score += rsiScore;
        }
        breakdown.rsi = rsiScore;
        
        // MACD 分析 (权重: 15分)
        let macdScore = 0;
        if (macd && macd.macd && macd.signal) {
            const lastMacd = macd.macd[macd.macd.length - 1];
            const lastSignal = macd.signal[macd.signal.length - 1];
            const prevMacd = macd.macd[macd.macd.length - 2];
            const prevSignal = macd.signal[macd.signal.length - 2];
            
            if (lastMacd !== null && lastSignal !== null) {
                if (lastMacd > lastSignal) {
                    macdScore += 10;
                    signals.push({ type: 'buy', text: 'MACD金叉，多头趋势', indicator: 'MACD', strength: 'medium' });
                } else {
                    macdScore -= 10;
                    signals.push({ type: 'sell', text: 'MACD死叉，空头趋势', indicator: 'MACD', strength: 'medium' });
                }
                
                // 柱状图趋势
                if (prevMacd !== null && prevSignal !== null) {
                    const histNow = lastMacd - lastSignal;
                    const histPrev = prevMacd - prevSignal;
                    if (histNow > 0 && histPrev < 0) {
                        macdScore += 5;
                        signals.push({ type: 'buy', text: 'MACD柱转正，动能增强', indicator: 'MACD', strength: 'weak' });
                    } else if (histNow < 0 && histPrev > 0) {
                        macdScore -= 5;
                        signals.push({ type: 'sell', text: 'MACD柱转负，动能减弱', indicator: 'MACD', strength: 'weak' });
                    }
                }
            }
            score += macdScore;
        }
        breakdown.macd = macdScore;
        
        // 均线分析 (权重: 15分)
        let maScore = 0;
        if (ma7 && ma25 && currentPrice) {
            const lastMA7 = ma7[ma7.length - 1];
            const lastMA25 = ma25[ma25.length - 1];
            
            if (lastMA7 && lastMA25) {
                if (currentPrice > lastMA7 && lastMA7 > lastMA25) {
                    maScore += 12;
                    signals.push({ type: 'buy', text: '价格站上均线，多头排列', indicator: 'MA', strength: 'strong' });
                } else if (currentPrice < lastMA7 && lastMA7 < lastMA25) {
                    maScore -= 12;
                    signals.push({ type: 'sell', text: '价格跌破均线，空头排列', indicator: 'MA', strength: 'strong' });
                } else if (currentPrice > lastMA7 && lastMA7 < lastMA25) {
                    maScore += 5;
                    signals.push({ type: 'buy', text: '短期均线拐头，关注突破', indicator: 'MA', strength: 'weak' });
                } else {
                    maScore -= 3;
                    signals.push({ type: 'neutral', text: '均线交织，方向不明', indicator: 'MA', strength: 'none' });
                }
            }
            
            // MA200 判断大趋势
            if (ma200 && ma200[ma200.length - 1]) {
                const lastMA200 = ma200[ma200.length - 1];
                if (currentPrice > lastMA200) {
                    maScore += 3;
                    signals.push({ type: 'buy', text: '价格站在MA200上方，大趋势偏多', indicator: 'MA200', strength: 'weak' });
                } else {
                    maScore -= 3;
                    signals.push({ type: 'sell', text: '价格在MA200下方，大趋势偏空', indicator: 'MA200', strength: 'weak' });
                }
            }
            score += maScore;
        }
        breakdown.ma = maScore;
        
        // 布林带分析 (权重: 8分)
        let bollScore = 0;
        if (bollingerBands && currentPrice) {
            const lastUpper = bollingerBands.upper[bollingerBands.upper.length - 1];
            const lastLower = bollingerBands.lower[bollingerBands.lower.length - 1];
            
            if (lastUpper && lastLower) {
                if (currentPrice >= lastUpper) {
                    bollScore = -8;
                    signals.push({ type: 'sell', text: '触及布林上轨，注意压力', indicator: 'BOLL', strength: 'medium' });
                } else if (currentPrice <= lastLower) {
                    bollScore = 8;
                    signals.push({ type: 'buy', text: '触及布林下轨，关注支撑', indicator: 'BOLL', strength: 'medium' });
                }
            }
            score += bollScore;
        }
        breakdown.bollinger = bollScore;
        
        // VWAP 分析 (权重: 5分)
        let vwapScore = 0;
        if (vwap && vwap[vwap.length - 1] && currentPrice) {
            const lastVWAP = vwap[vwap.length - 1];
            if (currentPrice > lastVWAP) {
                vwapScore = 5;
                signals.push({ type: 'buy', text: '价格在VWAP上方，日内偏多', indicator: 'VWAP', strength: 'weak' });
            } else {
                vwapScore = -5;
                signals.push({ type: 'sell', text: '价格在VWAP下方，日内偏空', indicator: 'VWAP', strength: 'weak' });
            }
            score += vwapScore;
        }
        breakdown.vwap = vwapScore;
        
        // Stochastic RSI 分析 (权重: 10分)
        let stochScore = 0;
        if (stochRSI && stochRSI.k && stochRSI.d) {
            const lastK = stochRSI.k[stochRSI.k.length - 1];
            const lastD = stochRSI.d[stochRSI.d.length - 1];
            
            if (lastK !== null && lastD !== null) {
                if (lastK < 20 && lastD < 20) {
                    stochScore = 10;
                    signals.push({ type: 'buy', text: 'StochRSI超卖，反弹概率大', indicator: 'StochRSI', strength: 'strong' });
                } else if (lastK > 80 && lastD > 80) {
                    stochScore = -10;
                    signals.push({ type: 'sell', text: 'StochRSI超买，回调风险高', indicator: 'StochRSI', strength: 'strong' });
                } else if (lastK > lastD && lastK < 50) {
                    stochScore = 5;
                    signals.push({ type: 'buy', text: 'StochRSI金叉向上', indicator: 'StochRSI', strength: 'weak' });
                } else if (lastK < lastD && lastK > 50) {
                    stochScore = -5;
                    signals.push({ type: 'sell', text: 'StochRSI死叉向下', indicator: 'StochRSI', strength: 'weak' });
                }
            }
            score += stochScore;
        }
        breakdown.stochRSI = stochScore;
        
        // KDJ 分析 (权重: 10分)
        let kdjScore = 0;
        if (kdj && kdj.k && kdj.d && kdj.j) {
            const lastK = kdj.k[kdj.k.length - 1];
            const lastD = kdj.d[kdj.d.length - 1];
            const lastJ = kdj.j[kdj.j.length - 1];
            
            if (lastK !== null && lastD !== null && lastJ !== null) {
                if (lastK < 20 && lastD < 20) {
                    kdjScore += 8;
                    signals.push({ type: 'buy', text: 'KDJ超卖区，关注金叉', indicator: 'KDJ', strength: 'medium' });
                } else if (lastK > 80 && lastD > 80) {
                    kdjScore -= 8;
                    signals.push({ type: 'sell', text: 'KDJ超买区，关注死叉', indicator: 'KDJ', strength: 'medium' });
                }
                
                if (lastK > lastD) {
                    kdjScore += 2;
                } else {
                    kdjScore -= 2;
                }
                
                if (lastJ > 100) {
                    kdjScore -= 3;
                    signals.push({ type: 'sell', text: 'J值超100，短期见顶信号', indicator: 'KDJ', strength: 'weak' });
                } else if (lastJ < 0) {
                    kdjScore += 3;
                    signals.push({ type: 'buy', text: 'J值低于0，短期见底信号', indicator: 'KDJ', strength: 'weak' });
                }
            }
            score += kdjScore;
        }
        breakdown.kdj = kdjScore;
        
        // AHR999 分析 (权重: 7分)
        let ahrScore = 0;
        if (ahr999 && ahr999.value !== null) {
            if (ahr999.zone === 'deep_value') {
                ahrScore = 7;
                signals.push({ type: 'buy', text: ahr999.description, indicator: 'AHR999', strength: 'strong' });
            } else if (ahr999.zone === 'accumulation') {
                ahrScore = 4;
                signals.push({ type: 'buy', text: ahr999.description, indicator: 'AHR999', strength: 'medium' });
            } else {
                ahrScore = -5;
                signals.push({ type: 'sell', text: ahr999.description, indicator: 'AHR999', strength: 'weak' });
            }
            score += ahrScore;
        }
        breakdown.ahr999 = ahrScore;
        
        // OBV 趋势分析 (权重: 5分)
        let obvScore = 0;
        if (obv && obv.length >= 10) {
            const recentOBV = obv.slice(-10);
            const firstOBV = recentOBV[0];
            const lastOBV = recentOBV[recentOBV.length - 1];
            const obvRising = lastOBV > firstOBV;
            
            if (obvRising && currentPrice > ma25?.[ma25.length - 1]) {
                obvScore = 5;
                signals.push({ type: 'buy', text: 'OBV上升，资金持续流入', indicator: 'OBV', strength: 'weak' });
            } else if (!obvRising && currentPrice < ma25?.[ma25.length - 1]) {
                obvScore = -5;
                signals.push({ type: 'sell', text: 'OBV下降，资金持续流出', indicator: 'OBV', strength: 'weak' });
            }
            score += obvScore;
        }
        breakdown.obv = obvScore;
        
        // 限制分数范围
        score = Math.max(0, Math.min(100, score));
        
        return {
            score: Math.round(score),
            signals: signals,
            breakdown: breakdown
        };
    },

    /**
     * 格式化价格显示
     * @param {number} price - 价格
     * @returns {string} 格式化后的价格字符串
     */
    formatPrice(price) {
        if (price === null || price === undefined || isNaN(price)) return '--';
        
        if (price >= 1000) {
            return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        } else if (price >= 1) {
            return price.toFixed(2);
        } else if (price >= 0.01) {
            return price.toFixed(4);
        } else {
            return price.toFixed(6);
        }
    },

    /**
     * 格式化大数字（如成交量）
     * @param {number} num - 数字
     * @returns {string} 格式化后的字符串
     */
    formatLargeNumber(num) {
        if (num === null || num === undefined || isNaN(num)) return '--';
        
        if (num >= 1e12) return (num / 1e12).toFixed(2) + 'T';
        if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
        if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
        if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
        return num.toFixed(2);
    }
};
