#!/bin/bash
# Orange Pi 4 Pro 硬件体检
#
# 用途：装完系统后跑一次，确认平台可用，再往下做。
# 每一节独立执行，某一项失败不会影响后面的检查。
#
# 用法：
#   bash check_hardware.sh

line() { echo "──────────────────────────────────────────────"; }
sec()  { echo; line; echo "  $1"; line; }
ok()   { echo "  [OK]   $1"; }
bad()  { echo "  [!!]   $1"; }
info() { echo "         $1"; }

echo
echo "  智药云联 · Orange Pi 4 Pro 硬件体检"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"

# ── 1. 系统 ────────────────────────────────────────────
sec "1. 系统与硬件"
if [ -f /proc/device-tree/model ]; then
  info "型号：$(tr -d '\0' < /proc/device-tree/model)"
fi
info "内核：$(uname -r)"
info "架构：$(uname -m)"
[ -f /etc/os-release ] && info "系统：$(grep PRETTY_NAME /etc/os-release | cut -d'"' -f2)"
info "$(free -h | awk '/Mem:/{print "内存：总计 "$2"，可用 "$7}')"
info "$(df -h / | awk 'NR==2{print "存储：总计 "$2"，已用 "$3"，可用 "$4}')"

MEM_MB=$(free -m | awk '/Mem:/{print $2}')
if [ "$MEM_MB" -ge 4000 ]; then
  ok "内存 ${MEM_MB}MB，跑 OpenCV 视觉处理没问题"
else
  bad "内存只有 ${MEM_MB}MB，跑视觉算法会吃紧"
fi

# ── 2. GPIO ────────────────────────────────────────────
sec "2. GPIO 子系统"
if command -v gpiodetect >/dev/null 2>&1; then
  gpiodetect 2>/dev/null | while read -r l; do info "$l"; done
  N=$(gpioinfo 2>/dev/null | grep -c "^	line")
  ok "libgpiod 可用，检测到 ${N} 条 GPIO 线"
  info "提示：A733 引脚定义与树莓派不同，接线前务必对照官方引脚图"
else
  bad "libgpiod 未安装，执行：sudo apt install -y gpiod"
fi

# ── 3. USB 摄像头（最关键的一项）───────────────────────
sec "3. USB 摄像头"
VIDS=$(ls /dev/video* 2>/dev/null)
if [ -n "$VIDS" ]; then
  ok "找到视频设备：$(echo $VIDS | tr '\n' ' ')"
  if command -v v4l2-ctl >/dev/null 2>&1; then
    for v in $VIDS; do
      NAME=$(v4l2-ctl -d "$v" --info 2>/dev/null | grep "Card type" | cut -d: -f2- | sed 's/^ *//')
      [ -n "$NAME" ] && info "$v → $NAME"
    done
    # 试着抓一帧，这是真正的验证
    if timeout 15 v4l2-ctl -d /dev/video0 --set-fmt-video=width=640,height=480,pixelformat=MJPG \
        --stream-mmap --stream-count=1 --stream-to=/tmp/_probe.jpg >/dev/null 2>&1 \
       && [ -s /tmp/_probe.jpg ]; then
      ok "成功抓取一帧 → /tmp/_probe.jpg ($(du -h /tmp/_probe.jpg | cut -f1))"
    else
      bad "能识别设备但抓帧失败，可能是权限或格式问题"
      info "试试：sudo usermod -aG video $USER 然后重新登录"
    fi
    rm -f /tmp/_probe.jpg
  else
    info "装 v4l-utils 可查看详细信息：sudo apt install -y v4l-utils"
  fi
else
  bad "没有找到 /dev/video*，摄像头可能没插好或没被识别"
  info "插好后跑：lsusb   看看设备在不在"
fi
info "$(lsusb 2>/dev/null | wc -l) 个 USB 设备已连接"

# ── 4. 音频 ────────────────────────────────────────────
sec "4. 音频输入输出"
if command -v arecord >/dev/null 2>&1; then
  REC=$(arecord -l 2>/dev/null | grep -c "^card")
  PLAY=$(aplay -l 2>/dev/null | grep -c "^card")
  [ "$REC" -gt 0 ] && ok "录音设备 ${REC} 个（板载麦克风）" || bad "没有录音设备"
  [ "$PLAY" -gt 0 ] && ok "放音设备 ${PLAY} 个" || bad "没有放音设备"
else
  bad "alsa-utils 未安装，执行：sudo apt install -y alsa-utils"
fi
info "注意：3.5mm 是 line-out，接无源喇叭没声音，要接有源音箱或耳机"

# ── 5. Python 环境 ─────────────────────────────────────
sec "5. Python 与关键库"
if command -v python3 >/dev/null 2>&1; then
  ok "Python $(python3 --version 2>&1 | cut -d' ' -f2)"
  python3 -c "import cv2; print('  [OK]   OpenCV', cv2.__version__)" 2>/dev/null \
    || bad "OpenCV 未安装：sudo apt install -y python3-opencv"
  python3 -c "import numpy; print('  [OK]   NumPy', numpy.__version__)" 2>/dev/null \
    || bad "NumPy 未安装：sudo apt install -y python3-numpy"
else
  bad "没有 python3"
fi
info "建议用 apt 装 OpenCV 而不是 pip —— ARM 架构下 pip 经常没有预编译包"

# ── 6. 网络与温度 ──────────────────────────────────────
sec "6. 网络与温度"
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -n "$IP" ] && ok "本机 IP：$IP" || bad "没拿到 IP"
if ping -c1 -W2 www.baidu.com >/dev/null 2>&1; then
  ok "外网连通"
else
  info "外网不通（可能是校园网需要认证，不影响本地开发）"
fi

TEMP=$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null)
if [ -n "$TEMP" ]; then
  C=$((TEMP / 1000))
  if [ "$C" -ge 70 ]; then
    bad "CPU 温度 ${C}°C，偏高，检查散热片和风扇是否装好"
  else
    ok "CPU 温度 ${C}°C"
  fi
fi
info "跑推理时温度会明显上升，注意观察是否降频"

# ── 汇总 ───────────────────────────────────────────────
sec "体检完成"
echo "  把上面完整输出复制发回，我来判断平台是否可用。"
echo
echo "  如果缺依赖，先跑这条一次性装齐："
echo "    sudo apt update && sudo apt install -y \\"
echo "      python3-opencv python3-numpy gpiod v4l-utils alsa-utils"
echo
