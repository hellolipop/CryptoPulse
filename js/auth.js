/* 用户登录：第一版只收用户名和密码，后续可替换为验证码或第三方身份提供商。 */
(function () {
    const API = localStorage.getItem('cryptoPulse_authApi') || 'http://127.0.0.1:8788';
    const SESSION_KEY = 'cryptoPulse_authSession';
    const gate = document.getElementById('authGate');
    const username = document.getElementById('authUsername');
    const password = document.getElementById('authPassword');
    const message = document.getElementById('authMessage');
    const submit = document.getElementById('authSubmit');
    const mode = document.getElementById('authMode');
    if (!gate || !username || !password || !submit || !mode) return;
    let registering = false;
    let session = null;
    function setMessage(text) { message.textContent = text || ''; }
    function setVisible(visible) { gate.hidden = !visible; }
    function saveSession(next) {
        session = next;
        localStorage.setItem(SESSION_KEY, JSON.stringify(next));
        if (typeof PaperTrader !== 'undefined') {
            PaperTrader.setUserStorage(next.user.username);
            PaperTrader.setSyncConfig(API, next.user.username);
        }
        // 预测记录同样要切到该用户的存储键：它原先用的是固定的全局键，
        // 不切的话会把上一个账号的预测当成自己的显示出来（也写进同一个地方）。
        if (typeof PredictionTracker !== 'undefined') {
            PredictionTracker.setUserStorage(next.user.username);
        }
    }
    async function request(path, body) {
        const response = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
        return data;
    }
    /**
     * 用本地缓存的令牌向服务端确认一次。
     * 服务端的会话是存在内存里的（进程重启即失效），所以本地还留着 token
     * 不代表它仍然有效。不校验的话，界面会显示「已登录」，而后面每一次
     * 同步都在后台 401 —— 用户看到的是「数据没同步」却没有任何提示。
     */
    async function verifySession(cached) {
        try {
            const response = await fetch(`${API}/api/auth/me`, { headers: { Authorization: `Bearer ${cached.token}` } });
            return response.ok;
        } catch (e) {
            // 服务没起来时也走这里：此时令牌同样不可用，应按未登录处理
            return false;
        }
    }
    async function restore(cached) {
        const valid = await verifySession(cached);
        if (!valid) {
            localStorage.removeItem(SESSION_KEY);
            setMessage('登录已过期，请重新登录');
            setVisible(true);
            return;
        }
        saveSession(cached);
        setVisible(false);
        // 校验是异步的，可能晚于 app.js 的 DOMContentLoaded 初始化。
        // 这里补一次「切到该用户的存储键 + 从后端拉取」，否则会拿默认键
        // 去同步，等于把别人的账本或空账本显示出来。
        if (typeof PaperTrader !== 'undefined') {
            await PaperTrader.initSync();
            if (typeof CryptoPulseApp !== 'undefined') CryptoPulseApp.renderPaperTab();
        }
        if (typeof PredictionTracker !== 'undefined') {
            await PredictionTracker.initSync();
            if (typeof CryptoPulseApp !== 'undefined') CryptoPulseApp.renderPredictTab();
        }
    }
    async function enter() {
        const name = username.value.trim();
        const pass = password.value;
        setMessage('');
        if (!name || pass.length < 6) { setMessage('请输入用户名和至少 6 位密码'); return; }
        submit.disabled = true;
        try {
            const data = await request(registering ? '/api/auth/register' : '/api/auth/login', { username: name, password: pass });
            saveSession(data);
            setVisible(false);
            if (typeof PaperTrader !== 'undefined') {
                await PaperTrader.initSync();
                if (typeof CryptoPulseApp !== 'undefined') CryptoPulseApp.renderPaperTab();
            }
            if (typeof PredictionTracker !== 'undefined') {
                await PredictionTracker.initSync();
                if (typeof CryptoPulseApp !== 'undefined') CryptoPulseApp.renderPredictTab();
            }
        } catch (error) { setMessage(error instanceof Error ? error.message : '登录失败'); }
        finally { submit.disabled = false; }
    }
    mode.addEventListener('click', () => {
        registering = !registering;
        submit.textContent = registering ? '注册并登录' : '登录';
        mode.textContent = registering ? '已有账号？返回登录' : '没有账号？注册';
        setMessage('');
    });
    /**
     * 同步过程中后端判定登录失效（401）时的收尾。
     * paper.js 清掉已失效的令牌后会调这里：把登录框重新弹出来并说明原因。
     * 只显示「同步失败：HTTP 401」的话，看不出该做什么，像后端坏了。
     */
    if (typeof PaperTrader !== 'undefined') {
        PaperTrader.onAuthExpired = () => {
            session = null;
            setMessage('登录已过期，请重新登录');
            setVisible(true);
        };
    }
    submit.addEventListener('click', enter);
    password.addEventListener('keydown', event => { if (event.key === 'Enter') enter(); });
    try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { session = null; }
    if (session && session.token && session.user && session.user.username) {
        // 先藏住登录卡，避免校验期间闪一下；校验失败时 restore 会重新显示
        setVisible(false);
        restore(session).catch(() => { /* 同步失败不影响已登录状态，后续操作会重试 */ });
    } else setVisible(true);
})();
