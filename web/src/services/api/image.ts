import axios, { type AxiosRequestConfig, type AxiosResponse } from "axios";

import { dataUrlToFile } from "@/lib/image-utils";
import { imageToDataUrl, resolveImageUrl } from "@/services/image-storage";
import { buildApiUrl, channelIdForActiveModel, localChannelForActiveModel, normalizeApiFormat, normalizeOpenAIBaseUrl, type AiConfig, type ApiCallFormat } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";
import { nanoid } from "nanoid";

export type ChatCompletionMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

type ImageApiResponse = {
    data?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};

type GeminiPart = {
    text?: string;
    inlineData?: { mimeType?: string; data?: string };
    inline_data?: { mime_type?: string; mimeType?: string; data?: string };
    fileData?: { mimeType?: string; fileUri?: string };
};

type GeminiContent = { role?: "user" | "model"; parts: GeminiPart[] };

type GeminiPayload = {
    candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
    models?: Array<{ name?: string }>;
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
};

type GeminiTextStreamState = { buffer: string; text: string; error?: string };

type GeneratedImage = { id: string; dataUrl: string; seed?: number };

type ParsedImageResponse = {
    images: GeneratedImage[];
    responseBody: string;
};

type ImageEditOptions = {
    maskDataUrl?: string;
};

export class ImageRequestError extends Error {
    detail?: string;

    constructor(message: string, detail?: unknown) {
        super(message);
        this.name = "ImageRequestError";
        this.detail = formatErrorDetail(detail);
    }
}

type ImageRequestParams = {
    n: number;
    quality: string;
    size?: string;
    outputFormat: "png" | "jpeg" | "webp";
    outputCompression: number;
    moderation: "auto" | "low";
    timeoutSeconds: number;
    streamPartialImages: number;
};

const QUALITY_BASE: Record<string, number> = {
    low: 1024,
    medium: 2048,
    high: 2880,
    standard: 1024,
    hd: 2048,
};
const QUALITY_ALIASES: Record<string, string> = {
    "1k": "low",
    "2k": "medium",
    "4k": "high",
};
const MIME_MAP: Record<ImageRequestParams["outputFormat"], string> = {
    png: "image/png",
    jpeg: "image/jpeg",
    webp: "image/webp",
};
const GEMINI_SUPPORTED_RATIOS = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];
const GEMINI_IMAGE_SIZE_BY_QUALITY: Record<string, string> = { low: "1K", medium: "2K", high: "4K", standard: "1K", hd: "2K" };
const PROMPT_REWRITE_GUARD_PREFIX = "Use the following text as the complete prompt. Do not rewrite it:";
const LOCAL_AI_PROXY_BASE_HEADER = "X-Canvas-AI-Base-URL";
const MAX_ERROR_MESSAGE_LENGTH = 260;
const MAX_ERROR_DETAIL_LENGTH = 12000;

function normalizeQuality(quality: string) {
    const value = quality.trim().toLowerCase();
    if (!value || value === "auto") return "auto";
    const normalized = QUALITY_ALIASES[value] || value;
    return QUALITY_BASE[normalized] ? normalized : "auto";
}

function normalizeOutputFormat(value: string): ImageRequestParams["outputFormat"] {
    return value === "jpeg" || value === "webp" ? value : "png";
}

function normalizeModeration(value: string): ImageRequestParams["moderation"] {
    return value === "low" ? "low" : "auto";
}

function normalizeBoundedInteger(value: string | number, fallback: number, min: number, max: number) {
    const number = Math.floor(Math.abs(Number(value)));
    if (!Number.isFinite(number) || number < min) return fallback;
    return Math.max(min, Math.min(max, number));
}

/** Map "quality + ratio" to an explicit pixel dimension like "3840x2160". Returns undefined when quality is auto. */
function resolveSize(quality: string, ratio: string): string | undefined {
    const basePixels = QUALITY_BASE[quality];
    if (!basePixels || ratio === "auto" || !ratio) return undefined;

    const parts = ratio.split(":");
    if (parts.length !== 2) return undefined;
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!w || !h) return undefined;

    const targetPixels = basePixels * basePixels;
    const isLandscape = w >= h;
    const longRatio = isLandscape ? w / h : h / w;

    const longSideRaw = Math.sqrt(targetPixels * longRatio);
    const longSide = Math.floor(longSideRaw / 16) * 16;
    const shortSide = Math.round(longSide / longRatio / 16) * 16;

    const width = isLandscape ? longSide : shortSide;
    const height = isLandscape ? shortSide : longSide;

    return `${width}x${height}`;
}

function resolveRequestSize(quality: string | undefined, size: string) {
    const value = size.trim();
    if (!value || value === "auto") return undefined;
    if (/^\d+x\d+$/.test(value)) return value;
    // 用户只选了宽高比时,即使 quality=auto 也要折算成具体像素尺寸,避免 "1:1" 这种非法值发到 API。
    return resolveSize(quality && QUALITY_BASE[quality] ? quality : "low", value);
}

function createImageRequestParams(config: AiConfig): ImageRequestParams {
    const quality = normalizeQuality(config.quality);
    const outputFormat = normalizeOutputFormat(config.outputFormat);
    return {
        n: normalizeBoundedInteger(config.count, 1, 1, 15),
        quality,
        size: resolveRequestSize(quality, config.size),
        outputFormat,
        outputCompression: normalizeBoundedInteger(config.outputCompression, 100, 0, 100),
        moderation: normalizeModeration(config.moderation),
        timeoutSeconds: normalizeBoundedInteger(config.timeout, 600, 1, 3600),
        streamPartialImages: normalizeBoundedInteger(config.streamPartialImages, 1, 0, 3),
    };
}

function normalizeBase64Image(value: string, fallbackMime: string) {
    return value.startsWith("data:") ? value : `data:${fallbackMime};base64,${value}`;
}

function resolveImageDataUrl(item: Record<string, unknown>, mime: string) {
    if (typeof item.b64_json === "string" && item.b64_json) {
        return normalizeBase64Image(item.b64_json, mime);
    }
    if (typeof item.url === "string" && item.url) {
        return item.url;
    }
    return null;
}

function parseImagePayload(payload: ImageApiResponse, mime: string): GeneratedImage[] {
    if (typeof payload.code === "number" && payload.code !== 0) {
        throw new ImageRequestError(payload.msg || "请求失败", payload);
    }
    const images =
        payload.data
            ?.map((item) => resolveImageDataUrl(item, mime))
            .filter((value): value is string => Boolean(value))
            .map((dataUrl) => ({ id: nanoid(), dataUrl })) || [];

    if (images.length === 0) {
        throw new ImageRequestError("接口没有返回图片", payload);
    }

    return images;
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return normalizeErrorMessage(responseData?.msg || responseData?.error?.message || "", error.response?.status ? `${fallback}：${error.response.status}` : fallback);
    }
    return normalizeErrorMessage(error instanceof Error ? error.message : "", fallback);
}

function compactErrorText(value: string) {
    return value.replace(/\s+/g, " ").trim();
}

function truncateErrorText(value: string, maxLength: number) {
    return value.length > maxLength ? `${value.slice(0, maxLength)}\n\n...内容过长，已截断...` : value;
}

function normalizeErrorMessage(message: string, fallback: string) {
    const text = compactErrorText(message || fallback);
    if (/image generation is not enabled for this group/i.test(text)) {
        return "当前 API Key 所属分组未开启图片生成权限，请在上游后台为该分组开启图片生成，或切换到有生图权限的 Key。";
    }
    if (/invalid api key/i.test(text)) {
        return "API Key 无效或已失效，请检查当前渠道的 API Key。";
    }
    if (/model is not supported when using codex with a chatgpt account/i.test(text)) {
        return "当前账号不支持调用这个模型，请切换模型或上游账号。";
    }
    if (/images endpoint requires an image model/i.test(text)) {
        const invalidModel = text.match(/got "([^"]+)"/i)?.[1];
        const modelTip = invalidModel ? `当前填写的是 ${invalidModel}，` : "";
        return `${modelTip}上游图片接口不认可这个模型名，请在配置里先拉取模型列表，并改用接口真实返回的图片模型。`;
    }
    return truncateErrorText(text || fallback, MAX_ERROR_MESSAGE_LENGTH);
}

function isHtmlErrorResponse(contentType: string, text: string) {
    const head = text.trim().slice(0, 300).toLowerCase();
    return contentType.toLowerCase().includes("text/html") || head.startsWith("<!doctype html") || head.startsWith("<html") || head.includes("<body");
}

async function fetchErrorDetail(response: Response, fallback: string) {
    try {
        const text = await response.text();
        if (!text.trim()) return { message: `${fallback}：${response.status}`, detail: `${response.status} ${response.statusText}` };
        if (isHtmlErrorResponse(response.headers.get("Content-Type") || "", text)) {
            return {
                message:
                    response.status === 504
                        ? "生图请求在站点网关等待超时（504），上游可能仍在处理中，请勿立即重复提交。"
                        : "上游返回了网页错误页面，请检查 Base URL 是否填写为接口根地址。",
                detail: truncateErrorText(text.trim(), MAX_ERROR_DETAIL_LENGTH),
            };
        }
        try {
            const payload = JSON.parse(text) as { error?: { message?: string }; msg?: string; message?: string };
            return { message: normalizeErrorMessage(payload.msg || payload.error?.message || payload.message || "", `${fallback}：${response.status}`), detail: payload };
        } catch {
            return { message: normalizeErrorMessage(text.trim(), `${fallback}：${response.status}`), detail: truncateErrorText(text, MAX_ERROR_DETAIL_LENGTH) };
        }
    } catch {
        return { message: `${fallback}：${response.status}`, detail: `${response.status} ${response.statusText}` };
    }
}

function formatErrorDetail(detail: unknown) {
    if (detail == null) return "";
    if (typeof detail === "string") return truncateErrorText(detail, MAX_ERROR_DETAIL_LENGTH);
    try {
        return truncateErrorText(JSON.stringify(detail, null, 2), MAX_ERROR_DETAIL_LENGTH);
    } catch {
        return truncateErrorText(String(detail), MAX_ERROR_DETAIL_LENGTH);
    }
}

function timeoutError(timeoutSeconds: number) {
    return `请求超时：超过 ${timeoutSeconds} 秒仍未完成，请稍后重试或提高超时时间。`;
}

async function withTimeout<T>(timeoutSeconds: number, run: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    try {
        return await run(controller.signal);
    } catch (error) {
        if (controller.signal.aborted) throw new Error(timeoutError(timeoutSeconds));
        throw error;
    } finally {
        window.clearTimeout(timeoutId);
    }
}

async function parseResponseWithTimeout<T>(response: Response, timeoutSeconds: number, parseResponse: (response: Response) => Promise<T>) {
    let timeoutId: number | undefined;
    try {
        return await new Promise<T>((resolve, reject) => {
            timeoutId = window.setTimeout(() => {
                void response.body?.cancel().catch(() => {});
                reject(new Error(timeoutError(timeoutSeconds)));
            }, timeoutSeconds * 1000);
            parseResponse(response).then(resolve, reject);
        });
    } finally {
        if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    }
}

function isTransientStatus(status: number) {
    return status === 429 || status === 502 || status === 503 || status === 504;
}

function isRequestTimeoutError(error: unknown) {
    return error instanceof Error && error.message.startsWith("请求超时：");
}

function retryDelay(attempt: number) {
    return 700 * attempt;
}

async function requestWithTransientRetry(run: () => Promise<Response>, retries = 2) {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const response = await run();
            if (!isTransientStatus(response.status) || attempt === retries) return response;
            lastError = new Error(`上游接口临时不可用：${response.status}`);
        } catch (error) {
            lastError = error;
            if (isRequestTimeoutError(error)) throw error;
            if (attempt === retries) throw error;
        }
        await new Promise((resolve) => window.setTimeout(resolve, retryDelay(attempt + 1)));
    }
    throw lastError instanceof Error ? lastError : new Error("请求失败");
}

function parseServerSentEventBlock(block: string) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return null;
    return JSON.parse(data) as Record<string, unknown>;
}

async function readJsonServerSentEvents(response: Response, onEvent: (event: Record<string, unknown>) => void) {
    if (!response.body) throw new ImageRequestError("接口未返回可读取的流式响应", `${response.status} ${response.statusText}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: Record<string, unknown>[] = [];

    const processBlock = (block: string) => {
        let event: Record<string, unknown> | null = null;
        try {
            event = parseServerSentEventBlock(block);
        } catch (error) {
            throw new ImageRequestError(error instanceof Error ? error.message : "流式响应解析失败", block);
        }
        if (!event) return;
        events.push(event);
        const error = event.error;
        if (error && typeof error === "object" && !Array.isArray(error) && typeof (error as { message?: unknown }).message === "string") {
            throw new ImageRequestError((error as { message: string }).message, event);
        }
        onEvent(event);
    };

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separatorIndex = buffer.search(/\r?\n\r?\n/);
        while (separatorIndex >= 0) {
            const separator = buffer.match(/\r?\n\r?\n/)?.[0] || "\n\n";
            processBlock(buffer.slice(0, separatorIndex));
            buffer = buffer.slice(separatorIndex + separator.length);
            separatorIndex = buffer.search(/\r?\n\r?\n/);
        }
    }
    buffer += decoder.decode();
    if (buffer.trim()) processBlock(buffer);
    return events;
}

function isEventStreamResponse(response: Response) {
    return response.headers.get("Content-Type")?.toLowerCase().includes("text/event-stream") ?? false;
}

async function parseImagesStreamResponse(response: Response, mime: string): Promise<GeneratedImage[]> {
    const completedItems: Record<string, unknown>[] = [];
    let resultPayload: ImageApiResponse | null = null;
    const events = await readJsonServerSentEvents(response, (event) => {
        const type = typeof event.type === "string" ? event.type : "";
        const object = typeof event.object === "string" ? event.object : "";
        if (object === "image.generation.result" || object === "image.edit.result") {
            resultPayload = event as ImageApiResponse;
        }
        if (type === "image_generation.completed" || type === "image_edit.completed") {
            completedItems.push(event);
        }
    });
    if (resultPayload) return parseImagePayload(resultPayload, mime);
    if (completedItems.length) return parseImagePayload({ data: completedItems }, mime);
    throw new ImageRequestError("流式接口未返回最终图片数据", events);
}

function parseStreamChunk(chunk: string, onDelta: (value: string) => void) {
    let deltaText = "";
    for (const eventBlock of chunk.split("\n\n")) {
        const data = eventBlock
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
        if (!data || data === "[DONE]") continue;
        const delta = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content || "";
        deltaText += delta;
    }
    if (deltaText) onDelta(deltaText);
}

function withSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = (config.systemPrompts.image || config.systemPrompt).trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

function withPromptGuard(config: AiConfig, prompt: string) {
    return config.codexCli ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}` : prompt;
}

function aiApiUrl(config: AiConfig, path: string) {
    if (config.channelMode === "remote") return `/api/v1${path}`;
    const channel = localChannelForActiveModel(config);
    return buildApiUrl(channel?.baseUrl || config.baseUrl, path);
}

function localProxyUrlFromPath(path: string) {
    const encodedPath = path
        .split("/")
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment).replace(/%3A/g, ":"))
        .join("/");
    return `/api/local-ai-proxy/${encodedPath}`;
}

function localProxyOpenAIUrl(path: string) {
    return localProxyUrlFromPath(path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    const token = useUserStore.getState().token;
    if (config.channelMode === "remote" && !token) throw new Error("请先登录后再使用云端渠道");
    return config.channelMode === "remote"
        ? {
              Authorization: `Bearer ${token}`,
              ...(channelIdForActiveModel(config) ? { "X-Model-Channel-ID": channelIdForActiveModel(config) } : {}),
              ...(contentType ? { "Content-Type": contentType } : {}),
          }
        : {
              Authorization: `Bearer ${localChannelForActiveModel(config)?.apiKey || config.apiKey}`,
              ...(contentType ? { "Content-Type": contentType } : {}),
          };
}

function activeApiFormat(config: AiConfig): ApiCallFormat {
    if (config.channelMode === "remote") return "openai";
    return normalizeApiFormat(localChannelForActiveModel(config)?.apiFormat || config.apiFormat);
}

function activeLocalBaseUrl(config: AiConfig) {
    return localChannelForActiveModel(config)?.baseUrl || config.baseUrl;
}

function activeLocalApiKey(config: AiConfig) {
    return localChannelForActiveModel(config)?.apiKey || config.apiKey;
}

function geminiBaseUrl(config: AiConfig) {
    const normalizedBaseUrl = activeLocalBaseUrl(config).trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    return lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/v1beta") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1beta`;
}

function geminiModelName(model: string) {
    return model.trim().replace(/^models\//, "");
}

function geminiApiUrl(config: AiConfig, action?: "generateContent" | "streamGenerateContent") {
    const baseUrl = geminiBaseUrl(config);
    if (!action) return `${baseUrl}/models`;
    return `${baseUrl}/models/${encodeURIComponent(geminiModelName(config.model))}:${action}`;
}

function localProxyGeminiApiUrl(config: AiConfig, action?: "generateContent" | "streamGenerateContent") {
    const lowerBaseUrl = activeLocalBaseUrl(config).trim().replace(/\/+$/, "").toLowerCase();
    const versionPrefix = lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/v1beta") ? "" : "/v1beta";
    const path = action ? `${versionPrefix}/models/${geminiModelName(config.model)}:${action}` : `${versionPrefix}/models`;
    return localProxyUrlFromPath(path);
}

function geminiHeaders(config: AiConfig) {
    return {
        "x-goog-api-key": activeLocalApiKey(config),
        "Content-Type": "application/json",
    };
}

function headersWithLocalProxyBase(config: AiConfig, headers: HeadersInit | undefined) {
    const nextHeaders = new Headers(headers);
    nextHeaders.set(LOCAL_AI_PROXY_BASE_HEADER, activeApiFormat(config) === "openai" ? normalizeOpenAIBaseUrl(activeLocalBaseUrl(config)) : activeLocalBaseUrl(config));
    return nextHeaders;
}

function axiosHeadersWithLocalProxyBase(config: AiConfig, headers: Record<string, string>) {
    return { ...headers, [LOCAL_AI_PROXY_BASE_HEADER]: activeApiFormat(config) === "openai" ? normalizeOpenAIBaseUrl(activeLocalBaseUrl(config)) : activeLocalBaseUrl(config) };
}

function isNetworkRequestError(error: unknown) {
    if (axios.isAxiosError(error)) return !error.response;
    if (error instanceof TypeError) return true;
    const message = error instanceof Error ? error.message : String(error || "");
    return /failed to fetch|networkerror|load failed|network request failed/i.test(message);
}

function shouldUseLocalProxyFallback(config: AiConfig, error: unknown) {
    return config.channelMode === "local" && isNetworkRequestError(error);
}

async function fetchWithLocalProxyFallback(config: AiConfig, directUrl: string, proxyUrl: string, timeoutSeconds: number, init: RequestInit) {
    return requestWithTransientRetry(() =>
        withTimeout(timeoutSeconds, async (signal) => {
            try {
                return await fetch(directUrl, { ...init, signal });
            } catch (error) {
                if (!proxyUrl || !shouldUseLocalProxyFallback(config, error)) throw error;
                return fetch(proxyUrl, { ...init, headers: headersWithLocalProxyBase(config, init.headers), signal });
            }
        }),
    );
}

function fetchOpenAIEndpoint(config: AiConfig, path: string, timeoutSeconds: number, init: RequestInit) {
    return fetchWithLocalProxyFallback(config, aiApiUrl(config, path), config.channelMode === "local" ? localProxyOpenAIUrl(path) : "", timeoutSeconds, init);
}

function fetchGeminiEndpoint(config: AiConfig, action: "generateContent" | "streamGenerateContent", timeoutSeconds: number, init: RequestInit, query = "") {
    return fetchWithLocalProxyFallback(config, `${geminiApiUrl(config, action)}${query}`, config.channelMode === "local" ? `${localProxyGeminiApiUrl(config, action)}${query}` : "", timeoutSeconds, init);
}

async function axiosGetWithLocalProxyFallback<T>(config: AiConfig, directUrl: string, proxyUrl: string, options: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    try {
        return await axios.get<T>(directUrl, options);
    } catch (error) {
        if (!proxyUrl || !shouldUseLocalProxyFallback(config, error)) throw error;
        return axios.get<T>(proxyUrl, { ...options, headers: axiosHeadersWithLocalProxyBase(config, (options.headers || {}) as Record<string, string>) });
    }
}

async function axiosPostWithLocalProxyFallback<T>(config: AiConfig, directUrl: string, proxyUrl: string, data: unknown, options: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    try {
        return await axios.post<T>(directUrl, data, options);
    } catch (error) {
        if (!proxyUrl || !shouldUseLocalProxyFallback(config, error)) throw error;
        return axios.post<T>(proxyUrl, data, { ...options, headers: axiosHeadersWithLocalProxyBase(config, (options.headers || {}) as Record<string, string>) });
    }
}

function refreshRemoteUser(config: AiConfig) {
    if (config.channelMode === "remote") void useUserStore.getState().hydrateUser();
}

async function writeLocalAICallLog(config: AiConfig, endpoint: string, startedAt: number, status: number, timeoutSeconds: number, requestBody: string, responseBody: string, error: string) {
    if (config.channelMode !== "local") return;
    const token = useUserStore.getState().token;
    if (!token) return;
    const channel = localChannelForActiveModel(config);
    await fetch("/api/v1/ai-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
            endpoint,
            method: "POST",
            model: config.model,
            channelId: channel?.id || config.activeChannelId || "",
            channelName: channel?.name || "本地直连",
            status,
            durationMs: Date.now() - startedAt,
            credits: 0,
            requestBody,
            responseBody,
            error,
        }),
    }).catch(() => {});
}

function stringifyLogPayload(value: unknown) {
    if (typeof value === "string") return value;
    try {
        const cloned = JSON.parse(JSON.stringify(value)) as unknown;
        redactLogImages(cloned);
        return JSON.stringify(cloned, null, 2);
    } catch {
        return String(value || "");
    }
}

function redactLogImages(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
        value.forEach(redactLogImages);
        return;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
        const item = record[key];
        if (typeof item === "string" && (item.startsWith("data:image/") || (item.length > 2048 && looksLikeBase64(item)))) {
            record[key] = `[redacted image/string len=${item.length}]`;
            continue;
        }
        redactLogImages(item);
    }
}

function looksLikeBase64(value: string) {
    return /^[A-Za-z0-9+/=]+$/.test(value.slice(0, 200));
}

function summarizeFormData(formData: FormData) {
    const fields: Record<string, string[]> = {};
    const files: Array<{ field: string; name: string; size: number; type: string }> = [];
    formData.forEach((value, key) => {
        if (value instanceof File) {
            files.push({ field: key, name: value.name, size: value.size, type: value.type });
            return;
        }
        fields[key] = [...(fields[key] || []), String(value)];
    });
    return { fields, files };
}

function summarizeGeneratedImages(images: GeneratedImage[], source: string) {
    return stringifyLogPayload({
        source,
        imageCount: images.length,
        images: images.map((image) => ({ id: image.id, dataUrl: image.dataUrl.startsWith("data:image/") ? `[redacted image len=${image.dataUrl.length}]` : image.dataUrl })),
    });
}

function withSystemMessage(config: AiConfig, messages: ChatCompletionMessage[]) {
    const systemPrompt = (config.systemPrompts.text || config.systemPrompt).trim();
    return systemPrompt ? [{ role: "system" as const, content: systemPrompt }, ...messages] : messages;
}

function validateGeminiPayload(payload: GeminiPayload) {
    if (payload.error?.message) throw new ImageRequestError(payload.error.message, payload);
    if (payload.promptFeedback?.blockReason) throw new ImageRequestError(`Gemini 拒绝了本次请求：${payload.promptFeedback.blockReason}`, payload);
}

function toGeminiBody(config: AiConfig, messages: ChatCompletionMessage[], extra?: Record<string, unknown>) {
    const systemText = [(config.systemPrompts.text || config.systemPrompt).trim(), ...messages.flatMap((message) => (message.role === "system" ? [geminiTextContent(message.content)] : []))].filter(Boolean).join("\n\n");
    const contents = toGeminiContents(messages.filter((message) => message.role !== "system"));
    return {
        contents,
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        ...extra,
    };
}

function toGeminiContents(messages: ChatCompletionMessage[]): GeminiContent[] {
    return messages.map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: toGeminiParts(message.content) }));
}

function toGeminiParts(content: ChatCompletionMessage["content"]): GeminiPart[] {
    if (!Array.isArray(content)) return [{ text: String(content || "") }];
    return content.map((item) => (item.type === "text" ? { text: item.text } : toGeminiImagePart(item.image_url.url)));
}

function toGeminiImagePart(url: string): GeminiPart {
    const match = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
    return { fileData: { fileUri: url, mimeType: "image/png" } };
}

function geminiTextContent(content: ChatCompletionMessage["content"]) {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? item.text : item.image_url.url)).join("\n");
}

function parseImageRatio(value: string) {
    const parts = value.split(":");
    if (parts.length !== 2) throw new ImageRequestError("图像比例格式不支持，请使用 auto、9:16 或 1024x1024");
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new ImageRequestError("图像比例必须是正数，例如 9:16");
    return { width: w, height: h };
}

function parseImageDimensions(value: string) {
    const match = value.match(/^(\d+)x(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function closestGeminiAspectRatio(value: string) {
    const ratio = parseImageRatio(value);
    const target = ratio.width / ratio.height;
    return GEMINI_SUPPORTED_RATIOS.reduce((best, item) => {
        const current = parseImageRatio(item);
        const bestRatio = parseImageRatio(best);
        return Math.abs(current.width / current.height - target) < Math.abs(bestRatio.width / bestRatio.height - target) ? item : best;
    });
}

function resolveGeminiImageSize(config: AiConfig, dimensions: { width: number; height: number } | null) {
    const normalizedQuality = normalizeQuality(config.quality);
    if (normalizedQuality !== "auto") return GEMINI_IMAGE_SIZE_BY_QUALITY[normalizedQuality];
    if (!dimensions) return undefined;
    const edge = Math.max(dimensions.width, dimensions.height);
    if (edge <= 768) return "512";
    if (edge <= 1536) return "1K";
    if (edge <= 3072) return "2K";
    return "4K";
}

function supportsGeminiImageSize(model: string) {
    const value = model.toLowerCase();
    return value.includes("gemini-3") || value.includes("3.1") || value.includes("3-pro");
}

function resolveGeminiImageConfig(config: AiConfig) {
    const value = config.size.trim();
    const dimensions = parseImageDimensions(value);
    const ratio = dimensions ? `${dimensions.width}:${dimensions.height}` : value;
    const aspectRatio = value && value.toLowerCase() !== "auto" ? closestGeminiAspectRatio(ratio) : undefined;
    const imageSize = supportsGeminiImageSize(config.model) ? resolveGeminiImageSize(config, dimensions) : undefined;
    const image = { ...(aspectRatio ? { aspectRatio } : {}), ...(imageSize ? { imageSize } : {}) };
    return Object.keys(image).length ? { responseFormat: { image } } : {};
}

function parseGeminiImagePayload(payload: GeminiPayload) {
    validateGeminiPayload(payload);
    const images =
        payload.candidates
            ?.flatMap((candidate) => candidate.content?.parts || [])
            .map((part) => {
                const inlineData = part.inlineData || (part.inline_data ? { mimeType: part.inline_data.mimeType || part.inline_data.mime_type, data: part.inline_data.data } : undefined);
                if (inlineData?.data) return `data:${inlineData.mimeType || "image/png"};base64,${inlineData.data}`;
                return part.fileData?.fileUri || null;
            })
            .filter((value): value is string => Boolean(value))
            .map((dataUrl) => ({ id: nanoid(), dataUrl })) || [];
    if (!images.length) throw new ImageRequestError("Gemini 接口没有返回图片", payload);
    return images;
}

function parseGeminiTextPayload(payload: GeminiPayload) {
    validateGeminiPayload(payload);
    return (
        payload.candidates
            ?.flatMap((candidate) => candidate.content?.parts || [])
            .map((part) => part.text || "")
            .join("") || ""
    );
}

function consumeGeminiTextStreamBlock(block: string, state: GeminiTextStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    try {
        const text = parseGeminiTextPayload(JSON.parse(data) as GeminiPayload);
        if (text) {
            state.text += text;
            onDelta?.(state.text);
        }
    } catch (error) {
        state.error = error instanceof Error ? error.message : "Gemini 流式响应解析失败";
    }
}

function consumeGeminiTextStream(state: GeminiTextStreamState, text: string, onDelta?: (value: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const index = match.index ?? 0;
        consumeGeminiTextStreamBlock(state.buffer.slice(0, index), state, onDelta);
        state.buffer = state.buffer.slice(index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeGeminiTextStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

async function requestGeminiImages(config: AiConfig, prompt: string, references: ReferenceImage[], params: ImageRequestParams): Promise<GeneratedImage[]> {
    const requests = Array.from({ length: params.n }, () => requestGeminiImagesOnce(config, prompt, references, params));
    return (await Promise.all(requests)).flat();
}

async function requestGeminiImagesOnce(config: AiConfig, prompt: string, references: ReferenceImage[], params: ImageRequestParams): Promise<GeneratedImage[]> {
    const systemPrompt = (config.systemPrompts.image || config.systemPrompt).trim();
    const finalPrompt = withPromptGuard(config, prompt);
    const parts: GeminiPart[] = [{ text: finalPrompt }];
    for (const image of references) {
        parts.push(toGeminiImagePart(await imageToDataUrl(image)));
    }
    const body = {
        ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
        generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...resolveGeminiImageConfig(config) },
        contents: [{ role: "user", parts }],
    };

    return requestAndParseImages(
        config,
        "/gemini/generateContent",
        body,
        params.timeoutSeconds,
        () =>
            fetchGeminiEndpoint(config, "generateContent", params.timeoutSeconds, {
                method: "POST",
                headers: geminiHeaders(config),
                body: JSON.stringify(body),
            }),
        async (response) => {
            const payload = (await response.json()) as GeminiPayload;
            const images = parseGeminiImagePayload(payload);
            return { images, responseBody: stringifyLogPayload(payload) };
        },
    );
}

async function requestGeminiQuestion(config: AiConfig, messages: ChatCompletionMessage[], onDelta: (text: string) => void) {
    const timeoutSeconds = normalizeBoundedInteger(config.timeout, 600, 1, 3600);
    const body = toGeminiBody(config, messages);
    const response = await fetchGeminiEndpoint(
        config,
        "streamGenerateContent",
        timeoutSeconds,
        {
            method: "POST",
            headers: geminiHeaders(config),
            body: JSON.stringify(body),
        },
        "?alt=sse",
    );
    if (!response.ok) {
        const error = await fetchErrorDetail(response, "请求失败");
        throw new ImageRequestError(error.message, error.detail);
    }
    if (!response.body) {
        const payload = (await response.json()) as GeminiPayload;
        const answer = parseGeminiTextPayload(payload) || "没有返回内容";
        onDelta(answer);
        return answer;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: GeminiTextStreamState = { buffer: "", text: "" };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeGeminiTextStream(state, decoder.decode(value, { stream: true }), onDelta);
        if (state.error) throw new ImageRequestError(state.error);
    }
    consumeGeminiTextStream(state, decoder.decode(), onDelta, true);
    if (state.error) throw new ImageRequestError(state.error);
    const answer = state.text || "没有返回内容";
    if (!state.text) onDelta(answer);
    return answer;
}

async function requestImageGenerationSingle(config: AiConfig & { seedIndex?: number; seedCount?: number }, prompt: string, params: ImageRequestParams): Promise<GeneratedImage[]> {
    const mime = MIME_MAP[params.outputFormat];

    // 针对 Agnes 渠道文生图模型定制精简 Payload，并强制注入高离散度种子
    if (isAgnesImageModel(config.model)) {
        const seedValue = generateDiscreteSeed(config.seedIndex, config.seedCount, config.seed);
        const body: Record<string, unknown> = {
            model: config.model,
            prompt: withPromptGuard(config, withSystemPrompt(config, prompt)),
            extra_body: {
                seed: seedValue,
            },
        };
        if (params.size) body.size = params.size;

        return requestAndParseImages(
            config,
            "/images/generations",
            body,
            params.timeoutSeconds,
            () =>
                fetchOpenAIEndpoint(config, "/images/generations", params.timeoutSeconds, {
                    method: "POST",
                    headers: aiHeaders(config, "application/json"),
                    body: JSON.stringify(body),
                }),
            async (response) => {
                if (config.streamImages && isEventStreamResponse(response)) {
                    const images = await parseImagesStreamResponse(response, mime);
                    return { images: images.map((img) => ({ ...img, seed: seedValue })), responseBody: summarizeGeneratedImages(images, "event-stream") };
                }
                const payload = (await response.json()) as ImageApiResponse;
                const images = parseImagePayload(payload, mime);
                return { images: images.map((img) => ({ ...img, seed: seedValue })), responseBody: stringifyLogPayload(payload) };
            },
        );
    }

    const body: Record<string, unknown> = {
        model: config.model,
        prompt: withPromptGuard(config, withSystemPrompt(config, prompt)),
        output_format: params.outputFormat,
        moderation: params.moderation,
    };
    if (params.n > 1) body.n = params.n;
    if (params.size) body.size = params.size;
    if (params.quality && !config.codexCli) body.quality = params.quality;
    if (params.outputFormat !== "png") body.output_compression = params.outputCompression;
    if (config.responseFormatB64Json) body.response_format = "b64_json";
    if (config.streamImages) {
        body.stream = true;
        body.partial_images = params.streamPartialImages;
    }

    return requestAndParseImages(
        config,
        "/images/generations",
        body,
        params.timeoutSeconds,
        () =>
            fetchOpenAIEndpoint(config, "/images/generations", params.timeoutSeconds, {
                method: "POST",
                headers: aiHeaders(config, "application/json"),
                body: JSON.stringify(body),
            }),
        async (response) => {
            if (config.streamImages && isEventStreamResponse(response)) {
                const images = await parseImagesStreamResponse(response, mime);
                return { images, responseBody: summarizeGeneratedImages(images, "event-stream") };
            }
            const payload = (await response.json()) as ImageApiResponse;
            return { images: parseImagePayload(payload, mime), responseBody: stringifyLogPayload(payload) };
        },
    );
}

async function requestImageEditSingle(config: AiConfig, prompt: string, references: ReferenceImage[], params: ImageRequestParams, options: ImageEditOptions = {}): Promise<GeneratedImage[]> {
    const mime = MIME_MAP[params.outputFormat];
    const formData = new FormData();
    formData.set("model", config.model);
    formData.set("prompt", withPromptGuard(config, withSystemPrompt(config, prompt)));
    formData.set("output_format", params.outputFormat);
    formData.set("moderation", params.moderation);
    if (params.n > 1) formData.set("n", String(params.n));
    if (params.size) formData.set("size", params.size);
    if (params.quality && !config.codexCli) formData.set("quality", params.quality);
    if (params.outputFormat !== "png") formData.set("output_compression", String(params.outputCompression));
    if (config.responseFormatB64Json) formData.set("response_format", "b64_json");
    if (config.streamImages) {
        formData.set("stream", "true");
        formData.set("partial_images", String(params.streamPartialImages));
    }
    const files = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => formData.append("image", file));
    if (options.maskDataUrl) {
        formData.set("mask", await dataUrlToFile({ id: "mask", name: "mask.png", type: "image/png", dataUrl: options.maskDataUrl }));
    }

    return requestAndParseImages(
        config,
        "/images/edits",
        summarizeFormData(formData),
        params.timeoutSeconds,
        () =>
            fetchOpenAIEndpoint(config, "/images/edits", params.timeoutSeconds, {
                method: "POST",
                headers: aiHeaders(config),
                body: formData,
            }),
        async (response) => {
            if (config.streamImages && isEventStreamResponse(response)) {
                const images = await parseImagesStreamResponse(response, mime);
                return { images, responseBody: summarizeGeneratedImages(images, "event-stream") };
            }
            const payload = (await response.json()) as ImageApiResponse;
            return { images: parseImagePayload(payload, mime), responseBody: stringifyLogPayload(payload) };
        },
    );
}

async function requestAndParseImages(config: AiConfig, endpoint: string, requestBody: unknown, timeoutSeconds: number, fetchResponse: () => Promise<Response>, parseResponse: (response: Response) => Promise<ParsedImageResponse>) {
    const startedAt = Date.now();
    let logged = false;
    try {
        const response = await fetchResponse();
        if (!response.ok) {
            const error = await fetchErrorDetail(response, "请求失败");
            logged = true;
            void writeLocalAICallLog(config, endpoint, startedAt, response.status, timeoutSeconds, stringifyLogPayload(requestBody), stringifyLogPayload(error.detail || error.message), error.message);
            throw new ImageRequestError(error.message, error.detail);
        }
        const parsed = await parseResponseWithTimeout(response, timeoutSeconds, parseResponse);
        logged = true;
        void writeLocalAICallLog(config, endpoint, startedAt, response.status, timeoutSeconds, stringifyLogPayload(requestBody), parsed.responseBody, "");
        return parsed.images;
    } catch (error) {
        if (!logged) {
            void writeLocalAICallLog(config, endpoint, startedAt, 0, timeoutSeconds, stringifyLogPayload(requestBody), "", error instanceof ImageRequestError ? error.detail || error.message : error instanceof Error ? error.message : "请求失败");
        }
        throw error;
    }
}

async function requestImages(config: AiConfig & { seedIndex?: number; seedCount?: number }, prompt: string, references: ReferenceImage[], options: ImageEditOptions = {}): Promise<GeneratedImage[]> {
    const imageConfig = { ...config, apiMode: "images" as const };
    const params = createImageRequestParams(config);
    if (activeApiFormat(imageConfig) === "gemini") {
        if (options.maskDataUrl) throw new ImageRequestError("Gemini 调用格式暂不支持蒙版局部重绘");
        return requestGeminiImages(imageConfig, prompt, references, params);
    }
    const useConcurrentSingleRequests = config.codexCli || config.streamImages;
    if (params.n > 1 && useConcurrentSingleRequests) {
        const results = await Promise.allSettled(Array.from({ length: params.n }, () => requestImages({ ...imageConfig, count: "1" }, prompt, references, options)));
        const images = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
        if (images.length) return images;
        const firstError = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        throw firstError?.reason || new Error("所有并发请求均失败");
    }
    if (references.length && isAgnesImageModel(imageConfig.model)) {
        return requestAgnesImageEdit(imageConfig, prompt, references, params);
    }
    return references.length ? requestImageEditSingle(imageConfig, prompt, references, params, options) : requestImageGenerationSingle(imageConfig, prompt, params);
}

export async function requestGeneration(config: AiConfig & { seedIndex?: number; seedCount?: number }, prompt: string) {
    try {
        const images = await requestImages(config, prompt, []);
        refreshRemoteUser(config);
        return images;
    } catch (error) {
        if (error instanceof ImageRequestError) throw error;
        throw new Error(error instanceof Error ? error.message : "请求失败");
    }
}

export async function requestEdit(config: AiConfig & { seedIndex?: number; seedCount?: number }, prompt: string, references: ReferenceImage[], options: ImageEditOptions = {}) {
    try {
        const images = await requestImages(config, prompt, references, options);
        refreshRemoteUser(config);
        return images;
    } catch (error) {
        if (error instanceof ImageRequestError) throw error;
        throw new Error(error instanceof Error ? error.message : "请求失败");
    }
}

export async function requestImageQuestion(config: AiConfig, messages: ChatCompletionMessage[], onDelta: (text: string) => void) {
    if (activeApiFormat(config) === "gemini") {
        try {
            const answer = await requestGeminiQuestion(config, messages, onDelta);
            refreshRemoteUser(config);
            return answer;
        } catch (error) {
            if (error instanceof ImageRequestError) throw new Error(error.message);
            throw new Error(error instanceof Error ? error.message : "请求失败");
        }
    }

    let buffer = "";
    let answer = "";
    let processedLength = 0;

    try {
        const timeoutMs = normalizeBoundedInteger(config.timeout, 600, 1, 3600) * 1000;
        const response = await axiosPostWithLocalProxyFallback<string | Record<string, unknown>>(
            config,
            aiApiUrl(config, "/chat/completions"),
            config.channelMode === "local" ? localProxyOpenAIUrl("/chat/completions") : "",
            {
                model: config.model,
                messages: withSystemMessage(config, messages),
                stream: true,
            },
            {
                headers: {
                    ...aiHeaders(config, "application/json"),
                } as Record<string, string>,
                responseType: "text",
                timeout: timeoutMs,
                onDownloadProgress: (event) => {
                    const responseText = String(event.event?.target?.responseText || "");
                    const nextText = responseText.slice(processedLength);
                    processedLength = responseText.length;
                    buffer += nextText;
                    const chunks = buffer.split("\n\n");
                    buffer = chunks.pop() || "";
                    for (const chunk of chunks) {
                        parseStreamChunk(chunk, (delta) => {
                            answer += delta;
                            onDelta(answer);
                        });
                    }
                },
            },
        );
        if (typeof response.data === "object" && response.data && "code" in response.data && (response.data as { code?: number; msg?: string }).code !== 0) {
            throw new Error((response.data as { msg?: string }).msg || "请求失败");
        }
        if (typeof response.data === "string") {
            let apiError = "";
            try {
                const payload = JSON.parse(response.data) as { code?: number; msg?: string };
                if (typeof payload.code === "number" && payload.code !== 0) {
                    apiError = payload.msg || "请求失败";
                }
            } catch {
                // ignore plain text stream content
            }
            if (apiError) throw new Error(apiError);
        }
        if (buffer) {
            parseStreamChunk(buffer, (delta) => {
                answer += delta;
                onDelta(answer);
            });
        }
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
    refreshRemoteUser(config);
    return answer || "没有返回内容";
}

export async function fetchImageModels(config: AiConfig) {
    if (config.channelMode === "remote") return config.models;
    try {
        if (activeApiFormat(config) === "gemini") {
            const response = await axiosGetWithLocalProxyFallback<GeminiPayload>(config, geminiApiUrl(config), config.channelMode === "local" ? localProxyGeminiApiUrl(config) : "", {
                headers: geminiHeaders(config),
                timeout: normalizeBoundedInteger(config.timeout, 600, 1, 3600) * 1000,
            });
            validateGeminiPayload(response.data);
            return (response.data.models || [])
                .map((model) => model.name?.replace(/^models\//, ""))
                .filter((id): id is string => Boolean(id))
                .sort((a, b) => a.localeCompare(b));
        }
        const response = await axiosGetWithLocalProxyFallback<{ data?: Array<{ id?: string }>; error?: { message?: string } }>(
            config,
            buildApiUrl(activeLocalBaseUrl(config), "/models"),
            config.channelMode === "local" ? localProxyOpenAIUrl("/models") : "",
            {
                headers: {
                    Authorization: `Bearer ${activeLocalApiKey(config)}`,
                },
                timeout: normalizeBoundedInteger(config.timeout, 600, 1, 3600) * 1000,
            },
        );
        return (response.data.data || [])
            .map((model) => model.id)
            .filter((id): id is string => Boolean(id))
            .sort((a, b) => a.localeCompare(b));
    } catch (error) {
        throw new Error(readAxiosError(error, "读取模型失败"));
    }
}
function isAgnesImageModel(model: string) {
    const m = model.toLowerCase().replace(/[\s_]+/g, "-");
    return m.startsWith("agnes-image") || m.startsWith("agens-image");
}
function generateDiscreteSeed(seedIndex?: number, seedCount?: number, customSeed?: string): number {
    if (customSeed && !isNaN(Number(customSeed))) {
        const baseSeed = Math.floor(Number(customSeed));
        if (baseSeed >= 0) {
            if (typeof seedIndex === "number" && seedIndex >= 0) {
                return (baseSeed + seedIndex) % 2147483648;
            }
            return baseSeed;
        }
    }

    let randVal = 0;
    if (typeof window !== "undefined" && window.crypto && window.crypto.getRandomValues) {
        const array = new Uint32Array(1);
        window.crypto.getRandomValues(array);
        randVal = array[0];
    } else {
        // 降级使用微秒级时空杂凑
        const timeSalt = Date.now() * 1000 + (Math.floor(performance.now() * 1000) % 1000);
        const mathRand = Math.random() * 1000000;
        randVal = timeSalt ^ mathRand;
    }

    if (typeof seedIndex === "number" && seedIndex >= 0) {
        const chunks = typeof seedCount === "number" && seedCount > 0 ? Math.floor(seedCount) : 100;
        const index = Math.floor(seedIndex) % chunks;
        const chunkSize = Math.floor(2147483647 / chunks);
        const minVal = index * chunkSize + 1;
        const maxVal = (index + 1) * chunkSize;
        const range = maxVal - minVal;
        return (randVal % range) + minVal;
    }

    // 默认依然在全域进行真随机
    return (randVal % 2147483647) + 1;
}

function publicHttpUrl(value?: string) {
    if (!value || value.startsWith("blob:") || value.startsWith("data:")) return "";
    try {
        const url = new URL(value, typeof window === "undefined" ? undefined : window.location.origin);
        if (!["http:", "https:"].includes(url.protocol)) return "";
        if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return "";
        return url.href;
    } catch {
        return "";
    }
}

async function requestAgnesImageEdit(config: AiConfig & { seedIndex?: number; seedCount?: number }, prompt: string, references: ReferenceImage[], params: ImageRequestParams): Promise<GeneratedImage[]> {
    const mime = MIME_MAP[params.outputFormat];

    // 获取所有参考图的公共 HTTP 链接或降级为 base64 数组，完美对齐 extra_body.image
    const imageUrls = await Promise.all(
        references.map(async (ref) => {
            const resolvedUrl = await resolveImageUrl(ref.storageKey, "");
            for (const url of [ref.dataUrl, ref.url, resolvedUrl]) {
                const publicUrl = publicHttpUrl(url);
                if (publicUrl) return publicUrl;
            }
            return imageToDataUrl(ref);
        }),
    );

    const seedValue = generateDiscreteSeed(config.seedIndex, config.seedCount, config.seed);
    const body: Record<string, unknown> = {
        model: config.model,
        prompt: withPromptGuard(config, withSystemPrompt(config, prompt)),
        extra_body: {
            image: imageUrls, // 👈 核心对齐：官方文档参考图参数 extra_body.image 数组
            seed: seedValue, // 👈 采用带分区锁定的高离散真随机种子发生器
        },
    };
    if (params.size) body.size = params.size; // 👈 官方支持参数
    // 彻底剔除 response_format、output_format、moderation、quality、stream 等 LiteLLM/agnes-i2i 模型不支持的冗余参数，防止引发 400 阻断

    return requestAndParseImages(
        config,
        "/images/generations", // 核心对齐：官方图生图同样使用 /images/generations 接口
        body,
        params.timeoutSeconds,
        () =>
            fetchOpenAIEndpoint(config, "/images/generations", params.timeoutSeconds, {
                method: "POST",
                headers: aiHeaders(config, "application/json"),
                body: JSON.stringify(body),
            }),
        async (response) => {
            if (config.streamImages && isEventStreamResponse(response)) {
                const images = await parseImagesStreamResponse(response, mime);
                return { images: images.map((img) => ({ ...img, seed: seedValue })), responseBody: summarizeGeneratedImages(images, "event-stream") };
            }
            const payload = (await response.json()) as ImageApiResponse;
            const images = parseImagePayload(payload, mime);
            return { images: images.map((img) => ({ ...img, seed: seedValue })), responseBody: stringifyLogPayload(payload) };
        },
    );
}
