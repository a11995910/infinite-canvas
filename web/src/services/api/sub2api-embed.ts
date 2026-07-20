import { activeSub2APIEmbedKeys, createSub2APIEmbedChannel, type Sub2APIEmbedConfig, type Sub2APIEmbedKey } from "@/lib/sub2api-embed";
import type { AuthSession } from "@/services/api/auth";
import { fetchChannelModels } from "@/services/api/image";

type Sub2APIEmbedKeysResponse = {
    sourceOrigin: string;
    proxyBaseUrl: string;
    keys: Sub2APIEmbedKey[];
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

    const results = await fetchSub2APIKeyModels(activeKeys, data.proxyBaseUrl);
    const keyChannels = activeKeys.map((key, index) => {
        const result = results[index];
        if (result.status === "fulfilled") return { key, models: result.value };
        console.warn("Sub2API Key 模型列表读取失败", key.id);
        return { key, models: [] };
    });

    return { sourceOrigin: data.sourceOrigin, proxyBaseUrl: data.proxyBaseUrl, keys, keyChannels };
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
