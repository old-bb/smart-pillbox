# -*- coding: utf-8 -*-
"""
智药云联 · 硬件端配置

所有需要按实际情况改的东西都集中在这个文件里。
"""

import os

# ══════════════════════════════════════════════════════════════
#  运行模式
# ══════════════════════════════════════════════════════════════

# True  = 模拟模式。不碰真实硬件，用打印代替点灯/响铃/播报。
#         元件没到货时用它开发逻辑，也能给老师演示完整流程。
# False = 真实模式。走 GPIO 和音频设备。
#
# 也可以用环境变量覆盖：ZHIHYAO_MOCK=0 python3 main.py
USE_MOCK = os.environ.get('ZHIHYAO_MOCK', '1') != '0'


# ══════════════════════════════════════════════════════════════
#  本机密钥文件
# ══════════════════════════════════════════════════════════════
#
# secret.json 存本机专有的凭证，已在 .gitignore 里，不会进仓库。
#
#     {"appsecret": "小程序AppSecret", "devicetoken": "设备令牌"}
#
# 两个值都不是必须写在同一个文件里 —— 也可以用环境变量给。

_SECRET_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'secret.json')
_SECRET = {}
if os.path.exists(_SECRET_FILE):
    try:
        import json as _json
        with open(_SECRET_FILE, encoding='utf-8') as _f:
            _loaded = _json.load(_f)
        if isinstance(_loaded, dict):
            _SECRET = _loaded
        else:
            print(f'[配置] {_SECRET_FILE} 的内容不是 JSON 对象，已忽略')
    except ValueError as e:
        # 把「文件存在但坏了」和「文件不存在」区分开 ——
        # 前者会让配置静默失效，必须让用户看见
        print(f'[配置] 读不了 {_SECRET_FILE}：{e}')
        print('       文件格式不对，设备会退到本地运行模式（数据不上报）')
    except OSError as e:
        print(f'[配置] 打不开 {_SECRET_FILE}：{e}')


# ══════════════════════════════════════════════════════════════
#  设备身份
# ══════════════════════════════════════════════════════════════

# 药盒编号。要和云端 devices 集合里的 deviceId 一致
DEVICE_ID = os.environ.get('ZHIHYAO_DEVICE_ID', 'BOX-TEST01')

# 设备上报用的令牌。必须和云函数的 DEVICE_TOKEN 环境变量一致。
#
# ⚠️ 这里【故意没有默认值】。
#
# 原先默认是 'zhihyao-dev-token'，但本仓库是公开的 —— 等于把线上凭证
# 写在明面上，任何人克隆仓库就能伪造服药记录、读取用药计划。
# 所以现在改成：没配置就不上报（进程会打印醒目提示）。
#
# 配置方法（二选一）：
#   1. secret.json 里加 "devicetoken": "xxx"
#   2. 环境变量 ZHIHYAO_DEVICE_TOKEN
#
# 云函数那边也要设：云开发控制台 → 三个设备接口函数（record / device / plan）
# → 配置 → 环境变量 → DEVICE_TOKEN = 同样的值
DEVICE_TOKEN = (os.environ.get('ZHIHYAO_DEVICE_TOKEN')
                or _SECRET.get('devicetoken', ''))


# ══════════════════════════════════════════════════════════════
#  云端对接
# ══════════════════════════════════════════════════════════════
#
# 两种方式，程序自动选：
#
#   方式一（推荐）：服务端 API —— 直接调云函数，不需要 HTTP 网关。
#                   免费、免域名、免备案，免费环境就能用。
#                   需要填 WX_APPSECRET。
#
#   方式二：HTTP 访问服务 —— 需要云开发环境的 HTTP 网关。
#           当前免费体验版控制台里没有这个入口，暂时用不了。
#           等以后能用了，把 CLOUD_BASE_URL 填上即可自动切换。
#
# 两者都不填 → 程序进入本地运行模式，数据不上传（调试时能用）

# 小程序 AppID。不是机密（任何人用你们的小程序都能看到）
WX_APPID = os.environ.get('ZHIHYAO_APPID', 'wx397363c4f4b4151d')

# 云开发环境 ID。也不是机密，写在小程序代码里
CLOUD_ENV = os.environ.get('ZHIHYAO_ENV', 'cloud1-d4gkyr16k10bd7e23')

# ⚠️ AppSecret 是小程序的最高权限钥匙，绝不能提交到 git。
#    填法（二选一）：
#      1. secret.json 里加 "appsecret": "xxx"
#      2. 环境变量 ZHIHYAO_APPSECRET
WX_APPSECRET = (os.environ.get('ZHIHYAO_APPSECRET')
                or _SECRET.get('appsecret', ''))

# 方式二用：HTTP 访问服务的公网地址。留空则走方式一
CLOUD_BASE_URL = os.environ.get('ZHIHYAO_CLOUD_URL', '')

# 方式二用：各功能对应的云函数路径
CLOUD_PATHS = {
    'record': 'record',      # 上报服药事件
    'device': 'device',      # 心跳、药仓配置
    'plan':   'plan',        # 拉取用药计划
}

# 单次 HTTP 请求超时（秒）
HTTP_TIMEOUT = 8

# 上报失败时的重试次数
HTTP_RETRY = 3


# ══════════════════════════════════════════════════════════════
#  GPIO 引脚
# ══════════════════════════════════════════════════════════════
#
# 🔴 下面的编号是【占位值】，必须按官方引脚表改！
#
#    Orange Pi 4 Pro 的 40-pin 定义和树莓派【不一样】，
#    接错 5V 会直接烧板子。
#
# ── 编号规则 ──────────────────────────────────────────────
#
#    统一填【全局 GPIO 号】，也就是官方手册 40-pin 表格里
#    「GPIO序号」那一列。它同时就是 sysfs 用的编号。
#
#    公式：全局号 = 端口组号 × 32 + 索引
#          组号 PA=0  PB=1  PC=2  PD=3  PE=4  PF=5
#               PG=6  PH=7  PI=8  PJ=9  PK=10 PL=11
#
#          例：PB3 = 1×32+3 = 35
#              PD0 = 3×32+0 = 96
#              PL4 = 11×32+4 = 356
#
# ── 去哪拿这张表 ──────────────────────────────────────────
#
#    官方用户手册《OrangePi 4 Pro A733 User Manual》，
#    第 3.18 节（40 Pin 接口测试）里有完整的物理引脚 ↔ GPIO序号 对照。
#    中文版在 orangepi.cn 的 Wiki 上。
#
# ⚠️ 注意 40-pin 的引脚【横跨两块芯片】（PB3=35 在 gpiochip0，
#    PL4=356 在 gpiochip1）。程序会自动判断引脚在哪块芯片上，
#    所以这里只管填全局号就行，不用管芯片。
#
# 接线前先跑 tools/test_gpio.py 验证 —— 见 README 第五节。

# ── 引脚分配（依据官方 40-pin 对照表）──────────────────────
#
# 下表是官方手册里的 40-pin 定义，我们挑了没被固定功能占用的引脚。
#
#   ⚠️ 标注了 PWM/TWI/SPI 的引脚，在那些功能**没启用**时就是普通 GPIO。
#      Armbian 默认不启用这些复用功能，所以可以用。
#      如果某个引脚死活不响应，多半是被复用占了 —— 换一个候选。
#
#   物理脚  芯片    全局号   用途
#   ─────────────────────────────────────────────
#     29    PD0      96     1号仓 LED
#     31    PD1      97     2号仓 LED
#     33    PD2      98     3号仓 LED
#     35    PD3      99     4号仓 LED
#     37    PD4     100     5号仓 LED
#     38    PD7     103     6号仓 LED
#     12    PL8     360     1号仓 霍尔
#     13    PL12    364     2号仓 霍尔
#     15    PK24    344     3号仓 霍尔
#     16    PL5     357     4号仓 霍尔
#     18    PK25    345     5号仓 霍尔
#     22    PD23    119     6号仓 霍尔
#     24    PE12    140     蜂鸣器
#     40    PL13    365     确认按键
#
#   GND 用 6/9/14/20/25/30/34/39 任意一个
#
# ⚠️ 全部要实测验证 —— 接一个 LED 试一个：
#      python3 tools/test_gpio.py blink 96

# 药仓 LED：每个药仓一颗。索引 0..5 对应 1..6 号仓
LED_PINS = [96, 97, 98, 99, 100, 103]

# 蜂鸣器（有源）
BUZZER_PIN = 140

# 确认按键
BUTTON_PIN = 365

# 药仓开盖检测（霍尔传感器 A3144E）。索引 0..5 对应 1..6 号仓
# ⚠️ A3144E 是【单极】霍尔，只对特定磁极响应。装的时候要试磁铁方向
# ⚠️ A3144E 最低工作电压 4.5V，VCC 接 5V；OUT 串 10kΩ 上拉到 3.3V 再接 GPIO
LID_PINS = [360, 364, 344, 357, 345, 119]

# 霍尔传感器的有效电平。开盖时读到 True 还是 False，取决于接线
# （A3144E 是开漏输出，磁铁靠近时拉低电平 → 这里填 True）
LID_ACTIVE_LOW = True

# 实际使用的药仓数量（基础版 4，专业版 6）
BAY_COUNT = 6


# ══════════════════════════════════════════════════════════════
#  摄像头
# ══════════════════════════════════════════════════════════════

CAMERA_DEVICE = int(os.environ.get('ZHIHYAO_CAMERA', '0'))
CAMERA_WIDTH = 640
CAMERA_HEIGHT = 480

# 拍一张之后要等多久让画面稳定（秒）
CAMERA_WARMUP = 1.5


# ══════════════════════════════════════════════════════════════
#  音频
# ══════════════════════════════════════════════════════════════

# 语音合成。留空则自动探测：espeak-ng → espeak → 都没有就不出声
TTS_COMMAND = os.environ.get('ZHIHYAO_TTS', 'espeak-ng')

# 语速（espeak 的字/分钟）。计划书要求 120~150，取中间值
TTS_SPEED = 135

# 预录语音目录。如果这里存在对应文件，优先播放录音而不是合成，
# 音质更好也更像真人 —— 对应计划书里的 DFPlayer 方案
VOICE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'voices')


# ══════════════════════════════════════════════════════════════
#  业务参数
# ══════════════════════════════════════════════════════════════

# 心跳间隔（秒）。必须小于云端的在线判定窗口（5 分钟），
# 否则会出现"设备活着但显示离线"的误报
HEARTBEAT_INTERVAL = 180     # 3 分钟

# 从云端拉取用药计划的间隔（秒）
PLAN_SYNC_INTERVAL = 600     # 10 分钟

# 到点后提醒持续多久（秒），超时未确认则本地判定为漏服
REMIND_TIMEOUT = 120         # 2 分钟，与云端 GRACE_MINUTES 保持一致

# 提醒时蜂鸣器响多久、隔多久响一次
BEEP_DURATION_MS = 500
BEEP_GAP_SECONDS = 5

# 时区偏移（北京时间为 UTC+8）
TZ_OFFSET_HOURS = 8
