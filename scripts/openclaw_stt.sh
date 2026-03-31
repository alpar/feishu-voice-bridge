#!/bin/bash
# 面向 feishu-voice-bridge 的 OpenClaw 原生 STT 包装脚本。
# 只向 stdout 输出转写结果，方便 OpenClaw 直接消费。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

INPUT_FILE="${1:-}"
LANGUAGE="${OPENCLAW_STT_LANGUAGE:-zh-CN}"
MODEL="${OPENCLAW_STT_MODEL:-small}"

if [ -z "$INPUT_FILE" ]; then
    echo "缺少输入音频路径" >&2
    exit 1
fi

exec bash "$SCRIPT_DIR/voice_to_text.sh" \
    --openclaw-stdout-only \
    -i "$INPUT_FILE" \
    -l "$LANGUAGE" \
    -m "$MODEL"
