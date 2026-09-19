/**
 * 给小程序补一个 fetch 的最小子集。
 *
 * 为什么要这么做：网页端的 libs/stocks.js 是用 fetch 写的，而小程序里没有 fetch。
 * 与其为了小程序把 stocks.js 改成回调/async 双份实现（然后两份慢慢走样），
 * 不如在运行时补一个等价物，让那份纯逻辑原样跑起来。
 * 只实现 stocks.js 真正用到的部分：url、ok、status、json()、text()。
 */

let installed = false;

function makeFetch() {
    return function fetchShim(url, options) {
        const opt = options || {};
        return new Promise(function (resolve, reject) {
            wx.request({
                url: url,
                method: opt.method || 'GET',
                header: opt.header || {},
                timeout: opt.timeout || 15000,
                // 不做 dataType 转换：让 json()/text() 自己决定怎么读，
                // 与浏览器 fetch 的语义保持一致
                success: function (res) {
                    const status = res.statusCode;
                    const body = res.data;
                    resolve({
                        ok: status >= 200 && status < 300,
                        status: status,
                        json: function () {
                            if (typeof body === 'string') {
                                try { return Promise.resolve(JSON.parse(body)); }
                                catch (e) { return Promise.reject(new Error('响应不是合法 JSON')); }
                            }
                            return Promise.resolve(body);
                        },
                        text: function () {
                            return Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body));
                        },
                    });
                },
                fail: function (err) {
                    // 域名未配置、网络不可达都会走到这里。
                    // 原始 errMsg 对排查很有用（例如 "url not in domain list"），原样往上抛。
                    const msg = (err && err.errMsg) ? err.errMsg : '网络请求失败';
                    const e = new Error(msg);
                    e.isNetwork = true;
                    reject(e);
                },
            });
        });
    };
}

function installFetchShim() {
    if (installed) return;
    installed = true;

    const g = typeof globalThis !== 'undefined' ? globalThis
        : (typeof global !== 'undefined' ? global : null);
    if (!g) return;

    // 真机上如果基础库已自带 fetch，就不覆盖，避免把原生实现换掉
    if (typeof g.fetch === 'function') return;
    g.fetch = makeFetch();
}

module.exports = { installFetchShim };
