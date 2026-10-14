# -*- coding: utf-8 -*-
"""
云端通信

两种传输方式，程序自动选：

  方式一（推荐）服务端 API
      先拿 access_token，再调 tcb/invokecloudfunction 直接执行云函数。
      不需要 HTTP 网关、不需要域名、不需要备案，免费环境就能用。
      云函数那边一个字都不用改 —— 收到的参数结构和以前完全一样。

  方式二 HTTP 访问服务
      直接 POST 到云函数的公网地址。需要环境的 HTTP 网关配好。
      当前免费体验版控制台里没有这个入口，暂时用不了。

两种都没配 → 本地运行模式，数据不上报（调试时能用）

断网处理：上报失败存到本地队列（pending.json），下次成功时补发。
老人家里断网是常事，服药记录不能因此丢掉。
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import config

PENDING_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pending.json')
MAX_PENDING = 200

# 云端明确拒绝的错误码：参数错、令牌错、设备没绑。
# 这类错误重试没意义，快速放弃。
PERMANENT_CODES = (400, 403, 404)

# 明确拒绝重复几次后放弃
PERMANENT_ATTEMPTS = 3

# 瞬时错误（网络不通、超时、云端 5xx）持续多久才放弃。
#
# ⚠️ 按【时间】而不是【次数】。
# 之前是「最多补发 8 次」，但心跳每 3 分钟成功一次就会触发一次补发，
# 于是 24 分钟就能把额度烧完 —— 一条因为网络抖动没发出去的服药记录，
# 半小时后就被永久删掉了。瞬时错误跟记录本身无关，
# 等网络好了自然能发出去，不该按次数判它死刑。
GIVE_UP_AFTER_HOURS = 24


class _Rejected(Exception):
    """云端明确拒绝（参数/凭证问题），重试无意义"""

# 微信服务端 API 的根地址
WX_API = 'https://api.weixin.qq.com'

# access_token 缓存。有效期 7200 秒，提前 5 分钟刷新
_token = {'value': '', 'expire_at': 0.0}
TOKEN_REFRESH_AHEAD = 300


# ══════════════════════════════════════════════════════════════
#  对外接口
# ══════════════════════════════════════════════════════════════

def is_configured():
    """
    配了设备令牌 + 任意一种传输方式，才算已配置。

    令牌是硬性前提：没有它云端一律拒绝（fail closed），
    上报只会得到 403、还在本地队列里越积越多。
    与其那样，不如启动时就说清楚。
    """
    if not config.DEVICE_TOKEN:
        return False
    if config.CLOUD_BASE_URL:
        return True
    return bool(config.WX_APPID and config.WX_APPSECRET and config.CLOUD_ENV)


def config_problems():
    """返回配置缺失的说明，供启动时提示"""
    missing = []
    if not config.DEVICE_TOKEN:
        missing.append(
            'DEVICE_TOKEN 没配置 —— 设备上报需要一个和云端一致的令牌。\n'
            '  · 硬件端：secret.json 里加 "devicetoken": "xxx"\n'
            '  · 云端：三个设备接口函数（record/device/plan）的环境变量 DEVICE_TOKEN 填同样的值\n'
            '  ⚠️ 这个值绝不能写进代码 —— 仓库是公开的')
    if not config.CLOUD_BASE_URL and not (config.WX_APPID and config.WX_APPSECRET and config.CLOUD_ENV):
        missing.append(
            '云端传输方式没配置 —— 二选一：\n'
            '  · 服务端 API（推荐）：secret.json 里加 "appsecret": "xxx"\n'
            '  · HTTP 访问服务：填 config.py 的 CLOUD_BASE_URL')
    return missing


def transport_name():
    if config.CLOUD_BASE_URL:
        return 'HTTP 访问服务'
    if config.WX_APPSECRET:
        return '服务端 API'
    return '未配置'


def report_event(bay, event_type, timestamp=None):
    """
    上报一次服药事件。

    event_type:
        'taken'            传感器检测到取药
        'vision_confirmed' 摄像头确认药片真的被取走（可信度更高）
        'missed'           药盒本地判定漏服（提醒超时仍未取药）
        'lid_open'         仅开盖，不单独计为服药

    时间戳一律带上。不带的话云端只能按「收到请求的时刻」判定，
    断网补发时会以补发时刻生成日期 —— 夜里断网、早上补发，
    这次服药就会被记到第二天，当天那一次还会被云端补成一条假漏服。
    """
    payload = {
        'action': 'report',
        'deviceId': config.DEVICE_ID,
        'bayIndex': bay,
        'eventType': event_type,
        'token': config.DEVICE_TOKEN,
        # 事件真正发生的时刻。进了本地队列后原样保留，
        # 补发时云端仍能按正确时间判定
        'timestamp': timestamp or datetime.now(timezone.utc).isoformat(),
    }
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
#  传输层
# ══════════════════════════════════════════════════════════════

_notified_unconfigured = False


def _call(name, payload, queue_on_fail=False):
    global _notified_unconfigured

    if not is_configured():
        if not _notified_unconfigured:
            print('[CLOUD] 未配置云端，本地运行模式（数据不会上传）')
            for msg in config_problems():
                print(f'  · {msg}')
            _notified_unconfigured = True
        return None

    last_err = None
    for attempt in range(config.HTTP_RETRY):
        try:
            res = _send(name, payload)
            # 云函数把业务错误放在返回体里（HTTP 状态仍是 200）：
            # 403 鉴权失败、404 设备未注册、500 内部错误……
            # 只判断「HTTP 没报错」会把它们全当成功，记录静默消失且不入队。
            if res is None or res.get('code') != 0:
                raise RuntimeError(_describe(res))
            _flush_pending()
            return res
        except Exception as e:
            last_err = e
            if attempt < config.HTTP_RETRY - 1:
                time.sleep(1.5 * (attempt + 1))

    print(f'[CLOUD] {name} 上报失败：{last_err}')
    if queue_on_fail:
        _enqueue(payload)
    return None


def _send(name, payload):
    """按配置选择传输方式"""
    if config.CLOUD_BASE_URL:
        return _send_via_http(name, payload)
    return _send_via_api(name, payload)


def _describe(res):
    """把云函数返回的错误拼成一句人话"""
    if res is None:
        return '响应为空或不是 JSON'
    code = res.get('code')
    msg = res.get('msg', '')
    human = {
        401: '未登录（这个接口不该由设备调用）',
        403: '鉴权失败 —— 检查 config.py 的 DEVICE_TOKEN 是否和云端一致',
        404: '设备未注册 —— 先在小程序里绑定这台药盒',
    }.get(code, '')
    return f'云端返回 code={code} {msg}{"（" + human + "）" if human else ""}'.strip()


# ── 方式一：服务端 API ─────────────────────────────────────

def _send_via_api(name, payload, _retried=False):
    """
    通过 tcb/invokecloudfunction 执行云函数。

    返回的是云函数的返回值（已经解掉外层包装），
    和走 HTTP 访问服务时拿到的结构完全一样。
    """
    token = _get_access_token()
    url = (f'{WX_API}/tcb/invokecloudfunction'
           f'?access_token={urllib.parse.quote(token)}'
           f'&env={urllib.parse.quote(config.CLOUD_ENV)}'
           f'&name={urllib.parse.quote(name)}')

    raw = _post_json(url, payload)

    errcode = raw.get('errcode')
    if errcode:
        # 令牌失效 → 强制刷新一次再重试。只重试一次，避免死循环
        if errcode in (40001, 40014, 42001) and not _retried:
            print('[CLOUD] 令牌已失效，刷新后重试')
            _get_access_token(force=True)
            return _send_via_api(name, payload, _retried=True)
        raise RuntimeError(_explain_api_error(errcode, raw.get('errmsg', '')))

    # resp_data 是云函数返回值的 JSON 字符串，要解第二层
    resp_data = raw.get('resp_data')
    if isinstance(resp_data, str):
        try:
            return json.loads(resp_data)
        except json.JSONDecodeError:
            return None
    return resp_data


def _explain_api_error(errcode, errmsg):
    """服务端 API 的错误码翻译成人话"""
    known = {
        40001: 'access_token 无效（已尝试刷新仍失败）—— 检查 AppID / AppSecret 是否匹配',
        40013: 'AppID 无效 —— 检查 config.py 的 WX_APPID',
        40125: 'AppSecret 无效 —— 检查 secret.json 或环境变量',
        45009: '接口调用超过限额 —— 等一下再试',
        85088: '该 AppID 未开通云开发 —— 确认小程序后台已开通云开发，且环境属于这个 AppID',
    }
    hint = known.get(errcode)
    return f'微信接口报错 {errcode}: {errmsg}' + (f'\n        {hint}' if hint else '')


def _get_access_token(force=False):
    """
    取 access_token，带内存缓存。

    用的是 stable_token 接口，不是老的 cgi-bin/token ——
    后者的毛病是「取得新令牌会让上一个立即失效」，
    设备、小程序、调试工具之间会互相把对方的令牌踢掉，
    表现就是时好时坏的 40001。stable_token 没有这个问题。
    """
    now = time.time()
    if (not force and _token['value']
            and _token['expire_at'] - TOKEN_REFRESH_AHEAD > now):
        return _token['value']

    if not (config.WX_APPID and config.WX_APPSECRET):
        raise RuntimeError(
            'AppSecret 没配置。三种填法见 config.py：\n'
            '  1. 环境变量 ZHIHYAO_APPSECRET\n'
            '  2. 同目录下建 secret.json，内容 {"appsecret": "你的密钥"}\n'
            '  3. 直接写在 config.py（不推荐）\n'
            '  AppSecret 在 小程序后台 → 开发管理 → 开发设置 里'
        )

    data = _post_json(f'{WX_API}/cgi-bin/stable_token', {
        'grant_type': 'client_credential',
        'appid': config.WX_APPID,
        'secret': config.WX_APPSECRET,
        'force_refresh': False,
    })

    if not data.get('access_token'):
        raise RuntimeError(_explain_api_error(
            data.get('errcode'), data.get('errmsg', '取 access_token 失败')))

    _token['value'] = data['access_token']
    _token['expire_at'] = now + int(data.get('expires_in', 7200))
    print(f'[CLOUD] 已获取 access_token，{int(data.get("expires_in", 7200))} 秒后过期')
    return _token['value']


# ── 方式二：HTTP 访问服务 ──────────────────────────────────

def _send_via_http(name, payload):
    url = config.CLOUD_BASE_URL.rstrip('/') + '/' + config.CLOUD_PATHS.get(name, name)
    return _post_json(url, payload)


# ── 共用的 HTTP 客户端 ─────────────────────────────────────

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
        raise RuntimeError(f'返回内容不是 JSON：{text[:200]}')


# ── 断网队列 ──────────────────────────────────────────────
#
# 这个队列是服药记录在断网期间【唯一】的副本 —— 丢了就真没了。
# 所以这里有三条硬要求：
#   1. 写文件必须原子（先写临时文件再改名），否则断电会写坏半个文件
#   2. 读到坏文件不能静默当成空队列，要先备份再继续
#   3. 放弃一条记录必须留下痕迹，不能只 print 一行了事

LOST_FILE = PENDING_FILE.replace('pending', 'pending_lost')


def _load_pending():
    if not os.path.exists(PENDING_FILE):
        return []
    try:
        with open(PENDING_FILE, encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, ValueError) as e:
        # ⚠️ 必须捕 ValueError，不能只捕 json.JSONDecodeError ——
        # 文件被截断在多字节字符中间时抛的是 UnicodeDecodeError，
        # 它不是 JSONDecodeError 的子类，漏掉会让坏文件永久卡死补发。
        #
        # 之前这里直接 return []：整队积压记录被静默清空，
        # 关机提示会说「还有 0 条未上报」，看不出出过事。
        backup = PENDING_FILE + '.bad'
        try:
            os.replace(PENDING_FILE, backup)
            print(f'[CLOUD] 本地队列文件损坏（{e}），已备份到 {backup}')
            print('        队列从空开始。原文件里可能还有可抢救的记录。')
        except OSError:
            print(f'[CLOUD] 本地队列损坏且无法备份：{e}')
        return []


def _save_pending(items):
    """
    原子写入：先写临时文件，fsync 落盘，再改名覆盖。

    直接以 'w' 打开真实文件的话，写入过程中断电会留下半个文件，
    而读取方会把「解析失败」当成空队列 —— 整队记录就这么没了。
    改名是原子操作，要么全有要么全无。
    """
    tmp = PENDING_FILE + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(items, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, PENDING_FILE)
        return True
    except OSError as e:
        print(f'[CLOUD] 本地队列写入失败：{e}')
        try:
            os.remove(tmp)
        except OSError:
            pass
        return False


def _enqueue(payload):
    items = _load_pending()
    items.append({'payload': payload, 'at': time.time()})
    # 只留最近的若干条，避免文件无限增长
    if len(items) > MAX_PENDING:
        dropped = len(items) - MAX_PENDING
        items = items[-MAX_PENDING:]
        print(f'[CLOUD] 队列已满，丢弃最早的 {dropped} 条记录')

    if _save_pending(items):
        print(f'[CLOUD] 已存入本地队列，待联网后补发（当前 {len(items)} 条）')
    else:
        # 写失败还报「已存入」的话，用户会以为记录安全了，其实已经丢了
        print('[CLOUD] ⚠️ 记录未能存入本地队列，本次上报已丢失')


def _give_up(item, reason):
    """
    放弃一条记录。不再重试，但**不静默删除** ——
    另存到 pending_lost.json，留证据供人工抢救。
    """
    lost = []
    if os.path.exists(LOST_FILE):
        try:
            with open(LOST_FILE, encoding='utf-8') as f:
                lost = json.load(f)
        except (OSError, ValueError):
            lost = []
    item['givenUpAt'] = time.time()
    item['givenUpReason'] = reason
    lost.append(item)
    _save_pending_to(LOST_FILE, lost)

    print(f'[CLOUD] ⚠️ 放弃一条服药记录（{reason}）：{item.get("lastError", "")}')
    print(f'        已存到 {LOST_FILE}，请人工检查是否需要补录')


def _save_pending_to(path, items):
    tmp = path + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(items, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except OSError as e:
        print(f'[CLOUD] 写入 {path} 失败：{e}')


def _flush_pending():
    items = _load_pending()
    if not items:
        return

    remaining = []
    sent = 0
    now = time.time()

    for item in items:
        try:
            res = _send('record', item['payload'])
            # 业务错误也算失败 —— 无条件算成功会把补发失败的记录
            # 直接从队列删掉，永久丢失
            code = (res or {}).get('code')
            if res is None or code != 0:
                if code in PERMANENT_CODES:
                    raise _Rejected(_describe(res))
                raise RuntimeError(_describe(res))
            sent += 1

        except _Rejected as e:
            # 云端明确拒绝（400 参数错 / 403 令牌错 / 404 设备没绑）——
            # 再试多少次都是这个结果，快速放弃
            item['attempts'] = item.get('attempts', 0) + 1
            item['lastError'] = str(e)[:120]
            if item['attempts'] >= PERMANENT_ATTEMPTS:
                _give_up(item, '云端明确拒绝（参数或凭证问题）')
            else:
                remaining.append(item)

        except Exception as e:
            # 瞬时错误（网络不通、超时、云端 5xx）——
            # 这类错误跟记录本身没关系，等网络好了自然就发出去了，
            # 绝不能按「次数」放弃：心跳每 3 分钟触发一次补发，
            # 按次数算 24 分钟就把该重试的记录全扔了。
            item.setdefault('firstFailedAt', now)
            item['lastError'] = str(e)[:120]
            if now - item['firstFailedAt'] > GIVE_UP_AFTER_HOURS * 3600:
                _give_up(item, f'持续失败超过 {GIVE_UP_AFTER_HOURS} 小时')
            else:
                remaining.append(item)

    if sent:
        print(f'[CLOUD] 补发了 {sent} 条积压记录')

    if remaining:
        _save_pending(remaining)
        if sent == 0:
            waited = (now - remaining[0].get('firstFailedAt', now)) / 60
            print(f'[CLOUD] {len(remaining)} 条仍未补发成功'
                  f'（最早一条已等待 {waited:.0f} 分钟）：'
                  f'{remaining[-1].get("lastError", "")}')
    elif os.path.exists(PENDING_FILE):
        os.remove(PENDING_FILE)


def pending_count():
    return len(_load_pending())
