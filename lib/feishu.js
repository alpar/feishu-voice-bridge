"use strict";

// 飞书上下文里的 target / messageId 来源很多，这里统一做归一化。
function normalizeFeishuTarget(input) {
  if (typeof input !== "string") return "";
  let target = input.trim();
  if (!target) return "";

  const prefixes = ["feishu:", "channel:", "chat:", "user:"];
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of prefixes) {
      if (target.startsWith(prefix)) {
        target = target.slice(prefix.length).trim();
        changed = true;
      }
    }
  }
  return target;
}

function normalizeFeishuMessageId(input) {
  if (typeof input !== "string") return "";
  const value = input.trim();
  if (!value) return "";
  return value.split(":")[0].trim();
}

function resolveReceiveIdType(target) {
  if (typeof target !== "string") return "";
  if (target.startsWith("oc_")) return "chat_id";
  if (target.startsWith("ou_")) return "open_id";
  return "open_id";
}

function normalizeAccountId(input) {
  return typeof input === "string" && input.trim() ? input.trim().toLowerCase() : "default";
}

// 支持多账号配置：默认账号走 base，指定账号再叠加 accounts 覆盖项。
function resolveFeishuAccountConfig(gatewayConfig, accountId) {
  const section = gatewayConfig?.channels?.feishu;
  if (!section || typeof section !== "object") return null;

  const { accounts, ...base } = section;
  const requestedId = normalizeAccountId(accountId);
  const override = requestedId !== "default" && accounts && typeof accounts === "object"
    ? accounts[requestedId]
    : undefined;

  if (override && typeof override === "object") {
    return { ...base, ...override };
  }
  return { ...base };
}

function resolveFeishuApiBaseUrl(feishuConfig) {
  const domain = typeof feishuConfig?.domain === "string" ? feishuConfig.domain.trim().toLowerCase() : "";
  if (domain.includes("lark")) return "https://open.larksuite.com";
  return "https://open.feishu.cn";
}

function summarizeJsonForLog(payload, maxLen = 240) {
  try {
    const text = JSON.stringify(payload);
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen)}...`;
  } catch {
    return String(payload);
  }
}

async function feishuJsonRequest(url, options) {
  const response = await fetch(url, options);
  const rawText = await response.text();
  let parsed = null;

  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${rawText.slice(0, 400)}`);
  }
  if (parsed && typeof parsed.code !== "undefined" && Number(parsed.code) !== 0) {
    throw new Error(`Feishu API code=${parsed.code}, msg=${parsed.msg || "unknown"}, body=${rawText.slice(0, 400)}`);
  }

  return parsed;
}

// 每次发送语音前都现取 tenant token，避免长期缓存导致账号切换或过期问题难排查。
async function getTenantAccessToken(config, logger, accountId) {
  const feishuConfig = resolveFeishuAccountConfig(config.gatewayConfig, accountId);
  const appId = typeof feishuConfig?.appId === "string" ? feishuConfig.appId.trim() : "";
  const appSecret = typeof feishuConfig?.appSecret === "string" ? feishuConfig.appSecret.trim() : "";
  if (!appId || !appSecret) {
    throw new Error(`missing Feishu credentials for account=${normalizeAccountId(accountId)}`);
  }

  const baseUrl = resolveFeishuApiBaseUrl(feishuConfig);
  const payload = await feishuJsonRequest(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret
    })
  });

  const token = typeof payload?.tenant_access_token === "string" ? payload.tenant_access_token : "";
  if (!token) {
    throw new Error(`tenant access token missing in auth response: ${summarizeJsonForLog(payload)}`);
  }

  logger?.info?.(`feishu-voice auth ok (account=${normalizeAccountId(accountId)}, appId=${appId.slice(0, 6)}***)`);
  return { token, baseUrl };
}

async function uploadAudioToFeishu(config, logger, params) {
  const { token, baseUrl } = await getTenantAccessToken(config, logger, params.accountId);
  const form = new FormData();
  form.set("file_type", params.fileType || "opus");
  form.set("file_name", params.fileName || "reply.opus");
  form.set("duration", String(params.durationMs));
  form.set("file", new Blob([params.audioBuffer], { type: params.mimeType || "audio/ogg" }), params.fileName || "reply.opus");

  const payload = await feishuJsonRequest(`${baseUrl}/open-apis/im/v1/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: form
  });

  const fileKey = typeof payload?.data?.file_key === "string" ? payload.data.file_key : "";
  if (!fileKey) {
    throw new Error(`file_key missing in upload response: ${summarizeJsonForLog(payload)}`);
  }

  logger?.info?.(`feishu-voice upload ok (account=${normalizeAccountId(params.accountId)}, fileType=${params.fileType || "opus"}, fileName=${params.fileName || "reply.opus"}, mimeType=${params.mimeType || "audio/ogg"}, durationMs=${params.durationMs}, fileKey=${fileKey})`);
  return { token, baseUrl, fileKey };
}

async function createAudioMessage(config, logger, params) {
  const { token, baseUrl, fileKey } = await uploadAudioToFeishu(config, logger, params);
  const target = normalizeFeishuTarget(params.chatId);
  const receiveIdType = resolveReceiveIdType(target);
  const content = JSON.stringify({
    file_key: fileKey
  });
  const replyToMessageId = normalizeFeishuMessageId(params.replyToMessageId);
  const url = replyToMessageId
    ? `${baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`
    : `${baseUrl}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`;
  const body = replyToMessageId
    ? {
      msg_type: "audio",
      content
    }
    : {
      receive_id: target,
      msg_type: "audio",
      content
    };
  const payload = await feishuJsonRequest(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const messageId = typeof payload?.data?.message_id === "string" ? payload.data.message_id : "";
  const chatId = typeof payload?.data?.chat_id === "string" ? payload.data.chat_id : "";
  logger?.info?.(`feishu-voice send ok (mode=${replyToMessageId ? "reply" : "create"}, target=${target}, replyTo=${replyToMessageId || "none"}, receiveIdType=${receiveIdType}, durationMs=${Number(params.durationMs) || 0}, messageId=${messageId || "unknown"}, chatId=${chatId || "unknown"})`);

  return {
    fileKey,
    messageId,
    chatId
  };
}

function isFeishuChannelContext(ctx) {
  if (typeof ctx?.channelId === "string" && ctx.channelId.toLowerCase() === "feishu") {
    return true;
  }

  const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";
  if (sessionKey.includes(":feishu:")) return true;

  const conversationTarget = normalizeFeishuTarget(ctx?.conversationId);
  const chatTarget = normalizeFeishuTarget(ctx?.chatId);
  return conversationTarget.startsWith("ou_")
    || conversationTarget.startsWith("oc_")
    || chatTarget.startsWith("ou_")
    || chatTarget.startsWith("oc_");
}

function inferTargetFromSessionKey(sessionKey) {
  if (typeof sessionKey !== "string" || !sessionKey) return "";
  const directMatch = sessionKey.match(/:direct:(ou_[^:]+)$/u);
  if (directMatch && directMatch[1]) return directMatch[1];

  const parts = sessionKey.split(":").filter(Boolean);
  const tail = parts.length > 0 ? parts[parts.length - 1] : "";
  if (tail.startsWith("ou_") || tail.startsWith("oc_")) return tail;
  return "";
}

// 同一条消息链路在不同事件里字段名不一致，这里按稳定性从高到低兜底解析。
function resolveFeishuTargetFromEventOrContext(event, ctx) {
  const candidates = [
    ctx?.chatId,
    event?.chatId,
    ctx?.conversationId,
    event?.conversationId,
    event?.metadata?.chatId,
    event?.metadata?.to,
    typeof ctx?.sessionKey === "string" ? inferTargetFromSessionKey(ctx.sessionKey) : ""
  ];

  for (const candidate of candidates) {
    const normalized = normalizeFeishuTarget(candidate);
    if (normalized) return normalized;
  }
  return "";
}

function resolveFeishuMessageIdFromEventOrContext(event, ctx) {
  const candidates = [
    ctx?.messageId,
    event?.messageId,
    event?.metadata?.messageId,
    event?.metadata?.message_id
  ];

  for (const candidate of candidates) {
    const normalized = normalizeFeishuMessageId(candidate);
    if (normalized) return normalized;
  }
  return "";
}

// 判断是否为语音入站时尽量宽松，兼容不同接入层吐出的媒体标识。
function isVoiceInboundEvent(event) {
  const body = typeof event?.body === "string" ? event.body.toLowerCase() : "";
  if (body.includes("[audio]") || body.includes("[voice]")) return true;

  const rawBody = typeof event?.body === "string" ? event.body.trim() : "";
  if (rawBody.startsWith("{") && rawBody.endsWith("}")) {
    try {
      const parsed = JSON.parse(rawBody);
      const fileKey = typeof parsed?.file_key === "string" ? parsed.file_key : typeof parsed?.fileKey === "string" ? parsed.fileKey : "";
      const duration = Number(parsed?.duration || 0);
      if (fileKey && duration > 0) return true;
    } catch {
      // ignore malformed body JSON and continue with other heuristics
    }
  }

  const mediaType = String(event?.metadata?.mediaType || "").toLowerCase();
  if (mediaType.includes("audio") || mediaType.includes("voice") || mediaType.includes("opus")) return true;

  const mediaPath = String(event?.metadata?.mediaPath || "").toLowerCase();
  if (mediaPath.endsWith(".ogg") || mediaPath.endsWith(".opus") || mediaPath.endsWith(".mp3") || mediaPath.endsWith(".wav")) return true;

  const fileKey = String(event?.metadata?.fileKey || event?.metadata?.file_key || "").trim();
  const duration = Number(event?.metadata?.duration || 0);
  if (fileKey && duration > 0) return true;

  const mediaTypes = Array.isArray(event?.metadata?.mediaTypes) ? event.metadata.mediaTypes : [];
  return mediaTypes.some((value) => {
    const type = String(value || "").toLowerCase();
    return type.includes("audio") || type.includes("voice") || type.includes("opus");
  });
}

module.exports = {
  createAudioMessage,
  feishuJsonRequest,
  getTenantAccessToken,
  inferTargetFromSessionKey,
  isFeishuChannelContext,
  isVoiceInboundEvent,
  normalizeAccountId,
  normalizeFeishuMessageId,
  normalizeFeishuTarget,
  resolveFeishuAccountConfig,
  resolveFeishuApiBaseUrl,
  resolveFeishuMessageIdFromEventOrContext,
  resolveFeishuTargetFromEventOrContext,
  resolveReceiveIdType,
  summarizeJsonForLog,
  uploadAudioToFeishu
};
