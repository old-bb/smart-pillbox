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

    # ══════════════════════════════════════════════════════
    #  以下是回归测试：每条都对应一个真实出现过的缺陷
    # ══════════════════════════════════════════════════════

    section('八、迟到仍要提醒（回归）')

    # 背景：触发窗口原先只有 [到点前 2 秒, 到点后 5 秒]。
    # 主循环里任何阻塞（网络请求、语音合成）都会让时点越过这 5 秒，
    # 于是它永远不提醒、也不上报，120 秒后被静默标记成已处理。

    hw, sch = make_scheduler([make_plan(0, ['08:00'])], today)
    slot = list(sch._slots.values())[0]
    late_now = slot.scheduled_at + timedelta(seconds=60)   # 迟了 60 秒
    sch._check_due(late_now)
    check('迟到 60 秒仍然启动提醒', sch.active is slot, True)

    hw, sch = make_scheduler([make_plan(0, ['08:00'])], today)
    slot = list(sch._slots.values())[0]
    too_late = slot.scheduled_at + timedelta(seconds=config.REMIND_TIMEOUT + 30)
    sch._check_due(too_late)
    check('错过太久则不再补提醒', sch.active, None)
    check('  且被标记为已处理', slot.key in sch._done, True)

    section('九、同一分钟两个药仓（回归）')

    hw, sch = make_scheduler([make_plan(0, ['08:00']), make_plan(1, ['08:00'])], today)
    first = min(sch._slots.values(), key=lambda s: s.bay)
    t0 = first.scheduled_at

    sch._check_due(t0)
    check('第一个药仓先提醒', sch.active is not None and sch.active.bay == 0, True)

    hw.simulate_button()
    sch._service_active(t0)

    # 第一个结束后，第二个已经迟到几十秒，但仍必须提醒
    sch._check_due(t0 + timedelta(seconds=30))
    check('第二个药仓不会因为迟到被跳过',
          sch.active is not None and sch.active.bay == 1, True)

    section('十、计划当天变更生效（回归）')

    hw, sch = make_scheduler([make_plan(0, ['08:00'])], today)
    check('初始 1 个时点', len(sch._slots), 1)

    # 原先只在跨天时重建时点表，当天在云端改的计划要到第二天才生效 ——
    # 药盒会继续按旧时间播报旧药名
    sch.plans = [make_plan(0, ['09:30'])]
    sch._rebuild_slots(today)
    check('重建后出现新的 09:30 时点',
          f'plan0_{today}_09:30' in sch._slots, True)
    check('  旧的 08:00 时点已移除',
          f'plan0_{today}_08:00' in sch._slots, False)

    # 已完成的时点不应该因为重建而复活
    hw, sch = make_scheduler([make_plan(0, ['08:00'])], today)
    slot = list(sch._slots.values())[0]
    sch._done.add(slot.key)
    sch._rebuild_slots(today)
    check('重建不会让已处理的时点复活', slot.key in sch._slots, False)

    # 正在提醒中的时点要保留，否则会被凭空抹掉
    hw, sch = make_scheduler([make_plan(0, ['08:00'])], today)
    slot = list(sch._slots.values())[0]
    sch._start_reminder(slot)
    sch._rebuild_slots(today)
    check('重建保留正在提醒的时点', slot.key in sch._slots, True)

    section('十一、忘记合盖不判漏服（回归）')

    # 背景：原先只在「盖子合上」的那一刻才算取药。
    # 但很多老人拿完药不关盖（或者虚掩着），那样会在 120 秒后被判漏服 ——
    # 明明吃了却告诉子女「没吃」，比漏报还糟。

    import cloud
    from scheduler import Slot

    recorded = []
    orig_report = cloud.report_event
    cloud.report_event = lambda bay, et, ts=None: recorded.append((bay, et))

    try:
        hw, sch = make_scheduler([make_plan(0, ['08:00'])], today)
        slot = list(sch._slots.values())[0]
        sch._start_reminder(slot)

        hw.simulate_lid(0, True)
        sch._service_active(datetime.now(BJ))
        check('开盖后仍在提醒中', sch.active is not None, True)

        # 一直不合盖，推到超时之后
        sch._active_since = time.time() - config.REMIND_TIMEOUT - 5
        sch._service_active(datetime.now(BJ))
        check('超过时限但盖子还开着 → 不判漏服', sch.active is None, True)
        check('  上报的是已取药，不是漏服',
              recorded and recorded[-1][1] == 'taken', True)
    finally:
        cloud.report_event = orig_report

    section('十二、上报异常不卡死调度器（回归）')

    # 背景：原先 _confirm / _missed 中途抛异常时 self.active 不会被清空，
    # 之后 _check_due 每次都提前返回 —— 调度器彻底卡死，
    # 所有时点都不再提醒。药盒是无人值守设备，这个错误不可接受。

    hw, sch = make_scheduler([make_plan(0, ['08:00'])], today)
    slot0 = list(sch._slots.values())[0]
    sch._start_reminder(slot0)

    def boom(*a, **k):
        raise RuntimeError('模拟上报失败')

    cloud.report_event = boom
    try:
        hw.simulate_button()
        try:
            sch._service_active(datetime.now(BJ))
        except RuntimeError:
            pass   # 异常会向上抛给主循环记录日志，这是预期行为
    finally:
        cloud.report_event = orig_report

    check('上报抛异常后 active 已被清空', sch.active, None)
    check('  该时点已标记完成', slot0.key in sch._done, True)
    # 关键：后续时点还能正常提醒
    hw2, sch2 = make_scheduler([make_plan(1, ['09:00'])], today)
    s2 = list(sch2._slots.values())[0]
    sch2._start_reminder(s2)
    check('  调度器没有卡死，能继续提醒', sch2.active is s2, True)

    section('十三、计划变化检测')

    from scheduler import Scheduler

    d1 = Scheduler._plans_digest([make_plan(0, ['08:00'])])
    d2 = Scheduler._plans_digest([make_plan(0, ['09:00'])])
    d3 = Scheduler._plans_digest([make_plan(0, ['08:00'])])
    check('时间变化能检出', d1 != d2, True)
    check('药名变化能检出',
          d1 != Scheduler._plans_digest([make_plan(0, ['08:00'], '别的药')]), True)
    check('没变化时摘要相同', d1 == d3, True)

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
