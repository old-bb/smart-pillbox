# 智药云联 · 硬件端

Orange Pi 4 Pro 上运行的药盒程序。负责**到点提醒、检测取药、上报云端**。

---

## 一、先看这里：没有元件也能跑

**这套代码默认是"模拟模式"** —— 不碰任何 GPIO，用打印代替点灯、响铃、播报。

元件还没到货也能：

- 验证整条逻辑跑不跑得通
- 给老师/组员演示完整流程
- 调云端对接

```bash
python3 main.py
```

跑起来后按键盘：

```
0~5   模拟第 N 号仓被打开取药（2 秒后自动合盖）
b     模拟按下确认键
q     退出
```

**等 B/C/D 元件到货，把 `config.py` 里的 `USE_MOCK` 改成 `False`，或者加 `--real` 参数，就切到真实硬件。**

---

## 二、文件结构

```
硬件端/
├── main.py            入口。命令行参数、环境自检、模拟控制台
├── config.py          ⭐ 所有要改的东西都在这里
├── hal.py             硬件抽象层。MockHardware / OrangePiHardware
├── scheduler.py       调度引擎。到点提醒、等确认、超时判漏服
├── cloud.py           云端通信。带断网重传队列
├── vision.py          药片计数（OpenCV）
├── test_logic.py      调度状态机测试（不需要元件）
├── test_transport.py  云端传输层测试（不碰网络）
├── secret.json        ⚠️ AppSecret，自己建，不入库
├── tools/
│   ├── test_gpio.py   ⭐ 接线前必跑，用来确认引脚编号
│   ├── test_camera.py 摄像头对焦与计数调参
│   └── test_cloud.py  ⭐ 云端连通性诊断，逐环排查
└── voices/            预录语音（可选）。bay1.wav、bay2.wav……
```

**设计要点**：业务逻辑只调用 `hal.py` 定义的接口，永远不直接碰 GPIO。所以换硬件平台、或者无元件开发，都只是换一个实现类的事。

---

## 三、部署到板子

### 1. 装依赖

```bash
sudo apt update
sudo apt install -y python3-opencv python3-numpy gpiod python3-libgpiod \
                    espeak-ng alsa-utils v4l-utils
```

### 2. 把代码传上去

在你自己的电脑上（不是板子上）执行：

```bash
scp -r 硬件端/ orangepi@<板子IP>:~/
```

或者用 FileZilla、WinSCP 这类图形工具拖过去。

### 3. 自检

```bash
cd ~/硬件端
python3 main.py --selftest
```

会把 Python、OpenCV、GPIO、摄像头、音频、云端配置逐项检查一遍。**哪一项是 ✗ 就先解决哪一项。**

### 4. 跑起来

```bash
python3 main.py
```

---

## 四、配置云端对接

不配置也能跑（纯本地，数据不上传）。要上报数据，**推荐走服务端 API**。

### 方式一（推荐）：服务端 API

直接调云函数，**不需要 HTTP 网关、不需要域名、不需要备案**，免费环境就能用。

**① 拿到 AppSecret**

小程序后台 → 「开发管理 → 开发设置」→ 复制 **AppSecret**

> ⚠️ AppSecret 只能完整查看一次，忘了就得重置。

**② 在云端设置设备令牌**

```
云开发控制台 → 云函数 → record / device / plan 三个函数
            → 配置 → 环境变量
            → 加一条：DEVICE_TOKEN = 一串足够长的随机字符
```

**三个函数都要设，值必须一样。**

> ⚠️ 这一步是必须的。云函数现在**没有默认令牌**了 ——
> 代码里写死的默认值会随公开仓库泄露，等于把线上凭证公开。
> 现在没设环境变量的话，设备请求一律被拒绝。

**③ 建一个 secret.json**（在 `硬件端/` 目录下）

```json
{
  "appsecret": "你复制的 AppSecret",
  "devicetoken": "刚才在云端设的那串随机字符"
}
```

> 🔒 这个文件**已经在 `.gitignore` 里**，不会被提交。
> 两个值也可以分别用环境变量 `ZHIHYAO_APPSECRET` / `ZHIHYAO_DEVICE_TOKEN` 提供。

**④ 跑诊断**

```bash
python3 tools/test_cloud.py
```

它会逐环检查：配置 → 取令牌 → 心跳 → 拉计划 → 上报通路。
**哪一环断了它会告诉你具体怎么修。**

### 方式二：HTTP 访问服务

需要环境的 HTTP 网关已配好。当前微信云开发的**免费体验版控制台里没有这个入口**，
所以暂时用不了 —— 等以后能用了，在 `config.py` 里填上 `CLOUD_BASE_URL` 就会自动切换。

```python
CLOUD_BASE_URL = 'https://<你的环境ID>.service.tcloudbase.com'
```

### 确认设备已绑定

`DEVICE_ID`（默认 `BOX-TEST01`）要和云端 `devices` 集合里的 `deviceId` 一致。
在小程序里绑定药盒时填的绑定码，云端会拼成 `BOX-<绑定码>`。

### ⚠️ 关于 AppSecret 的取舍

服务端 API 这条路要把 **AppSecret 放在设备上**。它是这个 AppID 的最高权限钥匙，
设备被拿走等于整个云开发环境被交出。

对原型的缓解措施：设备只在家用内网、定期更换 AppSecret。
**正式方案应是设备密钥签名验签 —— 这一点应当写进中期报告书的「存在问题」栏，不要藏着。**

### 断网了怎么办

`cloud.py` 会自动把没发出去的记录存到本地 `pending.json`，联网后补发。
老人家里断网是常事，服药记录不能因此丢掉。

**队列是服药记录在断网期间唯一的副本**，所以做得比较小心：

| 机制 | 为什么 |
|---|---|
| 原子写入（临时文件 + 改名） | 直接覆盖的话，写入中断电会留下半个文件，整队记录全丢 |
| 读到坏文件先备份再继续 | 不能静默当成空队列 —— 那样记录就无声消失了 |
| 分清「云端拒绝」和「网络不通」 | 网络抖动跟记录本身无关，不该因此丢掉它 |
| 瞬时错误按**时间**放弃（24 小时），不按**次数** | 心跳每 3 分钟触发一次补发，按次数算 24 分钟就把额度烧完了 |
| 放弃的记录存到 `pending_lost.json` | 只 print 一行的话没人看得见，留个文件供人工核对 |

---

## 五、接真实硬件

### ⚠️ 接线前必读

**Orange Pi 4 Pro 的 40-pin 和树莓派不一样，接错 5V 会直接烧板子。**

1. 去香橙派官网下载 **Orange Pi 4 Pro 的引脚定义图**
2. 用 `tools/test_gpio.py list` 打印出所有 GPIO 的 line number
3. 对照图纸，把 `config.py` 里的引脚编号换成真实的 line number
4. **先跑 `test_gpio.py blink <line>` 验一个引脚**，确认没问题再继续接

```bash
# 列出所有 GPIO
python3 tools/test_gpio.py list

# 试闪一个引脚（接好 LED + 限流电阻之后）
python3 tools/test_gpio.py blink 17

# 监视一个引脚（接好霍尔传感器之后）
python3 tools/test_gpio.py watch 27

# 依次点亮所有药仓 LED，确认顺序对不对
python3 tools/test_gpio.py scan
```

### 关键接线注意事项

| 元件 | 注意 |
|---|---|
| **LED** | 必须串限流电阻（150Ω 左右）。红黄绿用 150Ω，蓝白压降接近 3.3V 余量太小，不建议用 |
| **蜂鸣器** | 必须有源 + 模块版。散装 2 脚蜂鸣器 20~30mA，GPIO 推不动会烧引脚 |
| **霍尔 A3144E** | VCC 接 **5V**（最低工作电压 4.5V，3.3V 不工作）；OUT 串 **10kΩ 上拉到 3.3V** 再接 GPIO。**不要买"霍尔模块"成品板**，那种上拉到 5V 会打坏 GPIO |
| **钕磁铁** | A3144E 是**单极**霍尔，只对特定磁极响应。装的时候翻面试一下 |
| **按键** | 一端接 GPIO，一端接 GND，用内部上拉 |

### 调视觉参数

```bash
python3 tools/test_camera.py shot      # 先看能不能拍清
python3 tools/test_camera.py tune      # 交互式调参
python3 tools/test_camera.py compare   # 模拟一次取药前后的比对
```

调参时盯着 `debug_shots/` 里的 `*_bin.jpg` —— 药片应该是一个个干净的白块。

---

## 六、摄像头对焦问题（重要）

桌面摄像头是**定焦**的，设计工作距离 30cm 以上。放在药仓上方 10cm 会**失焦糊掉** —— 这是物理问题，换算法解决不了。

三个办法，按推荐顺序：

1. **换一个可调焦的 USB 摄像头模块**（¥40）。买之前问客服"最近对焦距离多少、能不能手动调焦"
2. **拆开现有摄像头**，里面镜头上有个对焦环，拧一下试试
3. **改用称重方案**（HX711 + 称重传感器，¥25）。这不是退而求其次 —— 对"还剩多少药"这个问题，称重比摄像头更成熟可靠，而且不受光照和对焦影响

先用 `test_camera.py shot` 拍一张判断。**能不能数清药片，决定走哪条路。**

---

## 七、故障排查

| 现象 | 原因与处理 |
|---|---|
| `摄像头打不开` | 被别的进程占用。`ps aux \| grep -E "ffmpeg\|cam.py"` 然后 kill 掉 |
| `找不到任何 GPIO 接口` | `sudo apt install -y python3-libgpiod gpiod` |
| 摄像头画面糊 | 对焦问题，见第六节 |
| `播报失败` | `sudo apt install -y espeak-ng alsa-utils` |
| 提醒不出来 | 检查云端有没有该药仓的**生效中**计划；或者用 `--test-bay 0` 手动演练 |
| 数据传不上云 | `python3 main.py --selftest` 看第 6 项；也可以先不管，程序会存本地队列 |

---

## 八、演示模式（答辩用）

不用等到点，启动就能演练一次提醒：

```bash
python3 main.py --test-bay 0
```

启动 2 秒后自动对 1 号仓走一遍完整流程：亮灯 → 播报 → 等取药 → 上报云端。

**演示时建议的画面**：一边是药盒亮灯播报，一边是手机上的小程序，取药后小程序里立刻出现新的服药记录。

---

## 九、和其他部分的关系

```
硬件端（本目录）                    云平台（../智药云联云平台/）
  scheduler.py  提醒与判定
  cloud.py      ──── HTTP ────▶     record 云函数     ──▶ 数据库
  vision.py     药片计数              plan 云函数      ──▶ 小程序
  hal.py        硬件接口              device 云函数
```
