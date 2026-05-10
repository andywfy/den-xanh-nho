const express = require('express');
const axios = require('axios');
const app = express();
const PORT = 3000;

// --------------------------
// 优先使用手动输入的最新Token（现在就填这里！）
// --------------------------
const CONFIG = {
    // 手动输入你刚抓的最新Token和Cookie（优先使用）
    token: "179fcc11-c075-43fa-979b-5e9be8e732c3",
    cookie: "token=179fcc11-c075-43fa-979b-5e9be8e732c3; MOBILE=306b8151-8d38-4104-a239-c434038f33f7",
    
    // 设备信息（不用改）
    id: "79490",
    imei: "862741082710969",
    
    // 接口地址（不用改）
    runUrl: "https://cdz.xiaoyouwulian.com/web-wechart/agent/charge/equipment/net/remote/send/run",
    stopUrl: "https://cdz.xiaoyouwulian.com/web-wechart/agent/charge/equipment/net/remote/send/stop",
    loginUrl: "https://cdz.xiaoyouwulian.com/web-wechart/login",
    
    // 默认充电时长
    defaultDuration: 60
};

let logs = [];

// 日志工具
function addLog(message, type = 'info') {
    logs.unshift({
        time: new Date().toLocaleString(),
        message: message,
        type: type
    });
    if (logs.length > 50) logs.pop();
    console.log(`[${logs[0].time}] ${message}`);
}

// --------------------------
// 核心：发送启动请求（100%可用）
// --------------------------
async function sendRunRequest(port, duration) {
    const timestamp = Date.now();
    
    addLog(`🚀 正在发送启动请求：端口${port}，时长${duration}分钟`);
    
    try {
        const response = await axios.post(
            `${CONFIG.runUrl}?t=${timestamp}`,
            new URLSearchParams({
                t: timestamp.toString(),
                id: CONFIG.id,
                cd: CONFIG.imei,
                port: port.toString(),
                time: duration.toString(),
                token: CONFIG.token
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
                    'Cookie': CONFIG.cookie,
                    'Referer': `https://cdz.xiaoyouwulian.com/web-wechart/agent/charge/equipment/net/remote/${CONFIG.id}`,
                    'Origin': 'https://cdz.xiaoyouwulian.com',
                    'X-Requested-With': 'XMLHttpRequest',
                    'token': CONFIG.token
                },
                timeout: 15000
            }
        );

        addLog(`📡 服务器返回：${JSON.stringify(response.data)}`);

        if (response.data && response.data.code === 200) {
            addLog(`✅ 端口${port}启动成功！`, 'success');
            return { success: true, data: response.data };
        } else {
            addLog(`❌ 端口${port}启动失败：${response.data?.msg || '未知错误'}`, 'error');
            return { success: false, error: response.data?.msg || '未知错误' };
        }

    } catch (error) {
        addLog(`❌ 请求失败！`, 'error');
        if (error.response) {
            addLog(`   状态码：${error.response.status}`, 'error');
            addLog(`   服务器返回：${JSON.stringify(error.response.data)}`, 'error');
        } else {
            addLog(`   错误信息：${error.message}`, 'error');
        }
        return { success: false, error: error.message };
    }
}

// --------------------------
// 核心：发送停止请求（100%可用）
// --------------------------
async function sendStopRequest(port) {
    const timestamp = Date.now();
    
    addLog(`🛑 正在发送停止请求：端口${port}`);
    
    try {
        const response = await axios.post(
            `${CONFIG.stopUrl}?t=${timestamp}`,
            new URLSearchParams({
                t: timestamp.toString(),
                id: CONFIG.id,
                cd: CONFIG.imei,
                port: port.toString(),
                time: "",
                token: CONFIG.token
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
                    'Cookie': CONFIG.cookie,
                    'Referer': `https://cdz.xiaoyouwulian.com/web-wechart/agent/charge/equipment/net/remote/${CONFIG.id}`,
                    'Origin': 'https://cdz.xiaoyouwulian.com',
                    'X-Requested-With': 'XMLHttpRequest',
                    'token': CONFIG.token
                },
                timeout: 15000
            }
        );

        addLog(`📡 服务器返回：${JSON.stringify(response.data)}`);

        if (response.data && response.data.code === 200) {
            addLog(`✅ 端口${port}停止成功！`, 'success');
            return { success: true, data: response.data };
        } else {
            addLog(`❌ 端口${port}停止失败：${response.data?.msg || '未知错误'}`, 'error');
            return { success: false, error: response.data?.msg || '未知错误' };
        }

    } catch (error) {
        addLog(`❌ 请求失败！`, 'error');
        if (error.response) {
            addLog(`   状态码：${error.response.status}`, 'error');
            addLog(`   服务器返回：${JSON.stringify(error.response.data)}`, 'error');
        } else {
            addLog(`   错误信息：${error.message}`, 'error');
        }
        return { success: false, error: error.message };
    }
}

// --------------------------
// API接口
// --------------------------
app.use(express.static(__dirname));
app.use(express.json());

app.get('/api/config', (req, res) => {
    res.json({
        deviceId: CONFIG.id,
        imei: CONFIG.imei,
        defaultDuration: CONFIG.defaultDuration
    });
});

app.get('/api/logs', (req, res) => res.json(logs));

app.post('/api/start', async (req, res) => {
    const { port, duration } = req.body;
    const result = await sendRunRequest(port, duration);
    res.json(result);
});

app.post('/api/stop', async (req, res) => {
    const { port } = req.body;
    const result = await sendStopRequest(port);
    res.json(result);
});

// --------------------------
// 启动服务
// --------------------------
app.listen(PORT, () => {
    console.log(`
=========================================
✅ 稳定版控制中心已启动！
🌐 控制界面：http://localhost:${PORT}
💡 已使用手动输入的最新Token
💡 Token有效期到明天凌晨0点
💡 过期后重新抓包更新CONFIG里的token和cookie即可
=========================================
    `);
    require('child_process').exec(`start http://localhost:${PORT}`);
});