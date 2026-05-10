const axios = require('axios');

const PLATFORM_BASE_URL = process.env.CHARGER_PLATFORM_BASE_URL || 'https://cdz.xiaoyouwulian.com';

function parseResponse(data) {
    if (typeof data !== 'string') return data;
    try {
        const clean = data.replace(/^\uFEFF/, '').trim();
        return JSON.parse(clean);
    } catch (e) {
        return { raw: data, success: data.includes('成功') };
    }
}

/**
 * 发送启动充电请求到第三方平台
 */
async function startCharging(charger, portNumber, duration) {
    const timestamp = Date.now();
    const runUrl = `${PLATFORM_BASE_URL}/web-wechart/agent/charge/equipment/net/remote/send/run`;

    try {
        const response = await axios.post(
            `${runUrl}?t=${timestamp}`,
            new URLSearchParams({
                t: timestamp.toString(),
                id: charger.device_id,
                cd: charger.imei,
                port: portNumber.toString(),
                time: duration.toString(),
                token: charger.platform_token
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'Cookie': charger.platform_cookie,
                    'token': charger.platform_token
                },
                timeout: 15000,
                responseType: 'text',
                transformResponse: [(data) => data]
            }
        );

        const result = parseResponse(response.data);
        console.log('[PLATFORM] start response raw:', response.data);
        console.log('[PLATFORM] start parsed:', JSON.stringify(result));

        if (result.success === true || result.code === 200) {
            return { success: true, data: result };
        } else {
            return { success: false, error: result.message || result.msg || result.raw || '启动失败' };
        }
    } catch (error) {
        console.log('[PLATFORM] start error:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * 发送停止充电请求到第三方平台
 */
async function stopCharging(charger, portNumber) {
    const timestamp = Date.now();
    const stopUrl = `${PLATFORM_BASE_URL}/web-wechart/agent/charge/equipment/net/remote/send/stop`;

    try {
        const response = await axios.post(
            `${stopUrl}?t=${timestamp}`,
            new URLSearchParams({
                t: timestamp.toString(),
                id: charger.device_id,
                cd: charger.imei,
                port: portNumber.toString(),
                time: '',
                token: charger.platform_token
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'Cookie': charger.platform_cookie,
                    'token': charger.platform_token
                },
                timeout: 15000,
                responseType: 'text',
                transformResponse: [(data) => data]
            }
        );

        const result = parseResponse(response.data);
        console.log('[PLATFORM] stop response raw:', response.data);
        console.log('[PLATFORM] stop parsed:', JSON.stringify(result));

        if (result.success === true || result.code === 200) {
            return { success: true, data: result };
        } else {
            return { success: false, error: result.message || result.msg || result.raw || '停止失败' };
        }
    } catch (error) {
        console.log('[PLATFORM] stop error:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * 查询充电桩在线状态（调用小优物联设备列表API）
 */
async function queryChargerOnlineStatus(charger) {
    const timestamp = Date.now();
    try {
        const response = await axios.get(
            `${PLATFORM_BASE_URL}/web-wechart/agent/charge/equipment/list/listData?pageSize=7&page=1&_=${timestamp}`,
            {
                headers: {
                    'Cookie': charger.platform_cookie,
                    'token': charger.platform_token
                },
                timeout: 10000,
                responseType: 'text',
                transformResponse: [(data) => data]
            }
        );

        const result = parseResponse(response.data);
        console.log('[PLATFORM] device list raw:', response.data.substring(0, 200));
        console.log('[PLATFORM] device list parsed:', JSON.stringify(result).substring(0, 300));

        if (result.records && Array.isArray(result.records)) {
            const device = result.records.find(r =>
                String(r.id) === String(charger.device_id) ||
                String(r.cd) === String(charger.imei)
            );
            if (device) {
                return {
                    success: true,
                    online: device.isOnline === true,
                    device: device,
                    data: result
                };
            }
            return {
                success: true,
                online: false,
                error: '设备未在平台列表中找到',
                data: result
            };
        }

        // 如果解析失败但请求成功，保守认为平台可达但无法确认设备状态
        return { success: true, online: null, error: '无法解析设备列表', data: result };
    } catch (error) {
        console.log('[PLATFORM] device list error:', error.message);
        const isTimeout = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND';
        return {
            success: false,
            online: false,
            error: isTimeout ? '平台连接超时' : error.message
        };
    }
}

/**
 * 查询充电桩端口实时状态（调用小优物联端口监控API，返回HTML）
 */
async function queryPortMonitor(charger) {
    const timestamp = Date.now();
    try {
        const response = await axios.get(
            `${PLATFORM_BASE_URL}/web-wechart/agent/charge/equipment/net/portMonitor/data?id=${charger.device_id}&_=${timestamp}`,
            {
                headers: {
                    'Cookie': charger.platform_cookie,
                    'token': charger.platform_token
                },
                timeout: 10000,
                responseType: 'text',
                transformResponse: [(data) => data]
            }
        );

        const html = response.data;
        console.log('[PLATFORM] port monitor raw length:', html.length);

        // 从HTML中解析所有 port-state 文本
        const portStates = [];
        const regex = /<span[^>]*class=["']port-state["'][^>]*>([^<]*)<\/span>/gi;
        let match;
        while ((match = regex.exec(html)) !== null) {
            const stateText = match[1].trim();
            let state = 'idle';
            if (stateText.includes('运行') || stateText.includes('充电')) {
                state = 'charging';
            } else if (stateText.includes('故障') || stateText.includes('停用') || stateText.includes('异常')) {
                state = 'fault';
            }
            portStates.push({
                port_number: portStates.length + 1,
                platform_status: state,
                platform_status_text: stateText
            });
        }

        // 如果上面没找到，尝试更宽松的正则
        if (portStates.length === 0) {
            const looseRegex = /port-state[^>]*>([^<]+)</gi;
            while ((match = looseRegex.exec(html)) !== null) {
                const stateText = match[1].trim();
                let state = 'idle';
                if (stateText.includes('运行') || stateText.includes('充电')) {
                    state = 'charging';
                } else if (stateText.includes('故障') || stateText.includes('停用')) {
                    state = 'fault';
                }
                portStates.push({
                    port_number: portStates.length + 1,
                    platform_status: state,
                    platform_status_text: stateText
                });
            }
        }

        return {
            success: true,
            ports: portStates,
            html_preview: html.substring(0, 300)
        };
    } catch (error) {
        console.log('[PLATFORM] port monitor error:', error.message);
        return {
            success: false,
            error: error.message,
            ports: []
        };
    }
}

module.exports = { startCharging, stopCharging, queryChargerOnlineStatus, queryPortMonitor };
