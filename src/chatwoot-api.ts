/**
 * Minimal Chatwoot REST API client — zero dependencies, just fetch.
 */

// ── Types ──────────────────────────────────────────────────────────────

export type ChatwootMessage = {
  id: number;
  content: string;
  message_type: "incoming" | "outgoing" | "activity" | "template";
  content_type: string;
  private: boolean;
  created_at: string;
  conversation_id: number;
  content_attributes?: Record<string, unknown>;
  sender?: {
    id: number;
    name: string;
    type: "contact" | "user" | "agent_bot";
  };
  attachments?: ChatwootAttachment[];
};

export type ChatwootAttachment = {
  id: number;
  file_type: "image" | "audio" | "video" | "file" | "location" | "fallback";
  data_url: string;
  thumb_url?: string;
  file_size?: number;
};

export type ChatwootConversation = {
  id: number;
  status: "open" | "resolved" | "pending" | "snoozed";
  contact_last_seen_at?: string;
  agent_last_seen_at?: string;
  meta?: {
    sender?: { id: number; name: string; phone_number?: string; email?: string };
  };
};

export type ChatwootWebhookPayload = {
  event: string;
  id?: number;
  content?: string;
  message_type?: "incoming" | "outgoing" | "activity" | "template";
  private?: boolean;
  created_at?: string;
  content_type?: string;
  content_attributes?: Record<string, unknown>;
  conversation?: {
    id: number;
    status: string;
    [key: string]: unknown;
  };
  sender?: {
    id: number;
    name: string;
    email?: string;
    phone_number?: string;
    type: "contact" | "user" | "agent_bot";
    [key: string]: unknown;
  };
  inbox?: { id: number; name: string };
  account?: { id: number };
  attachments?: ChatwootAttachment[];
};

// ── Client ─────────────────────────────────────────────────────────────

export class ChatwootApi {
  private baseUrl: string;
  private apiToken: string;

  constructor(baseUrl: string, apiToken: string) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiToken = apiToken;
  }

  private async request<T>(
    path: string,
    method: string = "GET",
    body?: unknown,
  ): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        api_access_token: this.apiToken,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    };

    const res = await fetch(`${this.baseUrl}${path}`, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Chatwoot API ${res.status}: ${text}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return res.json() as Promise<T>;
    }
    return {} as T;
  }

  async sendMessage(
    accountId: number,
    conversationId: number,
    content: string,
    opts?: { messageType?: string; isPrivate?: boolean },
  ): Promise<ChatwootMessage> {
    return this.request<ChatwootMessage>(
      `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
      "POST",
      {
        content,
        message_type: opts?.messageType ?? "outgoing",
        private: opts?.isPrivate ?? false,
      },
    );
  }

  async toggleStatus(
    accountId: number,
    conversationId: number,
    status: "open" | "pending" | "resolved" | "snoozed",
  ): Promise<unknown> {
    return this.request(
      `/api/v1/accounts/${accountId}/conversations/${conversationId}/toggle_status`,
      "POST",
      { status },
    );
  }

  async getMessages(
    accountId: number,
    conversationId: number,
  ): Promise<{ payload: ChatwootMessage[] }> {
    return this.request<{ payload: ChatwootMessage[] }>(
      `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
    );
  }

  async getConversation(
    accountId: number,
    conversationId: number,
  ): Promise<ChatwootConversation> {
    return this.request<ChatwootConversation>(
      `/api/v1/accounts/${accountId}/conversations/${conversationId}`,
    );
  }

  async toggleTyping(
    accountId: number,
    conversationId: number,
    typingStatus: "on" | "off",
    isPrivate = true,
  ): Promise<unknown> {
    return this.request(
      `/api/v1/accounts/${accountId}/conversations/${conversationId}/toggle_typing_status`,
      "POST",
      { typing_status: typingStatus, is_private: isPrivate },
    );
  }
}
