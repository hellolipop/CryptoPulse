/**
 * 交易信号生成模块
 * 结合技术面和消息面，生成买卖信号、加仓减仓提示、操作建议
 */

const SignalGenerator = {
    /**
     * 生成综合交易信号
     * @param {Object} techData - 技术面数据
     * @param {Object} newsData - 消息面数据
     * @param {Object} priceData - 价格数据
     * @returns {Object} 完整的信号数据
     */
    generateSignal(techData, newsData, priceData) {
        const techScore = techData.score || 50;
        const newsScore = newsData.score || 50;
        
        // 综合评分（技术面权重60%，消息面权重40%）
        const totalScore = Math.round(techScore * 0.6 + newsScore * 0.4);
        
        // 判断信号类型
        let signalType = 'hold';
        let signalText = '观望';
        let signalDesc = '建议观望，等待明确信号';
        let signalColor = 'crypto-gold';
        
        if (totalScore >= 70) {
            signalType = 'strong_buy';
            signalText = '强烈买入';
            signalDesc = '技术面与消息面均向好，可考虑建仓';
            signalColor = 'crypto-green';
        } else if (totalScore >= 58) {
            signalType = 'buy';
            signalText = '买入';
            signalDesc = '整体趋势偏多，可逢低布局';
            signalColor = 'crypto-green';
        } else if (totalScore <= 30) {
            signalType = 'strong_sell';
            signalText = '强烈卖出';
            signalDesc = '风险较高，建议减仓或离场观望';
            signalColor = 'crypto-red';
        } else if (totalScore <= 42) {
            signalType = 'sell';
            signalText = '卖出';
            signalDesc = '整体趋势偏空，注意控制仓位';
            signalColor = 'crypto-red';
        }
        
        // 生成操作建议
        const actionTips = this.generateActionTips(techData, newsData, priceData, signalType, totalScore);
        
        // 生成加仓减仓提示
        const positionAdvice = this.generatePositionAdvice(techData, priceData, signalType);
        
        return {
            type: signalType,
            text: signalText,
            desc: signalDesc,
            color: signalColor,
            techScore: techScore,
            newsScore: newsScore,
            totalScore: totalScore,
            actionTips: actionTips,
            positionAdvice: positionAdvice,
            techSignals: techData.signals || [],
            newsSignals: newsData.topNews || []
        };
    },

    /**
     * 生成操作建议列表
     * @param {Object} techData - 技术面数据
     * @param {Object} newsData - 消息面数据
     * @param {Object} priceData - 价格数据
     * @param {string} signalType - 信号类型
     * @param {number} totalScore - 综合评分
     * @returns {Array} 操作建议列表
     */
    generateActionTips(techData, newsData, priceData, signalType, totalScore) {
        const tips = [];
        const { supportResistance, currentPrice } = priceData;
        
        // 基于支撑压力位的建议
        if (supportResistance) {
            const distToRes1 = ((supportResistance.resistance1 - currentPrice) / currentPrice * 100).toFixed(2);
            const distToSup1 = ((currentPrice - supportResistance.support1) / currentPrice * 100).toFixed(2);
            
            if (distToRes1 < 2) {
                tips.push({
                    type: 'watch',
                    icon: '⚠️',
                    text: `距第一压力位仅${distToRes1}%，关注能否突破`,
                    priority: 'high'
                });
            }
            
            if (distToSup1 < 2) {
                tips.push({
                    type: 'watch',
                    icon: '⚠️',
                    text: `距第一支撑位仅${distToSup1}%，关注是否企稳`,
                    priority: 'high'
                });
            }
        }
        
        // 基于技术指标的具体建议
        if (techData.signals) {
            const buySignals = techData.signals.filter(s => s.type === 'buy');
            const sellSignals = techData.signals.filter(s => s.type === 'sell');
            
            if (buySignals.length >= 2) {
                tips.push({
                    type: 'buy',
                    icon: '📈',
                    text: `多个技术指标发出买入信号（${buySignals.length}个）`,
                    priority: 'medium'
                });
            }
            
            if (sellSignals.length >= 2) {
                tips.push({
                    type: 'sell',
                    icon: '📉',
                    text: `多个技术指标发出卖出信号（${sellSignals.length}个）`,
                    priority: 'medium'
                });
            }
        }
        
        // 基于消息面的建议
        if (newsData.label === 'positive' && newsData.positiveCount > 0) {
            tips.push({
                type: 'buy',
                icon: '📰',
                text: `近期利好消息较多（${newsData.positiveCount}条），情绪偏暖`,
                priority: 'medium'
            });
        } else if (newsData.label === 'negative' && newsData.negativeCount > 0) {
            tips.push({
                type: 'sell',
                icon: '📰',
                text: `近期利空消息较多（${newsData.negativeCount}条），保持谨慎`,
                priority: 'medium'
            });
        }
        
        // 基于综合评分的仓位建议
        if (totalScore >= 70) {
            tips.push({
                type: 'buy',
                icon: '✅',
                text: '综合评分较高，可考虑分批建仓，仓位控制在60-80%',
                priority: 'high'
            });
        } else if (totalScore >= 58) {
            tips.push({
                type: 'buy',
                icon: '👍',
                text: '整体偏多，可轻仓试探，逢回调加仓，仓位30-50%',
                priority: 'medium'
            });
        } else if (totalScore <= 30) {
            tips.push({
                type: 'sell',
                icon: '🛑',
                text: '风险较高，建议减仓至20%以下，或离场观望',
                priority: 'high'
            });
        } else if (totalScore <= 42) {
            tips.push({
                type: 'sell',
                icon: '👎',
                text: '整体偏空，降低仓位至30%以下，控制风险',
                priority: 'medium'
            });
        } else {
            tips.push({
                type: 'watch',
                icon: '👀',
                text: '方向不明，建议观望，等待更明确的信号',
                priority: 'low'
            });
        }
        
        // 按优先级排序
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        tips.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
        
        return tips.slice(0, 5); // 最多返回5条建议
    },

    /**
     * 生成加仓减仓点位建议
     * @param {Object} techData - 技术面数据
     * @param {Object} priceData - 价格数据
     * @param {string} signalType - 信号类型
     * @returns {Object} 加仓减仓建议
     */
    generatePositionAdvice(techData, priceData, signalType) {
        const { supportResistance, currentPrice } = priceData;
        
        if (!supportResistance) {
            return null;
        }
        
        const advice = {
            buyZones: [],
            sellZones: []
        };
        
        // 买入区域（支撑位附近）
        advice.buyZones.push({
            level: supportResistance.support1,
            label: '第一支撑位',
            description: '轻仓试探性买入',
            strength: 'medium'
        });
        
        advice.buyZones.push({
            level: supportResistance.support2,
            label: '第二支撑位',
            description: '强支撑位，可考虑加仓',
            strength: 'strong'
        });
        
        // 卖出区域（压力位附近）
        advice.sellZones.push({
            level: supportResistance.resistance1,
            label: '第一压力位',
            description: '部分止盈，降低仓位',
            strength: 'medium'
        });
        
        advice.sellZones.push({
            level: supportResistance.resistance2,
            label: '第二压力位',
            description: '强压力位，考虑大幅减仓',
            strength: 'strong'
        });
        
        return advice;
    },

    /**
     * 计算关键价位与当前价的距离百分比
     * @param {number} currentPrice - 当前价格
     * @param {number} targetPrice - 目标价格
     * @returns {number} 距离百分比
     */
    calculateDistancePercent(currentPrice, targetPrice) {
        if (!currentPrice || !targetPrice) return 0;
        return Math.abs((targetPrice - currentPrice) / currentPrice * 100);
    },

    /**
     * 获取信号图标SVG
     * @param {string} signalType - 信号类型
     * @returns {string} SVG图标
     */
    getSignalIcon(signalType) {
        switch (signalType) {
            case 'strong_buy':
            case 'buy':
                return `<svg class="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"></path>
                </svg>`;
            case 'strong_sell':
            case 'sell':
                return `<svg class="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 17h8m0 0v-8m0 8l-8-8-4 4-6-6"></path>
                </svg>`;
            default:
                return `<svg class="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4"></path>
                </svg>`;
        }
    },

    /**
     * 获取评分对应的颜色
     * @param {number} score - 分数
     * @returns {string} 颜色类名
     */
    getScoreColor(score) {
        if (score >= 70) return 'text-crypto-green';
        if (score >= 55) return 'text-crypto-green/70';
        if (score >= 45) return 'text-crypto-gold';
        if (score >= 30) return 'text-crypto-red/70';
        return 'text-crypto-red';
    },

    /**
     * 获取RSI颜色
     * @param {number} rsi - RSI值
     * @returns {string} 颜色
     */
    getRSIColor(rsi) {
        if (rsi >= 70) return '#ef4444'; // 超买 - 红色
        if (rsi <= 30) return '#10b981'; // 超卖 - 绿色
        return '#f59e0b'; // 中性 - 黄色
    }
};
