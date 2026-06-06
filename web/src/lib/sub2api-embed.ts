import type { AiConfig, LocalModelChannel } from "@/stores/use-config-store";

export type Sub2APIEmbedParams = {
    embedded: boolean;
    token: string;
    srcHost: string;
};

export type Sub2APIEmbedKey = {
    id: number;
    key: string;
    name: string;
    status: string;
    group?: {
        name?: string;
        platform?: string;
        allow_image_generation?: boolean;
    };
};

export type Sub2APIEmbedConfig = {
    sourceOrigin: string;
    proxyBaseUrl: string;
    selectedKey: Sub2APIEmbedKey;
    keys: Sub2APIEmbedKey[];
};

export const SUB2API_EMBED_CHANNEL_ID = "sub2api-embedded";
export const SUB2API_EMBED_MODEL_FALLBACKS = ["gpt-image-2", "gpt-5.5", "Agnes-Video-V2.0"];
const SUB2API_EMBED_QUERY_KEYS = ["ui_mode", "token", "src_host", "src_url", "theme", "lang"] as const;

export function readSub2APIEmbedParams(): Sub2APIEmbedParams {
    if (typeof window === "undefined") return { embedded: false, token: "", srcHost: "" };
    const params = new URLSearchParams(window.location.search);
    return {
        embedded: params.get("ui_mode") === "embedded",
        token: (params.get("token") || "").trim(),
        srcHost: (params.get("src_host") || "").trim(),
    };
}

export function isSub2APIEmbedded() {
    const params = readSub2APIEmbedParams();
    return params.embedded && !!params.token && !!params.srcHost;
}

export function withSub2APIEmbedParams(path: string) {
    if (typeof window === "undefined") return path;
    const currentParams = new URLSearchParams(window.location.search);
    if (currentParams.get("ui_mode") !== "embedded" || !currentParams.get("token") || !currentParams.get("src_host")) return path;

    const target = new URL(path, window.location.origin);
    SUB2API_EMBED_QUERY_KEYS.forEach((key) => {
        const value = currentParams.get(key);
        if (value && !target.searchParams.has(key)) target.searchParams.set(key, value);
    });
    return `${target.pathname}${target.search}${target.hash}`;
}

export function chooseSub2APIKey(keys: Sub2APIEmbedKey[]) {
    const active = keys.filter((key) => key.status === "active" && key.key);
    return (
        active.find((key) => key.group?.platform === "openai" && key.group.allow_image_generation === true) ||
        active.find((key) => key.group?.platform === "openai") ||
        active.find((key) => key.group?.allow_image_generation === true) ||
        active[0] ||
        null
    );
}

export function buildSub2APIEmbedConfig(config: AiConfig, payload: Sub2APIEmbedConfig, selectedKey?: Sub2APIEmbedKey, channelModels?: string[]): AiConfig {
    const channel = buildSub2APIEmbedChannel(payload, selectedKey || resolveSub2APIEmbedKey(config, payload), channelModels);
    const currentChannels = config.localChannels.filter((item) => item.id !== SUB2API_EMBED_CHANNEL_ID);
    const channels = [channel, ...currentChannels];
    const models = Array.from(new Set(channels.flatMap((item) => item.models)));
    return {
        ...config,
        channelMode: "local",
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        localChannels: channels,
        models,
        activeChannelId: SUB2API_EMBED_CHANNEL_ID,
        imageChannelId: SUB2API_EMBED_CHANNEL_ID,
        textChannelId: SUB2API_EMBED_CHANNEL_ID,
        videoChannelId: SUB2API_EMBED_CHANNEL_ID,
        apiMode: "images",
        imageModel: config.imageModel || "gpt-image-2",
        textModel: config.textModel || "gpt-5.5",
        videoModel: config.videoModel || "Agnes-Video-V2.0",
        responseFormatB64Json: true,
    };
}

export function clearSub2APIEmbedConfig(config: AiConfig): AiConfig {
    const localChannels = config.localChannels.filter((item) => item.id !== SUB2API_EMBED_CHANNEL_ID);
    const hasEmbedChannel = localChannels.length !== config.localChannels.length;
    const usesEmbedChannel = [config.activeChannelId, config.imageChannelId, config.textChannelId, config.videoChannelId].includes(SUB2API_EMBED_CHANNEL_ID);
    if (!hasEmbedChannel && !usesEmbedChannel) return config;

    const fallbackChannel = localChannels[0];
    const fallbackId = fallbackChannel?.id || "";
    const replaceEmbedId = (id: string) => (id === SUB2API_EMBED_CHANNEL_ID ? fallbackId : id);
    const models = Array.from(new Set(localChannels.flatMap((item) => item.models)));
    return {
        ...config,
        channelMode: config.channelMode === "local" && !localChannels.length ? "remote" : config.channelMode,
        baseUrl: fallbackChannel?.baseUrl || "",
        apiKey: fallbackChannel?.apiKey || "",
        localChannels,
        models,
        activeChannelId: replaceEmbedId(config.activeChannelId),
        imageChannelId: replaceEmbedId(config.imageChannelId),
        textChannelId: replaceEmbedId(config.textChannelId),
        videoChannelId: replaceEmbedId(config.videoChannelId),
    };
}

export function hasSub2APIEmbedChannel(config: AiConfig, payload: Sub2APIEmbedConfig) {
    const channel = config.localChannels.find((item) => item.id === SUB2API_EMBED_CHANNEL_ID);
    return channel?.baseUrl === payload.proxyBaseUrl && payload.keys.some((key) => key.status === "active" && key.key && key.key === channel.apiKey);
}

function resolveSub2APIEmbedKey(config: AiConfig, payload: Sub2APIEmbedConfig) {
    const currentKey = config.localChannels.find((item) => item.id === SUB2API_EMBED_CHANNEL_ID)?.apiKey || config.apiKey;
    return payload.keys.find((key) => key.status === "active" && key.key && key.key === currentKey) || payload.selectedKey;
}

function buildSub2APIEmbedChannel(payload: Sub2APIEmbedConfig, selectedKey: Sub2APIEmbedKey, models?: string[]): LocalModelChannel {
    return {
        id: SUB2API_EMBED_CHANNEL_ID,
        name: `Sub2API：${selectedKey.group?.name || selectedKey.name || "当前账号"}`,
        baseUrl: payload.proxyBaseUrl,
        apiKey: selectedKey.key,
        models: models?.length ? models : SUB2API_EMBED_MODEL_FALLBACKS,
    };
}
