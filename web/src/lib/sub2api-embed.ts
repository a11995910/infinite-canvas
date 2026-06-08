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
    selectedImageKey: Sub2APIEmbedKey;
    selectedTextKey: Sub2APIEmbedKey;
    keys: Sub2APIEmbedKey[];
};

export type Sub2APIEmbedRole = "image" | "text" | "video";
export type Sub2APIEmbedSelectedKeys = Partial<Record<Sub2APIEmbedRole, Sub2APIEmbedKey>>;

export const SUB2API_EMBED_CHANNEL_ID = "sub2api-embedded";
export const SUB2API_EMBED_IMAGE_CHANNEL_ID = "sub2api-embedded-image";
export const SUB2API_EMBED_TEXT_CHANNEL_ID = "sub2api-embedded-text";
export const SUB2API_EMBED_VIDEO_CHANNEL_ID = "sub2api-embedded-video";
export const SUB2API_EMBED_CHANNEL_IDS = [SUB2API_EMBED_CHANNEL_ID, SUB2API_EMBED_IMAGE_CHANNEL_ID, SUB2API_EMBED_TEXT_CHANNEL_ID, SUB2API_EMBED_VIDEO_CHANNEL_ID];
export const SUB2API_EMBED_CHANNEL_ROLES: Sub2APIEmbedRole[] = ["image", "text", "video"];
export const SUB2API_EMBED_MODEL_FALLBACKS: Record<Sub2APIEmbedRole, string[]> = {
    image: ["gpt-image-2"],
    text: ["gpt-5.5"],
    video: ["Agnes-Video-V2.0"],
};
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

export function chooseSub2APIKey(keys: Sub2APIEmbedKey[], role: "image" | "text" = "image") {
    const active = keys.filter((key) => key.status === "active" && key.key);
    if (role === "text") {
        return active.find((key) => key.group?.platform === "openai" && key.group.allow_image_generation !== true) || active.find((key) => key.group?.allow_image_generation !== true) || active.find((key) => key.group?.platform === "openai") || active[0] || null;
    }
    return active.find((key) => key.group?.platform === "openai" && key.group.allow_image_generation === true) || active.find((key) => key.group?.allow_image_generation === true) || active.find((key) => key.group?.platform === "openai") || active[0] || null;
}

export function buildSub2APIEmbedConfig(config: AiConfig, payload: Sub2APIEmbedConfig, selectedKeys?: Sub2APIEmbedSelectedKeys, channelModels?: Partial<Record<Sub2APIEmbedRole, string[]>>): AiConfig {
    const resolvedKeys = resolveSub2APIEmbedKeys(config, payload, selectedKeys);
    const embedChannels = SUB2API_EMBED_CHANNEL_ROLES.map((role) => buildSub2APIEmbedChannel(payload, role, resolvedKeys[role], channelModels?.[role]));
    const currentChannels = config.localChannels.filter((item) => !SUB2API_EMBED_CHANNEL_IDS.includes(item.id));
    const channels = [...embedChannels, ...currentChannels];
    const models = Array.from(new Set(channels.flatMap((item) => item.models)));
    return {
        ...config,
        channelMode: "local",
        baseUrl: embedChannels[0].baseUrl,
        apiKey: embedChannels[0].apiKey,
        localChannels: channels,
        models,
        activeChannelId: "",
        imageChannelId: SUB2API_EMBED_IMAGE_CHANNEL_ID,
        textChannelId: SUB2API_EMBED_TEXT_CHANNEL_ID,
        videoChannelId: SUB2API_EMBED_VIDEO_CHANNEL_ID,
        apiMode: "images",
        imageModel: resolveRoleModel(config.imageModel, embedChannels[0].models, "gpt-image-2"),
        textModel: resolveRoleModel(config.textModel, embedChannels[1].models, "gpt-5.5"),
        videoModel: resolveRoleModel(config.videoModel, embedChannels[2].models, "Agnes-Video-V2.0"),
        responseFormatB64Json: true,
    };
}

export function clearSub2APIEmbedConfig(config: AiConfig): AiConfig {
    const localChannels = config.localChannels.filter((item) => !SUB2API_EMBED_CHANNEL_IDS.includes(item.id));
    const hasEmbedChannel = localChannels.length !== config.localChannels.length;
    const usesEmbedChannel = [config.activeChannelId, config.imageChannelId, config.textChannelId, config.videoChannelId].some((id) => SUB2API_EMBED_CHANNEL_IDS.includes(id));
    if (!hasEmbedChannel && !usesEmbedChannel) return config;

    const fallbackChannel = localChannels[0];
    const fallbackId = fallbackChannel?.id || "";
    const replaceEmbedId = (id: string) => (SUB2API_EMBED_CHANNEL_IDS.includes(id) ? fallbackId : id);
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
    const activeKeys = payload.keys.filter((key) => key.status === "active" && key.key);
    return [SUB2API_EMBED_IMAGE_CHANNEL_ID, SUB2API_EMBED_TEXT_CHANNEL_ID].every((id) => {
        const channel = config.localChannels.find((item) => item.id === id);
        return channel?.baseUrl === payload.proxyBaseUrl && activeKeys.some((key) => key.key === channel.apiKey);
    });
}

export function sub2APIEmbedChannelId(role: Sub2APIEmbedRole) {
    if (role === "text") return SUB2API_EMBED_TEXT_CHANNEL_ID;
    if (role === "video") return SUB2API_EMBED_VIDEO_CHANNEL_ID;
    return SUB2API_EMBED_IMAGE_CHANNEL_ID;
}

function resolveSub2APIEmbedKeys(config: AiConfig, payload: Sub2APIEmbedConfig, selectedKeys?: Sub2APIEmbedSelectedKeys): Record<Sub2APIEmbedRole, Sub2APIEmbedKey> {
    return {
        image: selectedKeys?.image || currentSub2APIEmbedKey(config, payload, "image") || payload.selectedImageKey || payload.selectedKey,
        text: selectedKeys?.text || currentSub2APIEmbedKey(config, payload, "text") || payload.selectedTextKey || payload.selectedKey,
        video: selectedKeys?.video || selectedKeys?.image || currentSub2APIEmbedKey(config, payload, "video") || payload.selectedImageKey || payload.selectedKey,
    };
}

function currentSub2APIEmbedKey(config: AiConfig, payload: Sub2APIEmbedConfig, role: Sub2APIEmbedRole) {
    const channelId = role === "video" ? SUB2API_EMBED_VIDEO_CHANNEL_ID : sub2APIEmbedChannelId(role);
    const legacyKey = role === "image" ? config.localChannels.find((item) => item.id === SUB2API_EMBED_CHANNEL_ID)?.apiKey || config.apiKey : "";
    const currentKey = config.localChannels.find((item) => item.id === channelId)?.apiKey || legacyKey;
    return payload.keys.find((key) => key.status === "active" && key.key && key.key === currentKey);
}

function buildSub2APIEmbedChannel(payload: Sub2APIEmbedConfig, role: Sub2APIEmbedRole, selectedKey: Sub2APIEmbedKey, models?: string[]): LocalModelChannel {
    const roleName = role === "text" ? "文本" : role === "video" ? "视频" : "图片";
    return {
        id: sub2APIEmbedChannelId(role),
        name: `Sub2API ${roleName}：${selectedKey.group?.name || selectedKey.name || "当前账号"}`,
        baseUrl: payload.proxyBaseUrl,
        apiKey: selectedKey.key,
        models: models?.length ? models : SUB2API_EMBED_MODEL_FALLBACKS[role],
    };
}

function resolveRoleModel(current: string, models: string[], fallback: string) {
    if (current && models.includes(current)) return current;
    return models[0] || current || fallback;
}
