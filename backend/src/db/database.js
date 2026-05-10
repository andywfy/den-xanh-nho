const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.VERCEL
    ? path.join('/tmp', 'charger.db')
    : path.join(__dirname, '..', '..', 'data', 'charger.db');

let db = null;

function saveDb() {
    if (db) {
        const data = db.export();
        const buffer = Buffer.from(data);
        const dataDir = path.dirname(DB_PATH);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        fs.writeFileSync(DB_PATH, buffer);
    }
}

// 初始化并返回数据库实例
async function initDatabase() {
    const SQL = await initSqlJs();
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    if (fs.existsSync(DB_PATH)) {
        const buffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(buffer);
    } else {
        db = new SQL.Database();
    }

    // 管理员表
    db.run(`
        CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            name TEXT,
            role TEXT DEFAULT 'admin',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 商户表（修改：phone为登录名）
    db.run(`
        CREATE TABLE IF NOT EXISTS merchants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            name TEXT NOT NULL,
            zalo_id TEXT,
            status TEXT DEFAULT 'pending',
            balance INTEGER DEFAULT 0,
            frozen_balance INTEGER DEFAULT 0,
            commission_rate REAL DEFAULT 0.1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 充电桩设备表
    db.run(`
        CREATE TABLE IF NOT EXISTS chargers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            merchant_id INTEGER NOT NULL,
            device_id TEXT NOT NULL,
            imei TEXT NOT NULL UNIQUE,
            name TEXT,
            model TEXT DEFAULT '10port',
            port_count INTEGER DEFAULT 10,
            platform_token TEXT,
            platform_cookie TEXT,
            status TEXT DEFAULT 'online',
            location TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (merchant_id) REFERENCES merchants(id)
        )
    `);

    // 充电端口表
    db.run(`
        CREATE TABLE IF NOT EXISTS ports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            charger_id INTEGER NOT NULL,
            port_number INTEGER NOT NULL,
            status TEXT DEFAULT 'idle',
            current_order_id INTEGER,
            FOREIGN KEY (charger_id) REFERENCES chargers(id),
            UNIQUE(charger_id, port_number)
        )
    `);

    // 订单表
    db.run(`
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_no TEXT UNIQUE NOT NULL,
            merchant_id INTEGER NOT NULL,
            charger_id INTEGER NOT NULL,
            port_number INTEGER NOT NULL,
            user_phone TEXT NOT NULL,
            duration INTEGER NOT NULL,
            amount INTEGER NOT NULL,
            payment_status TEXT DEFAULT 'pending',
            charge_status TEXT DEFAULT 'waiting',
            sepay_transaction_id TEXT,
            payment_time DATETIME,
            charge_start_time DATETIME,
            charge_end_time DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (merchant_id) REFERENCES merchants(id),
            FOREIGN KEY (charger_id) REFERENCES chargers(id)
        )
    `);

    // 提现申请表
    db.run(`
        CREATE TABLE IF NOT EXISTS withdrawals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            merchant_id INTEGER NOT NULL,
            amount INTEGER NOT NULL,
            bank_account TEXT,
            bank_name TEXT,
            account_holder TEXT,
            status TEXT DEFAULT 'pending',
            admin_note TEXT,
            processed_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (merchant_id) REFERENCES merchants(id)
        )
    `);

    // 短信验证码表
    db.run(`
        CREATE TABLE IF NOT EXISTS sms_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT NOT NULL,
            code TEXT NOT NULL,
            type TEXT DEFAULT 'login',
            used INTEGER DEFAULT 0,
            expires_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 设备二维码配置表（存储扫码添加设备的信息）
    db.run(`
        CREATE TABLE IF NOT EXISTS device_configs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT,
            imei TEXT,
            token TEXT,
            cookie TEXT,
            model TEXT,
            port_count INTEGER,
            extra_data TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 创建索引
    db.run(`CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_orders_charger ON orders(charger_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_orders_order_no ON orders(order_no)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_chargers_merchant ON chargers(merchant_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_chargers_imei ON chargers(imei)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_withdrawals_merchant ON withdrawals(merchant_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sms_codes_phone ON sms_codes(phone)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_device_configs_imei ON device_configs(imei)`);

    // 创建默认管理员
    const adminCheck = db.exec("SELECT id FROM admins WHERE username = 'admin'");
    if (adminCheck.length === 0 || adminCheck[0].values.length === 0) {
        const hashedPassword = bcrypt.hashSync('admin123', 10);
        db.run("INSERT INTO admins (username, password, name, role) VALUES (?, ?, ?, ?)",
            ['admin', hashedPassword, '系统管理员', 'superadmin']);
    }

    // 创建测试商户（手机号+密码登录）
    const merchantCheck = db.exec("SELECT id FROM merchants WHERE phone = '0909123456'");
    if (merchantCheck.length === 0 || merchantCheck[0].values.length === 0) {
        const hashedPwd = bcrypt.hashSync('123456', 10);
        db.run("INSERT INTO merchants (phone, password, name, status, balance) VALUES (?, ?, ?, ?, ?)",
            ['0909123456', hashedPwd, '测试商户A', 'active', 0]);
        
        // 创建测试充电桩（10口）- 使用真实平台配置
        db.run("INSERT INTO chargers (merchant_id, device_id, imei, name, model, port_count, platform_token, platform_cookie, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [1, '79490', '862741082710969', '测试充电桩01', '10port', 10, '179fcc11-c075-43fa-979b-5e9be8e732c3', 'token=179fcc11-c075-43fa-979b-5e9be8e732c3; MOBILE=306b8151-8d38-4104-a239-c434038f33f7', '河内市西湖区']);
        
        // 创建10个端口
        for (let i = 1; i <= 10; i++) {
            db.run("INSERT INTO ports (charger_id, port_number, status) VALUES (?, ?, ?)", [1, i, 'idle']);
        }
    }

    saveDb();
    console.log('[DB] 数据库初始化完成');
    return db;
}

// 获取数据库（同步，需先调用initDatabase）
function getDb() {
    if (!db) {
        throw new Error('数据库未初始化，请先调用 initDatabase()');
    }
    return db;
}

// 查询所有行，返回对象数组
function queryAll(sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    const results = [];
    while (stmt.step()) {
        results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
}

// 查询单行
function queryOne(sql, params = []) {
    const results = queryAll(sql, params);
    return results.length > 0 ? results[0] : null;
}

// 执行写操作（INSERT/UPDATE/DELETE）
function runSql(sql, params = []) {
    db.run(sql, params);
    const lastId = db.exec("SELECT last_insert_rowid() as id");
    const changes = db.getRowsModified();
    saveDb();
    return {
        lastInsertRowid: lastId[0] ? lastId[0].values[0][0] : 0,
        changes: changes
    };
}

// 定期自动保存
setInterval(() => { saveDb(); }, 30000);
process.on('exit', saveDb);
process.on('SIGINT', () => { saveDb(); process.exit(); });
process.on('SIGTERM', () => { saveDb(); process.exit(); });

module.exports = { getDb, initDatabase, saveDb, queryAll, queryOne, runSql };