#!/usr/bin/env bash
# 把 astudio-qr-modal.js 装进正在运行的 agent2api 容器（可重复执行）。
#
#   sudo bash install.sh            # 安装 / 重新安装
#   sudo bash install.sh uninstall  # 卸载（恢复 index.html 并删掉脚本）
#
# 镜像升级（docker compose pull / 重建容器）会覆盖 /app/ui，升级后要再执行一次。
set -eo pipefail

CONTAINER="$(printenv CONTAINER || true)"
[ -n "$CONTAINER" ] || CONTAINER=agent2api
FILE="astudio-qr-modal.js"
HERE="$(cd "$(dirname "$0")" && pwd)"
ACTION="$1"
[ -n "$ACTION" ] || ACTION=install

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "找不到容器 $CONTAINER" >&2
  exit 1
fi

if [ "$ACTION" = "uninstall" ]; then
  docker exec "$CONTAINER" sh -c '
    cd /app/ui
    if [ -f index.html.a2a-orig ]; then mv index.html.a2a-orig index.html; fi
    rm -f astudio-qr-modal.js
  '
  echo "已卸载。"
  exit 0
fi

docker cp "$HERE/$FILE" "$CONTAINER:/app/ui/$FILE"

docker exec "$CONTAINER" sh -c '
  cd /app/ui
  if grep -q "astudio-qr-modal.js" index.html; then
    echo "index.html 里已有脚本标签，跳过注入"
    exit 0
  fi
  [ -f index.html.a2a-orig ] || cp index.html index.html.a2a-orig
  sed -i "s#</body>#  <script src=\"astudio-qr-modal.js\"></script>\n</body>#" index.html
  echo "已注入："
  grep -n "astudio-qr-modal" index.html
'

echo "完成。浏览器强制刷新（Ctrl/Cmd+Shift+R）后，扫码登录会以面板内弹窗显示二维码。"
