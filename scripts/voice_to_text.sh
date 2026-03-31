#!/bin/bash
# 飞书语音转文本脚本
# 用法：bash voice_to_text.sh -i audio.ogg

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$(dirname "$SCRIPT_DIR")"
WHISPER_MODEL="${WHISPER_MODEL:-small}"
WHISPER_MODEL_DIR="${WHISPER_MODEL_DIR:-$HOME/.openclaw/tmp/whisper-models}"
WHISPER_BEAM_SIZE="${WHISPER_BEAM_SIZE:-5}"
WHISPER_BEST_OF="${WHISPER_BEST_OF:-5}"
OPENCLAW_STDOUT_ONLY="${OPENCLAW_STDOUT_ONLY:-false}"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_stderr() {
    printf '%s\n' "$*" >&2
}

# 打印帮助
print_help() {
    cat << EOF
🎤 Feishu voice chat - 语音转文本功能

用法：bash $0 [选项]

选项:
  -i, --input <file>       输入音频文件（支持 .ogg, .mp3, .wav 等）
  -l, --language <lang>    语言（默认：Chinese）
  -m, --model <model>      Whisper 模型（默认：small，可选：tiny/base/small/medium/large）
  -o, --output <file>      输出文本文件路径
  --list-languages         列出支持的语言
  -h, --help              显示帮助

支持的语言:
  Chinese                  中文（推荐）
  English                  英语
  Japanese                 日语
  Korean                   韩语
  French                   法语
  German                   德语
  Spanish                  西班牙语

示例:
  bash $0 -i voice.ogg
  bash $0 -i voice.ogg -l English
  bash $0 -i voice.ogg -m small
  bash $0 -i voice.ogg -o result.txt
  bash $0 --list-languages

EOF
}

# 检查 whisper 是否可用
check_whisper() {
    if ! command -v whisper &> /dev/null; then
        log_stderr "$(printf "${RED}❌ 错误：未安装 whisper${NC}")"
        log_stderr "请安装 whisper 语音转文字工具："
        log_stderr "1. 安装 Python：pip install openai-whisper"
        log_stderr "2. 或使用其他语音转文字服务"
        return 1
    fi
    mkdir -p "$WHISPER_MODEL_DIR"
    return 0
}

# 列出支持的语言
list_languages() {
    printf "${BLUE}🌍 支持的语言列表：${NC}\n"
    printf "Chinese (中文)\n"
    printf "English (英语)\n"
    printf "Japanese (日语)\n"
    printf "Korean (韩语)\n"
    printf "French (法语)\n"
    printf "German (德语)\n"
    printf "Spanish (西班牙语)\n\n"
    printf "更多语言请参考 whisper 文档\n"
}

# 转换语音为文本
convert_audio_to_text() {
    local input_file="$1"
    local language="$2"
    local output_file="$3"
    
    log_stderr "$(printf "${BLUE}🎤 开始语音转文字...${NC}")"
    log_stderr "输入文件：$input_file"
    log_stderr "语言：$language"
    log_stderr ""
    
    # 检查输入文件
    if [ ! -f "$input_file" ]; then
        echo -e "${RED}❌ 错误：输入文件不存在${NC}" >&2
        return 1
    fi
    
    # 使用 whisper 转换
    if command -v whisper &> /dev/null; then
        log_stderr "$(printf "${BLUE}🔊 使用 whisper 转换...${NC}")"

        local temp_dir
        temp_dir="$(mktemp -d)"
        local base_name
        base_name="$(basename "$input_file")"
        base_name="${base_name%.*}"
        local temp_output="$temp_dir/${base_name}.txt"
        local normalized_audio="$temp_dir/${base_name}.wav"
        local whisper_lang="$language"
        local initial_prompt=""

        case "$language" in
            Chinese|中文|zh|zh-CN|zh_cn)
                whisper_lang="zh"
                initial_prompt="以下是普通话中文语音转写。"
                ;;
            English|英文|en|en-US|en_us)
                whisper_lang="en"
                ;;
            Japanese|日语|ja|ja-JP|ja_jp)
                whisper_lang="ja"
                ;;
            Korean|韩语|ko|ko-KR|ko_kr)
                whisper_lang="ko"
                ;;
        esac

        # 预处理：统一 16k 单声道并做轻度带通滤波，提升识别准确率
        if ! ffmpeg -y -i "$input_file" -ac 1 -ar 16000 -af "highpass=f=80,lowpass=f=7600,volume=1.8" "$normalized_audio" >/dev/null 2>&1; then
            log_stderr "$(printf "${YELLOW}⚠️ 音频预处理失败，回退原始音频识别${NC}")"
            normalized_audio="$input_file"
        fi

        # 运行 whisper（whisper 输出文件名是 <basename>.txt）
        local -a whisper_args
        whisper_args=(
            --language "$whisper_lang"
            --model "$WHISPER_MODEL"
            --model_dir "$WHISPER_MODEL_DIR"
            --beam_size "$WHISPER_BEAM_SIZE"
            --best_of "$WHISPER_BEST_OF"
            --temperature 0
            --fp16 False
            --output_format txt
            --output_dir "$temp_dir"
        )
        if [ -n "$initial_prompt" ]; then
            whisper_args+=(--initial_prompt "$initial_prompt")
        fi
        if ! whisper "$normalized_audio" "${whisper_args[@]}" >/dev/null 2>&1; then
            echo -e "${RED}❌ 错误：whisper 执行失败${NC}" >&2
            rm -rf "$temp_dir"
            return 1
        fi
        
        # 读取结果
        if [ -f "$temp_output" ]; then
            local result=$(cat "$temp_output" | tr -d '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
            
            # 保存到输出文件
            if [ -n "$output_file" ]; then
                echo "$result" > "$output_file"
                log_stderr "$(printf "${GREEN}✅ 文本已保存到：$output_file${NC}")"
            fi
            
            if [ "$OPENCLAW_STDOUT_ONLY" != "true" ]; then
                log_stderr "$(printf "${GREEN}📝 转换结果：${NC}")"
                log_stderr "$result"
            fi
            
            # 清理临时文件
            rm -rf "$temp_dir"
            printf '%s\n' "$result"
            return 0
        else
            echo -e "${RED}❌ 错误：未找到 whisper 输出文件${NC}" >&2
            rm -rf "$temp_dir"
            return 1
        fi
    else
        log_stderr "$(printf "${RED}❌ 错误：未找到 whisper 命令${NC}")"
        return 1
    fi
}

# 解析参数
INPUT_FILE=""
LANGUAGE="Chinese"
OUTPUT_FILE=""
MODEL=""
LIST_LANGUAGES=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -i|--input)
            INPUT_FILE="$2"
            shift 2
            ;;
        -l|--language)
            LANGUAGE="$2"
            shift 2
            ;;
        -m|--model)
            MODEL="$2"
            shift 2
            ;;
        -o|--output)
            OUTPUT_FILE="$2"
            shift 2
            ;;
        --list-languages)
            LIST_LANGUAGES=true
            shift
            ;;
        --openclaw-stdout-only)
            OPENCLAW_STDOUT_ONLY="true"
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

# 列出语言模式
if [ "$LIST_LANGUAGES" = true ]; then
    list_languages
    exit 0
fi

# 检查必需参数
if [ -z "$INPUT_FILE" ]; then
    echo -e "${RED}❌ 错误：必须提供 -i 输入文件${NC}"
    print_help
    exit 1
fi

if [ -n "$MODEL" ]; then
    WHISPER_MODEL="$MODEL"
fi

# 检查 whisper
if ! check_whisper; then
    exit 1
fi

# 执行转换
if ! convert_audio_to_text "$INPUT_FILE" "$LANGUAGE" "$OUTPUT_FILE"; then
    exit 1
fi

if [ "$OPENCLAW_STDOUT_ONLY" != "true" ]; then
    log_stderr "$(printf "${GREEN}✅ 语音转文字完成${NC}")"
fi
