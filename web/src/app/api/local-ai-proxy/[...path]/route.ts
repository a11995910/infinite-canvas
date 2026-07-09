import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 900;

const BASE_URL_HEADER = "x-canvas-ai-base-url";

type RouteContext = {
    params: Promise<{ path: string[] }>;
};

function proxyRequestHeaders(request: NextRequest) {
    const headers = new Headers(request.headers);
    headers.delete(BASE_URL_HEADER);
    headers.delete("host");
    headers.delete("content-length");
    headers.delete("connection");
    headers.delete("cookie");
    headers.delete("origin");
    headers.delete("referer");
    headers.delete("sec-fetch-dest");
    headers.delete("sec-fetch-mode");
    headers.delete("sec-fetch-site");
    return headers;
}

function proxyResponseHeaders(response: Response) {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
    headers.set("cache-control", "no-store");
    return headers;
}

function normalizeBaseUrl(value: string | null) {
    if (!value) throw new Error("缺少模型服务 Base URL");
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("模型服务 Base URL 只支持 http 或 https");
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url;
}

function assertAllowedAIPath(pathname: string) {
    const normalizedPath = pathname.replace(/\/+/g, "/");
    const allowedPatterns = [
        /(^|\/)(v1|v1beta)\/models$/,
        /(^|\/)v1\/images\/generations$/,
        /(^|\/)v1\/images\/edits$/,
        /(^|\/)v1\/chat\/completions$/,
        /(^|\/)(v1|v1beta)\/models\/[^/]+:(generateContent|streamGenerateContent)$/,
    ];
    if (!allowedPatterns.some((pattern) => pattern.test(normalizedPath))) {
        throw new Error("该代理只允许访问模型、图片和对话相关接口");
    }
}

async function proxy(request: NextRequest, context: RouteContext) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });

    try {
        const { path } = await context.params;
        const baseUrl = normalizeBaseUrl(request.headers.get(BASE_URL_HEADER));
        const targetPath = path.map((item) => encodeURIComponent(item).replace(/%3A/g, ":")).join("/");
        const upstream = new URL(`${baseUrl.pathname}/${targetPath}`.replace(/\/+/g, "/") + request.nextUrl.search, baseUrl.origin);
        assertAllowedAIPath(upstream.pathname);

        const hasBody = request.method !== "GET" && request.method !== "HEAD";
        let response: Response;
        try {
            response = await fetch(upstream, {
                method: request.method,
                headers: proxyRequestHeaders(request),
                body: hasBody ? request.body : undefined,
                duplex: hasBody ? "half" : undefined,
                redirect: "manual",
            } as RequestInit & { duplex?: "half" });
        } catch (error) {
            const message = error instanceof Error && error.message ? error.message : "上游连接失败";
            return Response.json({ error: { message: `模型代理连接上游失败：${message}` } }, { status: 502 });
        }

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: proxyResponseHeaders(response),
        });
    } catch (error) {
        return Response.json({ error: { message: error instanceof Error ? error.message : "模型代理请求失败" } }, { status: 400 });
    }
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
