import { chooseSub2APIKey, type Sub2APIEmbedConfig, type Sub2APIEmbedKey } from "@/lib/sub2api-embed";
import type { AuthSession } from "@/services/api/auth";

type Sub2APIEmbedKeysResponse = {
    sourceOrigin: string;
    proxyBaseUrl: string;
    keys: Sub2APIEmbedKey[];
};

export async function fetchSub2APIEmbedConfig(params: { token: string; srcHost: string }): Promise<Sub2APIEmbedConfig> {
    const query = new URLSearchParams({ src_host: params.srcHost });
    const response = await fetch(`/api/sub2api/keys?${query.toString()}`, {
        headers: { Authorization: `Bearer ${params.token}` },
    });
    const payload = (await response.json().catch(() => null)) as Sub2APIEmbedKeysResponse | { message?: string } | null;
    if (!response.ok) throw new Error((payload && "message" in payload && payload.message) || "读取 Sub2API Key 失败");
    const data = payload as Sub2APIEmbedKeysResponse;
    const selectedImageKey = chooseSub2APIKey(data.keys || [], "image");
    const selectedTextKey = chooseSub2APIKey(data.keys || [], "text") || selectedImageKey;
    const selectedVideoKey = chooseSub2APIKey(data.keys || [], "video") || undefined;
    const selectedKey = selectedImageKey || selectedTextKey || selectedVideoKey;
    if (!selectedKey) throw new Error("当前账号没有可用的 Sub2API Key");
    return { sourceOrigin: data.sourceOrigin, proxyBaseUrl: data.proxyBaseUrl, selectedKey, selectedImageKey: selectedImageKey || selectedKey, selectedTextKey: selectedTextKey || selectedKey, selectedVideoKey, keys: data.keys || [] };
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
