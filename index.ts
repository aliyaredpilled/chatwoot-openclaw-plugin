import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { chatwootChannelPlugin } from "./src/channel.js";

const plugin = {
  id: "chatwoot",
  name: "Chatwoot",
  description: "Chatwoot channel plugin (Agent Bot webhook)",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: chatwootChannelPlugin as any });
    api.logger.info("[chatwoot] plugin registered");
  },
};

export default plugin;
