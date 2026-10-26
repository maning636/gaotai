#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把「选择器 -> CSS 声明块」形态的排版主题翻译成稿台的排版样式包。

这是一次性的翻译器变成可重复的流程：**以后看到一套好看的排版，
下载下来、跑一遍这个脚本、编译打包，就进稿台了。**

输入要求（大多数排版主题都长这样）：
    每个主题一个 js（或 json），内容是 { name, styles: { 选择器: 声明;声明;... } }
    选择器名用标准 CSS 名：container / h1 / h2 / h3 / h4 / p / strong / em /
    a / ul / ol / li / blockquote / code / pre / hr / img / table / th / td / tr

用法：
    python scripts/translate-theme-to-pack.py <主题目录> <输出目录> [前缀]

前缀默认 rico-，产出 <前缀><主题名>.json，直接放进 resources/layout-packs/ 即成内置模板。

**授权是这一步的第一件事，不是最后一步。**
本脚本只做翻译，不判断许可——把上游带 AGPL 或无许可证的主题喂进来，
等于把别人的作品塞进自己的分发物。接任何新主题之前先查清它的许可：
- MIT / Apache-2.0 / BSD：可翻译可分发，但要保留版权声明与许可声明。
- AGPL：不许混进非 AGPL 的项目里。
- 无许可证：著作权默认归作者，不能抄。

本目录下的 21 套是这么接进来的：
    来源 github.com/ricocc/rico-md（MIT, Copyright (c) 2024-2026 Rico）
    只用 MIT 覆盖的部分（顶层 21 个主题，零 gzh 依赖）；
    gzh/ 目录与 gzh-design-skill.js 是 AGPL-3.0-or-later（甲木 x 摸鱼小李），整套不碰。

翻译不是照抄：
- 上游是「选择器 -> CSS 声明块」，稿台的部件是「部件 key -> HTML 模板」；
  这里按部件模型重新组装 HTML，标签与占位符都换成稿台自己的。
- 颜色提取成变量（text/heading/muted/codeBg/codeText/border/surface + accent），
  所以「改一个色值全篇跟着变」在导入的主题里同样成立。
- !important 与字体栈里的双引号会被去掉：行内样式里 !important 没有意义，
  而双引号会被稿台的清洗器当成非法字符整条丢掉（引号去掉后字体栈依然合法）。
- h2/h3/h4 拆成三个部件：主题给每一级标题配的样式差别很大（字号、边框、斜体、大写），
  合并会把层次糊掉。

翻译完必须验（这一步不能省）：
    用稿台的清洗器逐部件比对「清洗前 vs 清洗后」丢了什么，
    再端到端渲染一篇样稿看有没有残留占位符。
    本仓库的 .tmp/check-packs.ts 与 .tmp/render-pack.ts 就是干这个的。
"""
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ── 部件映射 ──────────────────────────────────────────────────────────────
#
# rico 选择器 → 稿台部件 key。标签与占位符由稿台的部件模板决定。
#
# h2/h3/h4 在主题里差别很大（字号、字重、边框、斜体、大写），
# 合并成一个 heading 会把主题的层次糊掉，所以稿台的部件目录扩了
# heading3 / heading4 两级。

# 每个部件：rico 取哪个选择器、标签、额外前后缀
PART_MAP = [
    # key,        选择器,      标签,          前缀,                后缀
    ("root",      "container", "section",     "",                  ""),
    ("title",     "h1",        "{{tag}}",     "",                  ""),
    ("heading",   "h2",        "{{tag}}",     "",                  ""),
    ("heading3",  "h3",        "{{tag}}",     "",                  ""),
    ("heading4",  "h4",        "{{tag}}",     "",                  ""),
    ("paragraph", "p",         "p",           "",                  ""),
    ("strong",    "strong",    "strong",      "",                  ""),
    ("em",        "em",        "em",          "",                  ""),
    ("inlineCode", "code",     "code",        "",                  ""),
    ("code",      "pre",       "pre",         "",                  ""),
    ("quote",     "blockquote", "blockquote", "",                  ""),
    ("list",      "ul",        "{{tag}}",     "",                  ""),
    ("listItem",  "li",        "li",          "",                  ""),
    ("link",      "a",         "a",           "",                  ""),
    ("tableHead", "th",        "th",          "",                  ""),
    ("tableCell", "td",        "td",          "",                  ""),
    ("table",     "table",     "table",       "",                  ""),
    ("image",     "img",       "img",         "",                  ""),
    ("divider",   "hr",        "hr",          "",                  ""),
]

# 这些部件的 html 不是「标签 + {{content}}」的简单形状，单独写。
SPECIAL_HTML = {
    # 列表：ol 有 start 属性（有序列表从第几项开始）
    "list": '<{{tag}}{{start}} style="{style}">{{content}}</{{tag}}>',
    # 链接：href 来自渲染上下文
    "link": '<a href="{{href}}" style="{style}">{{content}}</a>',
    # 图片：src / alt 来自渲染上下文
    "image": '<img src="{{src}}" alt="{{alt}}" style="{style}" />',
    # 分隔线：没有内容
    "divider": '<hr style="{style}">',
    # 表格：外面套一层横向滚动容器，窄屏上表格不把版式撑破
    "table": (
        '<section style="overflow-x: auto; max-width: 100%;">'
        '<table style="{style}">{{thead}}{{tbody}}</table></section>'
    ),
}

# ── 变量提取规则 ──────────────────────────────────────────────────────────
#
# 主题里的颜色写法五花八门（hex、rgba），这里按「语义位置」挑值，
# 再把所有等于该值的颜色替换成 {{变量名}}。
#
# 只挑 7 个标准变量 + 1 个自定义变量（accent）：挑多了语义会乱
# （比如把 quote 的底色也提成变量，用户改的时候分不清是哪个）。

VARIABLE_RULES = [
    # (变量名, 取哪个选择器的哪个属性)
    ("text",     "p",          "color"),
    ("heading",  "h1",         "color"),
    ("muted",    "blockquote",  "color"),
    ("codeBg",   "pre",        "background-color"),
    ("codeText", "code",       "color"),
    ("surface",  "th",         "background-color"),
    ("border",   "hr",         "border-top"),
    ("accent",   "a",          "color"),
]


def parse_theme(path):
    """从主题 js 里抠出 { name, styles }。"""
    src = open(path, encoding="utf-8").read()
    m = re.search(r"export const theme = (\{.*\});?\s*$", src, re.S)
    if not m:
        raise ValueError(f"认不出主题文件：{path}")
    obj = json.loads(m.group(1))
    return obj.get("name") or os.path.basename(path), obj.get("styles") or {}


def split_declarations(css):
    """把 CSS 声明块拆成 [(prop, value)]，顺带清掉 !important 与双引号。"""
    out = []
    for piece in css.split(";"):
        if ":" not in piece:
            continue
        prop, value = piece.split(":", 1)
        prop = prop.strip().lower()
        value = value.strip()
        if not prop or not value:
            continue
        # !important 在行内样式里没有意义，而且 ! 不在稿台清洗器的白名单里，
        # 留着会让整条声明被丢掉。
        value = re.sub(r"\s*!\s*important\s*$", "", value, flags=re.I).strip()
        # 字体栈里的双引号同理：双引号会被清洗器当成非法字符。
        # 去掉之后 "-apple-system, BlinkMacSystemFont, Segoe UI, ..." 依然合法。
        value = value.replace('"', "").replace("'", "")
        if not value:
            continue
        out.append((prop, value))
    return out


def render_style(decls):
    """声明列表 → 行内 style 字符串。"""
    return "; ".join(f"{prop}: {value}" for prop, value in decls)


def pick_value(decls, prop):
    for name, value in decls:
        if name == prop:
            return value
    return ""


def build_pack(name, styles, source_label):
    """主题 → 稿台样式包（name / vars / parts）。"""
    parsed = {key: split_declarations(styles.get(key, "")) for key in styles}

    # 1) 提取变量
    vars = {}
    for var_name, selector, prop in VARIABLE_RULES:
        value = pick_value(parsed.get(selector, []), prop)
        if value:
            vars[var_name] = value

    # border 规则特殊：hr 的 border-top 是 "1px solid #xxx"，
    # 取的是整串而不是颜色。改成取其中的颜色部分。
    if "border" in vars:
        border = vars["border"]
        color = re.search(r"(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))", border)
        vars["border"] = color.group(1) if color else border

    # 2) 同值的变量只留一个。
    #
    # 两个变量取到同一个颜色时（比如 h1 和 p 都是 #1a1a1a），
    # 替换会互相抢：先替换的那个把颜色换成了 {{text}}，
    # 后一个就再也匹配不上，于是界面上出现一个「改了没反应」的变量。
    # 所以这里按值去重，只留先出现的那个。
    seen_values = {}
    deduped = {}
    for var_name, value in vars.items():
        if value in seen_values:
            continue
        seen_values[value] = var_name
        deduped[var_name] = value
    vars = deduped

    # 3) 生成部件 html，并把颜色换成变量占位。
    #
    # 用一次扫描而不是逐个 replace：逐个 replace 会出现「值是另一个值子串」
    # 时的部分替换（#111 被 #111111 抢先匹配）。
    color_re = re.compile(r"(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))")

    def to_vars(text):
        def sub(match):
            value = match.group(1)
            var_name = seen_values.get(value)
            return "{{" + var_name + "}}" if var_name else value

        return color_re.sub(sub, text)

    parts = []
    for key, selector, tag, _prefix, _suffix in PART_MAP:
        decls = parsed.get(selector, [])
        if not decls:
            continue
        style = to_vars(render_style(decls))
        if key in SPECIAL_HTML:
            html = SPECIAL_HTML[key].replace("{style}", style)
        else:
            html = f'<{tag} style="{style}">{{{{content}}}}</{tag}>' if tag != "hr" else f'<hr style="{style}">'
        parts.append((key, html))

    # 4) 删掉没被用到的变量。
    # 界面上会把这些变量列出来让人改，留着「改了没反应」的项只会误导人。
    used = set()
    for _key, html in parts:
        for found in re.findall(r"\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}", html):
            used.add(found)
    vars = {name: value for name, value in vars.items() if name in used}

    return {
        "name": name,
        "description": f"源自 {source_label} 的「{name}」主题。",
        "source": "imported",
        "vars": vars,
        "parts": {key: {"html": html} for key, html in parts},
    }


def main():
    if len(sys.argv) < 3:
        print("用法：python scripts/translate-theme-to-pack.py <主题目录> <输出目录> [前缀] [上游标识]")
        return 1
    src_dir, out_dir = sys.argv[1], sys.argv[2]
    prefix = sys.argv[3] if len(sys.argv) > 3 else "rico-"
    source_label = sys.argv[4] if len(sys.argv) > 4 else "rico-md"
    os.makedirs(out_dir, exist_ok=True)

    # 只取顶层 *.js：index.js 是注册表、gzh-design-skill.js 是 AGPL 入口，都不要。
    files = sorted(
        f for f in os.listdir(src_dir)
        if f.endswith(".js") and f not in ("index.js", "gzh-design-skill.js")
    )
    # gzh/ 子目录是 AGPL，整个跳过。
    if os.path.isdir(os.path.join(src_dir, "gzh")):
        print("[skip] gzh/ 目录是 AGPL-3.0-or-later（甲木×摸鱼小李），不碰")

    written = []
    for f in files:
        name, styles = parse_theme(os.path.join(src_dir, f))
        pack = build_pack(name, styles, source_label)
        slug = f[:-3]
        target = os.path.join(out_dir, f"{prefix}{slug}.json")
        with open(target, "w", encoding="utf-8") as handle:
            json.dump(pack, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        written.append((slug, name, len(pack["parts"]), len(pack["vars"])))

    print(f"[translate-theme-to-pack] 生成 {len(written)} 套样式包 -> {out_dir}")
    for slug, name, parts, vars_count in written:
        print(f"  - {prefix}{slug:22s} {name:12s} 部件 {parts:2d}  变量 {vars_count}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
