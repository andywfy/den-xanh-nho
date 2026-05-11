#!/bin/bash
set -e

echo "========================================"
echo "  小蓝灯服务器部署脚本"
echo "========================================"

# 1. 更新系统
echo "[1/6] 更新系统..."
sudo apt-get update -y

# 2. 安装 Node.js 18.x
echo "[2/6] 安装 Node.js..."
if ! command -v node &> /dev/null || [ "$(node -v | cut -d'v' -f2 | cut -d'.' -f1)" != "18" ]; then
  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node.js 版本: $(node -v)"
echo "npm 版本: $(npm -v)"

# 3. 安装 PM2
echo "[3/6] 安装 PM2..."
sudo npm install -g pm2

# 4. 进入项目目录
echo "[4/6] 进入项目目录..."
cd "$(dirname "$0")"
PROJECT_DIR=$(pwd)
echo "项目目录: $PROJECT_DIR"

# 5. 安装依赖
echo "[5/6] 安装 npm 依赖..."
npm install

# 6. 启动服务
echo "[6/6] 启动服务..."
mkdir -p logs
pm2 delete den-xanh-nho 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u $(whoami) --hp $HOME

echo ""
echo "========================================"
echo "  部署完成！"
echo "========================================"
echo "API 地址: http://$(curl -s ifconfig.me):3000"
echo ""
echo "常用命令:"
echo "  pm2 status          查看运行状态"
echo "  pm2 logs            查看日志"
echo "  pm2 restart den-xanh-nho  重启服务"
echo "  pm2 stop den-xanh-nho     停止服务"
echo "========================================"
