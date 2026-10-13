# -*- coding: utf-8 -*-
"""
用药调度引擎

这是硬件端的核心：到点提醒 → 等老人取药 → 上报云端。

状态流转：
    待服 ──(到点)──▶ 提醒中 ──(开盖/按键)──▶ 已确认 ──▶ 上报
                        │
                        └──(超过补救时限)──▶ 漏服 ──▶ 上报

设计上有一处刻意为之：确认信号同时接受「开盖」和「按键」。
计划书设想的是老人按确认键，但实际使用中很多老人拿完药就合上盖子、
根本不会去按键 —— 只认按键会导致大量误判为漏服。
"""

import time
from datetime import datetime, timedelta, timezone

import config
import cloud

BJ = timezone(timedelta(hours=config.TZ_OFFSET_HOURS))


class Slot:
    """一个具体的"该吃药了"时点"""

    def __init__(self, plan, time_str, date_str):
        self.plan = plan
        self.plan_id = plan.get('_id', '')
        self.bay = plan.get('bayIndex', 0)
        self.medicine = plan.get('medicineName', '')
        self.dosage = plan.get('dosageText', '')
        self.meal = plan.get('mealRelation', '')
        self.voice = plan.get('voiceText', '')
        self.time_str = time_str
        self.date_str = date_str

        hh, mm = (int(x) for x in time_str.split(':'))
        y, mo, d = (int(x) for x in date_str.split('-'))
        self.scheduled_at = datetime(y, mo, d, hh, mm, tzinfo=BJ)

    @property
    def key(self):
        return f'{self.plan_id}_{self.date_str}_{self.time_str}'

    def announce_text(self):
        """播报词。优先用云端配置的自定义语音，否则按模板生成"""
        if self.voice:
            return self.voice
        parts = [f'该吃{self.medicine}了']
        if self.dosage:
            parts.append(self.dosage)
        if self.meal and self.meal != '不限':
            parts.append(self.meal)
        return '，'.join(parts)


class Scheduler:

    def __init__(self, hw, vision=None, verbose=True):
        self.hw = hw
        self.vision = vision
        self.verbose = verbose

        self.plans = []
        self._slots = {}          # key -> Slot，今天的全部时点
        self._day = None          # 当前 slot 表对应的日期
        self._done = set()        # 已处理过的 slot key

        self.active = None        # 正在提醒的 Slot
        self._active_since = 0.0
        self._last_beep = 0.0
        self._lid_was_open = False
        self._before_frame = None  # 提醒开始时的画面，用于视觉比对

        self._last_heartbeat = 0.0
        self._last_sync = 0.0
        self._running = False

    def _say(self, msg):
        if self.verbose:
            print(msg)

    # ══════════════════════════════════════════════════════════
    #  主循环
    # ══════════════════════════════════════════════════════════

    def run_forever(self):
        self._running = True
        self._say(f'[调度] 启动。设备 {config.DEVICE_ID}，'
              f'{config.BAY_COUNT} 个药仓')

        self.sync_plans()

        while self._running:
            try:
                now = datetime.now(BJ)
                self._roll_day(now)
                self._check_due(now)
                self._service_active(now)
                self._periodic(now)
                time.sleep(0.5)
            except KeyboardInterrupt:
                print('\n[调度] 收到中断，退出')
                break
            except Exception as e:
                # 单次循环出错不要让整个程序挂掉 —— 药盒得一直守着
                self._say(f'[调度] 循环异常（已忽略，继续运行）：{e}')
                time.sleep(2)

        self._shutdown()

    def stop(self):
        self._running = False

    # ══════════════════════════════════════════════════════════
    #  计划同步
    # ══════════════════════════════════════════════════════════

    def sync_plans(self):
        plans = cloud.fetch_plans()
        if plans is None:
            # 拉取失败就沿用旧计划，不要清空 —— 断网时药盒必须照常工作
            self._say('[调度] 拉取计划失败，继续使用本地已有的计划')
            return
        self.plans = plans
        active = [p for p in plans if p.get('active', True)]
        self._say(f'[调度] 已同步 {len(active)} 个生效计划')
        for p in active:
            times = '、'.join(p.get('times', []))
            print(f'        {p.get("bayIndex", 0) + 1}号仓 '
                  f'{p.get("medicineName", "")}  {times}')

    # ══════════════════════════════════════════════════════════
    #  时点管理
    # ══════════════════════════════════════════════════════════

    def _roll_day(self, now):
        """跨天时重建当天的时点表"""
        today = now.strftime('%Y-%m-%d')
        if self._day == today:
            return

        self._day = today
        self._slots = {}
        self._done = set()

        for p in self.plans:
            if not p.get('active', True):
                continue
            for t in p.get('times', []):
                s = Slot(p, t, today)
                self._slots[s.key] = s

        self._say(f'[调度] {today} 共 {len(self._slots)} 个服药时点')

    def _check_due(self, now):
        """有到点的就启动提醒"""
        if self.active is not None:
            return   # 一次只处理一个，避免同时响好几个

        for key, slot in sorted(self._slots.items(),
                                key=lambda kv: kv[1].scheduled_at):
            if key in self._done:
                continue
            delta = (now - slot.scheduled_at).total_seconds()
            # 到点后 0~5 秒内触发（给秒级误差留余量）
            if -2 <= delta <= 5:
                self._start_reminder(slot)
                return
            # 已经错过太久的，直接标记跳过，不补提醒
            if delta > config.REMIND_TIMEOUT:
                self._done.add(key)

    # ══════════════════════════════════════════════════════════
    #  提醒过程
    # ══════════════════════════════════════════════════════════

    def _start_reminder(self, slot):
        self.active = slot
        self._active_since = time.time()
        self._last_beep = 0.0
        self._lid_was_open = False
        self._before_frame = None

        print(f'\n[提醒] {slot.time_str} {slot.bay + 1}号仓 '
              f'{slot.medicine} {slot.dosage}')

        self.hw.led_on(slot.bay)

        # 拍一张"取药前"的画面，用于稍后比对药片数量
        if self.vision is not None:
            frame = self.hw.snapshot()
            if frame is not None:
                n = self.vision.count_pills(frame, slot.bay)
                self._before_frame = frame
                self._say(f'[视觉] 取药前 {slot.bay + 1}号仓检测到 {n} 片')
            else:
                self._say('[视觉] 拍照失败，本次跳过视觉确认')

        self.hw.speak(slot.announce_text(), bay=slot.bay)
        self.hw.beep()

    def _service_active(self, now):
        """提醒进行中：反复响铃、等老人确认"""
        if self.active is None:
            return

        slot = self.active
        elapsed = time.time() - self._active_since

        # ── 确认信号 1：开盖 ──
        lid = self.hw.is_lid_open(slot.bay)
        if lid and not self._lid_was_open:
            self._say(f'[提醒] 检测到 {slot.bay + 1}号仓开盖')
        if self._lid_was_open and not lid:
            # 盖子合上了 —— 说明拿完了
            self._confirm(slot, 'taken', reason='开盖取药')
            return
        self._lid_was_open = lid

        # ── 确认信号 2：按键 ──
        if self.hw.is_button_pressed():
            self._confirm(slot, 'taken', reason='按下确认键')
            return

        # ── 每隔几秒再响一次 ──
        if time.time() - self._last_beep > config.BEEP_GAP_SECONDS:
            self._last_beep = time.time()
            self.hw.beep()

        # ── 超时 ──
        if elapsed > config.REMIND_TIMEOUT:
            self._missed(slot)

    def _confirm(self, slot, event_type, reason=''):
        """老人取药了"""
        self._say(f'[提醒] 已确认（{reason}）')

        # 视觉二次确认：比对取药前后的药片数量
        if event_type == 'taken' and self.vision is not None and self._before_frame is not None:
            frame = self.hw.snapshot()
            if frame is not None:
                before = self.vision.count_pills(self._before_frame, slot.bay)
                after = self.vision.count_pills(frame, slot.bay)
                if before is not None and after is not None and after < before:
                    event_type = 'vision_confirmed'
                    self._say(f'[视觉] 药片 {before} → {after} 片，确认已取走')
                else:
                    self._say(f'[视觉] 数量没变化（{before} → {after}），'
                          f'可能只是开盖看了看。仍按传感器记录上报')

        self.hw.leds_off()
        cloud.report_event(slot.bay, event_type)

        self._done.add(slot.key)
        self.active = None
        self._before_frame = None

    def _missed(self, slot):
        """超时未取，本地判定为漏服并上报"""
        self._say(f'[提醒] 超时未取，判定为漏服')
        self.hw.leds_off()
        self.hw.speak(f'{slot.medicine}还没吃，请尽快服用', bay=slot.bay)
        cloud.report_event(slot.bay, 'missed')
        self._done.add(slot.key)
        self.active = None
        self._before_frame = None

    # ══════════════════════════════════════════════════════════
    #  周期性任务
    # ══════════════════════════════════════════════════════════

    def _periodic(self, now):
        t = time.time()

        if t - self._last_heartbeat > config.HEARTBEAT_INTERVAL:
            self._last_heartbeat = t
            cloud.heartbeat(battery=self._read_battery())

        if t - self._last_sync > config.PLAN_SYNC_INTERVAL:
            self._last_sync = t
            self.sync_plans()

    def _read_battery(self):
        """
        读电池电量百分比。

        中期阶段用市电供电，所以直接返回 None（云端会显示"未知"）。
        真要做电池方案时，这里换成读 I2C 电量计的代码。
        """
        return None

    def _shutdown(self):
        self.hw.leds_off()
        self.hw.cleanup()
        pending = cloud.pending_count()
        if pending:
            self._say(f'[调度] 还有 {pending} 条记录未上报，已存在本地队列')
