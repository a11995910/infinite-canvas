import type { NextRequest } from "next/server";

import { proxyRequestHeaders, proxyResponseHeaders, verifySub2APIProxyTarget } from "@/lib/sub2api-server";

export const runtime = "nodejs";
export const maxDuration = 300;

type RouteContext = {
    params: Promise<{ target: string; expires: string; signature: string; path: string[] }>;
};

async function proxy(request: NextRequest, context: RouteContext) {
    try {
        const { target, expires, signature, path } = await context.params;
        const origin = verifySub2APIProxyTarget(target, expires, signature);
        const upstream = `${origin}/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;
        const hasBody = request.method !== "GET" && request.method !== "HEAD";
        const response = await fetch(upstream, {
            method: request.method,
            headers: proxyRequestHeaders(request),
            body: hasBody ? request.body : undefined,
            duplex: hasBody ? "half" : undefined,
            redirect: "manual",
        } as RequestInit & { duplex?: "half" });

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: proxyResponseHeaders(response),
        });
    } catch (error) {
        return Response.json({ error: { message: error instanceof Error ? error.message : "Sub2API 代理请求失败" } }, { status: 400 });
    }
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
