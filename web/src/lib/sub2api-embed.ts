import { encodeChannelModel, modelOptionsFromChannels, type AiConfig, type ModelChannel } from "@/stores/use-config-store";

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
    selectedVideoKey?: Sub2APIEmbedKey;
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
    video: ["grok-imagine-video-1.5"],
};

const embedQueryKeys = ["ui_mode", "token", "src_host", "src_url", "theme", "lang"] as const;

export function readSub2APIEmbedParams(): Sub2APIEmbedParams {
    const params = new URLSearchParams(window.location.search);
    return {
        embedded: params.get("ui_mode") === "embedded",
        token: (params.get("token") || "").trim(),
        srcHost: (params.get("src_host") || "").trim(),
    };
}

export function isSub2APIEmbedded() {
    const params = readSub2APIEmbedParams();
    return params.embedded && Boolean(params.token && params.srcHost);
}

export function withSub2APIEmbedParams(path: string) {
    const currentParams = new URLSearchParams(window.location.search);
    if (currentParams.get("ui_mode") !== "embedded" || !currentParams.get("token") || !currentParams.get("src_host")) return path;

    const target = new URL(path, window.location.origin);
    embedQueryKeys.forEach((key) => {
        const value = currentParams.get(key);
        if (value && !target.searchParams.has(key)) target.searchParams.set(key, value);
    });
    return `${target.pathname}${target.search}${target.hash}`;
}

export function chooseSub2APIKey(keys: Sub2APIEmbedKey[], role: Sub2APIEmbedRole = "image") {
    const active = keys.filter((key) => key.status === "active" && key.key);
    if (role === "video") {
        return active.find((key) => isSub2APIGrokKey(key) && key.group?.allow_image_generation === true) || active.find(isSub2APIGrokKey) || null;
    }
    if (role === "text") {
        return active.find((key) => key.group?.platform === "openai" && key.group.allow_image_generation !== true) || active.find((key) => key.group?.allow_image_generation !== true) || active.find((key) => key.group?.platform === "openai") || active[0] || null;
    }
    return active.find((key) => key.group?.platform === "openai" && key.group.allow_image_generation === true) || active.find((key) => key.group?.allow_image_generation === true) || active.find((key) => key.group?.platform === "openai") || active[0] || null;
}

export function buildSub2APIEmbedConfig(config: AiConfig, payload: Sub2APIEmbedConfig, selectedKeys?: Sub2APIEmbedSelectedKeys, channelModels?: Partial<Record<Sub2APIEmbedRole, string[]>>): AiConfig {
    const keys = resolveSub2APIEmbedKeys(config, payload, selectedKeys);
    const imageChannel = buildSub2APIEmbedChannel(payload, "image", keys.image, channelModels?.image);
    const textChannel = buildSub2APIEmbedChannel(payload, "text", keys.text, channelModels?.text);
    const videoChannel = keys.video ? buildSub2APIEmbedChannel(payload, "video", keys.video, channelModels?.video) : undefined;
    const embedChannels = [imageChannel, textChannel, ...(videoChannel ? [videoChannel] : [])];
    const channels = [...embedChannels, ...config.channels.filter((channel) => !SUB2API_EMBED_CHANNEL_IDS.includes(channel.id))];
    const imageOptions = optionsForChannel(imageChannel);
    const textOptions = optionsForChannel(textChannel);
    const videoOptions = optionsForChannel(videoChannel);

    return {
        ...config,
        channelMode: "local",
        baseUrl: embedChannels[0].baseUrl,
        apiKey: embedChannels[0].apiKey,
        apiFormat: "openai",
        channels,
        models: modelOptionsFromChannels(channels),
        imageModel: resolveRoleModel(config.imageModel, imageOptions),
        textModel: resolveRoleModel(config.textModel, textOptions),
        videoModel: videoOptions.length ? resolveRoleModel(config.videoModel, videoOptions) : replaceEmbedModel(config.videoModel, []),
    };
}

export function clearSub2APIEmbedConfig(config: AiConfig): AiConfig {
    const channels = config.channels.filter((channel) => !SUB2API_EMBED_CHANNEL_IDS.includes(channel.id));
    if (channels.length === config.channels.length) return config;

    const fallbackOptions = optionsForChannel(channels[0]);
    return {
        ...config,
        channels,
        models: modelOptionsFromChannels(channels),
        imageModel: replaceEmbedModel(config.imageModel, fallbackOptions),
        textModel: replaceEmbedModel(config.textModel, fallbackOptions),
        videoModel: replaceEmbedModel(config.videoModel, fallbackOptions),
    };
}

export function hasSub2APIEmbedChannel(config: AiConfig, payload: Sub2APIEmbedConfig) {
    const keys = new Set(payload.keys.filter((key) => key.status === "active" && key.key).map((key) => key.key));
    const videoKeys = new Set(payload.keys.filter((key) => key.status === "active" && key.key && isSub2APIGrokKey(key)).map((key) => key.key));
    const requiredIds = [SUB2API_EMBED_IMAGE_CHANNEL_ID, SUB2API_EMBED_TEXT_CHANNEL_ID, ...(payload.selectedVideoKey ? [SUB2API_EMBED_VIDEO_CHANNEL_ID] : [])];
    return requiredIds.every((id) => {
        const channel = config.channels.find((item) => item.id === id);
        if (channel?.baseUrl !== payload.proxyBaseUrl) return false;
        if (id === SUB2API_EMBED_VIDEO_CHANNEL_ID) return videoKeys.has(channel.apiKey) && channel.models.some((model) => model.name === SUB2API_EMBED_MODEL_FALLBACKS.video[0]);
        return keys.has(channel.apiKey);
    });
}

export function sub2APIEmbedChannelId(role: Sub2APIEmbedRole) {
    if (role === "text") return SUB2API_EMBED_TEXT_CHANNEL_ID;
    if (role === "video") return SUB2API_EMBED_VIDEO_CHANNEL_ID;
    return SUB2API_EMBED_IMAGE_CHANNEL_ID;
}

function resolveSub2APIEmbedKeys(config: AiConfig, payload: Sub2APIEmbedConfig, selectedKeys?: Sub2APIEmbedSelectedKeys) {
    const currentVideoKey = currentSub2APIEmbedKey(config, payload, "video");
    return {
        image: selectedKeys?.image || currentSub2APIEmbedKey(config, payload, "image") || payload.selectedImageKey || payload.selectedKey,
        text: selectedKeys?.text || currentSub2APIEmbedKey(config, payload, "text") || payload.selectedTextKey || payload.selectedKey,
        video: selectedKeys?.video || (isSub2APIGrokKey(currentVideoKey) ? currentVideoKey : undefined) || payload.selectedVideoKey,
    };
}

function currentSub2APIEmbedKey(config: AiConfig, payload: Sub2APIEmbedConfig, role: Sub2APIEmbedRole) {
    const channel = config.channels.find((item) => item.id === sub2APIEmbedChannelId(role));
    return payload.keys.find((key) => key.status === "active" && key.key === channel?.apiKey);
}

function buildSub2APIEmbedChannel(payload: Sub2APIEmbedConfig, role: Sub2APIEmbedRole, selectedKey: Sub2APIEmbedKey, models?: string[]): ModelChannel {
    const roleName = role === "text" ? "文本" : role === "video" ? "视频" : "图片";
    return {
        id: sub2APIEmbedChannelId(role),
        name: `Sub2API ${roleName}：${selectedKey.group?.name || selectedKey.name || "当前账号"}`,
        baseUrl: payload.proxyBaseUrl,
        apiKey: selectedKey.key,
        apiFormat: "openai",
        models: (models?.length ? models : SUB2API_EMBED_MODEL_FALLBACKS[role]).map((name) => ({ name, capability: role === "text" ? "text" : role })),
    };
}

function optionsForChannel(channel?: ModelChannel) {
    return channel ? channel.models.map((model) => encodeChannelModel(channel.id, model.name)) : [];
}

function resolveRoleModel(current: string, options: string[]) {
    return options.includes(current) ? current : options[0] || current;
}

function replaceEmbedModel(current: string, fallback: string[]) {
    return isEmbedModel(current) ? fallback[0] || "" : current;
}

function isEmbedModel(model: string) {
    return SUB2API_EMBED_CHANNEL_IDS.some((id) => model.startsWith(`${id}::`));
}

function isSub2APIGrokKey(key: Sub2APIEmbedKey | undefined) {
    return key?.group?.platform?.trim().toLowerCase() === "grok";
}
