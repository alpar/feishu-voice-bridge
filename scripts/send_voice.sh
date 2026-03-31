#!/bin/bash
# 集成到 OpenClaw 的飞书 TTS 发送脚本。
# 当环境变量未设置时，会从 ~/.openclaw/openclaw.json 读取飞书凭证。

set -e

# 默认配置
DEFAULT_VOICE="zh-CN-XiaoxiaoNeural"
DEFAULT_RATE="+30"
DEFAULT_PITCH="0"

VOICE="$DEFAULT_VOICE"
RATE="$DEFAULT_RATE"
PITCH="$DEFAULT_PITCH"
TEXT=""
OUTPUT_FILE=""
LIST_VOICES=false
NO_SEND=false
REPLY_TO=""
CHAT_ID=""
RECEIVE_ID_TYPE=""

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'
OPENCLAW_JSON="${OPENCLAW_JSON:-$HOME/.openclaw/openclaw.json}"

json_escape() {
    python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])'
}

normalize_message_id() {
    local raw_id="$1"
    local normalized_id="${raw_id%%:*}"
    printf '%s' "$normalized_id"
}

format_rate_value() {
    local raw_value="$1"
    if [ -z "$raw_value" ] || [ "$raw_value" = "0" ]; then
        return 0
    fi
    if [[ "$raw_value" == *% ]]; then
        printf '%s' "$raw_value"
        return 0
    fi
    printf '%s%%' "$raw_value"
}

format_pitch_value() {
    local raw_value="$1"
    if [ -z "$raw_value" ] || [ "$raw_value" = "0" ]; then
        return 0
    fi
    if [[ "$raw_value" == *Hz ]] || [[ "$raw_value" == *hz ]] || [[ "$raw_value" == *% ]]; then
        printf '%s' "$raw_value"
        return 0
    fi
    printf '%sHz' "$raw_value"
}

resolve_receive_id_type() {
    local raw_target="$1"
    if [[ "$raw_target" == oc_* ]]; then
        printf 'chat_id'
        return 0
    fi
    if [[ "$raw_target" == ou_* ]]; then
        printf 'open_id'
        return 0
    fi
    printf 'open_id'
}

read_openclaw_config_value() {
    local field_path="$1"
    python3 - "$OPENCLAW_JSON" "$field_path" <<'PY'
import json
import sys

config_path, field_path = sys.argv[1], sys.argv[2]
try:
    with open(config_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
except Exception:
    print("")
    raise SystemExit(0)

value = data
for part in field_path.split("."):
    if not isinstance(value, dict):
        print("")
        raise SystemExit(0)
    value = value.get(part, "")
    if value == "":
        break

print(value if isinstance(value, str) else "")
PY
}

load_feishu_config_if_needed() {
    if [ -z "${FEISHU_APP_ID:-}" ] && [ -f "$OPENCLAW_JSON" ]; then
        FEISHU_APP_ID="$(read_openclaw_config_value "channels.feishu.appId")"
        export FEISHU_APP_ID
    fi
    if [ -z "${FEISHU_APP_SECRET:-}" ] && [ -f "$OPENCLAW_JSON" ]; then
        FEISHU_APP_SECRET="$(read_openclaw_config_value "channels.feishu.appSecret")"
        export FEISHU_APP_SECRET
    fi
    if [ -z "${FEISHU_CHAT_ID:-}" ] && [ -f "$OPENCLAW_JSON" ]; then
        FEISHU_CHAT_ID="$(read_openclaw_config_value "channels.feishu.chatId")"
        export FEISHU_CHAT_ID
    fi
}

# 打印帮助
print_help() {
    cat << EOF
🎤 Feishu voice chat - 微软免费 TTS 发送飞书语音条

用法：bash $0 [选项]

选项:
  -t, --text <text>       要转换的文字（必需）
  -v, --voice <voice>     音色名称（默认：zh-CN-XiaoxiaoNeural）
  -r, --rate <0>          语速（支持 10 / +10 / +10%，默认 0）
  -p, --pitch <0>         音调（支持 5 / +5Hz / +5%，默认 0）
  -o, --output <file>     输出音频文件路径
  -c, --chat-id <id>      指定 chat_id（覆盖 FEISHU_CHAT_ID）
  --receive-id-type <t>   指定接收方类型：chat_id / open_id / user_id
  --reply-to <message_id> 回复到指定消息（om_xxx）
  --list-voices           列出所有可用音色
  --no-send               只生成音频，不发送
  -h, --help              显示帮助

常用音色:
  zh-CN-XiaoxiaoNeural    女声，温暖亲切（推荐）
  zh-CN-YunxiNeural       男声，沉稳专业
  zh-CN-YunjianNeural     男声，激情澎湃
  zh-CN-XiaoyiNeural      女声，活泼可爱
  en-US-JennyNeural       女声，美式英语

示例:
  bash $0 -t "主人晚上好～"
  bash $0 -t "Hello!" -v en-US-JennyNeural
  bash $0 -t "你好" --rate 10 --pitch 5
  bash $0 -t "收到" --reply-to om_xxx
  bash $0 --list-voices

EOF
}

# 列出所有可用音色
list_voices() {
    echo -e "${BLUE}🎤 获取可用音色列表...${NC}"
    
    if command -v edge-tts &> /dev/null; then
        edge-tts --list-voices 2>/dev/null | grep -E "zh-CN|zh-HK|zh-TW|en-US|en-GB" | head -30
    else
        echo "未安装 edge-tts，请先运行：pip install edge-tts"
    fi
}

# 解析参数
while [[ $# -gt 0 ]]; do
    case $1 in
        -t|--text)
            TEXT="$2"
            shift 2
            ;;
        -v|--voice)
            VOICE="$2"
            shift 2
            ;;
        -r|--rate)
            RATE="$2"
            shift 2
            ;;
        -p|--pitch)
            PITCH="$2"
            shift 2
            ;;
        -o|--output)
            OUTPUT_FILE="$2"
            shift 2
            ;;
        -c|--chat-id)
            CHAT_ID="$2"
            shift 2
            ;;
        --receive-id-type)
            RECEIVE_ID_TYPE="$2"
            shift 2
            ;;
        --reply-to)
            REPLY_TO="$2"
            shift 2
            ;;
        --list-voices)
            LIST_VOICES=true
            shift
            ;;
        --no-send)
            NO_SEND=true
            shift
            ;;
        -h|--help)
            print_help
            exit 0
            ;;
        *)
            echo -e "${RED}❌ 未知选项：$1${NC}"
            print_help
            exit 1
            ;;
    esac
done

# 列出音色模式
if [ "$LIST_VOICES" = true ]; then
    list_voices
    exit 0
fi

# 检查必需参数
if [ -z "$TEXT" ]; then
    echo -e "${RED}❌ 错误：必须提供 -t 文字${NC}"
    print_help
    exit 1
fi

# 检查 edge-tts 是否安装
if ! command -v edge-tts &> /dev/null; then
    echo -e "${RED}❌ 错误：未安装 edge-tts${NC}"
    echo "请运行：pip install edge-tts"
    exit 1
fi

# 检查环境变量（发送时需要）
if [ "$NO_SEND" = false ]; then
    load_feishu_config_if_needed
    if [ -z "$FEISHU_APP_ID" ] || [ -z "$FEISHU_APP_SECRET" ]; then
        echo -e "${RED}❌ 错误：缺少 Feishu 配置${NC}"
        echo "请在 ~/.openclaw/openclaw.json 配置 channels.feishu.appId / appSecret"
        echo "或显式设置环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET"
        exit 1
    fi
fi

if [ -n "$REPLY_TO" ]; then
    REPLY_TO="$(normalize_message_id "$REPLY_TO")"
    if [[ "$REPLY_TO" == oc_* ]]; then
        echo -e "${RED}❌ 错误：--reply-to 需要 message_id（om_ 开头），当前是 chat_id: $REPLY_TO${NC}"
        exit 1
    fi
fi

if [ -z "$CHAT_ID" ]; then
    CHAT_ID="$FEISHU_CHAT_ID"
fi

if [ -n "$CHAT_ID" ] && [ -z "$RECEIVE_ID_TYPE" ]; then
    RECEIVE_ID_TYPE="$(resolve_receive_id_type "$CHAT_ID")"
fi

if [ -n "$RECEIVE_ID_TYPE" ]; then
    case "$RECEIVE_ID_TYPE" in
        chat_id|open_id|user_id)
            ;;
        *)
            echo -e "${RED}❌ 错误：--receive-id-type 仅支持 chat_id / open_id / user_id${NC}"
            exit 1
            ;;
    esac
fi

if [ "$NO_SEND" = false ] && [ -z "$REPLY_TO" ] && [ -z "$CHAT_ID" ]; then
    echo -e "${RED}❌ 错误：缺少 chat_id（请设置 FEISHU_CHAT_ID 或传 --chat-id）${NC}"
    exit 1
fi

echo -e "${BLUE}🎤 开始生成语音...${NC}"
echo "文字：$TEXT"
echo "音色：$VOICE"
DISPLAY_RATE="$(format_rate_value "$RATE")"
DISPLAY_PITCH="$(format_pitch_value "$PITCH")"
echo "语速：${DISPLAY_RATE:-0}"
echo "音调：${DISPLAY_PITCH:-0}"
echo ""

# 生成临时文件
TEMP_DIR=$(mktemp -d)
TEMP_MP3="$TEMP_DIR/voice.mp3"
TEMP_OPUS="$TEMP_DIR/voice.opus"

# 使用 edge-tts 生成语音
echo -e "${BLUE}🔊 调用 Edge TTS...${NC}"

# 构建参数
RATE_PARAM=""
if [ "$RATE" != "0" ]; then
    FORMATTED_RATE="$(format_rate_value "$RATE")"
    RATE_PARAM="--rate $FORMATTED_RATE"
fi

PITCH_PARAM=""
if [ "$PITCH" != "0" ]; then
    FORMATTED_PITCH="$(format_pitch_value "$PITCH")"
    PITCH_PARAM="--pitch $FORMATTED_PITCH"
fi

# 生成 MP3
edge-tts --voice "$VOICE" --text "$TEXT" $RATE_PARAM $PITCH_PARAM --write-media "$TEMP_MP3" 2>&1 | tail -3

if [ ! -f "$TEMP_MP3" ] || [ ! -s "$TEMP_MP3" ]; then
    echo -e "${RED}❌ 错误：语音生成失败${NC}"
    rm -rf "$TEMP_DIR"
    exit 1
fi

echo -e "${GREEN}✅ 语音生成成功${NC}"

# 转换为 OPUS 格式
echo -e "${BLUE}🔄 转换为 OPUS 格式...${NC}"
ffmpeg -i "$TEMP_MP3" -c:a libopus -b:a 32k "$TEMP_OPUS" -y 2>&1 | tail -3

if [ ! -f "$TEMP_OPUS" ] || [ ! -s "$TEMP_OPUS" ]; then
    echo -e "${RED}❌ 错误：OPUS 转换失败${NC}"
    rm -rf "$TEMP_DIR"
    exit 1
fi

echo -e "${GREEN}✅ OPUS 转换成功${NC}"

# 获取音频时长（飞书要求在上传文件时提供）
DURATION=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$TEMP_OPUS")
DURATION_MS=$(echo "$DURATION" | awk '{printf "%.0f", $1 * 1000}')

# 保存输出文件（如果指定）
if [ -n "$OUTPUT_FILE" ]; then
    cp "$TEMP_OPUS" "$OUTPUT_FILE"
    echo -e "${GREEN}✅ 已保存到：$OUTPUT_FILE${NC}"
fi

# 只生成不发送
if [ "$NO_SEND" = true ]; then
    rm -rf "$TEMP_DIR"
    echo -e "${GREEN}✅ 完成（未发送）${NC}"
    exit 0
fi

echo -e "${BLUE}📤 上传到飞书...${NC}"

# 获取 Token
TOKEN=$(curl -s -X POST "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
  -H "Content-Type: application/json" \
  -d "{\"app_id\":\"$FEISHU_APP_ID\",\"app_secret\":\"$FEISHU_APP_SECRET\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('tenant_access_token',''))")

if [ -z "$TOKEN" ]; then
    echo -e "${RED}❌ 错误：获取 Token 失败${NC}"
    rm -rf "$TEMP_DIR"
    exit 1
fi

# 上传文件
UPLOAD_RESULT=$(curl -s -X POST "https://open.feishu.cn/open-apis/im/v1/files" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file_type=opus" \
  -F "file_name=voice.opus" \
  -F "duration=$DURATION_MS" \
  -F "file=@$TEMP_OPUS")

FILE_KEY=$(echo "$UPLOAD_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('file_key',''))")

if [ -z "$FILE_KEY" ]; then
    echo -e "${RED}❌ 错误：文件上传失败${NC}"
    echo "$UPLOAD_RESULT"
    rm -rf "$TEMP_DIR"
    exit 1
fi

echo -e "${GREEN}✅ 文件上传成功，File Key: $FILE_KEY${NC}"

echo -e "${BLUE}📤 发送语音消息...${NC}"

# 发送消息
if [ -n "$REPLY_TO" ]; then
    RESULT=$(curl -s -X POST "https://open.feishu.cn/open-apis/im/v1/messages/$REPLY_TO/reply" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"msg_type\":\"audio\",\"content\":\"{\\\"file_key\\\":\\\"$FILE_KEY\\\"}\"}")
else
    RESULT=$(curl -s -X POST "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=$RECEIVE_ID_TYPE" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"receive_id\":\"$CHAT_ID\",\"msg_type\":\"audio\",\"content\":\"{\\\"file_key\\\":\\\"$FILE_KEY\\\"}\"}")
fi

MESSAGE_ID=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('message_id',''))")

# 清理临时文件
rm -rf "$TEMP_DIR"

# 检查结果
if [ -n "$MESSAGE_ID" ]; then
    echo -e "${GREEN}✅ 发送成功！${NC}"
    echo "Message ID: $MESSAGE_ID"
    if [ -n "$REPLY_TO" ]; then
        echo "Reply To: $REPLY_TO"
    else
        echo "Receive ID Type: $RECEIVE_ID_TYPE"
        echo "Target ID: $CHAT_ID"
    fi
    echo "时长：${DURATION_MS}ms (${DURATION}s)"
else
    echo -e "${RED}❌ 发送失败${NC}"
    echo "$RESULT"
    exit 1
fi
