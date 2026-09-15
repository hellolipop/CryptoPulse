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
     * 带超时的 fetch 封装
     * 新闻源/代理经常长时间无响应，必须限制等待时间，
     * 否则整页新闻会被一个挂死的请求拖到几十秒。
     * @param {string} url - 请求地址
     * @param {Object} options - fetch 配置
     * @param {number} timeoutMs - 超时毫秒数
     * @returns {Promise<Response>}
     */
    async fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    },

    /**
     * 获取加密货币新闻（多源聚合 + 中文翻译）
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
                this.fetchWithTimeout(`https://cryptocurrency.cv/api/news?category=${cat}&limit=10`, {}, 8000)
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
                                _source: 'cryptocurrency.cv',
                                _lang: 'en'
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
            const bnResp = await this.fetchWithTimeout(
                'https://corsproxy.io/?' + encodeURIComponent(
                    'https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=5'
                ), {}, 6000
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
                        _source: 'binance',
                        _lang: 'zh'
                    })));
                }
            }
        } catch (e) {
            errors.push(`binance: ${e.message}`);
        }

        // ========== 源3: 528btc 快讯（多代理降级 + 人机验证检测）==========
        try {
            const result = await this.fetch528btcFlash();
            if (result.items.length > 0) {
                allNews.push(...result.items);
            }
            if (result.blocked) {
                console.warn('[528btc] 被反爬人机验证拦截，本次未获取到快讯:', result.reason);
            } else if (result.items.length === 0) {
                console.warn('[528btc] 未解析到快讯内容:', result.reason);
            }
        } catch (e) {
            errors.push(`528btc: ${e.message}`);
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

            // 取前15条
            const topNews = uniqueNews.slice(0, 15);

            // 情感分析 + 关键词提取
            const processedNews = topNews.map(item => {
                const sentiment = this.analyzeSentiment(item.title + ' ' + item.description);
                return {
                    ...item,
                    sentiment: sentiment.score,
                    sentimentLabel: sentiment.label,
                    keywords: this.extractKeywords(item.title + ' ' + item.description),
                    translated: false
                };
            });

            // 翻译英文新闻（异步进行，不阻塞返回）
            this.translateNews(processedNews);

            return processedNews;
        }

        // ========== 兜底：模拟数据 ==========
        console.warn('所有新闻源获取失败，使用模拟数据:', errors.join(', '));
        return this.getMockNews(coinId);
    },

    /**
     * 获取 528btc 快讯（多代理降级 + 人机验证检测）
     *
     * 已知限制：528btc 部署了反爬虫人机验证（滑块验证码）。
     * 浏览器直连会被 CORS 拦截；经代理访问时，站点会返回
     * 混淆 JS 的验证页而非真实快讯内容。因此本方法在检测到
     * 验证页时会主动放弃，避免把验证页当成新闻解析。
     *
     * @returns {Promise<{items: Array, blocked: boolean, reason: string}>}
     */
    async fetch528btcFlash() {
        const target = 'https://www.528btc.com/kx/';

        // 代理降级链：注意 allorigins 必须用 /get（/raw 端点会返回 ERR_FAILED）
        const proxies = [
            { name: 'allorigins', build: (u) => 'https://api.allorigins.win/get?url=' + encodeURIComponent(u), extract: (txt) => { try { return JSON.parse(txt).contents || ''; } catch (e) { return ''; } } },
            { name: 'codetabs', build: (u) => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u), extract: (txt) => txt },
            { name: 'direct', build: (u) => u, extract: (txt) => txt }
        ];

        let lastReason = '未知原因';

        for (const proxy of proxies) {
            let raw = '';
            try {
                const resp = await this.fetchWithTimeout(proxy.build(target), {}, 5000);
                if (!resp.ok) {
                    lastReason = `${proxy.name} 返回 HTTP ${resp.status}`;
                    continue;
                }
                raw = await resp.text();
            } catch (e) {
                lastReason = `${proxy.name} 请求失败 (${e.message})`;
                continue;
            }

            if (!raw || raw.length < 200) {
                lastReason = `${proxy.name} 返回内容过短 (${raw.length} 字节)`;
                continue;
            }

            // 人机验证页检测
            if (this.isVerificationPage(raw)) {
                return {
                    items: [],
                    blocked: true,
                    reason: '528btc 返回了人机验证页（滑块验证码），需在真实浏览器中通过验证后才能访问'
                };
            }

            // 正常 HTML，尝试解析
            const items = this.parse528btcHTML(raw);
            if (items.length > 0) {
                return { items, blocked: false, reason: `经 ${proxy.name} 获取成功，共 ${items.length} 条` };
            }

            lastReason = `${proxy.name} 返回的页面中未找到快讯列表结构`;
        }

        return { items: [], blocked: false, reason: lastReason };
    },

    /**
     * 判断内容是否为反爬人机验证页
     * @param {string} text - 页面内容
     * @returns {boolean} 是否为验证页
     */
    isVerificationPage(text) {
        const head = text.substring(0, 5000);
        const markers = [
            'slide to verify',      // 滑块验证英文提示
            '请滑动验证',            // 滑块验证中文提示
            'complete the operation to verify',
            'verify that you are a real person',
            '滑块验证', '滑动验证', '人机验证',
            'function a(a){function n()', // 典型混淆 JS 验证脚本
            'challenge-platform',
            'cf-browser-verification',
            'just a moment'
        ];
        const lower = head.toLowerCase();
        return markers.some(m => lower.includes(m.toLowerCase()));
    },

    /**
     * 解析 528btc 快讯页面 HTML
     * @param {string} html - HTML 文本
     * @returns {Array} 新闻列表
     */
    parse528btcHTML(html) {
        const items = [];
        try {
            // 简单的正则解析快讯列表
            // 528btc 快讯页面通常有特定的 class 结构
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            // 尝试多种可能的选择器
            const selectors = [
                '.kx-list li',
                '.news-list li',
                '.list-item',
                'article',
                '.item'
            ];

            for (const selector of selectors) {
                const elements = doc.querySelectorAll(selector);
                if (elements.length > 0) {
                    elements.forEach((el, idx) => {
                        if (idx >= 10) return; // 最多取10条
                        const titleEl = el.querySelector('a, h3, h4, .title');
                        const timeEl = el.querySelector('.time, .date, time');
                        const linkEl = el.querySelector('a');

                        const title = titleEl?.textContent?.trim() || '';
                        if (!title) return;

                        items.push({
                            id: '528btc-' + idx + '-' + Date.now(),
                            title: title,
                            description: title, // 快讯通常标题就是内容
                            url: linkEl?.href || 'https://www.528btc.com/kx/',
                            source: '528btc 快讯',
                            image: '',
                            publishedAt: timeEl?.textContent?.trim() ? new Date(timeEl.textContent).toISOString() : new Date().toISOString(),
                            categories: ['flash', 'chinese'],
                            _source: '528btc',
                            _lang: 'zh'
                        });
                    });
                    break;
                }
            }
        } catch (e) {
            console.warn('解析528btc HTML失败:', e.message);
        }
        return items;
    },

    /**
     * 判断翻译接口返回的内容是否为有效译文
     * MyMemory 在额度用尽/请求超限时会返回 WARNING 文本而非译文，
     * 必须拦截，否则会把警告当新闻标题显示出来。
     * @param {string} text - 译文
     * @returns {boolean} 是否有效
     */
    isValidTranslation(text) {
        if (!text || typeof text !== 'string') return false;
        const t = text.trim();
        if (t.length < 2) return false;

        const invalidMarkers = [
            'MYMEMORY WARNING',
            'QUERY LENGTH LIMIT',
            'YOU USED ALL AVAILABLE FREE TRANSLATIONS',
            'INVALID EMAIL PROVIDED',
            'INVALID SOURCE LANGUAGE',
            'INVALID TARGET LANGUAGE',
            'NO QUERY SPECIFIED',
            'TOO MANY REQUESTS',
            'PLEASE CONTACT',
        ];
        const upper = t.toUpperCase();
        if (invalidMarkers.some(m => upper.includes(m))) return false;

        // 纯英文/数字的返回说明没有翻译成功
        if (!/[\u4e00-\u9fa5]/.test(t)) return false;

        return true;
    },

    /**
     * 调用单个翻译接口
     * @param {string} text - 待翻译文本
     * @returns {Promise<string>} 译文（失败返回空串）
     */
    async requestTranslation(text) {
        if (!text) return '';
        const q = text.substring(0, 480);

        // 接口1：Google 非官方端点（无需 Key）
        try {
            const resp = await this.fetchWithTimeout(
                `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(q)}`,
                {}, 5000
            );
            if (resp.ok) {
                const data = await resp.json();
                const out = Array.isArray(data?.[0])
                    ? data[0].map(seg => seg?.[0] || '').join('')
                    : '';
                if (this.isValidTranslation(out)) return out.trim();
            }
        } catch (e) { /* 降级到下一个接口 */ }

        // 接口2：MyMemory（免费额度有限，超额会返回警告文本）
        try {
            const resp = await this.fetchWithTimeout(
                `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=en|zh-CN`,
                {}, 5000
            );
            if (resp.ok) {
                const data = await resp.json();
                const status = Number(data?.responseStatus);
                const out = data?.responseData?.translatedText;
                // 仅当状态码正常且译文通过校验时才采用
                if ((!status || status === 200) && this.isValidTranslation(out)) {
                    return out.trim();
                }
            }
        } catch (e) { /* 两个接口都失败，返回空串 */ }

        return '';
    },

    /**
     * 翻译英文新闻为中文
     * @param {Array} newsList - 新闻列表
     */
    async translateNews(newsList) {
        const englishNews = newsList.filter(n => n._lang === 'en' && !n.translated);
        if (englishNews.length === 0) return;

        // 分批翻译，每次最多翻译5条（避免API限制）
        const batch = englishNews.slice(0, 5);

        for (const news of batch) {
            try {
                if (!news.title) continue;

                // 翻译标题（带接口降级校验）
                const translatedTitle = await this.requestTranslation(news.title);

                // 标题翻译失败则保留英文原文，不再浪费额度翻译摘要
                if (!translatedTitle) {
                    console.warn('标题翻译不可用，保留英文原文:', news.title.substring(0, 40));
                    continue;
                }

                // 翻译摘要（如果有）
                let translatedDesc = '';
                if (news.description) {
                    translatedDesc = await this.requestTranslation(news.description);
                }

                // 保存英文原文，用中文替换显示
                news.originalTitle = news.title;
                news.originalDescription = news.description;
                news.title = translatedTitle;
                news.description = translatedDesc || news.description;
                news.translated = true;

                // 重新提取关键词（基于中文）
                news.keywords = this.extractKeywords(translatedTitle + ' ' + (translatedDesc || ''));

                // 重新进行情感分析（基于中文）
                const sentiment = this.analyzeSentiment(translatedTitle + ' ' + (translatedDesc || ''));
                news.sentiment = sentiment.score;
                news.sentimentLabel = sentiment.label;
            } catch (e) {
                console.warn('翻译失败:', news.title?.substring(0, 30), e.message);
            }
        }

        // 翻译完成后通知 UI 更新
        if (typeof CryptoPulseApp !== 'undefined' && CryptoPulseApp.renderNews) {
            CryptoPulseApp.renderNews();
        }
    },

    /**
     * 提取关键词
     * @param {string} text - 文本
     * @returns {Array<string>} 关键词数组
     */
    extractKeywords(text) {
        const keywords = [
            // 币种
            '比特币', '以太坊', 'BTC', 'ETH', '索拉纳', 'SOL', '瑞波币', 'XRP',
            '币安币', 'BNB', '狗狗币', 'DOGE', '卡尔达诺', 'ADA',
            'Bitcoin', 'Ethereum', 'Solana', 'Ripple', 'Dogecoin', 'Cardano',
            // 概念
            'ETF', '现货ETF', 'SEC', '监管', '政策', '批准', '通过', '拒绝',
            'Layer2', 'DeFi', 'NFT', 'Web3', '链上', '质押', '挖矿',
            // 行情
            '上涨', '下跌', '暴涨', '暴跌', '突破', '新高', '新低',
            '牛市', '熊市', '反弹', '回调', '震荡', '横盘', '跳水', '拉升',
            'surge', 'plunge', 'rally', 'crash', 'all-time high', 'ATH',
            // 资金
            '机构', '鲸鱼', '大额', '增持', '减持', '买入', '卖出',
            '资金流入', '资金流出', '成交量', '放量', '缩量',
            'institutional', 'whale', 'accumulation', 'distribution',
            // 技术
            '升级', '硬分叉', '软分叉', '主网', '测试网', '空投',
            'hack', '黑客', '攻击', '安全', '漏洞', '被盗',
            // 事件
            '合作', '伙伴', '上线', '上市', '融资', '投资', '收购',
            'partnership', 'listing', 'funding', 'acquisition'
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
                    className: 'bg-rise-green/15 text-rise-green',
                    text: '利好'
                };
            case 'negative':
                return {
                    className: 'bg-fall-red/15 text-fall-red',
                    text: '利空'
                };
            default:
                return {
                    className: 'bg-gray-200 text-text-secondary',
                    text: '中性'
                };
        }
    }
};
