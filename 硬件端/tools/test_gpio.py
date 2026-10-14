#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GPIO 引脚测试工具 —— 接线前必须先跑这个

为什么需要它：
    Orange Pi 4 Pro 的 40-pin 定义和树莓派不一样，而且 gpiod 用的是
    line number（gpioinfo 第一列），不是物理引脚号、也不是 BCM 编号。
    照着图接之前，先用这个工具确认哪个号对应哪个物理脚。

用法：
    python3 tools/test_gpio.py list                 列出所有 gpiochip 和引脚
    python3 tools/test_gpio.py blink <line>         让某个引脚闪烁（接 LED 测试）
    python3 tools/test_gpio.py watch <line>         持续读某个引脚（接传感器测试）
    python3 tools/test_gpio.py scan                 依次闪 LED_PINS，确认每个接对了
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config   # noqa: E402


def cmd_list():
    print('当前系统上的 GPIO 控制器：\n')
    os.system('gpiodetect 2>/dev/null || echo "  没找到 gpiodetect，装一下：sudo apt install -y gpiod"')

    # sysfs 模式下编号要换算：全局号 = 芯片基址 + line
    from hal import _GpioBackend
    chips = _GpioBackend._list_sysfs_chips()
    if chips:
        print('\nsysfs 芯片与基址（config.py 的 GPIO_CHIP_INDEX 指的 就是这里的序号）：\n')
        for i, (name, base) in enumerate(chips):
            print(f'    [{i}] {name:16s} 基址 {base}')
        print('\n  如果你的引脚在 [1] 上，那config.py 里填的 line 5：')
        print(f'    · 用 gpiod 时 → gpiochip 第 2 块的 line 5')
        print(f'    · 退到 sysfs 时 → 全局 gpio{chips[1][1] + 5}（程序会自动算）')
    else:
        print('\n  没有 /sys/class/gpio，sysfs 不可用')

    print('\n全部引脚的当前状态（第一列就是 line number）：\n')
    os.system('gpioinfo 2>/dev/null | head -60')


def cmd_blink(line, times=6, interval=0.4):
    print(f'让 line {line} 闪烁 {times} 次。')
    print('把 LED 的正极（长脚）接到这个引脚，负极串一个电阻后接 GND。\n')

    from hal import _GpioBackend
    g = _GpioBackend()
    g.setup_outputs([line])

    try:
        for i in range(times):
            g.write(line, True)
            print(f'  第 {i + 1} 次：亮')
            time.sleep(interval)
            g.write(line, False)
            print(f'  第 {i + 1} 次：灭')
            time.sleep(interval)
    except KeyboardInterrupt:
        print('\n中断')
    finally:
        g.write(line, False)
        g.cleanup()
    print('\n结束。LED 没反应的话检查：')
    print('  · LED 极性是不是接反了（长脚是正极）')
    print('  · 有没有串限流电阻（150Ω 左右）。直接接会烧 LED 和引脚')
    print('  · line number 是不是填错了')


def cmd_watch(line, seconds=30):
    print(f'监视 line {line}，持续 {seconds} 秒。')
    print('开盖/合盖霍尔传感器，看读数有没有变化。Ctrl+C 提前结束。\n')

    from hal import _GpioBackend
    g = _GpioBackend()
    g.setup_inputs([line], pull_up=True)

    last = None
    t0 = time.time()
    try:
        while time.time() - t0 < seconds:
            v = g.read(line)
            if v != last:
                mark = '开盖' if (not v if config.LID_ACTIVE_LOW else v) else '合盖'
                print(f'  [{time.strftime("%H:%M:%S")}] 电平 {"高" if v else "低"}'
                      f'  → 判定为「{mark}」')
                last = v
            time.sleep(0.05)
    except KeyboardInterrupt:
        print('\n中断')
    finally:
        g.cleanup()

    if last is None:
        print('  读数一直没变。检查：')
        print('  · A3144E 是【单极】霍尔，只对特定磁极响应 —— 把磁铁翻面试试')
        print('  · A3144E 最低工作电压 4.5V，VCC 必须接 5V（不是 3.3V）')
        print('  · OUT 要串一个 10kΩ 上拉到 3.3V，再接 GPIO')
    else:
        print('\n  读到了变化，说明这个引脚接对了。')
        print(f'  如果开盖合盖的判定反了，改 config.py 里的 LID_ACTIVE_LOW')


def cmd_scan():
    """依次点亮配置里的 LED 引脚，肉眼确认哪个灯对应哪个仓"""
    print('依次点亮 LED_PINS 里的每个引脚，每个亮 1.5 秒。')
    print('盯着药盒看，确认 1 号灯亮的时候程序输出的是 1 号仓。\n')

    from hal import _GpioBackend
    g = _GpioBackend()
    pins = config.LED_PINS[:config.BAY_COUNT]
    g.setup_outputs(pins)

    try:
        for i, pin in enumerate(pins):
            print(f'  现在点亮 {i + 1} 号仓的灯（line {pin}）')
            g.write(pin, True)
            time.sleep(1.5)
            g.write(pin, False)
            time.sleep(0.3)
    except KeyboardInterrupt:
        print('\n中断')
    finally:
        for p in pins:
            try:
                g.write(p, False)
            except Exception:
                pass
        g.cleanup()

    print('\n如果亮的顺序和药仓对不上，调整 config.py 里 LED_PINS 的顺序即可。')


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return

    cmd = sys.argv[1]

    if cmd == 'list':
        cmd_list()
    elif cmd == 'blink':
        if len(sys.argv) < 3:
            print('用法：python3 tools/test_gpio.py blink <line>')
            return
        cmd_blink(int(sys.argv[2]))
    elif cmd == 'watch':
        if len(sys.argv) < 3:
            print('用法：python3 tools/test_gpio.py watch <line>')
            return
        cmd_watch(int(sys.argv[2]))
    elif cmd == 'scan':
        cmd_scan()
    else:
        print(__doc__)


if __name__ == '__main__':
    main()
