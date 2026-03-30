import type { ChatwootApi, ChatwootWebhookPayload, ChatwootAttachment } from "./chatwoot-api.js";

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

  log?.info?.(`[chatwoot] webhook received: event=${payload.event} type=${payload.message_type} sender=${JSON.stringify(payload.sender)} conv_status=${payload.conversation?.status} private=${payload.private} content=${(payload.content ?? "").slice(0, 50)}`);

  // ── Filter: only message_created ──
  if (payload.event !== "message_created") {
    log?.info?.(`[chatwoot] skipped: event=${payload.event}`);
    return;
  }

  // ── Handle outgoing messages from human operators → inject into agent session ──
  if (payload.message_type === "outgoing") {
    const senderType = payload.sender?.type;
    // Only record human operator messages (type "user"), not bot's own messages
    if (senderType === "user" && payload.content && !payload.private) {
      const conversationId = payload.conversation?.id;
      if (conversationId) {
        const operatorName = payload.sender?.name ?? "Оператор";
        log?.info?.(`[chatwoot] operator message from ${operatorName} (conv ${conversationId}): ${payload.content.slice(0, 50)}`);
        try {
          const route = cr.routing.resolveAgentRoute({
            cfg,
            channel: "chatwoot",
            peer: { kind: "direct" as const, id: String(conversationId) },
          });
          const storePath = cr.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId });
          const envelopeOptions = cr.reply.resolveEnvelopeFormatOptions(cfg);
          const operatorText = `[Оператор ${operatorName}]: ${payload.content}`;

          const body = cr.reply.formatInboundEnvelope({
            channel: "Chatwoot",
            from: `Оператор ${operatorName}`,
            timestamp: Date.now(),
            envelope: envelopeOptions,
            body: operatorText,
            chatType: "direct",
            senderLabel: `Оператор ${operatorName}`,
          });

          const ctxPayload = cr.reply.finalizeInboundContext({
            Body: body,
            BodyForAgent: operatorText,
            RawBody: payload.content,
            CommandBody: payload.content,
            From: `chatwoot:operator:${payload.sender?.id ?? 0}`,
            To: `chatwoot:conv:${conversationId}`,
            SessionKey: route.sessionKey,
            AccountId: "default",
            ChatType: "direct",
            ConversationLabel: `Оператор ${operatorName}`,
            SenderName: `Оператор ${operatorName}`,
            SenderId: String(payload.sender?.id ?? 0),
            Provider: "chatwoot",
            Surface: "chatwoot",
            MessageSid: `op_${payload_id()}`,
            OriginatingChannel: "chatwoot",
            OriginatingTo: `chatwoot:conv:${conversationId}`,
            CommandAuthorized: false,
            CommandSource: "text",
          });

          await cr.session.recordInboundSession({
            storePath,
            sessionKey: route.sessionKey,
            ctx: ctxPayload,
            onRecordError: (err: any) => {
              log?.warn?.(`[chatwoot] operator session record error: ${err}`);
            },
          });

          log?.info?.(`[chatwoot] recorded operator message in session ${route.sessionKey}`);
        } catch (err: any) {
          log?.warn?.(`[chatwoot] failed to record operator message: ${err?.message ?? err}`);
        }
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
  const { api, cfg, cr, log, conversationId, accountId, senderId, senderName, text, chatwootCfg, media } = params;

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

  // 3. Format body
  const body = cr.reply.formatInboundEnvelope({
    channel: "Chatwoot",
    from: senderName,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: text,
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
    BodyForAgent: text,
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

  log?.info?.(`[chatwoot] inbound from ${senderName} (conv ${conversationId}): ${text.slice(0, 80)}`);

  // 6. Delivery function
  const deliver = async (payload: any) => {
    let responseText = typeof payload === "string" ? payload : (payload?.text ?? "");
    if (!responseText) return;

    // Check for no-reply marker — agent decided to stay silent (operator is handling)
    const NO_REPLY = /\[NO_REPLY\]|no_reply/i;
    if (NO_REPLY.test(responseText.trim())) {
      log?.info?.(`[chatwoot] agent chose no_reply for conv ${conversationId}`);
      return;
    }

    // Check for handoff marker
    if (responseText.includes("[HANDOFF]")) {
      const cleanText = stripMarkdown(responseText.replace("[HANDOFF]", "").trim());
      if (cleanText) {
        await api.sendMessage(accountId, conversationId, cleanText);
      }
      await api.toggleStatus(accountId, conversationId, "open");
      log?.info?.(`[chatwoot] handoff conv ${conversationId} to human agents`);
      return;
    }

    // Strip markdown — Umnico doesn't support formatting
    responseText = stripMarkdown(responseText);

    const limit = chatwootCfg.textChunkLimit ?? TEXT_CHUNK_LIMIT;
    const chunks = chunkText(responseText, limit);
    for (const chunk of chunks) {
      await api.sendMessage(accountId, conversationId, chunk);
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
          onReplyStart: () => {},
          onIdle: () => {},
          onCleanup: () => {},
        },
        onError: (err: any, info: any) => {
          log?.error?.(`[chatwoot] reply delivery error (${info?.kind}): ${err}`);
        },
      },
    });

    log?.info?.(`[chatwoot] replied to conv ${conversationId}`);
  } catch (err: any) {
    log?.error?.(`[chatwoot] dispatch error: ${err?.message ?? err}`);
    try {
      await api.sendMessage(accountId, conversationId, "Извините, произошла ошибка. Попробуйте ещё раз.");
    } catch {}
  }
}

// ── Unique ID helper ──────────────────────────────────────────────────

let _counter = 0;
function payload_id(): string {
  return `${Date.now()}_${++_counter}`;
}
