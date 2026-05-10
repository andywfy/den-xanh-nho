const express = require('express');
const { queryAll, queryOne, runSql } = require('../db/database');
const { authMiddleware, merchantOnly } = require('../middleware/auth');
const { queryChargerOnlineStatus, queryPortMonitor } = require('../services/chargerPlatform');

const router = express.Router();

// 获取商户信息
router.get('/profile', authMiddleware, merchantOnly, (req, res) => {
    const merchant = queryOne(
        'SELECT id, phone, name, zalo_id, status, balance, frozen_balance, commission_rate, created_at FROM merchants WHERE id = ?',
        [req.user.id]
    );
    res.json({ code: 200, data: merchant });
});

// 更新商户信息
router.put('/profile', authMiddleware, merchantOnly, (req, res) => {
    const { name, zalo_id } = req.body;
    runSql('UPDATE merchants SET name = ?, zalo_id = ? WHERE id = ?',
        [name || '', zalo_id || '', req.user.id]);
    res.json({ code: 200, msg: '更新成功' });
});

// 获取商户余额信息
router.get('/balance', authMiddleware, merchantOnly, (req, res) => {
    const merchant = queryOne('SELECT balance, frozen_balance FROM merchants WHERE id = ?', [req.user.id]);
    const pendingWithdrawals = queryOne(
        "SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals WHERE merchant_id = ? AND status = 'pending'",
        [req.user.id]
    );

    // 计算可提现余额 = 余额 - 冻结金额 - 待处理提现
    const availableBalance = (merchant.balance || 0) - (merchant.frozen_balance || 0) - (pendingWithdrawals.total || 0);

    // 获取最近收入
    const today = new Date().toISOString().split('T')[0];
    const todayIncome = queryOne(
        "SELECT COALESCE(SUM(amount), 0) as total FROM orders WHERE merchant_id = ? AND payment_status = 'paid' AND DATE(created_at) = ?",
        [req.user.id, today]
    );

    res.json({ code: 200, data: {
        balance: merchant.balance || 0,
        frozen_balance: merchant.frozen_balance || 0,
        pending_withdrawal: pendingWithdrawals.total || 0,
        available_balance: availableBalance,
        today_income: todayIncome.total || 0
    }});
});

// 申请提现
router.post('/withdraw', authMiddleware, merchantOnly, (req, res) => {
    const { amount, bank_account, bank_name, account_holder } = req.body;
    
    if (!amount || amount <= 0) {
        return res.json({ code: 400, msg: '请输入正确的提现金额' });
    }

    if (!bank_account || !bank_name || !account_holder) {
        return res.json({ code: 400, msg: '请填写完整的银行账户信息' });
    }

    const merchant = queryOne('SELECT balance, frozen_balance FROM merchants WHERE id = ?', [req.user.id]);
    const pendingWithdrawals = queryOne(
        "SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals WHERE merchant_id = ? AND status = 'pending'",
        [req.user.id]
    );

    const availableBalance = (merchant.balance || 0) - (merchant.frozen_balance || 0) - (pendingWithdrawals.total || 0);

    if (amount > availableBalance) {
        return res.json({ code: 400, msg: '可提现余额不足' });
    }

    const result = runSql(
        'INSERT INTO withdrawals (merchant_id, amount, bank_account, bank_name, account_holder, status) VALUES (?, ?, ?, ?, ?, ?)',
        [req.user.id, amount, bank_account, bank_name, account_holder, 'pending']
    );

    res.json({ code: 200, msg: '提现申请已提交，请等待审核', data: { id: result.lastInsertRowid } });
});

// 获取提现记录
router.get('/withdrawals', authMiddleware, merchantOnly, (req, res) => {
    const withdrawals = queryAll(
        'SELECT * FROM withdrawals WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 50',
        [req.user.id]
    );

    res.json({ code: 200, data: withdrawals });
});

// 获取商户统计数据
router.get('/stats', authMiddleware, merchantOnly, (req, res) => {
    const merchantId = req.user.id;
    const today = new Date().toISOString().split('T')[0];

    const todayStats = queryOne(`
        SELECT COUNT(*) as order_count, COALESCE(SUM(amount), 0) as total_income
        FROM orders WHERE merchant_id = ? AND payment_status = 'paid' AND DATE(created_at) = ?
    `, [merchantId, today]);

    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const yesterdayStats = queryOne(`
        SELECT COUNT(*) as order_count, COALESCE(SUM(amount), 0) as total_income
        FROM orders WHERE merchant_id = ? AND payment_status = 'paid' AND DATE(created_at) = ?
    `, [merchantId, yesterday]);

    const monthStart = today.slice(0, 7) + '-01';
    const monthStats = queryOne(`
        SELECT COUNT(*) as order_count, COALESCE(SUM(amount), 0) as total_income
        FROM orders WHERE merchant_id = ? AND payment_status = 'paid' AND DATE(created_at) >= ?
    `, [merchantId, monthStart]);

    const totalStats = queryOne(`
        SELECT COUNT(*) as order_count, COALESCE(SUM(amount), 0) as total_income
        FROM orders WHERE merchant_id = ? AND payment_status = 'paid'
    `, [merchantId]);

    const chargerCount = queryOne('SELECT COUNT(*) as count FROM chargers WHERE merchant_id = ?', [merchantId]);

    const merchant = queryOne('SELECT balance, frozen_balance FROM merchants WHERE id = ?', [merchantId]);

    res.json({
        code: 200,
        data: {
            today: todayStats,
            yesterday: yesterdayStats,
            month: monthStats,
            total: totalStats,
            charger_count: chargerCount ? chargerCount.count : 0,
            balance: merchant.balance || 0,
            frozen_balance: merchant.frozen_balance || 0
        }
    });
});

// 获取商户所有充电桩及其端口状态
router.get('/chargers-with-ports', authMiddleware, merchantOnly, (req, res) => {
    const chargers = queryAll('SELECT * FROM chargers WHERE merchant_id = ? ORDER BY created_at DESC', [req.user.id]);
    
    const result = chargers.map(charger => {
        const ports = queryAll('SELECT * FROM ports WHERE charger_id = ? ORDER BY port_number', [charger.id]);
        const busyCount = ports.filter(p => p.status === 'charging').length;
        
        return {
            ...charger,
            ports: ports,
            busy_ports: busyCount,
            idle_ports: ports.length - busyCount
        };
    });

    res.json({ code: 200, data: result });
});

// 批量查询商户充电桩实时状态（含平台在线检测和超时订单修正）
router.get('/chargers-realtime-status', authMiddleware, merchantOnly, async (req, res) => {
    const chargers = queryAll('SELECT * FROM chargers WHERE merchant_id = ? ORDER BY created_at DESC', [req.user.id]);
    const now = new Date().toISOString();

    const results = [];
    for (const charger of chargers) {
        let platformOnline = null;
        let platformPorts = null;
        if (charger.platform_token && charger.platform_cookie) {
            try {
                const status = await queryChargerOnlineStatus(charger);
                platformOnline = status.online;
                if (status.online !== null) {
                    const newStatus = status.online ? 'online' : 'offline';
                    if (charger.status !== newStatus) {
                        runSql("UPDATE chargers SET status = ? WHERE id = ?", [newStatus, charger.id]);
                        charger.status = newStatus;
                    }
                }
                // 如果设备在线，查询端口实时状态
                if (status.online === true) {
                    const monitorResult = await queryPortMonitor(charger);
                    if (monitorResult.success && monitorResult.ports.length > 0) {
                        platformPorts = monitorResult.ports;
                    }
                }
            } catch (e) {
                platformOnline = false;
            }
        }

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

        let ports = queryAll('SELECT * FROM ports WHERE charger_id = ? ORDER BY port_number', [charger.id]);

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

        const busyCount = ports.filter(p => p.status === 'charging').length;

        results.push({
            ...charger,
            ports: ports,
            busy_ports: busyCount,
            idle_ports: ports.length - busyCount,
            platform_online: platformOnline
        });
    }

    res.json({ code: 200, data: results });
});

// 远程控制充电口（开始充电）
router.post('/control/start', authMiddleware, merchantOnly, (req, res) => {
    const { charger_id, port_number, duration } = req.body;
    
    if (!charger_id || !port_number || !duration) {
        return res.json({ code: 400, msg: '参数不完整' });
    }

    // 验证充电桩属于当前商户
    const charger = queryOne('SELECT * FROM chargers WHERE id = ? AND merchant_id = ?', [charger_id, req.user.id]);
    if (!charger) {
        return res.json({ code: 404, msg: '充电桩不存在' });
    }

    // 验证端口
    const port = queryOne('SELECT * FROM ports WHERE charger_id = ? AND port_number = ?', [charger_id, port_number]);
    if (!port) {
        return res.json({ code: 404, msg: '充电口不存在' });
    }

    if (port.status === 'charging') {
        return res.json({ code: 400, msg: '充电口已在使用中' });
    }

    // 调用充电桩平台API启动充电
    const { startCharging } = require('../services/chargerPlatform');
    
    startCharging(charger, port_number, duration)
        .then(apiResult => {
            // 更新端口状态
            runSql("UPDATE ports SET status = 'charging' WHERE charger_id = ? AND port_number = ?", [charger_id, port_number]);
            res.json({ code: 200, msg: '充电已启动', data: apiResult });
        })
        .catch(err => {
            res.json({ code: 500, msg: '启动充电失败: ' + err.message });
        });
});

// 远程控制充电口（停止充电）
router.post('/control/stop', authMiddleware, merchantOnly, (req, res) => {
    const { charger_id, port_number } = req.body;
    
    if (!charger_id || !port_number) {
        return res.json({ code: 400, msg: '参数不完整' });
    }

    const charger = queryOne('SELECT * FROM chargers WHERE id = ? AND merchant_id = ?', [charger_id, req.user.id]);
    if (!charger) {
        return res.json({ code: 404, msg: '充电桩不存在' });
    }

    const { stopCharging } = require('../services/chargerPlatform');
    
    stopCharging(charger, port_number)
        .then(apiResult => {
            // 更新端口状态
            runSql("UPDATE ports SET status = 'idle', current_order_id = NULL WHERE charger_id = ? AND port_number = ?", [charger_id, port_number]);
            res.json({ code: 200, msg: '充电已停止', data: apiResult });
        })
        .catch(err => {
            res.json({ code: 500, msg: '停止充电失败: ' + err.message });
        });
});

module.exports = router;