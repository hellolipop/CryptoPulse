/**
 * 新闻获取与情感分析模块
 * 从 CoinGecko 等来源获取加密货币新闻，并进行简单的情感分析
 */

const NewsAnalyzer = {
    // 情感关键词库
    positiveWords: [
        'surge', 'soar', 'rally', 'bull', 'bullish', 'gain', 'rise', 'up',
        'growth', 'adoption', 'partnership', 'launch', 'upgrade', 'breakthrough',
        'positive', 'optimistic', 'record', 'high', 'boom', 'explode',
        '上涨', '暴涨', '拉升', '牛市', '利好', '突破', '创新高', '增长',
        '合作', '上线', '升级', '积极', '乐观', '爆发', '腾飞', '反弹',
        '批准', '通过', '支持', '认可', '投资', '融资', '成功', '落地'
    ],
    
    negativeWords: [
        'crash', 'plunge', 'drop', 'fall', 'bear', 'bearish', 'loss', 'down',
        'decline', 'ban', 'regulation', 'hack', 'scam', 'fraud', 'crisis',
        'negative', 'pessimistic', 'low', 'dump', 'sell', 'liquidation',
        '下跌', '暴跌', '跳水', '熊市', '利空', '崩盘', '回调', '下跌',
        '监管', '禁令', '黑客', '诈骗', '危机', '抛售', '清算', '风险',
        '拒绝', '失败', '问题', '担忧', '恐慌', '崩盘', '破产', '调查'
    ],

    /**
     * 获取加密货币新闻（多源聚合）
     * @param {string} coinId - 币种ID
     * @returns {Promise<Array>} 新闻列表
     */
    async fetchNews(coinId = 'bitcoin') {
        const allNews = [];
        const errors = [];

        // 映射币种到 API 分类
        const categoryMap = {
            'bitcoin': 'bitcoin',
            'ethereum': 'general',
            'binancecoin': 'general',
            'solana': 'general',
            'ripple': 'general',
            'cardano': 'general',
            'dogecoin': 'general',
            'polkadot': 'general'
        };
        const category = categoryMap[coinId] || 'general';

        // ========== 源1: cryptocurrency.cv 新闻 API ==========
        // 免费、无需Key、支持CORS、多源聚合（CoinDesk, The Block, Decrypt等）
        try {
            const categories = ['general', category, 'etf', 'defi'].filter((v, i, a) => a.indexOf(v) === i);
            const fetchPromises = categories.slice(0, 3).map(cat =>
                fetch(`https://cryptocurrency.cv/api/news?category=${cat}&limit=10`)
                    .then(r => r.json())
                    .then(d => {
                        if (d.articles && Array.isArray(d.articles)) {
                            return d.articles.map(item => ({
                                id: item.id || item.url,
                                title: item.title || '',
                                description: item.description || item.summary || '',
                                url: item.url || item.link || '#',
                                source: item.source || item.publisher || 'CryptoNews',
                                image: item.image || item.thumbnail || '',
                                publishedAt: item.publishedAt || item.date || new Date().toISOString(),
                                categories: item.categories || [cat],
                                _source: 'cryptocurrency.cv'
                            }));
                        }
                        return [];
                    })
            );

            const results = await Promise.allSettled(fetchPromises);
            results.forEach(result => {
                if (result.status === 'fulfilled' && Array.isArray(result.value)) {
                    allNews.push(...result.value);
                }
            });
        } catch (e) {
            errors.push(`cryptocurrency.cv: ${e.message}`);
        }

        // ========== 源2: Binance 公告（通过 CORS 代理）==========
        try {
            const bnResp = await fetch(
                'https://corsproxy.io/?' + encodeURIComponent(
                    'https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=5'
                )
            );
            if (bnResp.ok) {
                const bnData = await bnResp.json();
                const articles = bnData.data?.articles || [];
                if (articles.length > 0) {
                    allNews.push(...articles.slice(0, 5).map(item => ({
                        id: item.id || Date.now() + Math.random(),
                        title: item.title || '',
                        description: item.digest || item.intro || '',
                        url: `https://www.binance.com/en/support/announcement/${item.code || item.id}`,
                        source: 'Binance 公告',
                        image: '',
                        publishedAt: item.publishDate || new Date(item.publishTime).toISOString() || new Date().toISOString(),
                        categories: ['exchange', 'binance'],
                        _source: 'binance'
                    })));
                }
            }
        } catch (e) {
            errors.push(`binance: ${e.message}`);
        }

        // ========== 去重 + 处理 ==========
        if (allNews.length > 0) {
            // 按标题去重
            const seen = new Set();
            const uniqueNews = allNews.filter(item => {
                const key = item.title?.substring(0, 50);
                if (!key || seen.has(key)) return false;
                seen.add(key);
                return true;
            });

            // 按时间排序（最新的在前）
            uniqueNews.sort((a, b) => {
                return new Date(b.publishedAt) - new Date(a.publishedAt);
            });

            // 情感分析
            const processedNews = uniqueNews.slice(0, 15).map(item => {
                const sentiment = this.analyzeSentiment(item.title + ' ' + item.description);
                return {
                    ...item,
                    sentiment: sentiment.score,
                    sentimentLabel: sentiment.label,
                    keywords: this.extractKeywords(item.title + ' ' + item.description)
                };
            });

            return processedNews;
        }

        // ========== 兜底：模拟数据 ==========
        console.warn('所有新闻源获取失败，使用模拟数据:', errors.join(', '));
        return this.getMockNews(coinId);
    },

    /**
     * 提取关键词
     * @param {string} text - 文本
     * @returns {Array<string>} 关键词数组
     */
    extractKeywords(text) {
        const keywords = [
            'Bitcoin', 'Ethereum', 'BTC', 'ETH', 'ETF', 'SEC', '监管', 'BTC现货ETF',
            '上涨', '下跌', '突破', '新高', '新低', '牛市', '熊市', '反弹', '回调',
            '机构', '鲸鱼', '大额', '增持', '减持', '买入', '卖出',
            '升级', '硬分叉', '软分叉', 'Layer2', 'DeFi', 'NFT', 'Web3',
            '黑客', '攻击', '安全', '漏洞', '被盗',
            '合作', '伙伴', '上线', '上市', '融资', '投资'
        ];
        const found = [];
        const lowerText = text.toLowerCase();
        keywords.forEach(kw => {
            if (lowerText.includes(kw.toLowerCase()) && found.length < 5) {
                found.push(kw);
            }
        });
        return found;
    },

    /**
     * 处理新闻数据（兼容旧格式）
     * @param {Array} newsData - 原始新闻数据
     * @returns {Array} 处理后的新闻列表
     */
    processNewsData(newsData) {
        return newsData.map(item => {
            const title = item.title || '';
            const description = item.description || '';
            const sentiment = this.analyzeSentiment(title + ' ' + description);

            return {
                id: item.id || Date.now() + Math.random(),
                title: title,
                description: description,
                url: item.url || '#',
                source: item.source || 'Unknown',
                image: item.thumb_2x || item.thumb || '',
                publishedAt: item.published_at || new Date().toISOString(),
                sentiment: sentiment.score,
                sentimentLabel: sentiment.label,
                categories: item.categories || [],
                keywords: this.extractKeywords(title + ' ' + description)
            };
        }).filter(item => item.title && item.title.length > 0);
    },

    /**
     * 获取模拟新闻数据（备用）
     * @param {string} coinId - 币种ID
     * @returns {Array} 模拟新闻列表
     */
    getMockNews(coinId) {
        const coinNames = {
            'bitcoin': '比特币',
            'ethereum': '以太坊',
            'binancecoin': '币安币',
            'solana': 'Solana',
            'ripple': '瑞波币',
            'cardano': '艾达币',
            'dogecoin': '狗狗币',
            'polkadot': '波卡币'
        };
        
        const coinName = coinNames[coinId] || '加密货币';
        
        const mockNews = [
            {
                title: `${coinName}价格突破关键阻力位，市场情绪回暖`,
                description: `今日${coinName}表现强劲，价格突破了近期重要阻力位，成交量明显放大，分析师认为可能开启新一轮上涨行情。`,
                source: 'CryptoNews',
                sentiment: 75,
                sentimentLabel: 'positive'
            },
            {
                title: `机构投资者持续增持${coinName}，长期看好`,
                description: `最新数据显示，机构投资者在过去一个月持续增持${coinName}，表明对长期价值的认可。`,
                source: 'BlockchainDaily',
                sentiment: 65,
                sentimentLabel: 'positive'
            },
            {
                title: `监管动态：多国讨论加密货币监管框架`,
                description: `全球多个国家正在积极讨论加密货币监管政策，市场对此保持关注，短期可能造成波动。`,
                source: 'FinanceToday',
                sentiment: 40,
                sentimentLabel: 'neutral'
            },
            {
                title: `${coinName}网络升级完成，性能大幅提升`,
                description: `${coinName}核心开发团队宣布最新网络升级已成功部署，交易速度提升50%，手续费降低30%。`,
                source: 'TechCrypto',
                sentiment: 80,
                sentimentLabel: 'positive'
            },
            {
                title: ` whales大额转账引发市场担忧`,
                description: `数据显示，近期有大额${coinName}从钱包转出至交易所，可能预示着抛售压力增加，投资者需保持谨慎。`,
                source: 'WhaleAlert',
                sentiment: 30,
                sentimentLabel: 'negative'
            },
            {
                title: `DeFi生态持续繁荣，${coinName}锁仓量创新高`,
                description: `去中心化金融（DeFi）生态持续发展，${coinName}相关协议锁仓量创下历史新高，显示生态活力。`,
                source: 'DeFiPulse',
                sentiment: 70,
                sentimentLabel: 'positive'
            }
        ];
        
        return mockNews.map((item, index) => ({
            id: Date.now() + index,
            title: item.title,
            description: item.description,
            url: '#',
            source: item.source,
            image: '',
            publishedAt: new Date(Date.now() - index * 3600000).toISOString(),
            sentiment: item.sentiment,
            sentimentLabel: item.sentimentLabel,
            categories: [coinId]
        }));
    },

    /**
     * 分析文本情感
     * @param {string} text - 要分析的文本
     * @returns {Object} { score, label }
     */
    analyzeSentiment(text) {
        if (!text) {
            return { score: 50, label: 'neutral' };
        }
        
        const lowerText = text.toLowerCase();
        let positiveCount = 0;
        let negativeCount = 0;
        
        // 统计正面词汇
        this.positiveWords.forEach(word => {
            const regex = new RegExp(word.toLowerCase(), 'gi');
            const matches = lowerText.match(regex);
            if (matches) {
                positiveCount += matches.length;
            }
        });
        
        // 统计负面词汇
        this.negativeWords.forEach(word => {
            const regex = new RegExp(word.toLowerCase(), 'gi');
            const matches = lowerText.match(regex);
            if (matches) {
                negativeCount += matches.length;
            }
        });
        
        // 计算情感分数 (0-100)
        const total = positiveCount + negativeCount;
        let score = 50; // 中性
        
        if (total > 0) {
            const ratio = positiveCount / total;
            score = Math.round(30 + ratio * 40); // 30-70 范围
            
            // 强烈情绪时加大分值
            if (positiveCount > negativeCount * 2) {
                score = Math.min(90, score + 15);
            } else if (negativeCount > positiveCount * 2) {
                score = Math.max(10, score - 15);
            }
        }
        
        // 判断标签
        let label = 'neutral';
        if (score >= 60) {
            label = 'positive';
        } else if (score <= 40) {
            label = 'negative';
        }
        
        return { score, label };
    },

    /**
     * 计算新闻面综合评分
     * @param {Array} newsList - 新闻列表
     * @returns {Object} { score, label, positiveCount, negativeCount, neutralCount }
     */
    calculateNewsScore(newsList) {
        if (!newsList || newsList.length === 0) {
            return {
                score: 50,
                label: 'neutral',
                positiveCount: 0,
                negativeCount: 0,
                neutralCount: 0
            };
        }
        
        let totalScore = 0;
        let positiveCount = 0;
        let negativeCount = 0;
        let neutralCount = 0;
        
        // 近期新闻权重更高
        newsList.forEach((news, index) => {
            const weight = 1 - (index / newsList.length) * 0.5; // 权重从1到0.5
            totalScore += news.sentiment * weight;
            
            if (news.sentimentLabel === 'positive') {
                positiveCount++;
            } else if (news.sentimentLabel === 'negative') {
                negativeCount++;
            } else {
                neutralCount++;
            }
        });
        
        const avgScore = Math.round(totalScore / newsList.length);
        
        let label = 'neutral';
        if (avgScore >= 60) {
            label = 'positive';
        } else if (avgScore <= 40) {
            label = 'negative';
        }
        
        return {
            score: avgScore,
            label: label,
            positiveCount,
            negativeCount,
            neutralCount
        };
    },

    /**
     * 格式化时间
     * @param {string} dateString - ISO日期字符串
     * @returns {string} 格式化的时间字符串
     */
    formatTime(dateString) {
        const date = new Date(dateString);
        const now = new Date();
        const diff = now - date;
        
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);
        
        if (minutes < 1) {
            return '刚刚';
        } else if (minutes < 60) {
            return `${minutes}分钟前`;
        } else if (hours < 24) {
            return `${hours}小时前`;
        } else if (days < 7) {
            return `${days}天前`;
        } else {
            return date.toLocaleDateString('zh-CN');
        }
    },

    /**
     * 获取情感标签样式
     * @param {string} label - 情感标签
     * @returns {Object} 样式类名和颜色
     */
    getSentimentStyle(label) {
        switch (label) {
            case 'positive':
                return {
                    className: 'bg-crypto-green/20 text-crypto-green',
                    text: '利好'
                };
            case 'negative':
                return {
                    className: 'bg-crypto-red/20 text-crypto-red',
                    text: '利空'
                };
            default:
                return {
                    className: 'bg-gray-600/50 text-gray-300',
                    text: '中性'
                };
        }
    }
};
