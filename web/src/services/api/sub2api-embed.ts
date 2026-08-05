import { activeSub2APIEmbedKeys, createSub2APIEmbedChannel, type Sub2APIEmbedConfig, type Sub2APIEmbedKey } from "@/lib/sub2api-embed";
import type { AuthSession } from "@/services/api/auth";
import { fetchChannelModels } from "@/services/api/image";
import { guessCapability, type ChannelModel, type ModelPrice } from "@/stores/use-config-store";

type Sub2APIEmbedKeysResponse = {
    sourceOrigin: string;
    proxyBaseUrl: string;
    keys: Sub2APIEmbedKey[];
};

type Sub2APIEnvelope<T> = {
    code?: number;
    data?: T;
    msg?: string;
    message?: string;
};

type Sub2APIAvailableGroup = {
    id: number;
    name: string;
    rate_multiplier?: number;
    video_rate_independent?: boolean;
    video_rate_multiplier?: number;
    video_price_480p?: number | null;
    video_price_720p?: number | null;
    video_price_1080p?: number | null;
};

type Sub2APIModelPricing = {
    billing_mode?: "token" | "per_request" | "image" | "video";
    per_request_price?: number | null;
    intervals?: Array<{ tier_label?: string; per_request_price?: number | null }>;
};

type Sub2APISupportedModel = {
    name: string;
    pricing?: Sub2APIModelPricing | null;
    group_ids?: number[];
};

type Sub2APIAvailableChannel = {
    platforms?: Array<{
        platform: string;
        groups?: Sub2APIAvailableGroup[];
        supported_models?: Sub2APISupportedModel[];
    }>;
};

type Sub2APIVideoPriceCatalog = {
    channels: Sub2APIAvailableChannel[];
    groupRates: Record<string, number>;
};

const MAX_PARALLEL_MODEL_REQUESTS = 6;

export async function fetchSub2APIEmbedConfig(params: { token: string; srcHost: string }): Promise<Sub2APIEmbedConfig> {
    const query = new URLSearchParams({ src_host: params.srcHost });
    const response = await fetch(`/api/sub2api/keys?${query.toString()}`, {
        headers: { Authorization: `Bearer ${params.token}` },
    });
    const payload = (await response.json().catch(() => null)) as Sub2APIEmbedKeysResponse | { message?: string } | null;
    if (!response.ok) throw new Error((payload && "message" in payload && payload.message) || "读取 Sub2API Key 失败");
    const data = payload as Sub2APIEmbedKeysResponse;
    const keys = data.keys || [];
    const activeKeys = activeSub2APIEmbedKeys(keys);
    if (!activeKeys.length) throw new Error("当前账号没有可用的 Sub2API Key");

    const [results, priceCatalog] = await Promise.all([
        fetchSub2APIKeyModels(activeKeys, data.proxyBaseUrl),
        fetchSub2APIVideoPriceCatalog(data.proxyBaseUrl, params.token).catch((error) => {
            console.warn("Sub2API 视频价格读取失败", error);
            return null;
        }),
    ]);
    const keyChannels = activeKeys.map((key, index) => {
        const result = results[index];
        if (result.status === "fulfilled") return { key, models: buildSub2APIChannelModels(key, result.value, priceCatalog) };
        console.warn("Sub2API Key 模型列表读取失败", key.id);
        return { key, models: [] };
    });

    return { sourceOrigin: data.sourceOrigin, proxyBaseUrl: data.proxyBaseUrl, keys, keyChannels };
}

function buildSub2APIChannelModels(key: Sub2APIEmbedKey, names: string[], catalog: Sub2APIVideoPriceCatalog | null): ChannelModel[] {
    return names.map((name) => {
        const capability = guessCapability(name);
        const price = capability === "video" && catalog ? resolveSub2APIVideoPrice(key, name, catalog) : undefined;
        return { name, capability, price };
    });
}

function resolveSub2APIVideoPrice(key: Sub2APIEmbedKey, modelName: string, catalog: Sub2APIVideoPriceCatalog): ModelPrice | undefined {
    const platformName = key.group?.platform?.trim().toLowerCase();
    const platforms = catalog.channels.flatMap((channel) => channel.platforms || []).filter((platform) => platform.platform?.trim().toLowerCase() === platformName);
    const models = platforms.flatMap((platform) => platform.supported_models || []).filter((model) => model.name === modelName);
    const model = models.find((item) => key.group_id && item.group_ids?.includes(key.group_id)) || models[0];
    if (!model || model.pricing?.billing_mode === "token") return undefined;

    const groups = platforms.flatMap((platform) => platform.groups || []);
    const group = groups.find((item) => item.id === key.group_id) || groups.find((item) => item.name === key.group?.name) || groups.find((item) => model.group_ids?.includes(item.id));
    const resolution = videoModelResolution(modelName);
    const resolutionPrice = resolution ? videoResolutionPrice(group, resolution) : undefined;
    const intervalPrice = resolution ? model.pricing?.intervals?.find((interval) => interval.tier_label?.trim().toLowerCase() === resolution)?.per_request_price : undefined;
    const unit = finiteNonNegative(resolutionPrice) ? "second" : model.pricing?.billing_mode === "video" ? "second" : model.pricing?.billing_mode === "per_request" || model.pricing?.billing_mode === "image" ? "item" : undefined;
    const basePrice = resolutionPrice ?? intervalPrice ?? model.pricing?.per_request_price;
    if (!unit) return undefined;
    if (!finiteNonNegative(basePrice)) return undefined;

    const customGroupRate = group ? catalog.groupRates[String(group.id)] : undefined;
    const groupRate = finiteNonNegative(customGroupRate) ? customGroupRate : finiteNonNegative(group?.rate_multiplier) ? group!.rate_multiplier! : 1;
    const multiplier = group?.video_rate_independent && finiteNonNegative(group.video_rate_multiplier) ? group.video_rate_multiplier : groupRate;
    return { amount: basePrice * multiplier, unit };
}

function videoModelResolution(modelName: string) {
    return modelName.toLowerCase().match(/(?:^|[-_])(480p|720p|1080p)(?:$|[-_])/)?.[1];
}

function videoResolutionPrice(group: Sub2APIAvailableGroup | undefined, resolution: string) {
    if (resolution === "480p") return group?.video_price_480p ?? undefined;
    if (resolution === "720p") return group?.video_price_720p ?? undefined;
    if (resolution === "1080p") return group?.video_price_1080p ?? undefined;
    return undefined;
}

function finiteNonNegative(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

async function fetchSub2APIVideoPriceCatalog(proxyBaseUrl: string, token: string): Promise<Sub2APIVideoPriceCatalog> {
    const [channels, rates] = await Promise.all([fetchSub2APIData<Sub2APIAvailableChannel[]>(proxyBaseUrl, "/api/v1/channels/available", token), fetchSub2APIData<Record<string, number>>(proxyBaseUrl, "/api/v1/groups/rates", token).catch(() => ({}))]);
    return { channels: Array.isArray(channels) ? channels : [], groupRates: rates || {} };
}

async function fetchSub2APIData<T>(proxyBaseUrl: string, path: string, token: string): Promise<T> {
    const response = await fetch(`${proxyBaseUrl}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    const payload = (await response.json().catch(() => null)) as Sub2APIEnvelope<T> | null;
    if (!response.ok || !payload || (typeof payload.code === "number" && payload.code !== 0) || payload.data === undefined) throw new Error(payload?.message || payload?.msg || "读取 Sub2API 价格失败");
    return payload.data;
}

async function fetchSub2APIKeyModels(keys: Sub2APIEmbedKey[], proxyBaseUrl: string) {
    const results: PromiseSettledResult<string[]>[] = [];
    for (let start = 0; start < keys.length; start += MAX_PARALLEL_MODEL_REQUESTS) {
        // 限制同时访问上游的 Key 数量，避免大量 Key 初始化时造成瞬时请求峰值。
        results.push(...(await Promise.allSettled(keys.slice(start, start + MAX_PARALLEL_MODEL_REQUESTS).map((key) => fetchChannelModels(createSub2APIEmbedChannel(key, proxyBaseUrl))))));
    }
    return results;
}

export async function fetchSub2APIEmbedSession(params: { token: string; srcHost: string }): Promise<AuthSession> {
    const query = new URLSearchParams({ src_host: params.srcHost });
    const response = await fetch(`/api/sub2api/session?${query.toString()}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${params.token}` },
    });
    const payload = (await response.json().catch(() => null)) as AuthSession | { message?: string } | null;
    if (!response.ok) throw new Error((payload && "message" in payload && payload.message) || "Sub2API 嵌入登录失败");
    return payload as AuthSession;
}
