#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
云端传输层测试

跑法：python3 test_transport.py

覆盖两种传输方式的选择、access_token 的缓存与刷新、
服务端 API 的返回值拆包、错误码翻译。
这些地方出错的表现都很隐蔽 —— 比如令牌没缓存会导致每秒都去取一次，
很快就被微信限流，而日志里只看到偶发的 40001。
"""

import json
import sys
import time

import cloud
import config

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


# ── 网络打桩 ──────────────────────────────────────────────
# 把 cloud._post_json 换掉，这样测试不碰网络，
# 也就能精确控制"哪种响应触发哪条分支"

_call_log = []


def patch_post(responder):
    """responder(url, payload) → 返回要模拟的响应 dict，或抛异常"""
    def fake(url, payload):
        _call_log.append({'url': url, 'payload': payload})
        return responder(url, payload)
    cloud._post_json = fake


def reset_token():
    cloud._token['value'] = ''
    cloud._token['expire_at'] = 0.0


# ══════════════════════════════════════════════════════════

def main():
    print('=' * 56)
    print('  云端传输层测试')
    print('=' * 56)

    section('一、传输方式选择')

    config.CLOUD_BASE_URL = ''
    config.WX_APPID = 'wx123'
    config.CLOUD_ENV = 'env-1'
    config.WX_APPSECRET = ''
    config.DEVICE_TOKEN = ''
    check('什么都没配 → 未配置', cloud.is_configured(), False)

    # 令牌是硬性前提：没有它云端一律拒绝，上报只会得到 403
    config.WX_APPSECRET = 'secret123'
    check('有密钥但没令牌 → 仍未配置', cloud.is_configured(), False)
    check('  缺失项里点名了令牌', any('DEVICE_TOKEN' in m for m in cloud.config_problems()), True)

    config.DEVICE_TOKEN = 'dev-token-xyz'
    check('密钥 + 令牌齐了 → 已配置', cloud.is_configured(), True)
    check('  传输方式为服务端 API', cloud.transport_name(), '服务端 API')

    config.CLOUD_BASE_URL = 'https://example.com'
    config.WX_APPSECRET = ''
    check('只有 URL + 令牌也算已配置', cloud.is_configured(), True)
    check('  填了 URL 优先走 HTTP', cloud.transport_name(), 'HTTP 访问服务')

    # 后续测试都走服务端 API
    config.CLOUD_BASE_URL = ''
    config.WX_APPSECRET = 'secret123'

    section('二、access_token 缓存')

    reset_token()
    _call_log.clear()

    def token_ok(url, payload):
        if 'stable_token' in url:
            return {'access_token': 'TOK-1', 'expires_in': 7200}
        return {'errcode': 0, 'resp_data': json.dumps({'code': 0})}

    patch_post(token_ok)

    t1 = cloud._get_access_token()
    check('第一次取到令牌', t1, 'TOK-1')
    check('  发了一次请求', len(_call_log), 1)

    t2 = cloud._get_access_token()
    check('第二次直接命中缓存', t2, 'TOK-1')
    check('  没有重复请求（关键）', len(_call_log), 1)

    # 快到期时应该提前刷新
    cloud._token['expire_at'] = time.time() + 60   # 只剩 60 秒
    cloud._get_access_token()
    check('临近过期会主动刷新', len(_call_log), 2)

    section('三、用 stable_token 而不是 cgi-bin/token')

    reset_token()
    _call_log.clear()
    cloud._get_access_token()
    url = _call_log[0]['url'] if _call_log else ''
    check('用的是 stable_token 接口', 'stable_token' in url, True)
    check('  不是老的 cgi-bin/token', 'cgi-bin/token' in url, False)
    # 老接口每取一次会作废上一个，设备和小程序会互相踢掉，
    # 表现为时好时坏的 40001。stable_token 没有这个问题。

    section('四、服务端 API 返回值拆包')

    reset_token()
    _call_log.clear()

    inner = {'code': 0, 'data': {'list': [{'bayIndex': 0}]}}

    def api_ok(url, payload):
        if 'stable_token' in url:
            return {'access_token': 'TOK-2', 'expires_in': 7200}
        # 云函数的返回值被包成字符串塞在 resp_data 里
        return {'errcode': 0, 'errmsg': 'ok', 'resp_data': json.dumps(inner)}

    patch_post(api_ok)
    got = cloud.fetch_plans()
    check('resp_data 被正确解成对象', isinstance(got, list), True)
    check('  内容正确', got[0]['bayIndex'] if got else None, 0)

    reset_token()

    def api_raw_object(url, payload):
        if 'stable_token' in url:
            return {'access_token': 'TOK-3', 'expires_in': 7200}
        return {'errcode': 0, 'resp_data': inner}   # 已经是对象，不是字符串

    patch_post(api_raw_object)
    got = cloud.fetch_plans()
    check('resp_data 已是对象时也能处理', isinstance(got, list), True)

    section('五、错误码翻译')

    reset_token()

    def api_err(code, msg='boom'):
        def r(url, payload):
            if 'stable_token' in url:
                return {'access_token': 'TOK-4', 'expires_in': 7200}
            return {'errcode': code, 'errmsg': msg}
        return r

    for code, keyword in [(85088, '未开通云开发'),
                          (40013, 'AppID 无效'),
                          (40125, 'AppSecret 无效')]:
        reset_token()
        patch_post(api_err(code))
        try:
            cloud._send_via_api('device', {})
            check(f'{code} 应该抛异常', 'no-raise', 'raised')
        except RuntimeError as e:
            check(f'{code} 抛异常且提示到位', keyword in str(e), True)

    section('六、令牌失效自动重试')

    reset_token()
    _call_log.clear()
    attempts = {'n': 0}

    def token_expires_once(url, payload):
        if 'stable_token' in url:
            attempts['n'] += 1
            return {'access_token': f'TOK-{attempts["n"]}', 'expires_in': 7200}
        # 第一次调用说令牌无效，之后正常
        if attempts['n'] == 1:
            return {'errcode': 40001, 'errmsg': 'invalid credential'}
        return {'errcode': 0, 'resp_data': json.dumps({'code': 0})}

    patch_post(token_expires_once)
    r = cloud._send_via_api('device', {})
    check('令牌失效后刷新并重试成功', r.get('code'), 0)
    check('  确实重新取了令牌', attempts['n'] >= 2, True)

    # 但不能无限重试
    reset_token()
    patch_post(lambda u, p: {'access_token': 'X', 'expires_in': 7200}
               if 'stable_token' in u
               else {'errcode': 40001, 'errmsg': 'invalid credential'})
    try:
        cloud._send_via_api('device', {})
        check('持续失效时应该放弃', 'no-raise', 'raised')
    except RuntimeError:
        check('持续失效时放弃并抛异常（不死循环）', True, True)

    section('七、业务错误会被当失败处理')

    reset_token()

    def api_biz_err(url, payload):
        if 'stable_token' in url:
            return {'access_token': 'TOK-5', 'expires_in': 7200}
        return {'errcode': 0, 'resp_data': json.dumps({'code': 403, 'msg': '设备鉴权失败'})}

    patch_post(api_biz_err)
    config.HTTP_RETRY = 1          # 别让测试等重试
    config.PENDING_FILE = 'test_pending.json'
    cloud.PENDING_FILE = 'test_pending.json'
    import os
    if os.path.exists('test_pending.json'):
        os.remove('test_pending.json')

    r = cloud.report_event(0, 'taken')
    check('云端返回 code=403 时不上报成功', r, None)
    check('  记录进了本地队列（没丢）', cloud.pending_count(), 1)

    if os.path.exists('test_pending.json'):
        os.remove('test_pending.json')

    section('八、缺 AppSecret 时给出可操作的提示')

    reset_token()
    old_secret = config.WX_APPSECRET
    config.WX_APPSECRET = ''
    try:
        cloud._get_access_token(force=True)
        check('应该抛异常', 'no-raise', 'raised')
    except RuntimeError as e:
        msg = str(e)
        check('提示里说明了三种填法', 'secret.json' in msg and '环境变量' in msg, True)
    finally:
        config.WX_APPSECRET = old_secret

    # ══════════════════════════════════════════════════════
    #  以下是回归测试：每条都对应一个真实出现过的缺陷
    # ══════════════════════════════════════════════════════

    import os

    config.DEVICE_TOKEN = 'tok'
    config.WX_APPSECRET = 'secret123'
    cloud.PENDING_FILE = 'test_pending.json'
    cloud.LOST_FILE = 'test_pending_lost.json'

    def clean():
        for f in ('test_pending.json', 'test_pending.json.tmp',
                  'test_pending.json.bad', 'test_pending_lost.json'):
            if os.path.exists(f):
                os.remove(f)

    section('九、瞬时错误不按次数放弃（回归）')

    # 背景：原来「最多补发 8 次」—— 而心跳每 3 分钟成功一次就触发一次补发，
    # 24 分钟就能烧完额度，把一条因网络抖动没发出去的服药记录永久删掉。
    # 瞬时错误跟记录本身无关，应该按【时间】判断，不能按【次数】。

    clean()
    cloud._enqueue({'action': 'report', 'n': 1})
    check('入队成功', cloud.pending_count(), 1)

    def always_timeout(name, payload):
        raise RuntimeError('Connection timed out')

    orig_send = cloud._send
    cloud._send = always_timeout
    try:
        for _ in range(12):      # 12 次，远超旧上限 8 次
            cloud._flush_pending()
    finally:
        cloud._send = orig_send

    check('网络故障重试 12 次后记录仍在队列', cloud.pending_count(), 1)
    check('  没有被误判成「永久失败」', os.path.exists('test_pending_lost.json'), False)

    section('十、队列文件损坏时备份而非静默清空（回归）')

    clean()
    # 模拟断电：写了一半的 JSON
    with open('test_pending.json', 'w', encoding='utf-8') as f:
        f.write('[{"payload": {"a": 1}}, {"payl')

    loaded = cloud._load_pending()
    check('损坏的文件不会返回半截数据', loaded, [])
    check('  原文件被备份（不是静默删除）', os.path.exists('test_pending.json.bad'), True)
    check('  队列从空开始，补发能继续跑（不再卡死）', cloud._load_pending(), [])

    section('十一、原子写入不留残骸')

    clean()
    cloud._save_pending([{'x': 1}])
    check('写入成功', os.path.exists('test_pending.json'), True)
    check('  没有 .tmp 残留', os.path.exists('test_pending.json.tmp'), False)

    section('十二、云端明确拒绝才快速放弃')

    clean()
    cloud._enqueue({'action': 'report', 'n': 2})

    def always_rejected(name, payload):
        return {'code': 403, 'msg': '设备鉴权失败'}

    cloud._send = always_rejected
    try:
        for _ in range(cloud.PERMANENT_ATTEMPTS):
            cloud._flush_pending()
    finally:
        cloud._send = orig_send

    check('明确拒绝超过阈值后移出队列', cloud.pending_count(), 0)
    check('  但留了证据文件，不是静默删除', os.path.exists('test_pending_lost.json'), True)

    clean()

    # ── 汇总 ──
    print('\n' + '─' * 56)
    print(f'通过 {PASS} 项，失败 {FAIL} 项')
    if FAIL:
        print('\n失败用例：')
        for f in FAILURES:
            print(f'  - {f}')
        sys.exit(1)
    print('全部通过 ✓')


if __name__ == '__main__':
    main()
