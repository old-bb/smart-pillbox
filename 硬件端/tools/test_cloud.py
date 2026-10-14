#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
云端连通性诊断

硬件端上报数据要经过好几环，任何一环没配好都表现为"没反应"。
这个脚本把每一环单独测一遍，并告诉你具体该怎么修。

跑法：
    python3 tools/test_cloud.py

它做的事（全部是安全操作，不会污染真实数据）：
    1. 检查配置（AppID / AppSecret / 环境 ID）
    2. 取 access_token —— 最常出问题的一步，单独测
    3. 测 device.heartbeat    —— 能到、鉴权对不对、设备注册没有
    4. 测 plan.listForDevice  —— 拉计划的通路通不通
    5. 测 record.report       —— 用 lid_open 事件，走完整路径但不会写记录
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config   # noqa: E402
import cloud    # noqa: E402

OK, BAD, WARN = '✓', '✗', '!'


def check_config():
    print(f'\n[{OK}] 配置检查')
    print(f'    设备 ID     {config.DEVICE_ID}')
    print(f'    小程序      {config.WX_APPID or "（空）"}')
    print(f'    云环境      {config.CLOUD_ENV or "（空）"}')

    # 逐项报告 —— 只说「还没配置」没用，得说清缺哪一个。
    # 两个凭证是独立的：缺 AppSecret 是取不到令牌，
    # 缺设备令牌是云端会拒绝设备请求，故障现象完全不同。
    has_secret = bool(config.WX_APPSECRET)
    has_token = bool(config.DEVICE_TOKEN)
    print(f'    AppSecret   {"已配置" if has_secret else "缺失 ✗"}')
    print(f'    设备令牌    {"已配置" if has_token else "缺失 ✗"}')
    print(f'    传输方式    {cloud.transport_name()}')

    if cloud.is_configured():
        return True

    print(f'\n  {BAD} 还差这些：')
    if not has_secret and not config.CLOUD_BASE_URL:
        print('      · AppSecret')
        print('        小程序后台 → 开发管理 → 开发设置 → 复制 AppSecret')
        print('        填到本目录 secret.json 的 "appsecret"')
    if not has_token:
        print('      · 设备令牌')
        print('        云开发控制台 → record / device / plan 三个云函数')
        print('        → 版本详情 → 配置 → 环境变量 → 加 DEVICE_TOKEN')
        print('        → 三个都要重新「上传并部署」才生效')
        print('        同一个值填到本目录 secret.json 的 "devicetoken"')

    print('\n  本目录下的 secret.json 应该长这样（两项都要有）：')
    print('      {')
    print('        "appsecret":   "小程序后台复制的那串",')
    print('        "devicetoken": "云函数环境变量 DEVICE_TOKEN 的同款值"')
    print('      }')
    return False


def check_token():
    """取 access_token —— 这一步最容易出错，单独测"""
    if config.CLOUD_BASE_URL:
        print(f'\n[{OK}] 取 access_token（跳过：走的是 HTTP 访问服务）')
        return True

    print(f'\n[{OK}] 取 access_token（服务端 API 的第一步）')
    try:
        tok = cloud._get_access_token(force=True)
        # 不打印令牌内容，哪怕是一部分 —— 凭证一旦进了终端和日志，
        # 就多了一处需要清理的地方。长度足够说明取到了。
        print(f'  {OK} 拿到了（{len(tok)} 字符，有效期 2 小时）')
        return True
    except Exception as e:
        print(f'  {BAD} 失败：{e}')
        print()
        print('  这一环失败的常见原因：')
        print('    · AppID / AppSecret 不匹配 —— 去后台重新复制一遍 AppSecret')
        print('      （AppSecret 只能完整查看一次，忘了就得重置）')
        print('    · 小程序被停用 / 欠费')
        print('    · 板子网络不通外网 —— ping api.weixin.qq.com 试试')
        return False


def check_device():
    """心跳：最安全的测试，不写任何业务数据"""
    print(f'\n[{OK}] 测 device.heartbeat（设备心跳）')
    r = cloud.heartbeat()

    if r is None:
        # cloud.py 已经把错误打出来了，这里补充排查方向
        print('  常见原因：')
        print('    · 403 → DEVICE_TOKEN 和云端不一致')
        print('    · 404 → 这台设备还没在小程序里绑定')
        print('    · 云函数没上传最新版')
        return False

    print(f'  {OK} 心跳成功，云端已更新 lastSeenAt')
    print(f'      小程序里这台药盒现在应该显示「在线」')
    return True


def check_plan():
    """拉计划：只读，安全"""
    print(f'\n[{OK}] 测 plan.listForDevice（拉取用药计划）')
    plans = cloud.fetch_plans()

    if plans is None:
        print(f'  {BAD} 拉取失败（原因见上面的日志）')
        return False

    if not plans:
        print(f'  {WARN} 通了，但这台设备没有生效中的用药计划')
        print('      去小程序「用药」页加一个，硬件才知道该提醒什么')
        return True

    print(f'  {OK} 拉到 {len(plans)} 个计划：')
    for p in plans:
        times = '、'.join(p.get('times', []))
        print(f'      {p.get("bayIndex", 0) + 1}号仓  '
              f'{p.get("medicineName", "")}  {times}')
    return True


def check_record():
    """
    上报：用 lid_open 事件。

    为什么用它：这条路径会完整走一遍鉴权、设备查询、心跳刷新，
    但在写记录之前就 return 了 —— 所以能验证链路，又不会污染真实数据。
    """
    print(f'\n[{OK}] 测 record.report（上报通路）')
    r = cloud.report_event(0, 'lid_open')

    if r is None:
        print(f'  {BAD} 上报失败（原因见上面的日志）')
        return False

    print(f'  {OK} 上报通路正常（用 lid_open 测的，没有写入记录）')
    if r.get('data', {}).get('ignored'):
        print(f'      云端回应：{r["data"].get("reason", "")}')
    return True


def main():
    print('=' * 56)
    print('  智药云联 · 云端连通性诊断')
    print('=' * 56)

    if not check_config():
        print('\n先解决配置问题再跑诊断。')
        sys.exit(1)

    results = {
        '取令牌': check_token(),
    }
    # 令牌拿不到就不用往下测了，后面每一步都要用它
    if results['取令牌']:
        results['心跳'] = check_device()
        results['拉计划'] = check_plan()
        results['上报通路'] = check_record()

    print('\n' + '─' * 56)
    print('  诊断结果')
    print('─' * 56)
    for name, ok in results.items():
        print(f'  {OK if ok else BAD}  {name}')

    print()
    if all(results.values()):
        print('  全部通过 —— 硬件端和云平台已经接上了。')
        print('  现在跑 python3 main.py --real 就能真实上报数据。')
    else:
        print('  有没通的。按上面的提示逐条修，修完再跑一次。')
        sys.exit(1)


if __name__ == '__main__':
    main()
