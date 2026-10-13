#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
硬件端逻辑测试（不需要任何元件）

跑法：python3 test_logic.py

覆盖调度引擎的状态机：到点提醒 → 开盖确认 / 按键确认 / 超时判漏服。
这些是最容易写错的地方，而且在真机上一旦出错很难定位 ——
比如"老人明明取了药却报漏服"，可能就是边沿判断写反了。
"""

import sys
import time

import config

# 强制模拟模式，不碰 GPIO
config.USE_MOCK = True


# ── 断言工具 ──────────────────────────────────────────────

PASS, FAIL = 0, 0
FAILURES = []


def check(name, actual, expected):
    global PASS, FAIL
    if actual == expected:
        PASS += 1
        print(f'  ✓ {name}')
    else:
        FAIL += 1
        FAILURES.append(name)
        print(f'  ✗ {name}')
        print(f'      期望 {expected!r}，实际 {actual!r}')


def section(t):
    print(f'\n{t}')


# ── 测试数据 ──────────────────────────────────────────────

def make_plan(bay=0, times=None, medicine='苯磺酸氨氯地平片'):
    return {
        '_id': f'plan{bay}',
        'bayIndex': bay,
        'medicineName': medicine,
        'dosageText': '1片',
        'mealRelation': '饭后',
        'voiceText': '',
        'times': times or ['08:00'],
        'active': True,
    }


def make_scheduler(plans, today_str):
    from hal import MockHardware
    from scheduler import Scheduler, Slot

    hw = MockHardware(quiet=True)
    sch = Scheduler(hw, vision=None, verbose=False)
    sch.plans = plans

    # 手工铺当天的时点，绕开 run_forever 的时间判定
    for p in plans:
        for t in p['times']:
            s = Slot(p, t, today_str)
            sch._slots[s.key] = s
    sch._day = today_str
    return hw, sch


# ══════════════════════════════════════════════════════════

def main():
    from datetime import datetime, timedelta, timezone
    BJ = timezone(timedelta(hours=config.TZ_OFFSET_HOURS))
    today = datetime.now(BJ).strftime('%Y-%m-%d')

    print('=' * 52)
    print('  硬件端逻辑测试（模拟模式）')
    print('=' * 52)

    # ─────────────────────────────────────────────────────
    section('一、时点展开')

    plans = [make_plan(0, ['08:00', '20:00']), make_plan(1, ['12:30'])]
    hw, sch = make_scheduler(plans, today)
    check('两个计划展开出 3 个时点', len(sch._slots), 3)

    s = sch._slots[f'plan0_{today}_08:00']
    check('时点药仓正确', s.bay, 0)
    check('时点时间正确', s.time_str, '08:00')
    check('计划时间解析正确', s.scheduled_at.hour, 8)
    check('时区为北京时间', s.scheduled_at.utcoffset().total_seconds(), 8 * 3600)

    section('二、播报文案生成')

    check('带药名', '苯磺酸氨氯地平片' in s.announce_text(), True)
    check('带剂量', '1片' in s.announce_text(), True)
    check('带服用方式', '饭后' in s.announce_text(), True)

    p = make_plan(0, ['08:00'])
    p['voiceText'] = '该吃降压药了，一片，饭后吃'
    _, sch2 = make_scheduler([p], today)
    s2 = list(sch2._slots.values())[0]
    check('自定义语音优先', s2.announce_text(), '该吃降压药了，一片，饭后吃')

    # ─────────────────────────────────────────────────────
    section('三、开盖确认路径')

    hw, sch = make_scheduler([make_plan(0, ['08:00'])], today)
    slot = list(sch._slots.values())[0]

    sch._start_reminder(slot)
    check('进入提醒状态', sch.active is not None, True)

    # 开盖
    hw.simulate_lid(0, True)
    sch._service_active(datetime.now(BJ))
    check('开盖后仍在提醒中（还没合盖）', sch.active is not None, True)

    # 合盖 —— 这一刻才算取药完成
    hw.simulate_lid(0, False)
    sch._service_active(datetime.now(BJ))
    check('合盖后提醒结束', sch.active is None, True)
    check('该时点已标记完成', slot.key in sch._done, True)

    section('四、按键确认路径')

    hw, sch = make_scheduler([make_plan(1, ['12:30'])], today)
    slot = list(sch._slots.values())[0]
    sch._start_reminder(slot)

    hw.simulate_button()
    sch._service_active(datetime.now(BJ))
    check('按键后提醒结束', sch.active is None, True)
    check('该时点已标记完成', slot.key in sch._done, True)

    section('五、超时判漏服')

    hw, sch = make_scheduler([make_plan(2, ['18:00'])], today)
    slot = list(sch._slots.values())[0]
    sch._start_reminder(slot)

    # 把起始时刻往前拨，模拟已经过了补救时限
    sch._active_since = time.time() - config.REMIND_TIMEOUT - 10
    sch._service_active(datetime.now(BJ))

    check('超时后提醒结束', sch.active is None, True)
    check('该时点已标记完成（不再重复提醒）', slot.key in sch._done, True)

    section('六、模式判断（关键）')

    # 只开盖不按键，也必须算取药 —— 很多老人拿完药不会去按键
    hw, sch = make_scheduler([make_plan(3, ['09:00'])], today)
    slot = list(sch._slots.values())[0]
    sch._start_reminder(slot)
    hw.simulate_lid(3, True)
    sch._service_active(datetime.now(BJ))
    hw.simulate_lid(3, False)
    sch._service_active(datetime.now(BJ))
    check('只开盖不按键也算取药', slot.key in sch._done, True)

    # 开盖后一直不合盖，不应该误判为取药
    hw, sch = make_scheduler([make_plan(4, ['09:00'])], today)
    slot = list(sch._slots.values())[0]
    sch._start_reminder(slot)
    hw.simulate_lid(4, True)
    for _ in range(5):
        sch._service_active(datetime.now(BJ))
        time.sleep(0.01)
    check('开盖未合盖不当作取药', sch.active is not None, True)

    section('七、一次只提醒一个')

    plans = [make_plan(0, ['08:00']), make_plan(1, ['08:00'])]
    hw, sch = make_scheduler(plans, today)
    first = list(sch._slots.values())[0]
    sch._start_reminder(first)

    # 此时另一个时点也到点了，不应该顶掉当前提醒
    sch._check_due(datetime.now(BJ))
    check('不会同时启动第二个提醒', sch.active is first, True)

    # ─────────────────────────────────────────────────────
    print('\n' + '─' * 52)
    print(f'通过 {PASS} 项，失败 {FAIL} 项')
    if FAIL:
        print('\n失败用例：')
        for f in FAILURES:
            print(f'  - {f}')
        sys.exit(1)
    print('全部通过 ✓')


if __name__ == '__main__':
    main()
