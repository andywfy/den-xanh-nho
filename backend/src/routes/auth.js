const express = require('express');
const bcrypt = require('bcryptjs');
const { queryOne, queryAll, runSql } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// 生成4位验证码
function generateCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

// 管理员登录
router.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.json({ code: 400, msg: '请输入用户名和密码' });
    }

    const admin = queryOne('SELECT * FROM admins WHERE username = ?', [username]);
    if (!admin) {
        return res.json({ code: 401, msg: '用户名或密码错误' });
    }

    if (!bcrypt.compareSync(password, admin.password)) {
        return res.json({ code: 401, msg: '用户名或密码错误' });
    }

    const token = generateToken({
        id: admin.id,
        username: admin.username,
        name: admin.name,
        role: admin.role
    });

    res.json({ code: 200, msg: '登录成功', data: { token, name: admin.name, role: admin.role } });
});

// 商户手机号登录（发送验证码）
router.post('/merchant/send-code', (req, res) => {
    const { phone } = req.body;
    if (!phone) {
        return res.json({ code: 400, msg: '请输入手机号' });
    }

    // 验证手机号格式（越南手机号）
    const phoneRegex = /^0[0-9]{9,10}$/;
    if (!phoneRegex.test(phone)) {
        return res.json({ code: 400, msg: '手机号格式不正确' });
    }

    // 生成验证码（模拟发送，实际项目中需要接入短信网关）
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5分钟过期

    // 删除旧验证码
    runSql('DELETE FROM sms_codes WHERE phone = ? AND type = ?', [phone, 'login']);

    // 保存新验证码
    runSql('INSERT INTO sms_codes (phone, code, type, expires_at) VALUES (?, ?, ?, ?)',
        [phone, code, 'login', expiresAt.toISOString()]);

    // 模拟发送（实际项目中这里调用短信网关）
    console.log(`[SMS] 向 ${phone} 发送验证码: ${code}`);

    res.json({ code: 200, msg: '验证码已发送', data: { 
        // 开发模式下直接返回验证码方便测试
        // 生产环境应删除此行
        dev_code: code 
    }});
});

// 商户手机号+密码登录
router.post('/merchant/login', (req, res) => {
    const { phone, password } = req.body;
    if (!phone || !password) {
        return res.json({ code: 400, msg: '请输入手机号和密码' });
    }

    // 查找商户
    const merchant = queryOne('SELECT * FROM merchants WHERE phone = ?', [phone]);
    if (!merchant) {
        return res.json({ code: 404, msg: '该手机号未注册' });
    }

    if (merchant.status === 'pending') {
        return res.json({ code: 403, msg: '账号正在等待审核，请耐心等待' });
    }

    if (merchant.status === 'disabled') {
        return res.json({ code: 403, msg: '账号已被禁用，请联系管理员' });
    }

    // 验证密码
    if (!bcrypt.compareSync(password, merchant.password)) {
        return res.json({ code: 401, msg: '手机号或密码错误' });
    }

    const token = generateToken({
        id: merchant.id,
        phone: merchant.phone,
        name: merchant.name,
        role: 'merchant'
    });

    res.json({ code: 200, msg: '登录成功', data: {
        token,
        name: merchant.name,
        phone: merchant.phone,
        balance: merchant.balance,
        frozen_balance: merchant.frozen_balance || 0
    }});
});

// 商户注册（待审核状态）
router.post('/merchant/register', (req, res) => {
    const { phone, password, name, code } = req.body;
    if (!phone || !password || !name || !code) {
        return res.json({ code: 400, msg: '请填写完整信息' });
    }

    // 验证手机号格式
    const phoneRegex = /^0[0-9]{9,10}$/;
    if (!phoneRegex.test(phone)) {
        return res.json({ code: 400, msg: '手机号格式不正确' });
    }

    // 验证验证码
    const smsRecord = queryOne(
        "SELECT * FROM sms_codes WHERE phone = ? AND code = ? AND type = 'register' AND used = 0 AND expires_at > datetime('now')",
        [phone, code]
    );

    if (!smsRecord) {
        return res.json({ code: 401, msg: '验证码无效或已过期' });
    }

    runSql('UPDATE sms_codes SET used = 1 WHERE id = ?', [smsRecord.id]);

    // 检查手机号是否已注册
    const existing = queryOne('SELECT id FROM merchants WHERE phone = ?', [phone]);
    if (existing) {
        return res.json({ code: 400, msg: '该手机号已注册' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const result = runSql(
        'INSERT INTO merchants (phone, password, name, status) VALUES (?, ?, ?, ?)',
        [phone, hashedPassword, name, 'pending']
    );

    res.json({ code: 200, msg: '注册成功，请等待管理员审核', data: { id: result.lastInsertRowid } });
});

// 商户发送注册验证码
router.post('/merchant/send-register-code', (req, res) => {
    const { phone } = req.body;
    if (!phone) {
        return res.json({ code: 400, msg: '请输入手机号' });
    }

    const phoneRegex = /^0[0-9]{9,10}$/;
    if (!phoneRegex.test(phone)) {
        return res.json({ code: 400, msg: '手机号格式不正确' });
    }

    // 检查是否已注册
    const existing = queryOne('SELECT id FROM merchants WHERE phone = ?', [phone]);
    if (existing) {
        return res.json({ code: 400, msg: '该手机号已注册' });
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    runSql('DELETE FROM sms_codes WHERE phone = ? AND type = ?', [phone, 'register']);
    runSql('INSERT INTO sms_codes (phone, code, type, expires_at) VALUES (?, ?, ?, ?)',
        [phone, code, 'register', expiresAt.toISOString()]);

    console.log(`[SMS] 向 ${phone} 发送注册验证码: ${code}`);

    res.json({ code: 200, msg: '验证码已发送', data: { dev_code: code } });
});

// 商户忘记密码（发送验证码）
router.post('/merchant/forgot-send-code', (req, res) => {
    const { phone } = req.body;
    if (!phone) {
        return res.json({ code: 400, msg: '请输入手机号' });
    }

    const merchant = queryOne('SELECT id FROM merchants WHERE phone = ?', [phone]);
    if (!merchant) {
        return res.json({ code: 404, msg: '该手机号未注册' });
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    runSql('DELETE FROM sms_codes WHERE phone = ? AND type = ?', [phone, 'forgot']);
    runSql('INSERT INTO sms_codes (phone, code, type, expires_at) VALUES (?, ?, ?, ?)',
        [phone, code, 'forgot', expiresAt.toISOString()]);

    console.log(`[SMS] 向 ${phone} 发送重置密码验证码: ${code}`);

    res.json({ code: 200, msg: '验证码已发送', data: { dev_code: code } });
});

// 商户重置密码
router.post('/merchant/reset-password', (req, res) => {
    const { phone, code, newPassword } = req.body;
    if (!phone || !code || !newPassword) {
        return res.json({ code: 400, msg: '请填写完整信息' });
    }

    const smsRecord = queryOne(
        "SELECT * FROM sms_codes WHERE phone = ? AND code = ? AND type = 'forgot' AND used = 0 AND expires_at > datetime('now')",
        [phone, code]
    );

    if (!smsRecord) {
        return res.json({ code: 401, msg: '验证码无效或已过期' });
    }

    runSql('UPDATE sms_codes SET used = 1 WHERE id = ?', [smsRecord.id]);

    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    runSql('UPDATE merchants SET password = ? WHERE phone = ?', [hashedPassword, phone]);

    res.json({ code: 200, msg: '密码重置成功' });
});

// 商户修改密码（需登录）
router.post('/merchant/change-password', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.json({ code: 401, msg: '请先登录' });
    }

    try {
        const jwt = require('jsonwebtoken');
        const { JWT_SECRET } = require('../config');
        const decoded = jwt.verify(authHeader.substring(7), JWT_SECRET);
        
        if (decoded.role !== 'merchant') {
            return res.json({ code: 403, msg: '权限不足' });
        }

        const { oldPassword, newPassword } = req.body;
        if (!oldPassword || !newPassword) {
            return res.json({ code: 400, msg: '请填写完整信息' });
        }

        const merchant = queryOne('SELECT * FROM merchants WHERE id = ?', [decoded.id]);
        if (!merchant) {
            return res.json({ code: 404, msg: '账号不存在' });
        }

        if (!bcrypt.compareSync(oldPassword, merchant.password)) {
            return res.json({ code: 401, msg: '原密码错误' });
        }

        const hashedPassword = bcrypt.hashSync(newPassword, 10);
        runSql('UPDATE merchants SET password = ? WHERE id = ?', [hashedPassword, decoded.id]);

        res.json({ code: 200, msg: '密码修改成功' });
    } catch (e) {
        return res.json({ code: 401, msg: '登录已过期' });
    }
});

// 设备二维码生成接口（商户扫码添加设备时调用）
router.post('/device/register', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.json({ code: 401, msg: '请先登录' });
    }

    try {
        const jwt = require('jsonwebtoken');
        const { JWT_SECRET } = require('../config');
        const decoded = jwt.verify(authHeader.substring(7), JWT_SECRET);
        
        const { device_id, imei, token, cookie, model, port_count, location } = req.body;
        
        if (!device_id || !imei) {
            return res.json({ code: 400, msg: '设备信息不完整' });
        }

        // 检查IMEI是否已被其他商户绑定
        const existing = queryOne('SELECT id, merchant_id FROM chargers WHERE imei = ?', [imei]);
        if (existing) {
            return res.json({ code: 400, msg: '该设备已被其他商户绑定' });
        }

        // 创建充电桩记录
        const chargerResult = runSql(
            'INSERT INTO chargers (merchant_id, device_id, imei, name, model, port_count, platform_token, platform_cookie, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [decoded.id, device_id, imei, `充电桩${device_id}`, model || '10port', port_count || 10, token || '', cookie || '', location || '']
        );

        const chargerId = chargerResult.lastInsertRowid;

        // 创建端口记录
        const ports = [];
        for (let i = 1; i <= (port_count || 10); i++) {
            runSql('INSERT INTO ports (charger_id, port_number, status) VALUES (?, ?, ?)', [chargerId, i, 'idle']);
            ports.push({ port_number: i, status: 'idle' });
        }

        res.json({ code: 200, msg: '设备绑定成功', data: { charger_id: chargerId, ports } });
    } catch (e) {
        return res.json({ code: 401, msg: '登录已过期' });
    }
});

module.exports = router;