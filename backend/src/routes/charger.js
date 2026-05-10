const express = require('express');
const { queryAll, queryOne, runSql } = require('../db/database');
const { authMiddleware, merchantOnly, adminOnly } = require('../middleware/auth');
const { startCharging, stopCharging, queryChargerOnlineStatus, queryPortMonitor } = require('../services/chargerPlatform');

const router = express.Router();

// 公开接口：查询充电桩信息（用户扫码后调用）
router.get('/info', (req, res) => {
    const { charger_id, port } = req.query;
    if (!charger_id) {
        return res.json({ code: 400, msg: '缺少充电桩ID' });
    }

    const charger = queryOne(`
        SELECT c.id, c.name, c.model, c.port_count, c.status, c.device_id,
               m.name as merchant_name, m.id as merchant_id
        FROM chargers c
        JOIN merchants m ON c.merchant_id = m.id
        WHERE c.id = ? AND m.status = 'active'
    `, [charger_id]);

    if (!charger) {
        return res.json({ code: 404, msg: '该充电桩暂未开通服务，请联系商家' });
    }

    if (charger.status === 'offline') {
        return res.json({ code: 503, msg: '设备维护中，请稍后再试' });
    }

    let ports = queryAll(
        'SELECT port_number, status FROM ports WHERE charger_id = ? ORDER BY port_number',
        [charger.id]
    );

    // 自动修正超时订单：充电时长已过且状态仍为charging的订单
    const now = new Date().toISOString();
    const activeOrders = queryAll(`
        SELECT * FROM orders WHERE charger_id = ? AND charge_status = 'charging'
    `, [charger.id]);
    let portsUpdated = false;
    activeOrders.forEach(order => {
        if (order.charge_start_time && order.duration) {
            const startTime = new Date(order.charge_start_time).getTime();
            const expectedEnd = startTime + order.duration * 60 * 1000;
            if (Date.now() > expectedEnd + 5 * 60 * 1000) {
                runSql("UPDATE orders SET charge_status = 'completed', charge_end_time = ? WHERE id = ?",
                    [now, order.id]);
                runSql("UPDATE ports SET status = 'idle', current_order_id = NULL WHERE charger_id = ? AND port_number = ?",
                    [order.charger_id, order.port_number]);
                portsUpdated = true;
            }
        }
    });
    if (portsUpdated) {
        ports = queryAll(
            'SELECT port_number, status FROM ports WHERE charger_id = ? ORDER BY port_number',
            [charger.id]
        );
    }

    if (port) {
        const portInfo = ports.find(p => p.port_number === parseInt(port));
        if (portInfo && portInfo.status === 'charging') {
            return res.json({ code: 409, msg: '该端口正在使用中' });
        }
    }

    res.json({
        code: 200,
        data: {
            id: charger.id,
            name: charger.name,
            model: charger.model,
            port_count: charger.port_count,
            status: charger.status,
            merchant_name: charger.merchant_name,
            merchant_id: charger.merchant_id,
            ports: ports
        }
    });
});

// 公开接口：查询充电桩实时状态（含平台在线检测）
router.get('/:id/realtime-status', async (req, res) => {
    const charger = queryOne('SELECT * FROM chargers WHERE id = ?', [req.params.id]);
    if (!charger) {
        return res.json({ code: 404, msg: '充电桩不存在' });
    }

    // 查询平台在线状态
    let platformStatus = null;
    let platformPorts = null;
    if (charger.platform_token && charger.platform_cookie) {
        platformStatus = await queryChargerOnlineStatus(charger);
        // 更新数据库中的在线状态
        if (platformStatus.online !== null) {
            const newStatus = platformStatus.online ? 'online' : 'offline';
            if (charger.status !== newStatus) {
                runSql("UPDATE chargers SET status = ? WHERE id = ?", [newStatus, charger.id]);
                charger.status = newStatus;
            }
        }
        // 如果设备在线，查询端口实时状态
        if (platformStatus.online === true) {
            const monitorResult = await queryPortMonitor(charger);
            if (monitorResult.success && monitorResult.ports.length > 0) {
                platformPorts = monitorResult.ports;
            }
        }
    }

    // 修正超时订单
    const now = new Date().toISOString();
    const activeOrders = queryAll(`
        SELECT * FROM orders WHERE charger_id = ? AND charge_status = 'charging'
    `, [charger.id]);
    activeOrders.forEach(order => {
        if (order.charge_start_time && order.duration) {
            const startTime = new Date(order.charge_start_time).getTime();
            const expectedEnd = startTime + order.duration * 60 * 1000;
            if (Date.now() > expectedEnd + 5 * 60 * 1000) {
                runSql("UPDATE orders SET charge_status = 'completed', charge_end_time = ? WHERE id = ?",
                    [now, order.id]);
                runSql("UPDATE ports SET status = 'idle', current_order_id = NULL WHERE charger_id = ? AND port_number = ?",
                    [order.charger_id, order.port_number]);
            }
        }
    });

    let ports = queryAll(
        'SELECT port_number, status, current_order_id FROM ports WHERE charger_id = ? ORDER BY port_number',
        [charger.id]
    );

    // 将平台端口状态合并到返回数据中
    if (platformPorts && platformPorts.length > 0) {
        ports = ports.map(p => {
            const platformPort = platformPorts.find(pp => pp.port_number === p.port_number);
            if (platformPort) {
                return {
                    ...p,
                    status: platformPort.platform_status,
                    platform_status_text: platformPort.platform_status_text
                };
            }
            return p;
        });
    }

    res.json({
        code: 200,
        data: {
            id: charger.id,
            name: charger.name,
            status: charger.status,
            platform_online: platformStatus ? platformStatus.online : null,
            platform_error: platformStatus ? (platformStatus.error || null) : null,
            ports: ports
        }
    });
});

// 商户接口：添加充电桩
router.post('/add', authMiddleware, merchantOnly, (req, res) => {
    const { device_id, imei, name, model, port_count, platform_token, platform_cookie } = req.body;

    if (!device_id || !imei) {
        return res.json({ code: 400, msg: '请填写设备编号和IMEI' });
    }

    const existing = queryOne('SELECT id FROM chargers WHERE imei = ?', [imei]);
    if (existing) {
        return res.json({ code: 400, msg: '该IMEI已被绑定' });
    }

    const portNum = port_count || 4;
    const chargerModel = model || '4port';

    const result = runSql(`
        INSERT INTO chargers (merchant_id, device_id, imei, name, model, port_count, platform_token, platform_cookie)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        req.user.id, device_id, imei,
        name || `充电桩-${imei.slice(-4)}`,
        chargerModel, portNum,
        platform_token || '', platform_cookie || ''
    ]);

    const chargerId = result.lastInsertRowid;

    for (let i = 1; i <= portNum; i++) {
        runSql('INSERT INTO ports (charger_id, port_number, status) VALUES (?, ?, ?)',
            [chargerId, i, 'idle']);
    }

    res.json({ code: 200, msg: '添加成功', data: { id: chargerId } });
});

// 商户接口：获取我的充电桩列表
router.get('/my-list', authMiddleware, merchantOnly, (req, res) => {
    const chargers = queryAll(`
        SELECT c.*,
               (SELECT COUNT(*) FROM ports WHERE charger_id = c.id AND status = 'charging') as busy_ports
        FROM chargers c WHERE c.merchant_id = ?
        ORDER BY c.created_at DESC
    `, [req.user.id]);

    res.json({ code: 200, data: chargers });
});

// 商户接口：删除充电桩
router.delete('/:id', authMiddleware, merchantOnly, (req, res) => {
    const charger = queryOne('SELECT * FROM chargers WHERE id = ? AND merchant_id = ?',
        [req.params.id, req.user.id]);

    if (!charger) {
        return res.json({ code: 404, msg: '充电桩不存在' });
    }

    const activeOrder = queryOne(
        "SELECT id FROM orders WHERE charger_id = ? AND charge_status = 'charging'",
        [charger.id]
    );

    if (activeOrder) {
        return res.json({ code: 400, msg: '该充电桩有正在进行的订单，无法删除' });
    }

    runSql('DELETE FROM ports WHERE charger_id = ?', [charger.id]);
    runSql('DELETE FROM chargers WHERE id = ?', [charger.id]);

    res.json({ code: 200, msg: '删除成功' });
});

// 远程启动充电
router.post('/start', authMiddleware, (req, res) => {
    const { charger_id, port_number, duration } = req.body;

    let charger;
    if (req.user.role === 'merchant') {
        charger = queryOne('SELECT * FROM chargers WHERE id = ? AND merchant_id = ?', [charger_id, req.user.id]);
    } else {
        charger = queryOne('SELECT * FROM chargers WHERE id = ?', [charger_id]);
    }

    if (!charger) {
        return res.json({ code: 404, msg: '充电桩不存在' });
    }

    startCharging(charger, port_number, duration || 60).then(result => {
        if (result.success) {
            runSql('UPDATE ports SET status = ? WHERE charger_id = ? AND port_number = ?',
                ['charging', charger_id, port_number]);
        }
        res.json({ code: result.success ? 200 : 500, msg: result.success ? '启动成功' : result.error, data: result.data });
    }).catch(err => {
        res.json({ code: 500, msg: err.message });
    });
});

// 远程停止充电
router.post('/stop', authMiddleware, (req, res) => {
    const { charger_id, port_number } = req.body;

    let charger;
    if (req.user.role === 'merchant') {
        charger = queryOne('SELECT * FROM chargers WHERE id = ? AND merchant_id = ?', [charger_id, req.user.id]);
    } else {
        charger = queryOne('SELECT * FROM chargers WHERE id = ?', [charger_id]);
    }

    if (!charger) {
        return res.json({ code: 404, msg: '充电桩不存在' });
    }

    stopCharging(charger, port_number).then(result => {
        if (result.success) {
            runSql('UPDATE ports SET status = ?, current_order_id = NULL WHERE charger_id = ? AND port_number = ?',
                ['idle', charger_id, port_number]);
        }
        res.json({ code: result.success ? 200 : 500, msg: result.success ? '停止成功' : result.error, data: result.data });
    }).catch(err => {
        res.json({ code: 500, msg: err.message });
    });
});

// 管理员接口：获取所有充电桩
router.get('/all', authMiddleware, adminOnly, (req, res) => {
    const chargers = queryAll(`
        SELECT c.*, m.name as merchant_name,
               (SELECT COUNT(*) FROM ports WHERE charger_id = c.id AND status = 'charging') as busy_ports
        FROM chargers c
        JOIN merchants m ON c.merchant_id = m.id
        ORDER BY c.created_at DESC
    `);

    res.json({ code: 200, data: chargers });
});

// 商户接口：更新充电桩平台凭证
router.put('/:id/credentials', authMiddleware, merchantOnly, (req, res) => {
    const { platform_token, platform_cookie } = req.body;

    const charger = queryOne('SELECT * FROM chargers WHERE id = ? AND merchant_id = ?',
        [req.params.id, req.user.id]);
    if (!charger) {
        return res.json({ code: 404, msg: '充电桩不存在' });
    }

    runSql('UPDATE chargers SET platform_token = ?, platform_cookie = ? WHERE id = ?',
        [platform_token || charger.platform_token, platform_cookie || charger.platform_cookie, charger.id]);

    res.json({ code: 200, msg: '凭证更新成功' });
});

module.exports = router;
