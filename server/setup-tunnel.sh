#!/bin/bash
# Cloudflare Tunnel 一键设置脚本
# 使用：bash setup-tunnel.sh
# 前置条件：cloudflared tunnel login 已完成

set -e

CLOUDFLARED="/Users/fox/.local/bin/cloudflared"
TUNNEL_NAME="gasms-api"
DOMAIN="api.gasms.cn"
LOCAL_PORT="3001"
CONFIG_DIR="$HOME/.cloudflared"

echo "🔧 步骤1: 创建隧道..."
$CLOUDFLARED tunnel create $TUNNEL_NAME

# 获取凭据文件路径
CRED_FILE=$(ls $CONFIG_DIR/*.json 2>/dev/null | head -1)
if [ -z "$CRED_FILE" ]; then
  echo "❌ 未找到凭据文件，请先运行 cloudflared tunnel login"
  exit 1
fi

echo "📝 步骤2: 创建配置文件..."
cat > $CONFIG_DIR/config.yml << EOF
tunnel: $TUNNEL_NAME
credentials-file: $CRED_FILE
ingress:
  - hostname: $DOMAIN
    service: http://localhost:${LOCAL_PORT}
  - service: http_status:404
EOF

echo "🌐 步骤3: 配置DNS..."
$CLOUDFLARED tunnel route dns $TUNNEL_NAME $DOMAIN

echo "🚀 步骤4: 启动隧道（PM2守护）..."
pm2 delete $TUNNEL_NAME 2>/dev/null || true
pm2 start $CLOUDFLARED --name $TUNNEL_NAME -- tunnel run $TUNNEL_NAME
pm2 save

echo ""
echo "✅ 完成！等待DNS生效..."
echo "   服务地址: https://$DOMAIN"
echo "   健康检查: https://$DOMAIN/api/health"
echo ""
echo "📋 管理命令:"
echo "   pm2 status          — 查看状态"
echo "   pm2 logs $TUNNEL_NAME — 查看日志"
echo "   pm2 restart $TUNNEL_NAME — 重启隧道"
