"""Bounded demo vocabulary, separate from interface translation resources.

These aliases identify actions, not translated data. New input languages can
add aliases without changing stable action or asset IDs.
"""
import re

ASSET_ALIASES = {
    'cherry': ('cherry', 'sakura', '樱花', '櫻花'),
    'bench': ('bench', 'benches', '长椅', '長椅'),
    'lantern': ('lantern', 'lamppost', 'lamp post', '灯笼', '灯柱', '燈籠', '燈柱'),
    'meadow': ('lavender', 'meadow', '薰衣草'),
}
ACTION_ALIASES = {
    'undo': ('undo', '撤销', '撤銷'),
    'delete': ('delete', 'remove', '删除', '移除', '刪除'),
    'move': ('move', 'shift', '移动', '挪', '向左', '向右', '往左', '往右', '移動'),
    'constraint': ('constraint', 'preserve', 'keep', 'reference image', 'material', 'texture', 'style', '约束', '保持', '参考图', '材质', '纹理', '风格', '約束', '參考圖', '材質', '紋理', '風格'),
    'create': ('create', 'add', 'place', 'plant', 'generate', '新增', '添加', '生成', '放置', '放一', '种一', '创建', '種一', '創建'),
}
CHINESE_NUMERALS = {'一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10}


def contains_alias(prompt, alias):
    if alias.isascii():
        return bool(re.search(r'(?<![a-z])' + re.escape(alias) + r'(?![a-z])', prompt, re.I))
    return alias in prompt


def demo_intent(prompt, chosen=None):
    material = next((asset for asset, aliases in ASSET_ALIASES.items() if any(contains_alias(prompt, alias) for alias in aliases)), chosen or '')
    action = next((action for action, aliases in ACTION_ALIASES.items() if any(contains_alias(prompt, alias) for alias in aliases)), 'replace')
    return material, 'future' if material == 'meadow' and action not in {'undo', 'delete', 'move', 'constraint'} else action


def movement_distance(prompt):
    numeric = re.search(r'(-?\d+(?:\.\d+)?)\s*(?:米|met(?:er|re)s?\b|m\b)', prompt, re.I)
    chinese = re.search(r'([一二两三四五六七八九十])\s*米', prompt)
    return float(numeric[1]) if numeric else CHINESE_NUMERALS[chinese[1]] if chinese else 2
