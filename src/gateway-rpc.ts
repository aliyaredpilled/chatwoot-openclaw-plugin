/**
 * Inject messages into OpenClaw session transcripts by appending JSONL entries
 * with correct parentId chain. Mimics SessionManager.appendMessage() behavior.
 */

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

type GatewayRpcOptions = {
  log?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void };
};

/** Read the last message entry from a JSONL file and return its id. */
function readLastMessageId(filePath: string): string | undefined {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
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

export class GatewayRpc {
  private log: GatewayRpcOptions["log"];

  constructor(opts?: GatewayRpcOptions) {
    this.log = opts?.log;
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
          role: "assistant",
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

  close() {}
}
