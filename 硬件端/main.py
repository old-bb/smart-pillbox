#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
智药云联 · 硬件端主程序

用法：
    python3 main.py                 模拟模式（默认，元件没到货时用）
    python3 main.py --real          真实模式（接好 GPIO 之后用）
    python3 main.py --selftest      只做环境自检，不进主循环
    python3 main.py --test-bay 0    启动后立刻对 1 号仓演练一次提醒

模拟模式下可以按键盘：
    0~5   模拟第 N 号仓被打开、取药、合上（2 秒后自动合盖）
    b     模拟按下大按键
    q     退出
"""

import argparse
import sys
import threading
import time

import config


def parse_args():
    p = argparse.ArgumentParser(description='智药云联硬件端')
    p.add_argument('--real', action='store_true',
                   help='真实硬件模式（默认是模拟模式）')
    p.add_argument('--selftest', action='store_true',
                   help='只做自检，不进主循环')
    p.add_argument('--test-bay', type=int, default=None, metavar='N',
                   help='启动后立刻对第 N 号仓（从 0 开始）演练一次提醒')
    p.add_argument('--vision', action='store_true',
                   help='启用摄像头视觉确认')
    p.add_argument('--vision-debug', action='store_true',
                   help='启用视觉并保存调试图像到 debug_shots/')
    return p.parse_args()


# ══════════════════════════════════════════════════════════════
#  自检
# ══════════════════════════════════════════════════════════════

def selftest():
    print('=' * 52)
    print('  环境自检')
    print('=' * 52)

    print(f'\n[1] Python')
    print(f'    版本 {sys.version.split()[0]}')
    if sys.version_info < (3, 8):
        print('    ✗ 版本过低，需要 3.8 以上')
    else:
        print('    ✓ 可用')

    print(f'\n[2] OpenCV / NumPy')
    try:
        import cv2
        import numpy
        print(f'    ✓ OpenCV {cv2.__version__}')
        print(f'    ✓ NumPy {numpy.__version__}')
    except ImportError as e:
        print(f'    ✗ 缺失：{e}')
        print('      安装：sudo apt install -y python3-opencv python3-numpy')

    print(f'\n[3] GPIO')
    try:
        from hal import _GpioBackend
        gpio = _GpioBackend()
        print(f'    ✓ 后端 {gpio.mode}，设备 {gpio._chip_path}')
        print('      ⚠️ 引脚编号还需按实际接线核对，见 config.py 的 GPIO 段')
    except Exception as e:
        # 异常信息是多行的，只取第一行，后面的安装建议单独打
        first = str(e).split('\n')[0]
        print(f'    ✗ {first}')
        for line in str(e).split('\n')[1:]:
            if line.strip():
                print(f'      {line.strip()}')

    print(f'\n[4] 摄像头')
    try:
        import cv2
        cap = cv2.VideoCapture(config.CAMERA_DEVICE)
        if cap.isOpened():
            ok, frame = cap.read()
            if ok:
                h, w = frame.shape[:2]
                print(f'    ✓ /dev/video{config.CAMERA_DEVICE} 出图正常，{w}×{h}')
            else:
                print(f'    ✗ 能打开但读不到画面')
        else:
            print(f'    ✗ 打不开。可能被占用 ——')
            print('      检查：ps aux | grep -E "ffmpeg|cam.py"')
        cap.release()
    except ImportError:
        print('    - 跳过（没装 OpenCV）')

    print(f'\n[5] 音频')
    import shutil
    for tool, desc in [('espeak-ng', '语音合成'), ('aplay', '播放'),
                       ('arecord', '录音')]:
        path = shutil.which(tool)
        print(f'    {"✓" if path else "✗"} {tool:12s} {desc}')
    if not shutil.which('espeak-ng'):
        print('      安装：sudo apt install -y espeak-ng alsa-utils')

    print(f'\n[6] 云端配置')
    import cloud
    if cloud.is_configured():
        print(f'    ✓ {config.CLOUD_BASE_URL}')
        print(f'      设备 {config.DEVICE_ID}')
    else:
        print('    - 未配置（本地运行模式，数据不会上传）')
        print('      配置方法见 config.py 的 CLOUD_BASE_URL')

    print(f'\n[7] 运行模式')
    print(f'    {"真实硬件" if not config.USE_MOCK else "模拟（不碰 GPIO）"}')
    print(f'    药仓数 {config.BAY_COUNT}')
    print()


# ══════════════════════════════════════════════════════════════
#  模拟控制台
# ══════════════════════════════════════════════════════════════

def start_mock_console(hw, scheduler):
    """在模拟模式下监听键盘，手动触发开盖/按键，方便演示和调试"""

    def loop():
        print('\n─── 模拟控制台 ───')
        print('  按 0~5 模拟对应药仓开盖取药（2 秒后自动合盖）')
        print('  按 b   模拟按下确认键')
        print('  按 q   退出\n')

        for line in sys.stdin:
            key = line.strip().lower()

            if key == 'q':
                print('[模拟] 退出')
                scheduler.stop()
                break

            elif key == 'b':
                print('[模拟] 按下确认键')
                hw.simulate_button()

            elif key.isdigit():
                bay = int(key)
                if bay >= config.BAY_COUNT:
                    print(f'[模拟] 只有 {config.BAY_COUNT} 个药仓')
                    continue
                print(f'[模拟] {bay + 1} 号仓开盖')
                hw.simulate_lid(bay, True)

                def close(b=bay):
                    time.sleep(2.0)
                    hw.simulate_lid(b, False)
                    print(f'[模拟] {b + 1} 号仓合盖')

                threading.Thread(target=close, daemon=True).start()

    threading.Thread(target=loop, daemon=True).start()


# ══════════════════════════════════════════════════════════════
#  主流程
# ══════════════════════════════════════════════════════════════

def build_vision(args):
    if not (args.vision or args.vision_debug):
        return None
    try:
        import vision
        counter = vision.make_counter(debug=args.vision_debug)
        if counter is None:
            print('[视觉] 没装 OpenCV，视觉确认已关闭')
        else:
            print(f'[视觉] 已启用'
                  f'{"，调试图存到 debug_shots/" if args.vision_debug else ""}')
        return counter
    except Exception as e:
        print(f'[视觉] 初始化失败：{e}')
        return None


def main():
    args = parse_args()

    if args.real:
        config.USE_MOCK = False

    if args.selftest:
        selftest()
        return

    print('=' * 52)
    print('  智药云联 · 硬件端')
    print(f'  设备 {config.DEVICE_ID}　'
          f'模式 {"真实硬件" if not config.USE_MOCK else "模拟"}')
    print('=' * 52)

    # ── 硬件 ──
    try:
        from hal import get_hardware
        hw = get_hardware()
    except Exception as e:
        print(f'\n硬件初始化失败：{e}')
        print('先用模拟模式跑：python3 main.py')
        sys.exit(1)

    # ── 视觉 ──
    vision_counter = build_vision(args)

    # ── 调度 ──
    from scheduler import Scheduler
    scheduler = Scheduler(hw, vision=vision_counter)

    if config.USE_MOCK:
        start_mock_console(hw, scheduler)

    # ── 手动演练：答辩演示时不用等时钟 ──
    if args.test_bay is not None:
        def demo(bay=args.test_bay):
            time.sleep(2)
            from datetime import datetime
            from scheduler import Slot, BJ

            # 优先用真实计划里该药仓的时点
            slot = next((s for s in scheduler._slots.values() if s.bay == bay), None)

            if slot is None:
                # 没有计划（比如还没配云端），造一个临时的，保证演示能跑
                print(f'[演示] 该药仓没有云端计划，使用临时计划')
                now = datetime.now(BJ)
                slot = Slot({
                    'bayIndex': bay,
                    'medicineName': '苯磺酸氨氯地平片',
                    'dosageText': '1片',
                    'mealRelation': '饭后',
                    'voiceText': '',
                }, now.strftime('%H:%M'), now.strftime('%Y-%m-%d'))
                scheduler._slots[slot.key] = slot

            print(f'\n[演示] 手动触发 {slot.bay + 1} 号仓的提醒')
            scheduler._start_reminder(slot)

        threading.Thread(target=demo, daemon=True).start()

    # ── 跑 ──
    try:
        scheduler.run_forever()
    except KeyboardInterrupt:
        print('\n收到中断')
        scheduler.stop()


if __name__ == '__main__':
    main()
