import type { NextRequest } from "next/server";

import { assertAllowedSub2APIOrigin, buildSub2APIProxyBaseUrl, normalizeSub2APIOrigin, readBearerToken, signSub2APIOrigin } from "@/lib/sub2api-server";

export const runtime = "nodejs";

type Sub2APIResponse<T> = {
    code?: number;
    data?: T;
    msg?: string;
    message?: string;
};

type Sub2APIPaginatedKeys = {
    items?: Sub2APIKey[];
};

type Sub2APIKey = {
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

export async function GET(request: NextRequest) {
    try {
        const sourceOrigin = normalizeSub2APIOrigin(request.nextUrl.searchParams.get("src_host"));
        assertAllowedSub2APIOrigin(sourceOrigin);

        const token = readBearerToken(request);
        if (!token) return Response.json({ message: "缺少 Sub2API 登录令牌" }, { status: 401 });

        const response = await fetch(`${sourceOrigin}/api/v1/keys?page=1&page_size=100`, {
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
            cache: "no-store",
        });
        const payload = (await response.json().catch(() => null)) as Sub2APIResponse<Sub2APIPaginatedKeys> | null;
        if (!response.ok || payload?.code !== 0) {
            return Response.json({ message: payload?.message || payload?.msg || "读取 Sub2API Key 失败" }, { status: response.status || 502 });
        }

        const keys = (payload.data?.items || []).map((key) => ({
            id: key.id,
            key: key.key,
            name: key.name,
            status: key.status,
            group: key.group
                ? {
                      name: key.group.name,
                      platform: key.group.platform,
                      allow_image_generation: key.group.allow_image_generation,
                  }
                : undefined,
        }));
        const signed = signSub2APIOrigin(sourceOrigin);
        return Response.json({
            sourceOrigin,
            proxyBaseUrl: buildSub2APIProxyBaseUrl(request, signed),
            keys,
        });
    } catch (error) {
        return Response.json({ message: error instanceof Error ? error.message : "读取 Sub2API Key 失败" }, { status: 400 });
    }
}
