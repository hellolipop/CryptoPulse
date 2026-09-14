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
        
        // 计算信号线 (MACD的EMA)
        // 需要先过滤掉 null 值
        const validMacd = macd.filter(v => v !== null);
        const signalEMA = this.calculateEMA(validMacd, signalPeriod);
        
        // 重新对齐 signal 数组
        const signal = [];
        const nullCount = macd.length - validMacd.length;
        for (let i = 0; i < nullCount + signalPeriod - 1; i++) {
            signal.push(null);
        }
        for (let i = signalPeriod - 1; i < signalEMA.length; i++) {
            if (signalEMA[i] !== null) {
                signal.push(signalEMA[i]);
            }
        }
        
        // 确保 signal 数组长度与 macd 一致
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
     * 计算技术面综合评分 (0-100)
     * @param {Object} indicators - 技术指标数据
     * @returns {Object} { score, signals }
     */
    calculateTechnicalScore(indicators) {
        let score = 50; // 中性分
        const signals = [];
        
        const { rsi, macd, ma7, ma25, currentPrice, bollingerBands } = indicators;
        
        // RSI 分析
        if (rsi !== null && rsi !== undefined) {
            if (rsi < 30) {
                score += 15;
                signals.push({ type: 'buy', text: 'RSI超卖，可能反弹', indicator: 'RSI' });
            } else if (rsi < 40) {
                score += 8;
                signals.push({ type: 'buy', text: 'RSI偏低，关注企稳', indicator: 'RSI' });
            } else if (rsi > 70) {
                score -= 15;
                signals.push({ type: 'sell', text: 'RSI超买，注意回调', indicator: 'RSI' });
            } else if (rsi > 60) {
                score -= 5;
                signals.push({ type: 'sell', text: 'RSI偏高，谨慎追高', indicator: 'RSI' });
            } else {
                signals.push({ type: 'neutral', text: 'RSI处于中性区间', indicator: 'RSI' });
            }
        }
        
        // MACD 分析
        if (macd && macd.macd !== null && macd.signal !== null) {
            const lastMacd = macd.macd[macd.macd.length - 1];
            const lastSignal = macd.signal[macd.signal.length - 1];
            const prevMacd = macd.macd[macd.macd.length - 2];
            const prevSignal = macd.signal[macd.signal.length - 2];
            
            if (lastMacd > lastSignal) {
                score += 10;
                signals.push({ type: 'buy', text: 'MACD金叉，多头趋势', indicator: 'MACD' });
            } else {
                score -= 10;
                signals.push({ type: 'sell', text: 'MACD死叉，空头趋势', indicator: 'MACD' });
            }
            
            // 柱状图趋势
            if (lastMacd - lastSignal > 0 && prevMacd - prevSignal < 0) {
                score += 5;
                signals.push({ type: 'buy', text: 'MACD柱转正，动能增强', indicator: 'MACD' });
            } else if (lastMacd - lastSignal < 0 && prevMacd - prevSignal > 0) {
                score -= 5;
                signals.push({ type: 'sell', text: 'MACD柱转负，动能减弱', indicator: 'MACD' });
            }
        }
        
        // 均线分析
        if (ma7 && ma25 && currentPrice) {
            const lastMA7 = ma7[ma7.length - 1];
            const lastMA25 = ma25[ma25.length - 1];
            
            if (lastMA7 && lastMA25) {
                if (currentPrice > lastMA7 && lastMA7 > lastMA25) {
                    score += 12;
                    signals.push({ type: 'buy', text: '价格站上均线，多头排列', indicator: 'MA' });
                } else if (currentPrice < lastMA7 && lastMA7 < lastMA25) {
                    score -= 12;
                    signals.push({ type: 'sell', text: '价格跌破均线，空头排列', indicator: 'MA' });
                } else if (currentPrice > lastMA7 && lastMA7 < lastMA25) {
                    score += 5;
                    signals.push({ type: 'buy', text: '短期均线拐头，关注突破', indicator: 'MA' });
                } else {
                    score -= 3;
                    signals.push({ type: 'neutral', text: '均线交织，方向不明', indicator: 'MA' });
                }
            }
        }
        
        // 布林带分析
        if (bollingerBands && currentPrice) {
            const lastUpper = bollingerBands.upper[bollingerBands.upper.length - 1];
            const lastLower = bollingerBands.lower[bollingerBands.lower.length - 1];
            
            if (lastUpper && lastLower) {
                if (currentPrice >= lastUpper) {
                    score -= 8;
                    signals.push({ type: 'sell', text: '触及布林上轨，注意压力', indicator: 'BOLL' });
                } else if (currentPrice <= lastLower) {
                    score += 8;
                    signals.push({ type: 'buy', text: '触及布林下轨，关注支撑', indicator: 'BOLL' });
                }
            }
        }
        
        // 限制分数范围
        score = Math.max(0, Math.min(100, score));
        
        return {
            score: Math.round(score),
            signals: signals
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
