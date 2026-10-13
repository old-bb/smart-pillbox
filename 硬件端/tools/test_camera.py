#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
摄像头与药片计数测试工具

用法：
    python3 tools/test_camera.py shot              拍一张存下来，先看能不能看清
    python3 tools/test_camera.py count             拍一张并统计药片数量
    python3 tools/test_camera.py tune              交互式调参，反复拍反复看
    python3 tools/test_camera.py compare           模拟一次取药前后的比对

调参时要盯的是 debug_shots/ 里的 *_bin.jpg（二值化结果）：
药片应该是一个个干净的白块。如果连成一片或者碎成渣，就调 PARAMS。
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config   # noqa: E402

try:
    import cv2
except ImportError:
    print('需要 OpenCV：sudo apt install -y python3-opencv python3-numpy')
    sys.exit(1)


OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       'debug_shots')


def grab():
    cap = cv2.VideoCapture(config.CAMERA_DEVICE)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, config.CAMERA_WIDTH)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, config.CAMERA_HEIGHT)
    if not cap.isOpened():
        print('摄像头打不开。检查是否被占用：')
        print('  ps aux | grep -E "ffmpeg|cam.py"')
        return None
    time.sleep(config.CAMERA_WARMUP)
    for _ in range(5):     # 丢掉前几帧，等自动曝光稳定
        cap.grab()
    ok, frame = cap.read()
    cap.release()
    return frame if ok else None


def save(frame, name):
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, name)
    cv2.imwrite(path, frame)
    print(f'  已保存 {path}')
    return path


def cmd_shot():
    print('拍一张照片，用来判断当前机位和光照下行不行。\n')
    frame = grab()
    if frame is None:
        return
    h, w = frame.shape[:2]
    print(f'  分辨率 {w}×{h}')
    p = save(frame, f'shot_{time.strftime("%H%M%S")}.jpg')
    print(f'\n  把这张图打开看：药片能不能数清？')
    print(f'  数不清的话，多半是【对焦】问题不是分辨率 —— 见 README 的说明。')


def cmd_count():
    import vision
    print('拍一张并统计药片。\n')
    frame = grab()
    if frame is None:
        return
    save(frame, f'count_{time.strftime("%H%M%S")}_raw.jpg')

    counter = vision.PillCounter(debug_dir=OUT_DIR)
    r = counter.analyze(frame, bay=0)
    if r is None:
        print('  分析失败')
        return

    print(f'\n  检测到药片 {r["count"]} 片，总像素面积 {r["area"]}')
    print(f'  二值化结果已存到 debug_shots/，打开 *_bin.jpg 对照看看：')
    print(f'  · 应该是一个个独立的白圆块')
    print(f'  · 连成一片 → 调大 PARAMS["blur"] 或改光照')
    print(f'  · 碎成渣 → 调大 PARAMS["morph"]')
    print(f'  · 数少了 → 调小 PARAMS["min_area"]')
    print(f'  · 把噪点当药片 → 调大 PARAMS["min_area"]')


def cmd_tune():
    """反复拍、反复调，直到数得准"""
    import vision

    params = dict(vision.PARAMS)
    print('交互式调参。每轮拍一张，看看数出来几片。\n')
    print('可用命令：')
    print('  min_area <值>      最小面积')
    print('  blur <值>          模糊核（奇数）')
    print('  morph <值>         形态学核')
    print('  circularity <值>   圆度下限')
    print('  invert             切换药片比背景亮/暗')
    print('  adaptive           切换自适应阈值')
    print('  shot               重拍一张')
    print('  show               打印当前参数')
    print('  done               结束，把参数抄进 vision.py\n')

    while True:
        try:
            cmd = input('tune> ').strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break

        if not cmd:
            continue

        if cmd == 'done':
            print('\n把下面这些值抄到 vision.py 的 PARAMS 里：\n')
            for k, v in params.items():
                print(f'    {k!r}: {v},')
            break

        if cmd == 'show':
            for k, v in params.items():
                print(f'  {k} = {v}')
            continue

        if cmd == 'shot':
            frame = grab()
            if frame is None:
                continue
            save(frame, f'tune_{time.strftime("%H%M%S")}_raw.jpg')
            counter = vision.PillCounter(params=params, debug_dir=OUT_DIR)
            r = counter.analyze(frame, bay=0)
            if r:
                print(f'  → {r["count"]} 片，面积 {r["area"]}')
            continue

        if cmd == 'invert':
            params['pills_brighter'] = not params['pills_brighter']
            print(f'  pills_brighter = {params["pills_brighter"]}')
            continue

        if cmd == 'adaptive':
            params['adaptive'] = not params['adaptive']
            print(f'  adaptive = {params["adaptive"]}')
            continue

        parts = cmd.split()
        if len(parts) == 2 and parts[0] in params and parts[1].isdigit():
            params[parts[0]] = int(parts[1])
            print(f'  {parts[0]} = {parts[1]}')
        else:
            print('  没听懂。输入命令名和数值，比如：min_area 300')


def cmd_compare():
    """模拟一次取药：先拍"取药前"，拿走几片，再拍"取药后"，看能不能判出来"""
    import vision
    counter = vision.PillCounter(debug_dir=OUT_DIR)

    print('第 1 步：摆好药片，按回车拍"取药前"')
    input()
    before = grab()
    if before is None:
        return
    save(before, 'compare_before.jpg')

    print('\n第 2 步：拿走一两片（模仿老人取药），按回车拍"取药后"')
    input()
    after = grab()
    if after is None:
        return
    save(after, 'compare_after.jpg')

    taken, why = counter.compare(before, after, bay=0)
    print(f'\n  判定：{"取走了药" if taken else "没取走"}')
    print(f'  依据：{why}')
    print(f'\n  判定不对的话，看 debug_shots/compare_*.jpg 和对应的 _bin.jpg，'
          f'调 vision.py 的 PARAMS')


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    {
        'shot': cmd_shot,
        'count': cmd_count,
        'tune': cmd_tune,
        'compare': cmd_compare,
    }.get(sys.argv[1], lambda: print(__doc__))()


if __name__ == '__main__':
    main()
