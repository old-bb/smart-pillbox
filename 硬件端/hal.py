# -*- coding: utf-8 -*-
"""
硬件抽象层（HAL）

业务逻辑只调用这里定义的接口，永远不直接碰 GPIO。
这样带来两个好处：

  1. 元件没到货时，用 MockHardware 就能把整条逻辑跑通、给老师演示
  2. 换硬件平台（比如以后不用香橙派了）只需要再写一个实现类

接口清单：
    led_on(bay) / led_off(bay) / leds_off()   分仓指示灯
    beep(ms)                                   蜂鸣器
    speak(text, bay=None)                      语音播报
    is_lid_open(bay)                           药仓盖是否打开
    is_button_pressed()                        大按键是否按下
    snapshot()                                 抓一帧图像
"""

import os
import subprocess
import tempfile
import time

import config


# ══════════════════════════════════════════════════════════════
#  接口定义
# ══════════════════════════════════════════════════════════════

class Hardware:
    """硬件接口。业务代码只依赖这个接口。"""

    def led_on(self, bay):
        raise NotImplementedError

    def led_off(self, bay):
        raise NotImplementedError

    def leds_off(self):
        for i in range(config.BAY_COUNT):
            self.led_off(i)

    def beep(self, ms=config.BEEP_DURATION_MS):
        raise NotImplementedError

    def speak(self, text, bay=None):
        raise NotImplementedError

    def is_lid_open(self, bay):
        raise NotImplementedError

    def is_button_pressed(self):
        raise NotImplementedError

    def snapshot(self):
        """返回一张 BGR 图像（numpy 数组），失败返回 None"""
        raise NotImplementedError

    def cleanup(self):
        pass


# ══════════════════════════════════════════════════════════════
#  模拟实现 —— 元件没到货时用这个
# ══════════════════════════════════════════════════════════════

class MockHardware(Hardware):
    """
    不碰任何真实硬件，全部用打印代替。

    用法：跑起来之后，在终端里按数字键模拟"第 N 号仓被打开"，
    按 b 模拟按下确认键 —— 这样没有元件也能走完整流程。
    """

    def __init__(self, quiet=False):
        self._lids = [False] * config.BAY_COUNT
        self._button_once = False
        self._quiet = quiet
        if not quiet:
            print('[HAL] 模拟模式：不会真的点灯/响铃/播报')
            print('[HAL] 提示：程序运行后按 0-5 模拟开盖，按 b 模拟按确认键')

    def _say(self, msg):
        if not self._quiet:
            print(msg)

    def led_on(self, bay):
        self._say(f'  [LED] {bay + 1} 号仓亮起')

    def led_off(self, bay):
        self._say(f'  [LED] {bay + 1} 号仓熄灭')

    def beep(self, ms=config.BEEP_DURATION_MS):
        self._say(f'  [蜂鸣] {ms}ms')

    def speak(self, text, bay=None):
        tag = f'{bay + 1}号仓' if bay is not None else '通用'
        self._say(f'  [播报·{tag}] {text}')

    def is_lid_open(self, bay):
        return self._lids[bay] if 0 <= bay < config.BAY_COUNT else False

    def is_button_pressed(self):
        # 按键是一次性的：按一次返回一次 True，之后自动复位，
        # 模拟真实按键的"按下-松开"
        if self._button_once:
            self._button_once = False
            return True
        return False

    # ── 以下方法只在模拟模式下有 ──

    def simulate_lid(self, bay, opened):
        """手动设置某个药仓的开盖状态"""
        if 0 <= bay < config.BAY_COUNT:
            self._lids[bay] = opened

    def simulate_button(self):
        """模拟按一下确认键"""
        self._button_once = True

    def clear_lids(self):
        self._lids = [False] * config.BAY_COUNT


# ══════════════════════════════════════════════════════════════
#  真实实现 —— Orange Pi 4 Pro
# ══════════════════════════════════════════════════════════════

class OrangePiHardware(Hardware):
    """
    真实 GPIO + 音频 + 摄像头。

    GPIO 用 libgpiod。Debian 13 自带的是 v2 API，
    老系统可能是 v1，这里两种都兼容。
    """

    def __init__(self):
        self._gpio = _GpioBackend()
        self._gpio.setup_outputs(config.LED_PINS + [config.BUZZER_PIN])
        self._gpio.setup_inputs(
            [config.BUTTON_PIN] + config.LID_PINS,
            pull_up=True,
        )
        self._camera = None
        self._tts = _pick_tts()
        if self._tts:
            print(f'[HAL] 语音合成：{self._tts}')
        else:
            print('[HAL] 没找到语音合成工具，播报会被跳过')
            print('      安装：sudo apt install -y espeak-ng')

    # ── LED ──

    def led_on(self, bay):
        if 0 <= bay < len(config.LED_PINS):
            self._gpio.write(config.LED_PINS[bay], True)

    def led_off(self, bay):
        if 0 <= bay < len(config.LED_PINS):
            self._gpio.write(config.LED_PINS[bay], False)

    # ── 蜂鸣器 ──

    def beep(self, ms=config.BEEP_DURATION_MS):
        self._gpio.write(config.BUZZER_PIN, True)
        time.sleep(ms / 1000.0)
        self._gpio.write(config.BUZZER_PIN, False)

    # ── 语音播报 ──

    def speak(self, text, bay=None):
        # 优先播放预录语音：音质好、像真人，对应计划书里的 DFPlayer 方案
        rec = self._find_recording(bay)
        if rec:
            self._play_file(rec)
            return
        if not self._tts:
            return
        try:
            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
                wav = f.name
            self._tts_synthesize(text, wav)
            self._play_file(wav)
            os.unlink(wav)
        except Exception as e:
            print(f'[HAL] 播报失败：{e}')

    def _find_recording(self, bay):
        """找药仓对应的预录语音文件（voices/bay1.wav 这种）"""
        if bay is None:
            return None
        for ext in ('.wav', '.mp3'):
            p = os.path.join(config.VOICE_DIR, f'bay{bay + 1}{ext}')
            if os.path.exists(p):
                return p
        return None

    def _tts_synthesize(self, text, out_wav):
        cmd = [self._tts]
        if self._tts == 'espeak-ng':
            cmd += ['-v', 'zh', '-s', str(config.TTS_SPEED)]
        elif self._tts == 'espeak':
            cmd += ['-v', 'zh', '-s', str(config.TTS_SPEED)]
        cmd += ['-w', out_wav, text]
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)

    def _play_file(self, path):
        player = 'aplay' if path.endswith('.wav') else 'ffplay'
        cmd = [player, '-q', path] if player == 'aplay' else \
              [player, '-nodisp', '-autoexit', '-loglevel', 'quiet', path]
        subprocess.run(cmd, check=False, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)

    # ── 传感器 ──

    def is_lid_open(self, bay):
        if not (0 <= bay < len(config.LID_PINS)):
            return False
        v = self._gpio.read(config.LID_PINS[bay])
        return (not v) if config.LID_ACTIVE_LOW else v

    def is_button_pressed(self):
        # 按键接 GPIO 与 GND 之间，内部上拉；按下时读到低电平
        return not self._gpio.read(config.BUTTON_PIN)

    # ── 摄像头 ──

    def snapshot(self):
        try:
            import cv2
        except ImportError:
            print('[HAL] 装 OpenCV：sudo apt install -y python3-opencv')
            return None

        if self._camera is None:
            cap = cv2.VideoCapture(config.CAMERA_DEVICE)
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, config.CAMERA_WIDTH)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, config.CAMERA_HEIGHT)
            if not cap.isOpened():
                print('[HAL] 摄像头打不开。可能被别的程序占用 ——')
                print('      检查：ps aux | grep -E "ffmpeg|cam.py"')
                return None
            self._camera = cap
            time.sleep(config.CAMERA_WARMUP)   # 等自动曝光稳定

        # 丢掉前几帧，摄像头刚打开时画面偏暗
        for _ in range(3):
            self._camera.grab()

        ok, frame = self._camera.read()
        return frame if ok else None

    def cleanup(self):
        self.leds_off()
        if self._camera is not None:
            self._camera.release()
            self._camera = None
        self._gpio.cleanup()


# ══════════════════════════════════════════════════════════════
#  GPIO 底层 —— 兼容 libgpiod v2 / v1 / sysfs
# ══════════════════════════════════════════════════════════════

class _GpioBackend:
    """
    把不同版本的 GPIO 接口抹平成同样三个方法：setup / read / write。

    优先 libgpiod（Debian 推荐），实在没有就退回 sysfs。
    sysfs 已被内核标记为废弃，但能用就先让它用着 —— 对学生项目来说，
    "跑得起来"比"用法先进"重要。
    """

    def __init__(self):
        self.mode = None
        self._out_req = None
        self._in_req = None
        self._out_pins = []
        self._in_pins = []

        try:
            import gpiod
            self._gpiod = gpiod
            if hasattr(gpiod, 'request_lines'):
                self.mode = 'gpiod-v2'
            elif hasattr(gpiod, 'Chip'):
                self.mode = 'gpiod-v1'
        except ImportError:
            gpiod = None

        if self.mode is None:
            if os.path.isdir('/sys/class/gpio'):
                self.mode = 'sysfs'
                print('[GPIO] libgpiod 不可用，退回 sysfs（已废弃，但能用）')
                print('       建议安装：sudo apt install -y python3-libgpiod')
            else:
                raise RuntimeError(
                    '找不到任何 GPIO 接口。\n'
                    '请安装：sudo apt install -y python3-libgpiod\n'
                    '或者先用模拟模式跑：ZHIHYAO_MOCK=1 python3 main.py'
                )

        # 探测 gpiochip。A733 通常只有一个
        self._chip_path = '/dev/gpiochip0'
        for i in range(8):
            p = f'/dev/gpiochip{i}'
            if os.path.exists(p):
                self._chip_path = p
                break

    # ── 输出 ──

    def setup_outputs(self, pins):
        self._out_pins = list(pins)
        if self.mode == 'gpiod-v2':
            g = self._gpiod
            from gpiod.line import Direction, Value
            cfg = {
                p: g.LineSettings(direction=Direction.OUTPUT, output_value=Value.INACTIVE)
                for p in self._out_pins
            }
            self._out_req = g.request_lines(self._chip_path, consumer='zhihyao-out', config=cfg)
        elif self.mode == 'gpiod-v1':
            self._out_req = {}
            chip = self._gpiod.Chip(self._chip_path)
            for p in self._out_pins:
                line = chip.get_line(p)
                line.request(consumer='zhihyao-out', type=self._gpiod.LINE_REQ_DIR_OUT)
                self._out_req[p] = line
        else:  # sysfs
            for p in self._out_pins:
                self._sysfs_export(p)
                self._sysfs_write(p, 'out')

    def write(self, pin, on):
        if self.mode == 'gpiod-v2':
            from gpiod.line import Value
            self._out_req.set_value(pin, Value.ACTIVE if on else Value.INACTIVE)
        elif self.mode == 'gpiod-v1':
            self._out_req[pin].set_value(1 if on else 0)
        else:
            self._sysfs_set(pin, '1' if on else '0')

    # ── 输入 ──

    def setup_inputs(self, pins, pull_up=False):
        self._in_pins = list(pins)
        if self.mode == 'gpiod-v2':
            g = self._gpiod
            from gpiod.line import Direction, Bias
            bias = Bias.PULL_UP if pull_up else Bias.AS_IS
            cfg = {
                p: g.LineSettings(direction=Direction.INPUT, bias=bias)
                for p in self._in_pins
            }
            self._in_req = g.request_lines(self._chip_path, consumer='zhihyao-in', config=cfg)
        elif self.mode == 'gpiod-v1':
            self._in_req = {}
            chip = self._gpiod.Chip(self._chip_path)
            for p in self._in_pins:
                line = chip.get_line(p)
                flags = self._gpiod.LINE_REQ_FLAG_BIAS_PULL_UP if pull_up else 0
                line.request(consumer='zhihyao-in',
                             type=self._gpiod.LINE_REQ_DIR_IN, flags=flags)
                self._in_req[p] = line
        else:
            for p in self._in_pins:
                self._sysfs_export(p)
                self._sysfs_write(p, 'in')

    def read(self, pin):
        if self.mode == 'gpiod-v2':
            from gpiod.line import Value
            return self._in_req.get_value(pin) == Value.ACTIVE
        elif self.mode == 'gpiod-v1':
            return bool(self._in_req[pin].get_value())
        else:
            try:
                with open(f'/sys/class/gpio/gpio{pin}/value') as f:
                    return f.read().strip() == '1'
            except OSError:
                return False

    # ── sysfs 辅助 ──

    def _sysfs_export(self, pin):
        p = f'/sys/class/gpio/gpio{pin}'
        if not os.path.exists(p):
            try:
                with open('/sys/class/gpio/export', 'w') as f:
                    f.write(str(pin))
                time.sleep(0.1)
            except OSError as e:
                print(f'[GPIO] 导出引脚 {pin} 失败：{e}')

    def _sysfs_write(self, pin, value):
        try:
            with open(f'/sys/class/gpio/gpio{pin}/direction', 'w') as f:
                f.write(value)
        except OSError:
            pass

    def _sysfs_set(self, pin, value):
        try:
            with open(f'/sys/class/gpio/gpio{pin}/value', 'w') as f:
                f.write(value)
        except OSError:
            pass

    def cleanup(self):
        for p in self._out_pins:
            try:
                self.write(p, False)
            except Exception:
                pass
        for req in (self._out_req, self._in_req):
            if req is not None and hasattr(req, 'release'):
                try:
                    req.release()
                except Exception:
                    pass


def _pick_tts():
    """挑一个可用的语音合成工具"""
    for name in (config.TTS_COMMAND, 'espeak-ng', 'espeak'):
        if not name:
            continue
        try:
            subprocess.run([name, '--version'], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return name
        except (OSError, subprocess.CalledProcessError):
            continue
    return None


# ══════════════════════════════════════════════════════════════

def get_hardware():
    """按配置返回合适的硬件实现"""
    if config.USE_MOCK:
        return MockHardware()
    return OrangePiHardware()
