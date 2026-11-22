#!/usr/bin/env bash
# 把面板补丁装进正在运行的 agent2api 容器（可重复执行）。
#
#   sudo bash install.sh            # 安装 / 重新安装
#   sudo bash install.sh uninstall  # 卸载（恢复 index.html 并删掉脚本）
#
# 默认装两个补丁：
#   astudio-qr-modal.js     微信二维码改成面板内弹窗（不再开新标签页）
#   astudio-sms-login.js    手机验证码登录改成面板内「手机号 + 极验滑块 + 验证码」
#
# astudio-usage-compact.js 在 agent2api:gov403-credits2-20261122 及更新的镜像上**不需要**：
# 新面板已原生把 windows/credits 画成 WorkBuddy 式胶囊 + 弹窗，脚本插件只要上报 credits
# 就有「7天 N」角标与「X 天后到期」标签（见 lib/usage.mjs）。老镜像若还要用它：
#   FILES_ALL=1 sudo bash install.sh
#
# 镜像升级（docker compose pull / 重建容器）会覆盖 /app/ui，升级后要再执行一次。
set -eo pipefail

CONTAINER="${CONTAINER:-agent2api}"
FILES="astudio-qr-modal.js astudio-sms-login.js"
if [ "${FILES_ALL:-0}" = "1" ]; then
  FILES="$FILES astudio-usage-compact.js"
fi
HERE="$(cd "$(dirname "$0")" && pwd)"
ACTION="${1:-install}"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "找不到容器 $CONTAINER" >&2
  exit 1
fi

if [ "$ACTION" = "uninstall" ]; then
  docker exec "$CONTAINER" sh -c '
    cd /app/ui
    if [ -f index.html.a2a-orig ]; then mv index.html.a2a-orig index.html; fi
    rm -f astudio-qr-modal.js astudio-sms-login.js astudio-usage-compact.js
  '
  echo "已卸载。"
  exit 0
fi

for FILE in $FILES; do
  docker cp "$HERE/$FILE" "$CONTAINER:/app/ui/$FILE"
done

# 逐个补 script 标签：已经有的跳过（幂等），第一个标签注入前先备份 index.html。
# 注意：整段用单引号，FILE 通过 -e 传进容器 —— 否则 sed 里的双引号会被外层 shell 吃掉，
# 注入成 <script src=astudio-sms-login.js></script>（能跑，但难看，也容易被别处误改）。
for FILE in $FILES; do
  docker exec -e FILE="$FILE" "$CONTAINER" sh -c '
    cd /app/ui
    if grep -q "$FILE" index.html; then
      echo "index.html 里已有 $FILE 的标签，跳过"
      exit 0
    fi
    [ -f index.html.a2a-orig ] || cp index.html index.html.a2a-orig
    sed -i "s#</body>#  <script src=\"$FILE\"></script>\n</body>#" index.html
    echo "已注入：$FILE"
  '
done

docker exec "$CONTAINER" sh -c 'grep -n "astudio-" /app/ui/index.html'
echo "完成。浏览器强制刷新（Ctrl/Cmd+Shift+R）后生效。"
