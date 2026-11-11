#!/usr/bin/env python3
"""
Idempotent config patching for the MiMo Coding Plan provider.

Writes the same provider into two places:

  1. MiMo Code  ~/.config/mimocode/mimocode.jsonc
     apiKey is the literal string "{env:MIMO_API_KEY}" — MiMo Code substitutes
     {env:VAR} at config-load time, so the real key never touches this file.

  2. DSH        ~/.dsh/profiles/<profile>/cordis.patch.yml
     apiKeyEnv: MIMO_API_KEY — DSH reads the named env var, which the launcher
     populates from the macOS keychain.

Backed up before the first edit. Re-running updates the block in place rather
than duplicating it, and the DSH file is verified afterwards: every pre-existing
provider must survive with an identical model list.

usage: patch-configs.py [--profile desktop] [--dry-run]
"""

import argparse
import json
import os
import re
import shutil
import time
from pathlib import Path

BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1"
PROVIDER_ID = "mimo-coding-plan"
DISPLAY_NAME = "MiMo Coding Plan"

# Coding Plan 的对话模型。ASR / TTS 走的是不同接口（MiMoCode 的 voice 配置），
# 不是对话模型，所以不在这里。
MODELS = [
    {"id": "mimo-v2.6-pro", "name": "MiMo-V2.6-Pro",
     "contextWindow": 262144, "maxTokens": 65536, "input": ["text", "image"]},
    {"id": "mimo-v2.6-flash", "name": "MiMo-V2.6-Flash",
     "contextWindow": 262144, "maxTokens": 65536, "input": ["text", "image"]},
    # 官方公告：mimo-v2.5 / mimo-v2.5-pro 将于 2026-10-21 10:00 (UTC+8) 下线。
    {"id": "mimo-v2.5-pro", "name": "MiMo-V2.5-Pro",
     "contextWindow": 262144, "maxTokens": 65536, "input": ["text", "image"]},
    {"id": "mimo-v2.5", "name": "MiMo-V2.5",
     "contextWindow": 262144, "maxTokens": 65536, "input": ["text", "image"]},
]

MIMO_CONFIG = Path.home() / ".config" / "mimocode" / "mimocode.jsonc"
DSH_PATCH = str(Path.home() / ".dsh" / "profiles" / "{profile}" / "cordis.patch.yml")

BEGIN = "      # >>> mimo-coding-plan >>> (由 mimo-webui/scripts/patch-configs.py 生成)"
END = "      # <<< mimo-coding-plan <<<"

# 早期版本用过的 provider id，迁移时清掉
LEGACY_IDS = ["mimoplan", "mimo-token-plan"]


def backup(path):
    if not path.exists():
        return
    stamp = time.strftime("%Y%m%d_%H%M%S")
    dest = path.with_suffix(path.suffix + ".bak-" + stamp)
    shutil.copy2(path, dest)
    print("  · 备份", dest)


def patch_mimocode(dry):
    print("MiMo Code 配置：", MIMO_CONFIG)
    if not MIMO_CONFIG.exists():
        print("  ! 配置文件不存在，跳过")
        return
    text = MIMO_CONFIG.read_text(encoding="utf-8")
    plain = re.sub(r"^\s*//.*$", "", text, flags=re.M)
    try:
        data = json.loads(plain)
    except json.JSONDecodeError as exc:
        print("  ! 不是合法 JSON，跳过：", exc)
        return

    providers = data.setdefault("provider", {})
    removed = [pid for pid in LEGACY_IDS if pid in providers and pid != PROVIDER_ID]
    for pid in removed:
        providers.pop(pid)
        print("  · 移除旧的 provider", pid)

    desired = {
        "npm": "@ai-sdk/openai-compatible",
        "name": DISPLAY_NAME,
        "only_configured_models": True,
        "models": {m["id"]: {"name": m["name"]} for m in MODELS},
        "options": {
            "baseURL": BASE_URL,
            # Substituted from the environment at load time; never a literal key.
            "apiKey": "{env:MIMO_API_KEY}",
        },
    }

    if providers.get(PROVIDER_ID) == desired and not removed:
        print("  · 已是最新，跳过")
        return
    if dry:
        print("  · dry-run，未写入")
        return
    backup(MIMO_CONFIG)
    providers[PROVIDER_ID] = desired
    MIMO_CONFIG.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(MIMO_CONFIG, 0o600)
    print("  ✓ provider %s 已就绪（%d 个模型）" % (PROVIDER_ID, len(MODELS)))


def dsh_block():
    lines = [BEGIN, "      %s:" % PROVIDER_ID,
             "        displayName: %s" % DISPLAY_NAME,
             "        apiKeyEnv: MIMO_API_KEY",
             "        api: openai-completions",
             "        baseURL: %s" % BASE_URL,
             "        models:"]
    for m in MODELS:
        lines.append("          - id: %s" % m["id"])
        lines.append("            name: %s" % m["name"])
        lines.append("            contextWindow: %s" % m["contextWindow"])
        lines.append("            maxTokens: %s" % m["maxTokens"])
        lines.append("            input:")
        for mod in m["input"]:
            lines.append("              - %s" % mod)
    lines.append(END)
    return "\n".join(lines)


def patch_dsh(profile, dry):
    path = Path(DSH_PATCH.format(profile=profile))
    print("DSH 配置：", path)
    if not path.exists():
        print("  ! 配置文件不存在，跳过")
        return
    text = path.read_text(encoding="utf-8")

    # Drop any previously generated block (BEGIN..END), then re-insert.
    kept, in_block = [], False
    for line in text.splitlines():
        if line.strip() == BEGIN.strip():
            in_block = True
            continue
        if in_block:
            if line.strip() == END.strip():
                in_block = False
            continue
        kept.append(line)
    lines = kept

    # Top-level loader entries start at column 0. Match the RAW line: a stripped
    # match would also hit the nested `- id: <model>` entries under `models:`.
    start = None
    for i, line in enumerate(lines):
        if re.match(r"^- id: llm-pi-ai$", line):
            start = i
            break
    if start is None:
        print("  ! 没找到 llm-pi-ai 条目，跳过（未改动文件）")
        return

    end = len(lines)
    for i in range(start + 1, len(lines)):
        if re.match(r"^- id: ", lines[i]):
            end = i
            break

    block_lines = lines[start:end]
    providers_at = next((i for i, l in enumerate(block_lines)
                         if re.match(r"^    providers:$", l)), None)
    if providers_at is None:
        print("  ! llm-pi-ai 条目里没有 providers 块，跳过（未改动文件）")
        return

    provider_keys = [l for l in block_lines[providers_at + 1:] if re.match(r"^      \S", l)]
    if not provider_keys:
        print("  ! providers 块里没有条目，跳过（未改动文件）")
        return

    insert_at = start + providers_at + 1
    new_lines = lines[:insert_at] + dsh_block().splitlines() + lines[insert_at:]
    new_text = "\n".join(new_lines) + "\n"

    if dry:
        print("  · dry-run，未写入")
        return

    # Safety net: purely additive. Every pre-existing provider must survive
    # with an identical model list.
    try:
        import yaml
        before = yaml.safe_load(text)
        after = yaml.safe_load(new_text)
    except Exception as exc:
        print("  ! YAML 校验失败，未写入：", exc)
        return

    def providers_of(doc):
        for e in doc or []:
            if e.get("id") == "llm-pi-ai":
                return e.get("config", {}).get("providers", {})
        return {}

    b, a = providers_of(before), providers_of(after)
    broken = [k for k in b if k not in a or a[k] != b[k]]
    if broken:
        print("  ! 校验失败（%s 被破坏），未写入" % broken)
        return

    backup(path)
    path.write_text(new_text, encoding="utf-8")
    print("  ✓ provider %s 已就绪（原有 %d 个 provider 全部完好）" % (PROVIDER_ID, len(b)))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default="desktop")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    print("=== MiMo Coding Plan 配置补丁 ===")
    patch_mimocode(args.dry_run)
    patch_dsh(args.profile, args.dry_run)
    print("完成。")
