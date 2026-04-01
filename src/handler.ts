import { ChatwootApi, type ChatwootWebhookPayload, type ChatwootAttachment } from "./chatwoot-api.js";
import { GatewayRpc } from "./gateway-rpc.js";
import { buildAndSaveCorrectionRecord } from "./correction-store.js";
import {
  CORRECTION_FEEDBACK_MARKER,
  HANDOFF_MARKER,
  NO_REPLY_MARKER,
  SUGGESTION_MARKER,
  TRACE_MARKER,
  WORKING_MARKER,
} from "./technical-markers.js";

// ── Own-message tracking ──────────────────────────────────────────────
// When the bot sends a message via Chatwoot API, we store its ID here.
// Account-level webhooks echo back our own outgoing messages — we skip them.

const OWN_MESSAGE_IDS = new Set<number>();
const OWN_MSG_TTL = 60_000; // auto-cleanup after 60s

export function trackOwnMessage(id: number) {
  OWN_MESSAGE_IDS.add(id);
  setTimeout(() => OWN_MESSAGE_IDS.delete(id), OWN_MSG_TTL);
}

export function isOwnMessage(id: number): boolean {
  return OWN_MESSAGE_IDS.has(id);
}

// ── Gateway RPC (singleton) ─────────────────────────────────────────
// Used to inject operator messages directly into session transcripts
// via chat.inject, instead of buffering them in memory.

let gatewayRpc: GatewayRpc | null = null;

export function initGatewayRpc(log?: any) {
  if (gatewayRpc) return;
  gatewayRpc = new GatewayRpc({ log });
}

// ── Copilot: pending suggestions ────────────────────────────────────
// When copilot mode is enabled, agent suggestions are sent as private notes
// instead of direct replies. We track them here to compare with operator's
// actual response and inject feedback into the session transcript.

const PENDING_SUGGESTIONS = new Map<number, { text: string; ts: number; runId?: string }>();
const SUGGESTION_TTL = 30 * 60_000; // discard after 30 min

export {
  SUGGESTION_MARKER,
  WORKING_MARKER,
  TRACE_MARKER,
  HANDOFF_MARKER,
  NO_REPLY_MARKER,
  CORRECTION_FEEDBACK_MARKER,
};

function storeSuggestion(conversationId: number, text: string, runId?: string) {
  PENDING_SUGGESTIONS.set(conversationId, { text, ts: Date.now(), runId });
}

function consumeSuggestion(conversationId: number): string | null {
  const entry = PENDING_SUGGESTIONS.get(conversationId);
  if (!entry) return null;
  PENDING_SUGGESTIONS.delete(conversationId);
  if (Date.now() - entry.ts > SUGGESTION_TTL) return null;
  return entry.text;
}

async function sendTechnicalNote(params: {
  api: ChatwootApi;
  accountId: number;
  conversationId: number;
  marker: string;
  text?: string;
  data?: Record<string, any>;
}) {
  const { api, accountId, conversationId, marker, text, data } = params;
  const content = data
    ? `${marker}\n${JSON.stringify(data)}`
    : text
      ? `${marker}\n${text}`
      : marker;
  const sent = await api.sendMessage(accountId, conversationId, content, {
    isPrivate: true,
  });
  if (sent?.id) trackOwnMessage(sent.id);
  return sent;
}

function parseTechnicalNote<T = Record<string, any>>(content: string | undefined, marker: string): { raw: string; data: T | null } | null {
  if (!content || !content.startsWith(marker)) return null;
  const raw = content.slice(marker.length).trim();
  if (!raw) return { raw: "", data: null };
  try {
    return { raw, data: JSON.parse(raw) as T };
  } catch {
    return { raw, data: null };
  }
}

async function persistCorrectionFeedback(params: {
  api: ChatwootApi;
  payload: ChatwootWebhookPayload;
  accountId: number;
  conversationId: number;
  log?: any;
}) {
  const { api, payload, accountId, conversationId, log } = params;
  const parsed = parseTechnicalNote<{
    version?: number;
    runId?: string;
    publicMessageId?: number | null;
    suggestionMessageId?: number | null;
    traceMessageId?: number | null;
    suggestion?: string;
    finalText?: string;
    comment?: string;
    savedAt?: string;
  }>(payload.content, CORRECTION_FEEDBACK_MARKER);

  const feedback = parsed?.data;
  const runId = String(feedback?.runId ?? "").trim();
  const comment = String(feedback?.comment ?? "").trim();
  const finalText = String(feedback?.finalText ?? "").trim();

  if (!runId || !comment || !finalText) {
    log?.warn?.(`[chatwoot] correction feedback skipped: incomplete payload for conv ${conversationId}`);
    return null;
  }

  const saved = await buildAndSaveCorrectionRecord({
    api,
    accountId,
    conversationId,
    operator: {
      id: payload.sender?.id,
      name: payload.sender?.name,
    },
    feedback: {
      ...feedback,
      runId,
      comment,
      finalText,
      savedAt: feedback?.savedAt ?? new Date().toISOString(),
    },
  });

  if (!saved) {
    log?.info?.(`[chatwoot] correction feedback skipped for run ${runId}`);
    return null;
  }

  log?.info?.(`[chatwoot] correction dataset saved for run ${runId}: ${saved.filePath}`);
  return saved;
}

// ── Operator message buffer (fallback) ──────────────────────────────
// Kept as fallback if chat.inject fails (e.g. gateway token not configured).
// When inject succeeds, this buffer is not used.

const OPERATOR_BUFFER = new Map<number, { name: string; text: string; ts: number }[]>();
const OP_BUF_TTL = 30 * 60_000; // discard after 30 min

function bufferOperatorMessage(conversationId: number, name: string, text: string) {
  if (!OPERATOR_BUFFER.has(conversationId)) OPERATOR_BUFFER.set(conversationId, []);
  OPERATOR_BUFFER.get(conversationId)!.push({ name, text, ts: Date.now() });
}

function drainOperatorMessages(conversationId: number): string {
  const msgs = OPERATOR_BUFFER.get(conversationId);
  if (!msgs || msgs.length === 0) return "";
  OPERATOR_BUFFER.delete(conversationId);
  const now = Date.now();
  const fresh = msgs.filter((m) => now - m.ts < OP_BUF_TTL);
  if (fresh.length === 0) return "";
  return fresh.map((m) => `[Сообщение от оператора ${m.name}]: ${m.text}`).join("\n");
}

// ── Constants ──────────────────────────────────────────────────────────

const TEXT_CHUNK_LIMIT = 4000;
const MEDIA_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

const DOWNLOADABLE_TYPES = new Set(["image", "audio", "video", "file"]);

function mediaPlaceholder(att: ChatwootAttachment): string {
  const map: Record<string, string> = {
    image: "<media:image>",
    audio: "<media:audio>",
    video: "<media:video>",
    file: "<media:document>",
    location: "<media:location>",
    fallback: "<media:fallback>",
  };
  return map[att.file_type] ?? `<media:${att.file_type}>`;
}

// ── Markdown stripping ────────────────────────────────────────────────

function stripMarkdown(text: string): string {
  return text
    // Code blocks: ```lang\ncode\n``` → code
    .replace(/```\w*\n([\s\S]*?)```/g, "$1")
    // Inline code: `code` → code
    .replace(/`([^`]+)`/g, "$1")
    // Bold+italic: ***text*** or ___text___
    .replace(/\*{3}(.+?)\*{3}/g, "$1")
    .replace(/_{3}(.+?)_{3}/g, "$1")
    // Bold: **text** or __text__
    .replace(/\*{2}(.+?)\*{2}/g, "$1")
    .replace(/_{2}(.+?)_{2}/g, "$1")
    // Italic: *text* or _text_
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/(?<!\w)_(.+?)_(?!\w)/g, "$1")
    // Strikethrough: ~~text~~
    .replace(/~~(.+?)~~/g, "$1")
    // Headers: ### text → text
    .replace(/^#{1,6}\s+/gm, "")
    // Links: [text](url) → text (url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    // Images: ![alt](url) → (alt)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "($1)")
    // Blockquotes: > text → text
    .replace(/^>\s+/gm, "")
    // Horizontal rules: --- or *** or ___
    .replace(/^[-*_]{3,}\s*$/gm, "")
    // Unordered lists: - item or * item → • item
    .replace(/^[\s]*[-*+]\s+/gm, "• ")
    // Ordered lists: 1. item → 1) item
    .replace(/^(\s*\d+)\.\s+/gm, "$1) ")
    // Clean up extra blank lines
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Helpers ────────────────────────────────────────────────────────────

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit * 0.3) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

function truncateText(text: string, limit = 240): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function summarizeUnknown(value: unknown, limit = 240): string {
  if (typeof value === "string") return truncateText(value, limit);
  if (value === null || value === undefined) return "";
  try {
    return truncateText(JSON.stringify(value), limit);
  } catch {
    return truncateText(String(value), limit);
  }
}

function summarizeToolResult(message: any, limit = 240): string {
  const details = message?.details;
  if (details?.results && Array.isArray(details.results)) {
    const preview = details.results
      .slice(0, 3)
      .map((item: any) => item?.citation ?? item?.path ?? item?.title ?? summarizeUnknown(item, 60))
      .filter(Boolean);
    const suffix = details.results.length > preview.length ? ` (+${details.results.length - preview.length} more)` : "";
    return truncateText(`Found ${details.results.length} result(s): ${preview.join(", ")}${suffix}`, limit);
  }

  const firstText = message?.content?.find?.((item: any) => item?.type === "text")?.text;
  if (typeof firstText === "string" && firstText.trim()) {
    return truncateText(firstText, limit);
  }

  if (details) return summarizeUnknown(details, limit);
  return message?.isError ? "Tool returned an error." : "Tool completed.";
}

function summarizeThinkingItem(item: any, limit = 4000): string | null {
  if (!item || item.type !== "thinking") return null;

  const signature = item.thinkingSignature;
  if (typeof signature === "string") {
    try {
      const parsed = JSON.parse(signature);
      const summaryText = parsed?.summary?.find?.((entry: any) => entry?.type === "summary_text")?.text;
      if (typeof summaryText === "string" && summaryText.trim()) {
        return truncateText(summaryText, limit);
      }
    } catch {}
  }

  if (typeof item.thinking === "string" && item.thinking.trim()) {
    return truncateText(item.thinking, limit);
  }

  return null;
}

function buildTracePayload(params: {
  runId: string;
  conversationId: number;
  senderName: string;
  inboundText: string;
  startedAt: string;
  finishedAt: string;
  finalText?: string;
  transcriptEntries?: any[];
}) {
  const {
    runId,
    conversationId,
    senderName,
    inboundText,
    startedAt,
    finishedAt,
    finalText,
    transcriptEntries = [],
  } = params;

  const steps: Record<string, any>[] = [
    {
      type: "inbound",
      title: `Message from ${senderName}`,
      text: truncateText(inboundText, 280),
      timestamp: startedAt,
    },
    {
      type: "working",
      title: "Agent working",
      timestamp: startedAt,
    },
  ];

  for (const entry of transcriptEntries) {
    if (entry?.type !== "message" || !entry.message) continue;
    const message = entry.message;
    const timestamp = entry.timestamp ?? (typeof message.timestamp === "number" ? new Date(message.timestamp).toISOString() : undefined);

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const item of message.content) {
        if (item?.type === "toolCall") {
          steps.push({
            type: "tool_call",
            title: `Called ${item.name ?? "tool"}`,
            toolName: item.name ?? "tool",
            inputSummary: summarizeUnknown(item.arguments ?? item.partialJson ?? {}, 220),
            timestamp,
          });
          continue;
        }

        const thinking = summarizeThinkingItem(item);
        if (thinking) {
          steps.push({
            type: "note",
            title: "Reasoning note",
            content: thinking,
            timestamp,
          });
        }
      }

      continue;
    }

    if (message.role === "toolResult") {
      steps.push({
        type: message.isError ? "tool_error" : "tool_result",
        title: message.isError ? `${message.toolName ?? "Tool"} failed` : `${message.toolName ?? "Tool"} returned`,
        toolName: message.toolName ?? undefined,
        outputSummary: summarizeToolResult(message, 240),
        timestamp,
      });
    }
  }

  if (finalText) {
    steps.push({
      type: "final",
      title: "Final suggestion",
      text: truncateText(finalText, 600),
      timestamp: finishedAt,
    });
  }

  const uiSteps = steps.length <= 24
    ? steps
    : [...steps.slice(0, 23), steps[steps.length - 1]];

  return {
    version: 1,
    runId,
    conversationId,
    status: finalText ? "completed" : "no_reply",
    startedAt,
    finishedAt,
    finalText: finalText ? truncateText(finalText, 1200) : "",
    stepCount: steps.length,
    steps: uiSteps,
  };
}

// ── Media resolution ──────────────────────────────────────────────────

type ResolvedMedia = { path: string; contentType?: string };

async function resolveMedia(params: {
  attachments: ChatwootAttachment[];
  cr: any;
  log?: any;
}): Promise<ResolvedMedia[]> {
  const { attachments, cr, log } = params;
  const results: ResolvedMedia[] = [];

  for (const att of attachments) {
    if (!DOWNLOADABLE_TYPES.has(att.file_type) || !att.data_url) continue;

    try {
      const fetched = await cr.media.fetchRemoteMedia({
        url: att.data_url,
        maxBytes: MEDIA_MAX_BYTES,
        filePathHint: att.data_url,
      });

      const saved = await cr.media.saveMediaBuffer(
        fetched.buffer,
        fetched.contentType,
        "inbound",
        MEDIA_MAX_BYTES,
        fetched.fileName,
      );

      results.push({ path: saved.path, contentType: saved.contentType ?? fetched.contentType });
      log?.info?.(`[chatwoot] saved media: type=${att.file_type} path=${saved.path}`);
    } catch (err: any) {
      log?.warn?.(`[chatwoot] failed to fetch media type=${att.file_type}: ${err?.message ?? err}`);
    }
  }

  return results;
}

// ── Types ──────────────────────────────────────────────────────────────

type HandleParams = {
  payload: ChatwootWebhookPayload;
  api: ChatwootApi;
  cfg: any;
  cr: any;
  log?: any;
  chatwootCfg: any;
};

// ── Inbound handler ────────────────────────────────────────────────────

export async function handleChatwootInbound(params: HandleParams) {
  const { payload, api, cfg, cr, log, chatwootCfg } = params;
  const isCopilot = chatwootCfg.copilot === true;

  log?.info?.(`[chatwoot] webhook received: event=${payload.event} type=${payload.message_type} sender=${JSON.stringify(payload.sender)} conv_status=${payload.conversation?.status} private=${payload.private} content=${(payload.content ?? "").slice(0, 50)}`);

  // ── Filter: only message_created ──
  if (payload.event !== "message_created") {
    log?.info?.(`[chatwoot] skipped: event=${payload.event}`);
    return;
  }

  // ── Handle outgoing messages from human operators ──
  if (payload.message_type === "outgoing") {
    if (payload.id && isOwnMessage(payload.id)) {
      log?.info?.(`[chatwoot] skipped own message id=${payload.id}`);
      return;
    }
    const senderType = payload.sender?.type;
    const conversationId = payload.conversation?.id;
    const accountId = payload.account?.id ?? chatwootCfg.accountId ?? 1;

    if (
      senderType === "user"
      && payload.private
      && payload.content
      && payload.content.startsWith(CORRECTION_FEEDBACK_MARKER)
      && conversationId
    ) {
      try {
        await persistCorrectionFeedback({
          api,
          payload,
          accountId,
          conversationId,
          log,
        });
      } catch (err: any) {
        log?.warn?.(`[chatwoot] correction feedback persistence failed for conv ${conversationId}: ${err?.message ?? err}`);
      }
      return;
    }

    if (senderType === "user" && payload.content && !payload.private) {
      if (conversationId) {
        const operatorName = payload.sender?.name ?? "Оператор";
        const suggestion = isCopilot ? consumeSuggestion(conversationId) : null;

        // Try to inject directly into session transcript via SessionManager
        if (gatewayRpc) {
          const route = cr.routing.resolveAgentRoute({
            cfg,
            channel: "chatwoot",
            peer: { kind: "direct" as const, id: String(conversationId) },
          });
          const storePath = cr.session.resolveStorePath(cfg.session?.store, {
            agentId: route.agentId,
          });

          if (suggestion) {
            const modified = suggestion.trim() !== payload.content.trim();
            const feedbackText = modified
              ? `[Коррекция от оператора ${operatorName}]
Предложение агента:
${suggestion}

Отправлено клиенту:
${payload.content}`
              : `[Оператор ${operatorName} одобрил ответ агента без изменений]
${payload.content}`;
            const injected = await gatewayRpc.injectFeedback(
              route.sessionKey,
              feedbackText,
              storePath,
            );
            if (injected) {
              log?.info?.(`[chatwoot] injected copilot feedback from ${operatorName} into session ${route.sessionKey}`);
            } else {
              log?.warn?.(`[chatwoot] feedback inject failed, falling back to buffer`);
              bufferOperatorMessage(conversationId, operatorName, payload.content);
            }
          } else {
            const injected = await gatewayRpc.injectMessage(
              route.sessionKey,
              payload.content,
              `Оператор ${operatorName}`,
              storePath,
            );
            if (injected) {
              log?.info?.(`[chatwoot] injected operator message from ${operatorName} into session ${route.sessionKey}`);
            } else {
              log?.warn?.(`[chatwoot] inject failed, falling back to buffer`);
              bufferOperatorMessage(conversationId, operatorName, payload.content);
            }
          }
        } else {
          // Fallback: buffer for next client message
          bufferOperatorMessage(conversationId, operatorName, payload.content);
          log?.info?.(`[chatwoot] buffered operator message from ${operatorName} (conv ${conversationId}): ${payload.content.slice(0, 50)}`);
        }

        // In copilot mode, operator outgoing is the human-approved final answer.
        // Do not spin up another AI turn from the operator's public reply.
        if (isCopilot) {
          log?.info?.(`[chatwoot] copilot: recorded operator reply without redispatch for conv ${conversationId}`);
          return;
        }

        await dispatchMessage({
          api,
          cfg,
          cr,
          log,
          conversationId,
          accountId,
          senderId: payload.sender.id,
          senderName: payload.sender.name ?? String(payload.sender.id),
          text: payload.content,
          chatwootCfg,
          media: [],
        });
        return;
      }
    }
    return;
  }

  // ── Filter: only incoming messages from contacts ──
  if (payload.message_type !== "incoming") {
    log?.info?.(`[chatwoot] skipped: message_type=${payload.message_type}`);
    return;
  }
  // Chatwoot webhook sender may not have "type" field; skip only if it's explicitly a non-contact
  const senderType = payload.sender?.type;
  if (!payload.sender || senderType === "user" || senderType === "agent_bot") {
    log?.info?.(`[chatwoot] skipped: sender.type=${senderType}`);
    return;
  }
  if (payload.private) {
    log?.info?.("[chatwoot] skipped: private message");
    return;
  }

  // ── Filter: skip resolved/snoozed conversations ──
  // Accept both "pending" (initial bot mode) and "open" (Chatwoot auto-opens after bot reply)
  const convStatus = payload.conversation?.status;
  if (convStatus === "resolved" || convStatus === "snoozed") {
    log?.info?.(`[chatwoot] skipped: conv status=${convStatus}`);
    return;
  }

  // ── Extract fields ──
  const conversationId = payload.conversation.id;
  const accountId = payload.account?.id ?? chatwootCfg.accountId ?? 1;
  const messageId = payload.id;
  const senderId = payload.sender.id;
  const senderName = payload.sender.name ?? String(senderId);
  let text = payload.content ?? "";
  let attachments = payload.attachments ?? [];

  if (!text && attachments.length === 0) return;

  // ── Fetch attachments via API if webhook didn't include them ──
  // Chatwoot (via Umnico) fires webhook before Sidekiq processes attachments,
  // so attachments array is always empty. We re-fetch from API after a short delay.
  const MEDIA_PLACEHOLDERS = /^\[(photo|file|doc|video|audio|sticker|voice|document|gif)\]$/i;
  const isPlaceholder = MEDIA_PLACEHOLDERS.test(text.trim());

  if (attachments.length === 0 && messageId) {
    // For pure placeholders like [photo] — always fetch (definitely has media)
    // For text messages — also try to fetch (may have text + photo combo)
    const delay = isPlaceholder ? 2000 : 1500;
    if (isPlaceholder) {
      log?.info?.(`[chatwoot] detected media placeholder "${text.trim()}", waiting for attachment...`);
    }
    await new Promise((r) => setTimeout(r, delay));

    try {
      const messagesResp = await api.getMessages(accountId, conversationId);
      const msgs = messagesResp.payload ?? [];
      const msg = msgs.find((m: any) => m.id === messageId);
      if (msg?.attachments?.length) {
        attachments = msg.attachments;
        log?.info?.(`[chatwoot] fetched ${attachments.length} attachment(s) from API`);
      } else if (isPlaceholder) {
        // Retry with longer delay only for placeholders (they definitely have media)
        await new Promise((r) => setTimeout(r, 3000));
        const retry = await api.getMessages(accountId, conversationId);
        const retryMsg = (retry.payload ?? []).find((m: any) => m.id === messageId);
        if (retryMsg?.attachments?.length) {
          attachments = retryMsg.attachments;
          log?.info?.(`[chatwoot] fetched ${attachments.length} attachment(s) from API (retry)`);
        } else {
          log?.info?.("[chatwoot] no attachments found after retry");
        }
      }
    } catch (err: any) {
      log?.warn?.(`[chatwoot] failed to fetch attachments: ${err?.message ?? err}`);
    }
  }

  // ── Resolve media ──
  const media = await resolveMedia({ attachments, cr, log });

  // Build text: replace placeholder if we got real media
  if (media.length > 0 && MEDIA_PLACEHOLDERS.test(text.trim())) {
    text = ""; // drop the "[photo]" placeholder since we have the actual file
  }

  // Build placeholder text for failed/non-downloadable attachments
  let mediaContext = "";
  const nonDownloadable = attachments.filter((a: any) => !DOWNLOADABLE_TYPES.has(a.file_type));
  if (nonDownloadable.length > 0) {
    mediaContext = nonDownloadable.map(mediaPlaceholder).join(" ");
  }
  const downloadableCount = attachments.filter((a: any) => DOWNLOADABLE_TYPES.has(a.file_type)).length;
  if (media.length < downloadableCount) {
    const failed = attachments
      .filter((a: any) => DOWNLOADABLE_TYPES.has(a.file_type))
      .slice(media.length)
      .map(mediaPlaceholder);
    if (failed.length > 0) {
      mediaContext = [mediaContext, ...failed].filter(Boolean).join(" ");
    }
  }

  const fullText = [text, mediaContext].filter(Boolean).join("\n").trim();
  if (!fullText && media.length === 0) return;

  // ── Dispatch through native AI pipeline ──
  await dispatchMessage({
    api,
    cfg,
    cr,
    log,
    conversationId,
    accountId,
    senderId,
    senderName,
    text: fullText || (media.length > 0 ? `<media:image>${media.length > 1 ? ` (${media.length} files)` : ""}` : ""),
    chatwootCfg,
    media,
  });
}

// ── Native pipeline dispatch ───────────────────────────────────────────

type DispatchParams = {
  api: ChatwootApi;
  cfg: any;
  cr: any;
  log?: any;
  conversationId: number;
  accountId: number;
  senderId: number;
  senderName: string;
  text: string;
  chatwootCfg: any;
  media: ResolvedMedia[];
};

async function dispatchMessage(params: DispatchParams) {
  const { cfg, cr, log, conversationId, accountId, senderId, senderName, text, chatwootCfg, media } = params;
  const isCopilot = chatwootCfg.copilot === true;
  const runId = `cw_${conversationId}_${payload_id()}`;
  const startedAt = new Date().toISOString();

  // Use Agent Bot token for outbound (shows as "OpenClaw Support" in UI)
  // Fall back to admin API for inbound operations (getMessages, etc.)
  const botToken = chatwootCfg.agentBotToken;
  const botApi = botToken
    ? new ChatwootApi(chatwootCfg.apiUrl, botToken)
    : params.api;
  const api = params.api; // admin API for reads

  // 1. Resolve agent route
  const route = cr.routing.resolveAgentRoute({
    cfg,
    channel: "chatwoot",
    peer: { kind: "direct" as const, id: String(conversationId) },
  });

  // 2. Resolve session & envelope context
  const storePath = cr.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = cr.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = cr.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  // 3. Prepend buffered operator messages (if any)
  const operatorContext = drainOperatorMessages(conversationId);
  const bodyWithContext = operatorContext
    ? `${operatorContext}\n---\n${text}`
    : text;

  // 4. Format body
  const body = cr.reply.formatInboundEnvelope({
    channel: "Chatwoot",
    from: senderName,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: bodyWithContext,
    chatType: "direct",
    senderLabel: senderName,
  });

  // 4. Finalize inbound context
  const mediaPaths = media.length > 0 ? media.map((m) => m.path) : undefined;
  const mediaTypes = media.length > 0
    ? (media.map((m) => m.contentType).filter(Boolean) as string[])
    : undefined;

  const ctxPayload = cr.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: bodyWithContext,
    RawBody: text,
    CommandBody: text,
    From: `chatwoot:${senderId}`,
    To: `chatwoot:conv:${conversationId}`,
    SessionKey: route.sessionKey,
    AccountId: "default",
    ChatType: "direct",
    ConversationLabel: senderName,
    SenderName: senderName,
    SenderId: String(senderId),
    Provider: "chatwoot",
    Surface: "chatwoot",
    MessageSid: `cw_${payload_id()}`,
    OriginatingChannel: "chatwoot",
    OriginatingTo: `chatwoot:conv:${conversationId}`,
    CommandAuthorized: true,
    CommandSource: "text",
    MediaPath: media.length > 0 ? media[0].path : undefined,
    MediaType: media.length > 0 ? media[0].contentType : undefined,
    MediaUrl: media.length > 0 ? media[0].path : undefined,
    MediaPaths: mediaPaths,
    MediaUrls: mediaPaths,
    MediaTypes: mediaTypes,
  });

  // 5. Record inbound session
  const sessionKey = ctxPayload.SessionKey ?? route.sessionKey;
  await cr.session.recordInboundSession({
    storePath,
    sessionKey,
    ctx: ctxPayload,
    updateLastRoute: {
      sessionKey: route.mainSessionKey,
      channel: "chatwoot",
      to: `chatwoot:conv:${conversationId}`,
      accountId: "default",
    },
    onRecordError: (err: any) => {
      log?.warn?.(`[chatwoot] session record error: ${err}`);
    },
  });

  const transcriptBaseline = gatewayRpc?.readTranscriptEntries(sessionKey, storePath)?.totalLines ?? 0;
  let finalSuggestionText = "";

  if (isCopilot) {
    try {
      await sendTechnicalNote({
        api,
        accountId,
        conversationId,
        marker: WORKING_MARKER,
        data: {
          runId,
          startedAt,
          conversationId,
        },
      });
      log?.info?.(`[chatwoot] copilot working marker sent for conv ${conversationId}`);
    } catch (err: any) {
      log?.warn?.(
        `[chatwoot] failed to send working marker for conv ${conversationId}: ${err?.message ?? err}`,
      );
    }
  }

  log?.info?.(`[chatwoot] inbound from ${senderName} (conv ${conversationId}): ${text.slice(0, 80)}`);

  // 6. Delivery function
  const deliver = async (payload: any) => {
    let responseText = typeof payload === "string" ? payload : (payload?.text ?? "");
    if (!responseText) return;

    // Check for no-reply marker — agent decided to stay silent (operator is handling)
    const NO_REPLY = /\[NO_REPLY\]|no_reply/i;
    if (NO_REPLY.test(responseText.trim())) {
      await sendTechnicalNote({
        api,
        accountId,
        conversationId,
        marker: NO_REPLY_MARKER,
        data: {
          runId,
          startedAt,
          finishedAt: new Date().toISOString(),
          conversationId,
          reason: "operator_handling",
        },
      });
      log?.info?.(`[chatwoot] agent chose no_reply for conv ${conversationId}`);
      return;
    }

    // Check for handoff marker
    if (responseText.includes("[HANDOFF]")) {
      const cleanText = stripMarkdown(responseText.replace("[HANDOFF]", "").trim());
      if (cleanText) {
        const sent = await botApi.sendMessage(accountId, conversationId, cleanText);
        if (sent?.id) trackOwnMessage(sent.id);
      }
      await botApi.toggleStatus(accountId, conversationId, "open");
      await sendTechnicalNote({
        api,
        accountId,
        conversationId,
        marker: HANDOFF_MARKER,
        data: {
          runId,
          startedAt,
          finishedAt: new Date().toISOString(),
          conversationId,
          text: cleanText,
        },
      });
      log?.info?.(`[chatwoot] handoff conv ${conversationId} to human agents`);
      return;
    }

    // Strip markdown — Umnico doesn't support formatting
    responseText = stripMarkdown(responseText);

    // ── Copilot mode: send as private note for operator review ──
    if (isCopilot) {
      finalSuggestionText = responseText;
      storeSuggestion(conversationId, responseText, runId);
      await sendTechnicalNote({
        api,
        accountId,
        conversationId,
        marker: SUGGESTION_MARKER,
        data: {
          runId,
          text: responseText,
          startedAt,
          finishedAt: new Date().toISOString(),
          conversationId,
        },
      });
      log?.info?.(`[chatwoot] copilot suggestion sent as private note for conv ${conversationId}`);
      return;
    }

    // ── Direct mode: send to client ──
    const limit = chatwootCfg.textChunkLimit ?? TEXT_CHUNK_LIMIT;
    const chunks = chunkText(responseText, limit);
    for (const chunk of chunks) {
      const sent = await botApi.sendMessage(accountId, conversationId, chunk);
      if (sent?.id) trackOwnMessage(sent.id);
    }
  };

  // 7. Dispatch through native AI pipeline
  try {
    await cr.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver,
        typingCallbacks: {
          onReplyStart: async () => {
            try {
              await botApi.toggleTyping(accountId, conversationId, "on", true);
            } catch {}
          },
          onIdle: () => {
            botApi.toggleTyping(accountId, conversationId, "off", true).catch(() => {});
          },
          onCleanup: () => {
            botApi.toggleTyping(accountId, conversationId, "off", true).catch(() => {});
          },
        },
        onError: (err: any, info: any) => {
          log?.error?.(`[chatwoot] reply delivery error (${info?.kind}): ${err}`);
        },
      },
    });

    if (isCopilot && finalSuggestionText) {
      try {
        const transcript = gatewayRpc?.readTranscriptEntries(sessionKey, storePath, {
          startLine: transcriptBaseline,
        });
        const finishedAt = new Date().toISOString();
        const tracePayload = buildTracePayload({
          runId,
          conversationId,
          senderName,
          inboundText: text,
          startedAt,
          finishedAt,
          finalText: finalSuggestionText,
          transcriptEntries: transcript?.entries,
        });

        await sendTechnicalNote({
          api,
          accountId,
          conversationId,
          marker: TRACE_MARKER,
          data: tracePayload,
        });
        log?.info?.(
          `[chatwoot] copilot trace sent for conv ${conversationId} run ${runId} (${tracePayload.stepCount} steps)`,
        );
      } catch (err: any) {
        log?.warn?.(`[chatwoot] failed to build/send trace for conv ${conversationId}: ${err?.message ?? err}`);
      }
    }

    log?.info?.(`[chatwoot] replied to conv ${conversationId}`);
  } catch (err: any) {
    log?.error?.(`[chatwoot] dispatch error: ${err?.message ?? err}`);
    try {
      const sent = await botApi.sendMessage(accountId, conversationId, "Извините, произошла ошибка. Попробуйте ещё раз.");
      if (sent?.id) trackOwnMessage(sent.id);
    } catch {}
  }
}

// ── Unique ID helper ──────────────────────────────────────────────────

let _counter = 0;
function payload_id(): string {
  return `${Date.now()}_${++_counter}`;
}
