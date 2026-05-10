const express = require('express');
const { queryAll, queryOne, runSql } = require('../db/database');
const { authMiddleware, merchantOnly, adminOnly } = require('../middleware/auth');
const { generateOrderNo } = require('../utils/helpers');
const { startCharging, stopCharging } = require('../services/chargerPlatform');

const router = express.Router();

// 用户接口：创建订单
router.post('/create', (req, res) => {
    const { charger_id, port_number, phone, duration, amount } = req.body;

    if (!charger_id || !port_number || !phone || !duration || !amount) {
        return res.json({ code: 400, msg: '请填写完整信息' });
    }

    const charger = queryOne(`
        SELECT c.*, m.id as merchant_id FROM chargers c
        JOIN merchants m ON c.merchant_id = m.id
        WHERE c.id = ? AND c.status = 'online' AND m.status = 'active'
    `, [charger_id]);

    if (!charger) {
        return res.json({ code: 404, msg: '充电桩不可用' });
    }

    const port = queryOne(
        'SELECT * FROM ports WHERE charger_id = ? AND port_number = ?',
        [charger_id, port_number]
    );

    if (!port || port.status === 'charging') {
        return res.json({ code: 409, msg: '该端口正在使用中' });
    }

    const orderNo = generateOrderNo();

    runSql(`
        INSERT INTO orders (order_no, merchant_id, charger_id, port_number, user_phone, duration, amount)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [orderNo, charger.merchant_id, charger_id, port_number, phone, duration, amount]);

    res.json({
        code: 200,
        msg: '订单创建成功',
        data: {
            order_no: orderNo,
            amount: amount,
            charger_name: charger.name,
            port_number: port_number,
            duration: duration
        }
    });
});

// SePay Webhook回调
router.post('/sepay/webhook', (req, res) => {
    const { id, transferAmount, content } = req.body;

    console.log('[SePay Webhook]', req.body);

    const orderNoMatch = content && content.match(/DXN\d+/);
    if (!orderNoMatch) {
        return res.json({ code: 200, msg: 'OK - no matching order' });
    }

    const orderNo = orderNoMatch[0];
    const order = queryOne("SELECT * FROM orders WHERE order_no = ? AND payment_status = 'pending'", [orderNo]);

    if (!order) {
        return res.json({ code: 200, msg: 'OK - order not found or already paid' });
    }

    if (transferAmount < order.amount) {
        return res.json({ code: 200, msg: 'OK - amount mismatch' });
    }

    const now = new Date().toISOString();
    runSql(`UPDATE orders SET payment_status = 'paid', sepay_transaction_id = ?, payment_time = ? WHERE order_no = ?`,
        [id ? id.toString() : '', now, orderNo]);

    const charger = queryOne('SELECT * FROM chargers WHERE id = ?', [order.charger_id]);
    if (charger) {
        startCharging(charger, order.port_number, order.duration).then(result => {
            if (result.success) {
                runSql(`UPDATE orders SET charge_status = 'charging', charge_start_time = ? WHERE order_no = ?`,
                    [now, orderNo]);
                runSql('UPDATE ports SET status = ?, current_order_id = ? WHERE charger_id = ? AND port_number = ?',
                    ['charging', order.id, order.charger_id, order.port_number]);

                setTimeout(() => { autoStopCharging(orderNo); }, order.duration * 60 * 1000);
                console.log(`[充电启动] 订单${orderNo} 端口${order.port_number} 时长${order.duration}分钟`);
            } else {
                runSql("UPDATE orders SET charge_status = 'failed' WHERE order_no = ?", [orderNo]);
                console.error(`[充电启动失败] 订单${orderNo}: ${result.error}`);
            }
        });
    }

    res.json({ code: 200, msg: 'OK' });
});

// 模拟支付成功（测试用）
router.post('/mock-pay', (req, res) => {
    const { order_no } = req.body;
    if (!order_no) {
        return res.json({ code: 400, msg: '缺少订单号' });
    }

    const order = queryOne("SELECT * FROM orders WHERE order_no = ? AND payment_status = 'pending'", [order_no]);
    if (!order) {
        return res.json({ code: 404, msg: '订单不存在或已支付' });
    }

    const now = new Date().toISOString();
    runSql(`UPDATE orders SET payment_status = 'paid', sepay_transaction_id = ?, payment_time = ? WHERE order_no = ?`,
        ['MOCK_' + Date.now(), now, order_no]);

    const charger = queryOne('SELECT * FROM chargers WHERE id = ?', [order.charger_id]);
    if (charger) {
        startCharging(charger, order.port_number, order.duration).then(result => {
            if (result.success) {
                runSql(`UPDATE orders SET charge_status = 'charging', charge_start_time = ? WHERE order_no = ?`,
                    [now, order_no]);
                runSql('UPDATE ports SET status = ?, current_order_id = ? WHERE charger_id = ? AND port_number = ?',
                    ['charging', order.id, order.charger_id, order.port_number]);

                setTimeout(() => { autoStopCharging(order_no); }, order.duration * 60 * 1000);
            }
            res.json({
                code: 200,
                msg: result.success ? '支付成功，充电已启动' : '支付成功，但充电启动失败: ' + result.error,
                data: { charging: result.success }
            });
        });
    } else {
        res.json({ code: 500, msg: '充电桩配置错误' });
    }
});

// 公开接口：通过手机号查询订单列表
router.get('/list', (req, res) => {
    const { phone, limit = 10 } = req.query;
    if (!phone) {
        return res.json({ code: 400, msg: '请输入手机号' });
    }

    const orders = queryAll(`
        SELECT o.*, c.name as charger_name
        FROM orders o
        JOIN chargers c ON o.charger_id = c.id
        WHERE o.user_phone = ?
        ORDER BY o.created_at DESC
        LIMIT ?
    `, [phone, parseInt(limit)]);

    res.json({ code: 200, data: orders });
});

// 用户接口：查询订单状态
router.get('/status/:order_no', (req, res) => {
    const order = queryOne(`
        SELECT o.*, c.name as charger_name
        FROM orders o
        JOIN chargers c ON o.charger_id = c.id
        WHERE o.order_no = ?
    `, [req.params.order_no]);

    if (!order) {
        return res.json({ code: 404, msg: '订单不存在' });
    }

    res.json({
        code: 200,
        data: {
            order_no: order.order_no,
            charger_name: order.charger_name,
            port_number: order.port_number,
            duration: order.duration,
            amount: order.amount,
            payment_status: order.payment_status,
            charge_status: order.charge_status,
            charge_start_time: order.charge_start_time,
            charge_end_time: order.charge_end_time
        }
    });
});

// 商户接口：获取订单列表
router.get('/merchant-list', authMiddleware, merchantOnly, (req, res) => {
    const { page = 1, limit = 50, status, date_from, date_to, charger_id } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let sql = 'SELECT o.*, c.name as charger_name FROM orders o JOIN chargers c ON o.charger_id = c.id WHERE o.merchant_id = ?';
    let countSql = 'SELECT COUNT(*) as total FROM orders o WHERE o.merchant_id = ?';
    let params = [req.user.id];
    let countParams = [req.user.id];

    if (charger_id) {
        sql += ' AND o.charger_id = ?';
        countSql += ' AND o.charger_id = ?';
        params.push(parseInt(charger_id));
        countParams.push(parseInt(charger_id));
    }
    if (status) {
        sql += ' AND o.charge_status = ?';
        countSql += ' AND o.charge_status = ?';
        params.push(status);
        countParams.push(status);
    }
    if (date_from) {
        sql += ' AND o.created_at >= ?';
        countSql += ' AND o.created_at >= ?';
        params.push(date_from);
        countParams.push(date_from);
    }
    if (date_to) {
        sql += ' AND o.created_at <= ?';
        countSql += ' AND o.created_at <= ?';
        params.push(date_to + ' 23:59:59');
        countParams.push(date_to + ' 23:59:59');
    }

    const totalResult = queryOne(countSql, countParams);
    const total = totalResult ? totalResult.total : 0;

    sql += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const orders = queryAll(sql, params);

    res.json({ code: 200, data: { orders, total, page: parseInt(page), limit: parseInt(limit) } });
});

// 管理员接口：获取所有订单
router.get('/all', authMiddleware, adminOnly, (req, res) => {
    const { page = 1, limit = 20, merchant_id, status } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let sql = `SELECT o.*, c.name as charger_name, m.name as merchant_name
               FROM orders o
               JOIN chargers c ON o.charger_id = c.id
               JOIN merchants m ON o.merchant_id = m.id WHERE 1=1`;
    let countSql = 'SELECT COUNT(*) as total FROM orders o WHERE 1=1';
    let params = [];
    let countParams = [];

    if (merchant_id) {
        sql += ' AND o.merchant_id = ?';
        countSql += ' AND o.merchant_id = ?';
        params.push(merchant_id);
        countParams.push(merchant_id);
    }
    if (status) {
        sql += ' AND o.charge_status = ?';
        countSql += ' AND o.charge_status = ?';
        params.push(status);
        countParams.push(status);
    }

    const totalResult = queryOne(countSql, countParams);
    const total = totalResult ? totalResult.total : 0;

    sql += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const orders = queryAll(sql, params);

    res.json({ code: 200, data: { orders, total, page: parseInt(page), limit: parseInt(limit) } });
});

// 自动停止充电
async function autoStopCharging(orderNo) {
    const order = queryOne("SELECT * FROM orders WHERE order_no = ? AND charge_status = 'charging'", [orderNo]);
    if (!order) return;

    const charger = queryOne('SELECT * FROM chargers WHERE id = ?', [order.charger_id]);
    if (!charger) return;

    const result = await stopCharging(charger, order.port_number);
    const now = new Date().toISOString();

    runSql("UPDATE orders SET charge_status = 'completed', charge_end_time = ? WHERE order_no = ?",
        [now, orderNo]);
    runSql('UPDATE ports SET status = ?, current_order_id = NULL WHERE charger_id = ? AND port_number = ?',
        ['idle', order.charger_id, order.port_number]);

    console.log(`[充电完成] 订单${orderNo} ${result.success ? '停止成功' : '停止失败: ' + result.error}`);
}

module.exports = router;
