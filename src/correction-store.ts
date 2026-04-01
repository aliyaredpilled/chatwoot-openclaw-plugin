import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatwootApi, ChatwootMessage } from "./chatwoot-api.js";
import {
  CORRECTION_FEEDBACK_MARKER,
  SUGGESTION_MARKER,
  TRACE_MARKER,
  WORKING_MARKER,
} from "./technical-markers.js";

type CorrectionStoreResult = {
  filePath: string;
  fingerprint: string;
};

type CorrectionFeedbackPayload = {
  version?: number;
  runId?: string | null;
  publicMessageId?: number | null;
  suggestionMessageId?: number | null;
  traceMessageId?: number | null;
  suggestion?: string;
  finalText?: string;
  comment?: string;
  savedAt?: string;
};

type SaveCorrectionParams = {
  api: ChatwootApi;
  accountId: number;
  conversationId: number;
  operator: { id?: number; name?: string };
  feedback: CorrectionFeedbackPayload;
};

const TECHNICAL_MARKERS = [
  SUGGESTION_MARKER,
  WORKING_MARKER,
  TRACE_MARKER,
  CORRECTION_FEEDBACK_MARKER,
];

function normalizeText(text: string): string {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function buildFingerprint(record: any): string {
  const hash = createHash("sha256");
  hash.update(
    [
      record.runId,
      normalizeText(record?.suggestion?.text ?? ""),
      normalizeText(record?.finalMessage?.text ?? ""),
      normalizeText(record?.feedback?.comment ?? ""),
    ].join("\n---\n"),
  );
  return `sha256:${hash.digest("hex")}`;
}

function resolveBaseDir(): string {
  return process.env.OPENCLAW_CORRECTIONS_DIR
    || join(homedir(), ".openclaw", "data", "agent-corrections");
}

function parseTechnicalMessage(message: ChatwootMessage | null | undefined, marker: string) {
  const content = message?.content ?? "";
  if (!content.startsWith(marker)) return null;

  const raw = content.slice(marker.length).trim();
  if (!raw) return null;

  try {
    return {
      raw,
      data: JSON.parse(raw),
    };
  } catch {
    return {
      raw,
      data: null,
    };
  }
}

function isTechnicalMessage(message: ChatwootMessage | null | undefined): boolean {
  const content = message?.content ?? "";
  return TECHNICAL_MARKERS.some((marker) => content.startsWith(marker));
}

function messageTimestamp(message: ChatwootMessage): number {
  const parsed = Date.parse(message.created_at ?? "");
  return Number.isFinite(parsed) ? parsed : message.id ?? 0;
}

function truncateText(text = "", limit = 2000): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function findMessageById(messages: ChatwootMessage[], id?: number | null) {
  if (!id) return null;
  return messages.find((message) => message.id === id) ?? null;
}

function findSuggestionMessage(
  messages: ChatwootMessage[],
  feedback: CorrectionFeedbackPayload,
) {
  const directMatch = findMessageById(messages, feedback.suggestionMessageId);
  if (directMatch) return directMatch;

  if (!feedback.runId) return null;

  return (
    messages.find((message) => {
      const parsed = parseTechnicalMessage(message, SUGGESTION_MARKER);
      return parsed?.data?.runId === feedback.runId;
    }) ?? null
  );
}

function findTraceMessage(messages: ChatwootMessage[], feedback: CorrectionFeedbackPayload) {
  const directMatch = findMessageById(messages, feedback.traceMessageId);
  if (directMatch) return directMatch;

  if (!feedback.runId) return null;

  return (
    messages.find((message) => {
      const parsed = parseTechnicalMessage(message, TRACE_MARKER);
      return parsed?.data?.runId === feedback.runId;
    }) ?? null
  );
}

function buildLastTurns(messages: ChatwootMessage[]) {
  return messages
    .filter((message) => message.message_type === "incoming" || message.message_type === "outgoing")
    .filter((message) => !isTechnicalMessage(message))
    .sort((a, b) => messageTimestamp(a) - messageTimestamp(b))
    .slice(-10)
    .map((message) => ({
      id: message.id,
      createdAt: message.created_at,
      messageType: message.message_type,
      private: message.private,
      sender: {
        id: message.sender?.id ?? null,
        name: message.sender?.name ?? null,
        type: message.sender?.type ?? null,
      },
      text: truncateText(message.content ?? "", 2000),
      attachments: (message.attachments ?? []).map((attachment) => ({
        id: attachment.id,
        fileType: attachment.file_type,
        dataUrl: attachment.data_url,
      })),
    }));
}

export function saveCorrectionRecord(record: any): CorrectionStoreResult {
  const savedAt = String(record.savedAt || new Date().toISOString());
  const day = savedAt.slice(0, 10);
  const dir = join(resolveBaseDir(), day);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const fingerprint = buildFingerprint(record);
  const nextRecord = {
    ...record,
    dedupe: {
      ...(record.dedupe || {}),
      fingerprint,
    },
  };

  const filePath = join(dir, `${safeRunId(record.runId)}.json`);
  if (existsSync(filePath)) {
    try {
      const existing = JSON.parse(readFileSync(filePath, "utf-8"));
      const merged = {
        ...existing,
        ...nextRecord,
        feedback: {
          ...(existing.feedback || {}),
          ...(nextRecord.feedback || {}),
        },
        diff: {
          ...(existing.diff || {}),
          ...(nextRecord.diff || {}),
        },
        trace: nextRecord.trace || existing.trace,
        context: nextRecord.context || existing.context,
        dedupe: {
          ...(existing.dedupe || {}),
          ...(nextRecord.dedupe || {}),
        },
      };
      writeFileSync(filePath, JSON.stringify(merged, null, 2));
      return { filePath, fingerprint };
    } catch {
      // Fall through and overwrite with normalized record.
    }
  }

  writeFileSync(filePath, JSON.stringify(nextRecord, null, 2));
  return { filePath, fingerprint };
}

export async function buildAndSaveCorrectionRecord(params: SaveCorrectionParams) {
  const { api, accountId, conversationId, operator, feedback } = params;

  const runId = feedback.runId?.trim();
  const comment = feedback.comment?.trim() ?? "";
  if (!runId || !comment) {
    return null;
  }

  const savedAt = feedback.savedAt ?? new Date().toISOString();
  const [{ payload: messages = [] } = { payload: [] }, conversation] = await Promise.all([
    api.getMessages(accountId, conversationId),
    api.getConversation(accountId, conversationId).catch(() => null),
  ]);

  const publicMessage = findMessageById(messages, feedback.publicMessageId);
  const suggestionMessage = findSuggestionMessage(messages, feedback);
  const traceMessage = findTraceMessage(messages, feedback);
  const parsedSuggestion = parseTechnicalMessage(suggestionMessage, SUGGESTION_MARKER);
  const parsedTrace = parseTechnicalMessage(traceMessage, TRACE_MARKER);

  const suggestionText = parsedSuggestion?.data?.text ?? parsedSuggestion?.raw ?? feedback.suggestion ?? "";
  const finalText = publicMessage?.content ?? feedback.finalText ?? "";
  const changed = normalizeText(suggestionText) !== normalizeText(finalText);

  if (!suggestionText.trim() || !finalText.trim() || !changed) {
    return null;
  }

  const record = {
    version: 1,
    savedAt,
    runId,
    conversationId,
    accountId,
    channel: "chatwoot",
    operator: {
      id: operator.id ?? null,
      name: operator.name ?? null,
    },
    customer: {
      id: conversation?.meta?.sender?.id ?? null,
      name: conversation?.meta?.sender?.name ?? null,
      email: conversation?.meta?.sender?.email ?? null,
      phoneNumber: conversation?.meta?.sender?.phone_number ?? null,
    },
    messageIds: {
      publicMessageId: publicMessage?.id ?? feedback.publicMessageId ?? null,
      suggestionMessageId: suggestionMessage?.id ?? feedback.suggestionMessageId ?? null,
      traceMessageId: traceMessage?.id ?? feedback.traceMessageId ?? null,
    },
    suggestion: {
      text: suggestionText,
    },
    finalMessage: {
      id: publicMessage?.id ?? feedback.publicMessageId ?? null,
      text: finalText,
      createdAt: publicMessage?.created_at ?? null,
    },
    feedback: {
      comment,
    },
    diff: {
      changed,
      before: suggestionText,
      after: finalText,
    },
    trace: parsedTrace?.data ?? null,
    context: {
      lastTurns: buildLastTurns(messages),
    },
  };

  return saveCorrectionRecord(record);
}
