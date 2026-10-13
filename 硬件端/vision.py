# -*- coding: utf-8 -*-
"""
药片计数（视觉确认）

为什么不上深度学习：
    药片是规则圆形、颜色统一、背景可控，传统图像处理完全够用，而且
    不需要训练数据、不依赖 NPU 工具链、在 CPU 上跑几毫秒。9 周的周期里，
    "稳定能跑"比"技术先进"重要得多。

核心思路：
    灰度 → 高斯模糊 → 阈值分割 → 形态学去噪 → 找轮廓 → 按面积/圆度筛选 → 计数

同时输出「药片总像素面积」。**比对前后变化时优先看面积而不是片数** ——
药片互相重叠时计数会不准，但面积是可靠的。
"""

import os
from datetime import datetime

import config

try:
    import cv2
    import numpy as np

    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False


# ══════════════════════════════════════════════════════════════
#  可调参数
# ══════════════════════════════════════════════════════════════
#
# 这些值必须在现场用真实药片和真实光照调一遍。
# 调参工具：python3 tools/test_camera.py
#
# 调参思路：
#   1. 先看 debug 图里二值化后的画面，药片应该是清晰的白块
#   2. 药片连成一片 → 提高阈值或加大模糊
#   3. 噪点太多被当成药片 → 调大 MIN_AREA
#   4. 数出来的片数偏少 → 调小 MIN_AREA 或放宽 CIRCULARITY_MIN

PARAMS = {
    # 药片在图像中的像素面积范围。640×480 下，直径 8mm 的药片
    # 若占画面 1/6 宽，面积大约 5000 像素。需要现场实测调整。
    'min_area': 200,
    'max_area': 20000,

    # 圆度 = 4π×面积 / 周长²。正圆为 1，越接近 1 越像药片。
    # 调到 0.5 左右可以容忍椭圆和轻微缺损
    'circularity_min': 0.45,

    # 高斯模糊核大小（奇数）。药片表面有反光时调大一点
    'blur': 5,

    # 形态学开运算的核大小，用来去掉细小噪点
    'morph': 5,

    # 药片比背景亮 → True；药片比背景暗 → False
    'pills_brighter': True,

    # 是否用自适应阈值。光照不均匀时开，均匀时用 OTSU 更稳
    'adaptive': False,
}


# 各药仓在画面中的位置，(x, y, w, h) 归一化到 0~1。
# 如果摄像头视野里只有一个药仓，就保持 None。
# 如果一眼能拍到多个仓，按格子位置填进去。
BAY_REGIONS = {
    # 0: (0.05, 0.05, 0.28, 0.45),
    # 1: (0.36, 0.05, 0.28, 0.45),
}


class PillCounter:

    def __init__(self, params=None, debug_dir=None):
        if not HAS_CV2:
            raise RuntimeError(
                'OpenCV 没装。执行：sudo apt install -y python3-opencv python3-numpy'
            )
        self.p = dict(PARAMS)
        if params:
            self.p.update(params)
        self.debug_dir = debug_dir
        if debug_dir:
            os.makedirs(debug_dir, exist_ok=True)

    # ── 对外接口 ──────────────────────────────────────────

    def analyze(self, frame, bay=0):
        """
        分析一帧画面。

        返回 {'count': 片数, 'area': 药片总像素面积}，失败返回 None。
        """
        if frame is None:
            return None

        roi = self._crop(frame, bay)
        if roi is None or roi.size == 0:
            return None

        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (self.p['blur'], self.p['blur']), 0)

        binary = self._threshold(gray)
        binary = self._denoise(binary)

        contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL,
                                       cv2.CHAIN_APPROX_SIMPLE)

        count, total_area = 0, 0
        for c in contours:
            area = cv2.contourArea(c)
            if area < self.p['min_area'] or area > self.p['max_area']:
                continue
            peri = cv2.arcLength(c, True)
            if peri <= 0:
                continue
            circularity = 4 * np.pi * area / (peri * peri)
            if circularity < self.p['circularity_min']:
                continue
            count += 1
            total_area += int(area)

        if self.debug_dir:
            self._save_debug(roi, binary, bay)

        return {'count': count, 'area': total_area}

    def count_pills(self, frame, bay=0):
        """只要片数，方便调用"""
        r = self.analyze(frame, bay)
        return r['count'] if r else None

    def compare(self, before, after, bay=0):
        """
        比对取药前后。

        返回 (是否取走, 说明文字)。
        判定优先看面积：药片重叠时计数不准，但面积是可靠的。
        """
        b = self.analyze(before, bay)
        a = self.analyze(after, bay)

        if b is None or a is None:
            return None, '画面不可用，跳过视觉确认'

        # 面积减少超过 8% 就算取走了。留余量是因为光照波动会让面积小幅抖动
        if b['area'] > 0:
            drop = (b['area'] - a['area']) / b['area']
            if drop > 0.08:
                return True, (f"药片减少 {drop * 100:.0f}%"
                              f"（{b['count']}片/{b['area']}px → "
                              f"{a['count']}片/{a['area']}px）")

        if a['count'] < b['count']:
            return True, f"片数 {b['count']} → {a['count']}"

        return False, (f"数量没变化（{b['count']}片 → {a['count']}片），"
                       f"可能只是开盖看了看")

    # ── 内部 ──────────────────────────────────────────────

    def _crop(self, frame, bay):
        h, w = frame.shape[:2]
        if bay in BAY_REGIONS:
            x0, y0, rw, rh = BAY_REGIONS[bay]
            return frame[int(y0 * h):int((y0 + rh) * h),
                         int(x0 * w):int((x0 + rw) * w)]
        return frame

    def _threshold(self, gray):
        if self.p['adaptive']:
            # 光照不均时用自适应阈值：每个小区域各算各的阈值
            b = cv2.adaptiveThreshold(
                gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                cv2.THRESH_BINARY, 31, -5
            )
            if not self.p['pills_brighter']:
                b = cv2.bitwise_not(b)
            return b

        # 光照均匀时 OTSU 更稳 —— 它自己找最佳分割点
        flag = cv2.THRESH_BINARY if self.p['pills_brighter'] else cv2.THRESH_BINARY_INV
        _, b = cv2.threshold(gray, 0, 255, flag + cv2.THRESH_OTSU)
        return b

    def _denoise(self, binary):
        k = self.p['morph']
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
        # 开运算：先腐蚀掉小噪点，再膨胀回来，药片主体不受影响
        return cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)

    def _save_debug(self, roi, binary, bay):
        """存下原图和二值图，调参时对着看就知道问题出在哪"""
        ts = datetime.now().strftime('%H%M%S')
        cv2.imwrite(os.path.join(self.debug_dir, f'bay{bay + 1}_{ts}_raw.jpg'), roi)
        cv2.imwrite(os.path.join(self.debug_dir, f'bay{bay + 1}_{ts}_bin.jpg'), binary)


# ══════════════════════════════════════════════════════════════

def make_counter(debug=False):
    """按配置创建计数器。没装 OpenCV 时返回 None，让调用方降级处理。"""
    if not HAS_CV2:
        return None
    d = None
    if debug:
        d = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'debug_shots')
    return PillCounter(debug_dir=d)
