import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ChatwootApi } from "./chatwoot-api.js";
import { handleChatwootInbound } from "./handler.js";

// ── Helpers ────────────────────────────────────────────────────────────

const TEXT_CHUNK_LIMIT = 4000;

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

// ── Types ──────────────────────────────────────────────────────────────

type ChatwootAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};

// ── Channel Plugin ─────────────────────────────────────────────────────

export const chatwootChannelPlugin = {
  id: "chatwoot",
  meta: {
    id: "chatwoot",
    label: "Chatwoot",
    selectionLabel: "Chatwoot (Agent Bot webhook)",
    docsPath: "/channels/chatwoot",
    docsLabel: "chatwoot",
    blurb: "Chatwoot integration via Agent Bot webhooks.",
    aliases: ["cw"],
  },

  capabilities: {
    chatTypes: ["direct"] as const,
  },

  config: {
    listAccountIds: (_cfg: any) => ["default"],
    resolveAccount: (cfg: any, accountId?: string | null): ChatwootAccount => {
      const cwCfg = cfg?.channels?.chatwoot ?? {};
      return {
        accountId: accountId ?? "default",
        enabled: cwCfg.enabled !== false,
        configured: !!cwCfg.apiToken && !!cwCfg.apiUrl,
      };
    },
  },

  outbound: {
    deliveryMode: "direct" as const,
    sendText: async (ctx: any) => {
      const cwCfg = ctx.cfg?.channels?.chatwoot ?? {};
      if (!cwCfg.apiToken || !cwCfg.apiUrl) {
        return { ok: false, error: "No apiToken or apiUrl configured" };
      }

      const api = new ChatwootApi(cwCfg.apiUrl, cwCfg.apiToken);
      const to = ctx.to ?? "";
      const convMatch = to.match(/chatwoot:conv:(\d+)/);
      if (!convMatch) return { ok: false, error: `Cannot resolve target: ${to}` };
      const conversationId = Number(convMatch[1]);
      const accountId = cwCfg.accountId ?? 1;

      const limit = cwCfg.textChunkLimit ?? TEXT_CHUNK_LIMIT;
      const chunks = chunkText(ctx.text, limit);
      for (const chunk of chunks) {
        await api.sendMessage(accountId, conversationId, chunk);
      }
      return { ok: true };
    },
  },

  gateway: {
    startAccount: async (ctx: any) => {
      const cr = ctx.channelRuntime;
      if (!cr) {
        ctx.log?.warn?.("[chatwoot] channelRuntime not available — cannot start");
        return;
      }

      const cwCfg = ctx.cfg?.channels?.chatwoot;
      if (!cwCfg?.apiToken || !cwCfg?.apiUrl) {
        ctx.log?.warn?.("[chatwoot] no apiToken/apiUrl in channels.chatwoot — skipping");
        return;
      }
      if (cwCfg.enabled === false) {
        ctx.log?.info?.("[chatwoot] channel disabled");
        return;
      }

      const webhookPort = cwCfg.webhookPort ?? 18800;
      const api = new ChatwootApi(cwCfg.apiUrl, cwCfg.apiToken);

      ctx.log?.info?.(`[chatwoot] starting webhook server on :${webhookPort}`);

      ctx.setStatus({
        accountId: ctx.accountId,
        selfId: "agent-bot",
        selfName: "OpenClaw Chatwoot",
      });

      // ── HTTP server for receiving Agent Bot webhooks ──
      const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        // Health check
        if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"status":"ok"}');
          return;
        }

        // Webhook endpoint
        if (req.method === "POST" && (req.url === "/webhook" || req.url === "/")) {
          let body = "";
          req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          req.on("end", async () => {
            // Respond immediately so Chatwoot doesn't retry
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end('{"status":"ok"}');

            try {
              const payload = JSON.parse(body);
              console.log(`[chatwoot] webhook POST received: event=${payload.event} keys=${Object.keys(payload).join(",")}`);
              ctx.log?.info?.(`[chatwoot] webhook POST received: event=${payload.event}`);

              // Debug: save raw payloads to /tmp/chatwoot-webhooks/
              try {
                const fs = await import("node:fs");
                const dir = "/tmp/chatwoot-webhooks";
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                const ts = new Date().toISOString().replace(/[:.]/g, "-");
                fs.writeFileSync(`${dir}/${ts}.json`, JSON.stringify(payload, null, 2));
              } catch {}

              await handleChatwootInbound({
                payload,
                api,
                cfg: ctx.cfg,
                cr,
                log: ctx.log,
                chatwootCfg: cwCfg,
              });
            } catch (err: any) {
              ctx.log?.error?.(`[chatwoot] webhook handler error: ${err?.message ?? err}`);
            }
          });
          return;
        }

        // 404 for everything else
        res.writeHead(404);
        res.end("Not found");
      });

      server.listen(webhookPort, () => {
        ctx.log?.info?.(`[chatwoot] webhook server listening on :${webhookPort}`);
      });

      // Graceful shutdown on abort signal
      ctx.abortSignal?.addEventListener("abort", () => {
        ctx.log?.info?.("[chatwoot] shutting down webhook server");
        server.close();
      });

      // Keep alive until abort — the server handles everything via callbacks
      await new Promise<void>((resolve) => {
        ctx.abortSignal?.addEventListener("abort", () => resolve());
      });

      ctx.log?.info?.("[chatwoot] webhook server stopped");
    },
  },
};
