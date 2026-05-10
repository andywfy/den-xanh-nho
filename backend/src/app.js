const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDatabase } = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 静态文件（前端页面）
app.use(express.static(path.join(__dirname, '..', 'public')));

// API路由（数据库初始化后才注册）
function setupRoutes() {
    app.use('/api/auth', require('./routes/auth'));
    app.use('/api/charger', require('./routes/charger'));
    app.use('/api/order', require('./routes/order'));
    app.use('/api/merchant', require('./routes/merchant'));
    app.use('/api/admin', require('./routes/admin'));

    // 健康检查
    app.get('/api/health', (req, res) => {
        res.json({ code: 200, msg: 'OK', time: new Date().toISOString() });
    });

    // 错误处理
    app.use((err, req, res, next) => {
        console.error('[Error]', err.message);
        res.status(500).json({ code: 500, msg: '服务器内部错误' });
    });
}

// 启动服务
async function start() {
    await initDatabase();
    setupRoutes();

    if (require.main === module) {
        app.listen(PORT, () => {
            console.log(`
=========================================
  小蓝灯充电桩管理系统 后端服务
  端口: ${PORT}
  环境: ${process.env.NODE_ENV || 'development'}
  API: http://localhost:${PORT}/api/health
=========================================
            `);
        });
    }
}

start().catch(err => {
    console.error('启动失败:', err);
    process.exit(1);
});

module.exports = app;
