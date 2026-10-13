# -*- coding: utf-8 -*-
"""
云端通信

只依赖 Python 标准库（urllib），不装 requests 也能跑 —— 在刚装好的
Armbian 上少一个需要装的包，就少一个出错的地方。

三个能力：
    report_event(bay, event_type)   上报服药事件
    heartbeat(battery)              上报心跳与电量
    fetch_plans()                   拉取该设备的用药计划

断网处理：上报失败会存到本地队列（pending.json），下次成功时补发。
老人家里断网是常事，服药记录不能因此丢掉。
"""

import json
import os
import time
import urllib.error
import urllib.request

import config

PENDING_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pending.json')
MAX_PENDING = 200


# ══════════════════════════════════════════════════════════════
#  对外接口
# ══════════════════════════════════════════════════════════════

def is_configured():
    return bool(config.CLOUD_BASE_URL)


def report_event(bay, event_type, timestamp=None):
    """
    上报一次服药事件。

    event_type:
        'taken'            传感器检测到取药
        'vision_confirmed' 摄像头确认药片真的被取走（可信度更高）
        'lid_open'         仅开盖，不单独计为服药
    """
    payload = {
        'action': 'report',
        'deviceId': config.DEVICE_ID,
        'bayIndex': bay,
        'eventType': event_type,
        'token': config.DEVICE_TOKEN,
    }
    if timestamp:
        payload['timestamp'] = timestamp
    return _call('record', payload, queue_on_fail=True)


def heartbeat(battery=None):
    """上报心跳。间隔必须小于云端的 5 分钟在线判定窗口。"""
    payload = {
        'action': 'heartbeat',
        'deviceId': config.DEVICE_ID,
        'token': config.DEVICE_TOKEN,
    }
    if battery is not None:
        payload['battery'] = battery
    return _call('device', payload)


def fetch_plans():
    """拉取该设备的用药计划。返回计划列表，失败返回 None（调用方保留旧计划）。"""
    payload = {
        'action': 'listForDevice',
        'deviceId': config.DEVICE_ID,
        'token': config.DEVICE_TOKEN,
    }
    r = _call('plan', payload)
    if r and r.get('code') == 0:
        return r.get('data', {}).get('list', [])
    return None


# ══════════════════════════════════════════════════════════════
#  内部实现
# ══════════════════════════════════════════════════════════════

_notified_unconfigured = False


def _call(name, payload, queue_on_fail=False):
    global _notified_unconfigured

    if not is_configured():
        if not _notified_unconfigured:
            print('[CLOUD] 未配置云端地址，本地运行模式（数据不会上传）')
            print('        配置方法见 config.py 的 CLOUD_BASE_URL')
            _notified_unconfigured = True
        return None

    url = config.CLOUD_BASE_URL.rstrip('/') + '/' + config.CLOUD_PATHS.get(name, name)

    for attempt in range(config.HTTP_RETRY):
        try:
            res = _post_json(url, payload)
            # 顺手把积压的记录补发掉
            _flush_pending()
            return res
        except Exception as e:
            if attempt < config.HTTP_RETRY - 1:
                time.sleep(1.5 * (attempt + 1))
                continue
            print(f'[CLOUD] {name} 上报失败：{e}')
            if queue_on_fail:
                _enqueue(payload)
            return None


def _post_json(url, payload):
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(
        url, data=body, method='POST',
        headers={'Content-Type': 'application/json; charset=utf-8'},
    )
    with urllib.request.urlopen(req, timeout=config.HTTP_TIMEOUT) as resp:
        text = resp.read().decode('utf-8')
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        print(f'[CLOUD] 返回内容不是 JSON：{text[:200]}')
        return None


# ── 断网队列 ──────────────────────────────────────────────

def _load_pending():
    if not os.path.exists(PENDING_FILE):
        return []
    try:
        with open(PENDING_FILE, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return []


def _save_pending(items):
    try:
        with open(PENDING_FILE, 'w', encoding='utf-8') as f:
            json.dump(items, f, ensure_ascii=False)
    except OSError as e:
        print(f'[CLOUD] 本地队列写入失败：{e}')


def _enqueue(payload):
    items = _load_pending()
    items.append({'payload': payload, 'at': time.time()})
    # 只留最近的若干条，避免文件无限增长
    if len(items) > MAX_PENDING:
        items = items[-MAX_PENDING:]
    _save_pending(items)
    print(f'[CLOUD] 已存入本地队列，待联网后补发（当前 {len(items)} 条）')


def _flush_pending():
    items = _load_pending()
    if not items:
        return

    url = config.CLOUD_BASE_URL.rstrip('/') + '/' + config.CLOUD_PATHS.get('record', 'record')
    remaining = []
    sent = 0

    for item in items:
        try:
            _post_json(url, item['payload'])
            sent += 1
        except Exception:
            remaining.append(item)

    if sent:
        print(f'[CLOUD] 补发了 {sent} 条积压记录')
    if remaining:
        _save_pending(remaining)
    elif os.path.exists(PENDING_FILE):
        os.remove(PENDING_FILE)


def pending_count():
    return len(_load_pending())
