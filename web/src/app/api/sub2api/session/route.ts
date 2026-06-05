import type { NextRequest } from "next/server";

import type { AuthSession } from "@/services/api/auth";
import { assertAllowedSub2APIOrigin, backendAPIBaseUrl, normalizeSub2APIOrigin, readBearerToken, sub2APIEmbedSecret } from "@/lib/sub2api-server";

export const runtime = "nodejs";

type Sub2APIResponse<T> = {
    code?: number;
    data?: T;
    msg?: string;
    message?: string;
};

type Sub2APIUser = {
    id?: number | string;
    email?: string;
    username?: string;
    display_name?: string;
    displayName?: string;
    nickname?: string;
    name?: string;
    avatar_url?: string;
    avatarUrl?: string;
};

type BackendResponse<T> = {
    code?: number;
    data?: T;
    msg?: string;
    message?: string;
};

export async function POST(request: NextRequest) {
    try {
        const sourceOrigin = normalizeSub2APIOrigin(request.nextUrl.searchParams.get("src_host"));
        assertAllowedSub2APIOrigin(sourceOrigin);

        const token = readBearerToken(request);
        if (!token) return Response.json({ message: "缺少 Sub2API 登录令牌" }, { status: 401 });

        const sub2apiUser = await fetchSub2APIUser(sourceOrigin, token);
        const userID = String(sub2apiUser.id || "").trim();
        if (!userID) return Response.json({ message: "Sub2API 用户信息缺少 ID" }, { status: 502 });

        const session = await createCanvasSession(sourceOrigin, sub2apiUser, userID);
        return Response.json(session);
    } catch (error) {
        return Response.json({ message: error instanceof Error ? error.message : "Sub2API 嵌入登录失败" }, { status: 400 });
    }
}

async function fetchSub2APIUser(sourceOrigin: string, token: string) {
    const response = await fetch(`${sourceOrigin}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        cache: "no-store",
    });
    const payload = (await response.json().catch(() => null)) as Sub2APIResponse<Sub2APIUser> | null;
    if (!response.ok || payload?.code !== 0 || !payload.data) {
        throw new Error(payload?.message || payload?.msg || "Sub2API 登录状态无效");
    }
    return payload.data;
}

async function createCanvasSession(sourceOrigin: string, user: Sub2APIUser, userID: string) {
    const embedSecret = sub2APIEmbedSecret();
    if (!embedSecret) throw new Error("Sub2API 嵌入密钥未配置");

    const response = await fetch(`${backendAPIBaseUrl()}/auth/sub2api-embed`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Sub2API-Embed-Secret": embedSecret,
        },
        body: JSON.stringify({
            sourceOrigin,
            userId: userID,
            email: firstString(user.email),
            username: firstString(user.username),
            displayName: firstString(user.displayName, user.display_name, user.nickname, user.name, user.username, user.email),
            avatarUrl: firstString(user.avatarUrl, user.avatar_url),
        }),
        cache: "no-store",
    });
    const payload = (await response.json().catch(() => null)) as BackendResponse<AuthSession> | null;
    if (!response.ok || payload?.code !== 0 || !payload.data) {
        throw new Error(payload?.message || payload?.msg || "创建画布登录会话失败");
    }
    return payload.data;
}

function firstString(...values: unknown[]) {
    for (const value of values) {
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
}
