const express = require('express');
const bcrypt = require('bcryptjs');
const { queryAll, queryOne, runSql } = require('../db/database');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { startCharging, stopCharging, queryChargerOnlineStatus, queryPortMonitor } = require('../services/chargerPlatform');

const router = express.Router();

// 获取平台全局统计
router.get('/stats', authMiddleware, adminOnly, (req, res) => {
    const today = new Date().toISOString().split('T')[0];

    const merchantCount = queryOne('SELECT COUNT(*) as count FROM merchants WHERE status = "active"');
    const pendingCount = queryOne('SELECT COUNT(*) as count FROM merchants WHERE status = "pending"');
    const chargerCount = queryOne('SELECT COUNT(*) as count FROM chargers');

    const todayStats = queryOne(`
        SELECT COUNT(*) as order_count, COALESCE(SUM(amount), 0) as total_income
        FROM orders WHERE payment_status = 'paid' AND DATE(created_at) = ?
    `, [today]);

    const totalStats = queryOne(`
        SELECT COUNT(*) as order_count, COALESCE(SUM(amount), 0) as total_income
        FROM orders WHERE payment_status = 'paid'
    `);

    // 计算总余额
    const totalBalance = queryOne('SELECT COALESCE(SUM(balance), 0) as total FROM merchants WHERE status = "active"');
    const pendingWithdrawals = queryOne('SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals WHERE status = "pending"');

    res.json({
        code: 200,
        data: {
            merchant_count: merchantCount ? merchantCount.count : 0,
            pending_merchant_count: pendingCount ? pendingCount.count : 0,
            charger_count: chargerCount ? chargerCount.count : 0,
            today: todayStats,
            total: totalStats,
            total_balance: totalBalance ? totalBalance.total : 0,
            pending_withdrawals: pendingWithdrawals ? pendingWithdrawals.total : 0
        }
    });
});

// 获取商户列表
router.get('/merchants', authMiddleware, adminOnly, (req, res) => {
    const { status, search } = req.query;
    
    let sql = `
        SELECT m.id, m.phone, m.name, m.status, m.balance, m.frozen_balance, m.commission_rate, m.created_at,
               (SELECT COUNT(*) FROM chargers WHERE merchant_id = m.id) as charger_count,
               (SELECT COALESCE(SUM(amount), 0) FROM orders WHERE merchant_id = m.id AND payment_status = 'paid') as total_income,
               (SELECT COUNT(*) FROM orders WHERE merchant_id = m.id AND payment_status = 'paid') as total_orders
        FROM merchants m WHERE 1=1
    `;
    let params = [];

    if (status) {
        sql += ' AND m.status = ?';
        params.push(status);
    }

    if (search) {
        sql += ' AND (m.name LIKE ? OR m.phone LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY m.created_at DESC';

    const merchants = queryAll(sql, params);

    res.json({ code: 200, data: merchants });
});

// 审核商户（批准或拒绝）
router.put('/merchants/:id/approve', authMiddleware, adminOnly, (req, res) => {
    const { status } = req.body;
    if (!['active', 'disabled'].includes(status)) {
        return res.json({ code: 400, msg: '无效状态' });
    }

    runSql('UPDATE merchants SET status = ? WHERE id = ?', [status, req.params.id]);
    res.json({ code: 200, msg: status === 'active' ? '已批准，该商户可以正常登录' : '已禁用该商户' });
});

// 修改商户余额
router.put('/merchants/:id/balance', authMiddleware, adminOnly, (req, res) => {
    const { balance, frozen_balance } = req.body;

    if (balance !== undefined) {
        runSql('UPDATE merchants SET balance = ? WHERE id = ?', [parseInt(balance), req.params.id]);
    }
    if (frozen_balance !== undefined) {
        runSql('UPDATE merchants SET frozen_balance = ? WHERE id = ?', [parseInt(frozen_balance), req.params.id]);
    }

    res.json({ code: 200, msg: '余额更新成功' });
});

// 手动调整余额（增加/减少）
router.post('/merchants/:id/adjust-balance', authMiddleware, adminOnly, (req, res) => {
    const { amount, reason } = req.body;
    
    if (!amount || amount === 0) {
        return res.json({ code: 400, msg: '请输入调整金额' });
    }

    const merchant = queryOne('SELECT balance FROM merchants WHERE id = ?', [req.params.id]);
    if (!merchant) {
        return res.json({ code: 404, msg: '商户不存在' });
    }

    const newBalance = (merchant.balance || 0) + parseInt(amount);
    if (newBalance < 0) {
        return res.json({ code: 400, msg: '余额不能为负数' });
    }

    runSql('UPDATE merchants SET balance = ? WHERE id = ?', [newBalance, req.params.id]);

    res.json({ code: 200, msg: `余额已${amount > 0 ? '增加' : '减少'} ${Math.abs(amount)} VND，当前余额: ${newBalance} VND` });
});

// 处理提现申请
router.put('/withdrawals/:id/process', authMiddleware, adminOnly, (req, res) => {
    const { status, admin_note } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
        return res.json({ code: 400, msg: '无效状态' });
    }

    const withdrawal = queryOne('SELECT * FROM withdrawals WHERE id = ?', [req.params.id]);
    if (!withdrawal) {
        return res.json({ code: 404, msg: '提现申请不存在' });
    }

    if (withdrawal.status !== 'pending') {
        return res.json({ code: 400, msg: '该申请已处理' });
    }

    runSql('UPDATE withdrawals SET status = ?, admin_note = ?, processed_at = datetime("now") WHERE id = ?',
        [status, admin_note || '', req.params.id]);

    // 如果批准，扣除商户余额
    if (status === 'approved') {
        const merchant = queryOne('SELECT balance FROM merchants WHERE id = ?', [withdrawal.merchant_id]);
        if (merchant && merchant.balance >= withdrawal.amount) {
            runSql('UPDATE merchants SET balance = balance - ? WHERE id = ?', [withdrawal.amount, withdrawal.merchant_id]);
            res.json({ code: 200, msg: '已批准并扣除余额' });
        } else {
            res.json({ code: 400, msg: '商户余额不足' });
        }
    } else {
        res.json({ code: 200, msg: '已拒绝该提现申请' });
    }
});

// 获取待处理提现列表
router.get('/withdrawals/pending', authMiddleware, adminOnly, (req, res) => {
    const withdrawals = queryAll(`
        SELECT w.*, m.name as merchant_name, m.phone as merchant_phone
        FROM withdrawals w
        JOIN merchants m ON w.merchant_id = m.id
        WHERE w.status = 'pending'
        ORDER BY w.created_at DESC
    `);

    res.json({ code: 200, data: withdrawals });
});

// 获取所有充电桩（带搜索和过滤）
router.get('/chargers', authMiddleware, adminOnly, (req, res) => {
    const { search, status, merchant_id } = req.query;

    let sql = `
        SELECT c.*, m.name as merchant_name,
               (SELECT COUNT(*) FROM ports WHERE charger_id = c.id AND status = 'charging') as busy_ports,
               (SELECT COUNT(*) FROM ports WHERE charger_id = c.id AND status = 'idle') as idle_ports
        FROM chargers c
        JOIN merchants m ON c.merchant_id = m.id
        WHERE 1=1
    `;
    let params = [];

    if (status) {
        sql += ' AND c.status = ?';
        params.push(status);
    }

    if (merchant_id) {
        sql += ' AND c.merchant_id = ?';
        params.push(merchant_id);
    }

    if (search) {
        sql += ' AND (c.name LIKE ? OR c.location LIKE ? OR c.device_id LIKE ?)';
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY c.created_at DESC';

    const chargers = queryAll(sql, params);

    res.json({ code: 200, data: chargers });
});

// 批量查询所有充电桩实时状态（含平台在线检测和超时订单修正）
router.get('/chargers-realtime-status', authMiddleware, adminOnly, async (req, res) => {
    const chargers = queryAll('SELECT * FROM chargers ORDER BY created_at DESC');
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
        const merchant = queryOne('SELECT name FROM merchants WHERE id = ?', [charger.merchant_id]);

        results.push({
            ...charger,
            merchant_name: merchant ? merchant.name : '-',
            ports: ports,
            busy_ports: busyCount,
            idle_ports: ports.length - busyCount,
            platform_online: platformOnline
        });
    }

    res.json({ code: 200, data: results });
});

// 获取充电桩详情（含端口状态）
router.get('/chargers/:id', authMiddleware, adminOnly, (req, res) => {
    const charger = queryOne(`
        SELECT c.*, m.name as merchant_name
        FROM chargers c
        JOIN merchants m ON c.merchant_id = m.id
        WHERE c.id = ?
    `, [req.params.id]);

    if (!charger) {
        return res.json({ code: 404, msg: '充电桩不存在' });
    }

    const ports = queryAll('SELECT * FROM ports WHERE charger_id = ? ORDER BY port_number', [charger.id]);

    res.json({ code: 200, data: { ...charger, ports } });
});

// 管理员远程控制充电口
router.post('/control/port', authMiddleware, adminOnly, (req, res) => {
    const { charger_id, port_number, action, duration } = req.body;

    if (!charger_id || !port_number || !action) {
        return res.json({ code: 400, msg: '参数不完整' });
    }

    const charger = queryOne('SELECT * FROM chargers WHERE id = ?', [charger_id]);
    if (!charger) {
        return res.json({ code: 404, msg: '充电桩不存在' });
    }

    const port = queryOne('SELECT * FROM ports WHERE charger_id = ? AND port_number = ?', [charger_id, port_number]);
    if (!port) {
        return res.json({ code: 404, msg: '充电口不存在' });
    }

    if (action === 'start') {
        const dur = duration || 60;
        startCharging(charger, port_number, dur)
            .then(result => {
                if (result.success) {
                    runSql("UPDATE ports SET status = 'charging' WHERE charger_id = ? AND port_number = ?", [charger_id, port_number]);
                }
                res.json({ code: result.success ? 200 : 500, msg: result.success ? `充电${dur}分钟已启动` : result.error });
            })
            .catch(err => res.json({ code: 500, msg: err.message }));
    } else if (action === 'stop') {
        stopCharging(charger, port_number)
            .then(result => {
                if (result.success) {
                    runSql("UPDATE ports SET status = 'idle', current_order_id = NULL WHERE charger_id = ? AND port_number = ?", [charger_id, port_number]);
                }
                res.json({ code: result.success ? 200 : 500, msg: result.success ? '充电已停止' : result.error });
            })
            .catch(err => res.json({ code: 500, msg: err.message }));
    } else {
        res.json({ code: 400, msg: '无效的操作' });
    }
});

// 导出订单Excel
router.get('/export/orders', authMiddleware, adminOnly, (req, res) => {
    const XLSX = require('xlsx');
    const { merchant_id, date_from, date_to } = req.query;

    let sql = `SELECT o.order_no, m.name as merchant_name, c.name as charger_name,
               o.port_number, o.user_phone, o.duration, o.amount,
               o.payment_status, o.charge_status, o.sepay_transaction_id,
               o.payment_time, o.charge_start_time, o.charge_end_time, o.created_at
               FROM orders o
               JOIN merchants m ON o.merchant_id = m.id
               JOIN chargers c ON o.charger_id = c.id WHERE 1=1`;
    let params = [];

    if (merchant_id) {
        sql += ' AND o.merchant_id = ?';
        params.push(merchant_id);
    }
    if (date_from) {
        sql += ' AND DATE(o.created_at) >= ?';
        params.push(date_from);
    }
    if (date_to) {
        sql += ' AND DATE(o.created_at) <= ?';
        params.push(date_to);
    }

    sql += ' ORDER BY o.created_at DESC';
    const orders = queryAll(sql, params);

    const data = orders.map(o => ({
        '订单号': o.order_no,
        '商户': o.merchant_name,
        '充电桩': o.charger_name,
        '端口': o.port_number,
        '用户手机': o.user_phone,
        '时长(分钟)': o.duration,
        '金额(VND)': o.amount,
        '支付状态': o.payment_status === 'paid' ? '已支付' : '未支付',
        '充电状态': { waiting: '等待', charging: '充电中', completed: '已完成', failed: '失败' }[o.charge_status] || o.charge_status,
        'SePay交易ID': o.sepay_transaction_id || '',
        '支付时间': o.payment_time || '',
        '充电开始': o.charge_start_time || '',
        '充电结束': o.charge_end_time || '',
        '创建时间': o.created_at
    }));

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '订单列表');

    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=orders_${new Date().toISOString().split('T')[0]}.xlsx`);
    res.send(buffer);
});

// 商户对账统计导出
router.get('/export/settlement', authMiddleware, adminOnly, (req, res) => {
    const XLSX = require('xlsx');
    const { date_from, date_to } = req.query;

    let sql = `SELECT m.name as merchant_name, m.commission_rate,
               DATE(o.created_at) as order_date,
               COUNT(*) as order_count,
               SUM(o.amount) as total_income
               FROM orders o
               JOIN merchants m ON o.merchant_id = m.id
               WHERE o.payment_status = 'paid'`;
    let params = [];

    if (date_from) {
        sql += ' AND DATE(o.created_at) >= ?';
        params.push(date_from);
    }
    if (date_to) {
        sql += ' AND DATE(o.created_at) <= ?';
        params.push(date_to);
    }

    sql += ' GROUP BY m.id, DATE(o.created_at) ORDER BY order_date DESC';
    const results = queryAll(sql, params);

    const data = results.map(r => ({
        '商户': r.merchant_name,
        '日期': r.order_date,
        '订单数': r.order_count,
        '总收入(VND)': r.total_income,
        '平台分成(%)': (r.commission_rate * 100).toFixed(1),
        '平台收入(VND)': Math.round(r.total_income * r.commission_rate),
        '商户应得(VND)': Math.round(r.total_income * (1 - r.commission_rate))
    }));

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '商户对账');

    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=settlement_${new Date().toISOString().split('T')[0]}.xlsx`);
    res.send(buffer);
});

module.exports = router;