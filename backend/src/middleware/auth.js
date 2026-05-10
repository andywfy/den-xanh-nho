const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'xiaolandan_dev_secret_2024';

// 验证JWT Token
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ code: 401, msg: '未登录或Token已过期' });
    }

    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ code: 401, msg: 'Token无效或已过期' });
    }
}

// 验证管理员权限
function adminOnly(req, res, next) {
    if (req.user.role !== 'superadmin' && req.user.role !== 'admin') {
        return res.status(403).json({ code: 403, msg: '权限不足' });
    }
    next();
}

// 验证商户权限
function merchantOnly(req, res, next) {
    if (req.user.role !== 'merchant') {
        return res.status(403).json({ code: 403, msg: '权限不足' });
    }
    next();
}

// 生成Token
function generateToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

module.exports = { authMiddleware, adminOnly, merchantOnly, generateToken };
