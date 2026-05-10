const { v4: uuidv4 } = require('uuid');

/**
 * 生成订单号：DXN + 年月日时分秒 + 4位随机数
 */
function generateOrderNo() {
    const now = new Date();
    const dateStr = now.getFullYear().toString().slice(2) +
        String(now.getMonth() + 1).padStart(2, '0') +
        String(now.getDate()).padStart(2, '0') +
        String(now.getHours()).padStart(2, '0') +
        String(now.getMinutes()).padStart(2, '0') +
        String(now.getSeconds()).padStart(2, '0');
    const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `DXN${dateStr}${rand}`;
}

/**
 * 格式化金额（VND整数）
 */
function formatVND(amount) {
    return new Intl.NumberFormat('vi-VN').format(amount) + ' VND';
}

/**
 * 验证越南手机号格式
 */
function isValidVietnamPhone(phone) {
    // 越南手机号: 0开头 + 9或10位数字
    return /^0\d{8,9}$/.test(phone);
}

module.exports = { generateOrderNo, formatVND, isValidVietnamPhone };
