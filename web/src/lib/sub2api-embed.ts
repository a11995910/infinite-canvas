import { encodeChannelModel, modelOptionsFromChannels, normalizeChannelModels, selectableModelsByCapability, type AiConfig, type ApiCallFormat, type ChannelModel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";

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

export type Sub2APIEmbedKeyChannel = {
    key: Sub2APIEmbedKey;
    models: string[];
};

export type Sub2APIEmbedConfig = {
    sourceOrigin: string;
    proxyBaseUrl: string;
    keys: Sub2APIEmbedKey[];
    keyChannels: Sub2APIEmbedKeyChannel[];
};

export const SUB2API_EMBED_CHANNEL_PREFIX = "sub2api-embedded-key-";

const legacySub2APIEmbedChannelIds = ["sub2api-embedded", "sub2api-embedded-image", "sub2api-embedded-text", "sub2api-embedded-video"];
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

export function activeSub2APIEmbedKeys(keys: Sub2APIEmbedKey[]) {
    return keys.filter((key) => key.status === "active" && key.key && sub2APIKeyApiFormat(key));
}

export function sub2APIKeyApiFormat(key: Sub2APIEmbedKey): ApiCallFormat | null {
    const platform = sub2APIKeyPlatform(key);
    if (platform === "gemini") return "gemini";
    if (platform === "openai" || platform === "grok") return "openai";
    return null;
}

export function sub2APIEmbedChannelId(key: Pick<Sub2APIEmbedKey, "id">) {
    return `${SUB2API_EMBED_CHANNEL_PREFIX}${key.id}`;
}

export function createSub2APIEmbedChannel(key: Sub2APIEmbedKey, proxyBaseUrl: string, models: string[] = []): ModelChannel {
    const apiFormat = sub2APIKeyApiFormat(key);
    if (!apiFormat) throw new Error("Sub2API Key 平台暂不支持");
    const channelModels = normalizeChannelModels(models);

    return {
        id: sub2APIEmbedChannelId(key),
        name: sub2APIEmbedChannelName(key),
        baseUrl: proxyBaseUrl,
        apiKey: key.key,
        apiFormat,
        models: key.group?.allow_image_generation === true ? channelModels : channelModels.filter((model) => model.capability !== "image"),
    };
}

export function buildSub2APIEmbedConfig(config: AiConfig, payload: Sub2APIEmbedConfig): AiConfig {
    const embedChannels = payload.keyChannels.map(({ key, models }) => createSub2APIEmbedChannel(key, payload.proxyBaseUrl, models));
    const channels = [...embedChannels, ...config.channels.filter((channel) => !isSub2APIEmbedChannelId(channel.id))];
    const models = modelOptionsFromChannels(channels);
    const nextConfig = { ...config, channels, models };

    return {
        ...nextConfig,
        channelMode: "local",
        baseUrl: embedChannels[0]?.baseUrl || config.baseUrl,
        apiKey: embedChannels[0]?.apiKey || config.apiKey,
        apiFormat: embedChannels[0]?.apiFormat || config.apiFormat,
        imageModel: resolveRoleModel(config.imageModel, modelOptionsForCapability(payload, "image")),
        videoModel: resolveRoleModel(config.videoModel, modelOptionsForCapability(payload, "video")),
        textModel: resolveRoleModel(config.textModel, modelOptionsForCapability(payload, "text")),
        audioModel: resolveRoleModel(config.audioModel, modelOptionsForCapability(payload, "audio")),
    };
}

export function clearSub2APIEmbedConfig(config: AiConfig): AiConfig {
    const channels = config.channels.filter((channel) => !isSub2APIEmbedChannelId(channel.id));
    if (channels.length === config.channels.length) return config;

    const models = modelOptionsFromChannels(channels);
    const nextConfig = { ...config, channels, models };
    return {
        ...nextConfig,
        imageModel: replaceEmbedModel(config.imageModel, selectableModelsByCapability(nextConfig, "image")),
        videoModel: replaceEmbedModel(config.videoModel, selectableModelsByCapability(nextConfig, "video")),
        textModel: replaceEmbedModel(config.textModel, selectableModelsByCapability(nextConfig, "text")),
        audioModel: replaceEmbedModel(config.audioModel, selectableModelsByCapability(nextConfig, "audio")),
    };
}

export function hasSub2APIEmbedChannel(config: AiConfig, payload: Sub2APIEmbedConfig) {
    const expected = payload.keyChannels.map(({ key, models }) => createSub2APIEmbedChannel(key, payload.proxyBaseUrl, models));
    const actual = config.channels.filter((channel) => isSub2APIEmbedChannelId(channel.id));
    return (
        expected.length === actual.length &&
        expected.every((channel) =>
            actual.some((item) => item.id === channel.id && item.name === channel.name && item.baseUrl === channel.baseUrl && item.apiKey === channel.apiKey && item.apiFormat === channel.apiFormat && sameModels(item.models, channel.models)),
        )
    );
}

function modelOptionsForCapability(payload: Sub2APIEmbedConfig, capability: ModelCapability) {
    return Array.from(
        new Set(
            payload.keyChannels.flatMap(({ key, models }) => {
                const channel = createSub2APIEmbedChannel(key, payload.proxyBaseUrl, models);
                return channel.models.filter((model) => model.capability === capability).map((model) => encodeChannelModel(channel.id, model.name));
            }),
        ),
    );
}

function sub2APIEmbedChannelName(key: Sub2APIEmbedKey) {
    const groupName = key.group?.name?.trim();
    const keyName = key.name.trim();
    const name = groupName && keyName && groupName !== keyName ? `${groupName} / ${keyName}` : groupName || keyName || "当前账号";
    return `Sub2API：${name}（#${key.id}）`;
}

function sub2APIKeyPlatform(key: Sub2APIEmbedKey) {
    return key.group?.platform?.trim().toLowerCase();
}

function isSub2APIEmbedChannelId(channelId: string) {
    return channelId.startsWith(SUB2API_EMBED_CHANNEL_PREFIX) || legacySub2APIEmbedChannelIds.includes(channelId);
}

function resolveRoleModel(current: string, options: string[]) {
    if (options.includes(current)) return current;
    return options[0] || (isSub2APIEmbedModel(current) ? "" : current);
}

function replaceEmbedModel(current: string, fallback: string[]) {
    return isSub2APIEmbedModel(current) ? fallback[0] || "" : current;
}

function isSub2APIEmbedModel(model: string) {
    return model.startsWith(SUB2API_EMBED_CHANNEL_PREFIX) || legacySub2APIEmbedChannelIds.some((id) => model.startsWith(`${id}::`));
}

function sameModels(left: ChannelModel[], right: ChannelModel[]) {
    return left.length === right.length && left.every((model, index) => model.name === right[index]?.name && model.capability === right[index]?.capability && model.script === right[index]?.script);
}
