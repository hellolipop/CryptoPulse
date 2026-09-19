const { installFetchShim } = require('./utils/fetch-shim');

// 必须在任何数据模块发请求之前装好 fetch 垫片：
// libs/stocks.js 是用 fetch 写的，小程序里没有这个 API。
installFetchShim();

App({
    globalData: {
        // 上一次详情页停留的币种，返回列表时用于高亮
        lastCoinId: '',
    },

    onLaunch() {
        // fetch 垫片是全局的，冷启动时再确认一次（热启动不会重跑上面的模块顶层代码）
        installFetchShim();
    },

    onError(err) {
        console.error('[小程序] 未捕获错误', err);
    },
});
