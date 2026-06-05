import { createHmac, timingSafeEqual } from "crypto";
import { isIP } from "net";

import type { NextRequest } from "next/server";

const DEFAULT_SIGNATURE_TTL_SECONDS = 24 * 60 * 60;
const PRIVATE_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

export function normalizeSub2APIOrigin(value: string | null) {
    const raw = (value || "").trim();
    if (!raw) throw new Error("缺少 Sub2API 来源地址");

    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error("Sub2API 来源地址格式不正确");
    }

    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Sub2API 来源地址只支持 HTTP/HTTPS");
    if (process.env.SUB2API_EMBED_ALLOW_PRIVATE_HOSTS !== "true" && isPrivateHost(url.hostname)) throw new Error("Sub2API 来源地址不允许使用内网主机");

    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.origin;
}

export function assertAllowedSub2APIOrigin(origin: string) {
    const allowed = (process.env.SUB2API_EMBED_ALLOWED_ORIGINS || "")
        .split(",")
        .map((item) => item.trim().replace(/\/+$/, ""))
        .filter(Boolean);
    if (allowed.length && !allowed.includes(origin)) throw new Error("当前 Sub2API 来源不在允许列表中");
}

export function signSub2APIOrigin(origin: string) {
    const expires = Math.floor(Date.now() / 1000) + signatureTTLSeconds();
    return { target: encodeTarget(origin), expires, signature: signatureFor(origin, expires) };
}

export function verifySub2APIProxyTarget(target: string, expires: string | null, signature: string | null) {
    const exp = Number(expires);
    if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) throw new Error("Sub2API 代理地址已过期");

    const origin = decodeTarget(target);
    assertAllowedSub2APIOrigin(origin);

    const expected = signatureFor(origin, exp);
    if (!signature || !safeEqual(signature, expected)) throw new Error("Sub2API 代理签名无效");
    return origin;
}

export function buildSub2APIProxyBaseUrl(request: NextRequest, signed: { target: string; expires: number; signature: string }) {
    return `${publicRequestOrigin(request)}/api/sub2api/proxy/${signed.target}/${signed.expires}/${signed.signature}`;
}

export function proxyRequestHeaders(request: NextRequest) {
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");
    headers.delete("connection");
    headers.delete("accept-encoding");
    headers.delete("cookie");
    headers.delete("x-forwarded-host");
    headers.delete("x-forwarded-proto");
    return headers;
}

export function proxyResponseHeaders(response: Response) {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
    return headers;
}

function isPrivateHost(hostname: string) {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (PRIVATE_HOSTS.has(normalized) || normalized.endsWith(".local")) return true;

    if (isIP(normalized) === 4) {
        const parts = normalized.split(".").map(Number);
        return parts[0] === 10 || parts[0] === 127 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 169 && parts[1] === 254);
    }
    return isIP(normalized) === 6 && (normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80"));
}

function encodeTarget(origin: string) {
    return Buffer.from(origin, "utf8").toString("base64url");
}

function decodeTarget(target: string) {
    try {
        return normalizeSub2APIOrigin(Buffer.from(target, "base64url").toString("utf8"));
    } catch {
        throw new Error("Sub2API 代理目标不正确");
    }
}

function publicRequestOrigin(request: NextRequest) {
    const forwardedHost = request.headers.get("x-forwarded-host") || request.headers.get("host") || request.nextUrl.host;
    const forwardedProto = request.headers.get("x-forwarded-proto") || request.nextUrl.protocol.replace(":", "");
    const protocol = forwardedProto.split(",")[0]?.trim() === "https" ? "https" : "http";
    const host = forwardedHost.split(",")[0]?.trim();
    return host ? `${protocol}://${host}` : request.nextUrl.origin;
}

function signatureFor(origin: string, expires: number) {
    return createHmac("sha256", proxySecret()).update(`${origin}:${expires}`).digest("base64url");
}

function proxySecret() {
    return process.env.SUB2API_EMBED_PROXY_SECRET || process.env.JWT_SECRET || "infinite-canvas-sub2api-embed";
}

function signatureTTLSeconds() {
    const value = Number(process.env.SUB2API_EMBED_PROXY_TTL_SECONDS);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_SIGNATURE_TTL_SECONDS;
}

function safeEqual(a: string, b: string) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}
