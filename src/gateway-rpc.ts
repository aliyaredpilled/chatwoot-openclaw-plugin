/**
 * Inject messages into OpenClaw session transcripts by appending JSONL entries
 * with correct parentId chain. Also exposes a minimal transcript reader for
 * building compact UI traces after a run completes.
 */

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

type GatewayRpcOptions = {
  log?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void };
};

/** Read the last message entry from a JSONL file and return its id. */
function readLastMessageId(filePath: string): string | undefined {
  const lines = readTranscriptLines(filePath);
  // Walk backwards to find the last entry with type "message"
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === "message" && entry.id) return entry.id;
    } catch {}
  }
  return undefined;
}

/** Find the JSONL transcript file for a session. */
function findTranscriptFile(storePath: string, sessionKey: string): string | null {
  try {
    if (!existsSync(storePath)) return null;
    const sessionsJson = JSON.parse(readFileSync(storePath, "utf-8"));
    const key = sessionKey.toLowerCase();
    const entry = sessionsJson[key] ?? sessionsJson[sessionKey];
    if (!entry?.sessionId) return null;

    if (entry.sessionFile && existsSync(entry.sessionFile)) {
      return entry.sessionFile;
    }

    const sessionsDir = dirname(storePath);

    // Try agent-specific path first (most common for routed sessions)
    const agentMatch = sessionKey.match(/^agent:([^:]+)/);
    if (agentMatch) {
      const agentId = agentMatch[1];
      const agentPath = resolve(sessionsDir, "agents", agentId, "sessions", `${entry.sessionId}.jsonl`);
      if (existsSync(agentPath)) return agentPath;
    }

    // Generic sessions dir
    const genericPath = resolve(sessionsDir, "sessions", `${entry.sessionId}.jsonl`);
    if (existsSync(genericPath)) return genericPath;

    return null;
  } catch {
    return null;
  }
}

function readTranscriptLines(filePath: string): string[] {
  const content = readFileSync(filePath, "utf-8");
  return content.split("\n").filter(Boolean);
}

function parseTranscriptLine(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export class GatewayRpc {
  private log: GatewayRpcOptions["log"];

  constructor(opts?: GatewayRpcOptions) {
    this.log = opts?.log;
  }

  resolveTranscriptFile(sessionKey: string, storePath?: string): string | null {
    if (!storePath) return null;
    return findTranscriptFile(storePath, sessionKey);
  }

  readTranscriptEntries(
    sessionKey: string,
    storePath?: string,
    opts?: { startLine?: number },
  ): { filePath: string; totalLines: number; entries: any[] } | null {
    try {
      if (!storePath) return null;

      const transcriptFile = findTranscriptFile(storePath, sessionKey);
      if (!transcriptFile) return null;

      const allLines = readTranscriptLines(transcriptFile);
      const startLine = Math.max(0, opts?.startLine ?? 0);
      const entries = allLines
        .slice(startLine)
        .map(parseTranscriptLine)
        .filter(Boolean);

      return {
        filePath: transcriptFile,
        totalLines: allLines.length,
        entries,
      };
    } catch (err: any) {
      this.log?.warn?.(`[gateway-rpc] readTranscriptEntries failed: ${err?.message ?? err}`);
      return null;
    }
  }

  /** Inject an operator message into a session transcript. */
  async injectMessage(
    sessionKey: string,
    message: string,
    label?: string,
    storePath?: string,
  ): Promise<boolean> {
    try {
      if (!storePath) {
        console.log("[gateway-rpc] no storePath");
        return false;
      }

      const transcriptFile = findTranscriptFile(storePath, sessionKey);
      if (!transcriptFile) {
        console.log(`[gateway-rpc] transcript not found for ${sessionKey} (store: ${storePath})`);
        return false;
      }

      // Read last parentId from the chain
      const parentId = readLastMessageId(transcriptFile);

      const labelPrefix = label ? `[${label}]\n\n` : "";
      const id = randomUUID();
      const entry = {
        type: "message",
        id,
        ...(parentId ? { parentId } : {}),
        message: {
          role: "user",
          content: [{ type: "text", text: `${labelPrefix}${message}` }],
          stopReason: "stop",
          timestamp: Date.now(),
          api: "openai-responses",
          provider: "openclaw",
          model: "operator-injected",
          usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      };

      appendFileSync(transcriptFile, JSON.stringify(entry) + "\n");
      console.log(`[gateway-rpc] inject ok: ${sessionKey} → ${transcriptFile} (parentId=${parentId ?? "none"})`);
      return true;
    } catch (err: any) {
      console.log(`[gateway-rpc] inject FAILED: ${err?.message ?? err}`);
      return false;
    }
  }

  /** Inject operator feedback (suggestion vs actual response) into a session transcript. */
  async injectFeedback(
    sessionKey: string,
    feedbackText: string,
    storePath?: string,
  ): Promise<boolean> {
    try {
      if (!storePath) return false;

      const transcriptFile = findTranscriptFile(storePath, sessionKey);
      if (!transcriptFile) return false;

      const parentId = readLastMessageId(transcriptFile);
      const id = randomUUID();
      const entry = {
        type: "message",
        id,
        ...(parentId ? { parentId } : {}),
        message: {
          role: "user",
          content: [{ type: "text", text: feedbackText }],
          stopReason: "stop",
          timestamp: Date.now(),
          api: "openai-responses",
          provider: "openclaw",
          model: "operator-feedback",
          usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      };

      appendFileSync(transcriptFile, JSON.stringify(entry) + "\n");
      console.log(`[gateway-rpc] feedback ok: ${sessionKey} → ${transcriptFile}`);
      return true;
    } catch (err: any) {
      console.log(`[gateway-rpc] feedback FAILED: ${err?.message ?? err}`);
      return false;
    }
  }

  close() {}
}
