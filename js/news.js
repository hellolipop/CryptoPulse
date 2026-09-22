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

        // 三个源互不依赖，必须并行。
        // 之前是逐个 await，总耗时变成三者相加（实测约 5.6 秒）；
        // 并行后总耗时约等于最慢的那一个。
        //
        // 2026-09-22 换源。原来的「币安公告（经 corsproxy.io）」和「528btc 快讯
        // （经 allorigins / codetabs / 直连）」四条路全断，且都不是配置能修的：
        //   - corsproxy.io 已停用无 key 的匿名代理，返回 403
        //     「Anonymous legacy proxy URLs are no longer supported」；
        //   - allorigins 与 codetabs 双双 522；
        //   - 528btc 直连 200 但不带 access-control-allow-origin，浏览器读不到，
        //     且该站有反爬滑块，经代理也只能拿到验证页；
        //   - 币安 bapi 那条上游本身在本机就不可达（DNS 层）。
        // 现改为两个走 rss2json 的 RSS 源，理由见 RSS_FEEDS 的注释。
        const sources = [
            { name: 'cryptocurrency.cv', run: () => this.sourceCryptocurrencyCv(category) },
            { name: 'cointelegraph', run: () => this.sourceRssFeed(this.RSS_FEEDS[0]) },
            { name: 'decrypt', run: () => this.sourceRssFeed(this.RSS_FEEDS[1]) },
        ];
        const settled = await Promise.allSettled(sources.map(s => s.run()));
        const names = sources.map(s => s.name);

        const allNews = [];
        const errors = [];
        settled.forEach((r, i) => {
            if (r.status === 'fulfilled' && Array.isArray(r.value)) {
                allNews.push(...r.value);
            } else if (r.status === 'rejected') {
                errors.push(`${names[i]}: ${r.reason && r.reason.message ? r.reason.message : r.reason}`);
            }
        });

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

            this.lastFailure = null;
            return processedNews;
        }

        // 所有源都没给出内容。
        //
        // 这里绝不再返回「模拟新闻」。之前 getMockNews 会编 6 条读起来完全像真的
        // 标题（连来源名都是假的：CryptoNews / BlockchainDaily），并带上写死的
        // 情感分（均分约 60，偏多），以 12% 的权重混进综合信号。
        // 那比「没有新闻」糟得多：用户看到的是一个有理有据的消息面结论，
        // 而它对应的输入根本不存在。
        //
        // 现在返回空数组，并把原因记在 lastFailure 上交给界面展示。
        this.lastFailure = errors.length
            ? errors.join('；')
            : '所有新闻源都返回了空内容';
        console.warn('[新闻] 未取到任何内容:', this.lastFailure);
        return [];
    },

    /**
     * 上一次 fetchNews 失败的原因；成功时为 null。
     * 界面据此区分「暂时取不到」与「确实没有新闻」。
     */
    lastFailure: null,

    /**
     * 源1：cryptocurrency.cv（免费、无需 Key、支持 CORS、多源聚合）
     * @returns {Promise<Array>}
     */
    async sourceCryptocurrencyCv(category) {
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
                            // 实测这个接口的 source 字段一直有（10/10），
                            // 兜底只是防御。但不写死成「CryptoNews」——
                            // 那会把真实文章挂到一个可能不是它的媒体名下。
                            source: item.source || item.publisher || '来源未标注',
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
        const out = [];
        results.forEach(result => {
            if (result.status === 'fulfilled' && Array.isArray(result.value)) {
                out.push(...result.value);
            }
        });
        return out;
    },

    /**
     * 走 rss2json 的 RSS 源清单。
     *
     * 为什么必须经这一层：本项目是纯前端，新闻源要同时满足「免 key」和
     * 「允许跨域」两条硬约束。而加密媒体基本只提供 RSS、不给 CORS 头 ——
     * 实测 528btc 直连返回 200，但响应里没有 access-control-allow-origin，
     * 浏览器拿到响应也读不了。rss2json 把 RSS 转成 JSON 并带上
     * `Access-Control-Allow-Origin: *`，免 key 的免费额度对本应用的调用频率
     * （每 5 分钟一次，见 app.js 的 startAutoRefresh）足够。
     *
     * 这两个源都是英文，界面上的中文由 translateNews 负责翻译 —— 与
     * cryptocurrency.cv 那条路径的处理方式一致。
     */
    RSS_FEEDS: [
        { label: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
        { label: 'Decrypt', url: 'https://decrypt.co/feed' },
    ],

    /**
     * 源2 / 源3：RSS 源（经 rss2json 转 JSON 并补上 CORS 头）
     * @param {{label: string, url: string}} feed
     * @returns {Promise<Array>}
     */
    async sourceRssFeed(feed) {
        const endpoint = 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(feed.url);
        const resp = await this.fetchWithTimeout(endpoint, {}, 8000);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);

        const data = await resp.json();
        if (data.status !== 'ok' || !Array.isArray(data.items)) {
            // rss2json 失败时返回 {status:'error', message:'...'}，
            // 把它的原因带上去，否则排查时只剩一句「没拿到新闻」
            throw new Error(data.message || 'rss2json 返回异常');
        }

        return data.items.slice(0, 10).map(item => ({
            id: item.guid || item.link,
            title: item.title || '',
            description: this.stripHtml(item.description || ''),
            url: item.link || '#',
            source: feed.label,
            image: item.thumbnail || '',
            publishedAt: this.parseRssDate(item.pubDate),
            categories: Array.isArray(item.categories) ? item.categories : [],
            _source: feed.label.toLowerCase(),
            _lang: 'en'
        }));
    },

    /**
     * 解析 rss2json 的时间字段。
     *
     * 它给的是「2026-09-22 04:03:00」这种不带时区标记的 UTC 字符串。
     * 直接丢给 new Date() 在部分引擎里会被当成本地时间，排序随之错位，
     * 所以显式补上 T 与 Z。解析不出来就回落到当前时间 ——
     * 不让一条脏数据把整个列表的排序拖垮。
     * @param {string} s
     * @returns {string} ISO 时间串
     */
    parseRssDate(s) {
        const raw = String(s || '').trim();
        if (!raw) return new Date().toISOString();
        const hasZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(raw);
        const d = new Date(raw.replace(' ', 'T') + (hasZone ? '' : 'Z'));
        return isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
    },

    /**
     * 去掉描述里的 HTML 标签。
     * RSS 的 description 常带 <p> / <img> / 实体转义，直接送进情感分析会
     * 把标签名当成词；参与关键词提取时也会把 "p"、"img" 混进结果。
     * @param {string} html
     * @returns {string}
     */
    stripHtml(html) {
        return String(html || '')
            .replace(/<[^>]*>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ')
            .trim();
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
