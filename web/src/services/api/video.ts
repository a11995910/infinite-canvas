import axios from "axios";

import { dataUrlToFile } from "@/lib/image-utils";
import { imageToDataUrl, resolveImageUrl } from "@/services/image-storage";
import { buildApiUrl, channelIdForActiveModel, localChannelForActiveModel, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

export type VideoResponse = { id: string; status?: string; video_url?: string; url?: string; error?: { message?: string } };
type ApiVideoEnvelope = { code: number; data?: VideoResponse | null; msg?: string; message?: string };
type ApiVideoResponse = VideoResponse | ApiVideoEnvelope;
export type VideoGenerationResult = { id: string; url: string; durationMs: number; width: number; height: number; bytes: number; mimeType: string; task: VideoResponse };

export class VideoRequestError extends Error {
    detail?: string;

    constructor(message: string, detail?: unknown) {
        super(message);
        this.name = "VideoRequestError";
        this.detail = formatErrorDetail(detail);
    }
}

function aiApiUrl(config: AiConfig, path: string) {
    if (config.channelMode === "remote") return `/api/v1${path}`;
    const channel = localChannelForActiveModel(config);
    return buildApiUrl(channel?.baseUrl || config.baseUrl, path);
}

function aiHeaders(config: AiConfig) {
    const token = useUserStore.getState().token;
    if (config.channelMode === "remote" && !token) throw new Error("请先登录后再使用云端渠道");
    return config.channelMode === "remote" ? { Authorization: `Bearer ${token}`, ...(channelIdForActiveModel(config) ? { "X-Model-Channel-ID": channelIdForActiveModel(config) } : {}) } : { Authorization: `Bearer ${localChannelForActiveModel(config)?.apiKey || config.apiKey}` };
}

function refreshRemoteUser(config: AiConfig) {
    if (config.channelMode === "remote") void useUserStore.getState().hydrateUser();
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = []) {
    const model = config.model || config.videoModel;
    const systemPrompt = (config.systemPrompts.video || config.systemPrompt).trim();
    const body = await createVideoRequestBody(config, model, systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt, references);
    const startedAt = Date.now();
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config) })).data);
        if (!created.id) throw new Error("视频接口没有返回任务 ID");
        let completed: VideoResponse | null = null;
        for (;;) {
            const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${created.id}`), { headers: aiHeaders(config), params: config.channelMode === "remote" ? { model } : undefined })).data);
            if (isFailedVideoStatus(video.status)) throw new VideoRequestError(video.error?.message || "视频生成失败", video);
            if (isCompletedVideoStatus(video.status) || video.video_url || video.url) {
                completed = video;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 2500));
        }
        const videoUrl = completed?.video_url || completed?.url || "";
        if (!videoUrl) throw new VideoRequestError("视频生成完成但没有返回视频地址", completed);
        const result = buildVideoGenerationResult(completed, videoUrl, Date.now() - startedAt);
        void writeVideoAICallLog(config, model, "/videos", "POST", startedAt, 200, stringifyLogPayload(summarizeVideoRequestBody(body)), stringifyLogPayload({ task: completed, video: result }), "");
        refreshRemoteUser(config);
        return result;
    } catch (error) {
        const { message, detail } = readAxiosError(error, "视频生成失败");
        void writeVideoAICallLog(config, model, "/videos", "POST", startedAt, axios.isAxiosError(error) ? error.response?.status || 0 : 0, stringifyLogPayload(summarizeVideoRequestBody(body)), stringifyLogPayload(detail), message);
        throw new VideoRequestError(message, detail);
    }
}

async function createVideoRequestBody(config: AiConfig, model: string, prompt: string, references: ReferenceImage[]) {
    const size = normalizeVideoSize(config.size);
    if (isAgnesVideoModel(model)) {
        const inputReferences = await Promise.all(references.slice(0, 7).map(imageToAgnesReference));
        const dimensions = size ? parseVideoDimensions(size) : null;
        const frameRate = agnesFrameRate(config.videoSeconds);
        const body: Record<string, unknown> = {
            model,
            prompt,
            num_frames: agnesNumFrames(config.videoSeconds, frameRate),
            frame_rate: frameRate,
        };
        if (dimensions) {
            body.width = dimensions.width;
            body.height = dimensions.height;
        }
        if (inputReferences.length === 1) body.image = inputReferences[0];
        if (inputReferences.length > 1) body.extra_body = { image: inputReferences };
        return body;
    }

    const body = new FormData();
    body.append("model", model);
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSeconds(config.videoSeconds));
    if (size) body.append("size", size);
    body.append("resolution_name", normalizeVideoResolution(config.vquality));
    body.append("preset", "normal");
    const files = await Promise.all(references.slice(0, 7).map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => body.append("input_reference[]", file));
    return body;
}

async function imageToAgnesReference(image: ReferenceImage) {
    const resolvedUrl = await resolveImageUrl(image.storageKey, "");
    for (const url of [image.dataUrl, image.url, resolvedUrl]) {
        const publicUrl = publicHttpUrl(url);
        if (publicUrl) return publicUrl;
    }
    return imageToDataUrl(image);
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

function agnesFrameRate(secondsValue: string) {
    const seconds = Number(normalizeVideoSeconds(secondsValue));
    return seconds > 18 ? Math.max(1, Math.floor(440 / seconds)) : 24;
}

function agnesNumFrames(secondsValue: string, frameRate: number) {
    const target = Math.round(Number(normalizeVideoSeconds(secondsValue)) * frameRate) + 1;
    const capped = Math.min(441, Math.max(9, target));
    return capped - ((capped - 1) % 8);
}

function isAgnesVideoModel(model: string) {
    return model.toLowerCase().includes("agnes-video");
}

function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, Math.min(20, seconds)));
}

function normalizeVideoSize(value: string) {
    if (value === "auto") return null;
    const size = value || "1280x720";
    if (/^\d+x\d+$/.test(size)) return size;
    return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
}

function parseVideoDimensions(size: string) {
    const match = size.match(/^(\d+)x(\d+)$/);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

function unwrapVideoResponse(payload: ApiVideoResponse): VideoResponse {
    if (!payload) throw new Error("接口没有返回视频任务");
    if (isVideoEnvelope(payload)) {
        if (payload.code !== 0) throw new VideoRequestError(payload.msg || payload.message || "请求失败", payload);
        if (!payload.data) throw new Error("接口没有返回视频任务");
        return normalizeVideoResponse(payload.data);
    }
    const error = videoPayloadErrorMessage(payload);
    if (error) throw new VideoRequestError(error, payload);
    if (payload.error?.message) throw new VideoRequestError(payload.error.message, payload);
    return normalizeVideoResponse(payload);
}

function isVideoEnvelope(payload: ApiVideoResponse): payload is ApiVideoEnvelope {
    return "code" in payload && typeof payload.code === "number";
}

function readAxiosError(error: unknown, fallback: string) {
    if (error instanceof VideoRequestError) return { message: error.message, detail: error.detail || error.stack || error.message };
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return { message: responseData?.msg || responseData?.error?.message || (error.response?.status ? `${fallback}：${error.response.status}` : fallback), detail: responseData || error.message };
    }
    return { message: error instanceof Error ? error.message : fallback, detail: error instanceof Error ? error.stack || error.message : error };
}

async function writeVideoAICallLog(config: AiConfig, model: string, endpoint: string, method: "GET" | "POST", startedAt: number, status: number, requestBody: string, responseBody: string, error: string) {
    if (config.channelMode !== "local") return;
    const token = useUserStore.getState().token;
    if (!token) return;
    const channel = localChannelForActiveModel(config);
    await fetch("/api/v1/ai-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
            endpoint,
            method,
            model,
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

function summarizeVideoRequestBody(value: unknown) {
    if (value instanceof FormData) {
        const fields: Record<string, string[]> = {};
        const files: Array<{ field: string; name: string; size: number; type: string }> = [];
        value.forEach((item, key) => {
            if (item instanceof File) {
                files.push({ field: key, name: item.name, size: item.size, type: item.type });
                return;
            }
            fields[key] = [...(fields[key] || []), String(item)];
        });
        return { fields, files };
    }
    return value;
}

function formatErrorDetail(detail: unknown) {
    if (detail == null) return "";
    if (typeof detail === "string") return detail;
    try {
        return JSON.stringify(detail, null, 2);
    } catch {
        return String(detail);
    }
}

function stringifyLogPayload(value: unknown) {
    if (typeof value === "string") return value;
    try {
        const cloned = JSON.parse(JSON.stringify(value)) as unknown;
        redactLogMedia(cloned);
        return JSON.stringify(cloned, null, 2);
    } catch {
        return String(value || "");
    }
}

function redactLogMedia(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
        value.forEach(redactLogMedia);
        return;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
        const item = record[key];
        if (typeof item === "string" && (item.startsWith("data:image/") || item.includes("data:image/") || item.length > 2048 && looksLikeBase64(item))) {
            record[key] = `[redacted image/string len=${item.length}]`;
            continue;
        }
        redactLogMedia(item);
    }
}

function looksLikeBase64(value: string) {
    return /^[A-Za-z0-9+/=]+$/.test(value.slice(0, 200));
}

function normalizeVideoResponse(value: unknown): VideoResponse {
    const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const id = firstString(record.id, record.request_id, record.task_id, record.video_id, firstTaskId(record));
    return {
        ...(record as VideoResponse),
        id,
        status: firstString(record.status, record.state),
        video_url: firstString(record.video_url, record.videoUrl, record.remixed_from_video_id, record.output_url, record.download_url, firstVideoUrl(record)),
    };
}

function buildVideoGenerationResult(task: VideoResponse, url: string, durationMs: number): VideoGenerationResult {
    const size = parseVideoSize((task as Record<string, unknown>).size);
    return { id: task.id, url, durationMs, width: size.width, height: size.height, bytes: 0, mimeType: "video/mp4", task };
}

function parseVideoSize(value: unknown) {
    const match = typeof value === "string" ? value.match(/^(\d+)x(\d+)$/) : null;
    return { width: match ? Number(match[1]) : 1280, height: match ? Number(match[2]) : 720 };
}

function firstString(...values: unknown[]) {
    return values.find((value): value is string => typeof value === "string" && value.trim())?.trim() || "";
}

function isCompletedVideoStatus(status?: string) {
    return ["completed", "complete", "done", "succeeded", "success"].includes((status || "").toLowerCase());
}

function isFailedVideoStatus(status?: string) {
    return ["failed", "fail", "error", "cancelled", "canceled"].includes((status || "").toLowerCase());
}

function videoPayloadErrorMessage(value: unknown): string {
    const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    if (typeof record.code === "number" && record.code !== 0) return firstString(record.msg, record.message, nestedMessage(record.error)) || "视频下载失败";
    if (typeof record.code === "string" && /fail|error/i.test(record.code)) return firstString(nestedMessage(record.error), record.msg, record.message, record.code);
    return firstString(nestedMessage(record.error));
}

function nestedMessage(value: unknown) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    return firstString((value as Record<string, unknown>).message);
}

function firstVideoUrl(value: unknown, depth = 0): string {
    if (depth > 5 || value == null) return "";
    if (typeof value === "string") return /^https?:\/\//.test(value) ? value : "";
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = firstVideoUrl(item, depth + 1);
            if (found) return found;
        }
        return "";
    }
    if (typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    const direct = firstString(record.video_url, record.videoUrl, record.url, record.remixed_from_video_id, record.output_url, record.download_url, record.file_url);
    if (/^https?:\/\//.test(direct)) return direct;
    for (const key of ["video", "data", "output", "result", "content"]) {
        const found = firstVideoUrl(record[key], depth + 1);
        if (found) return found;
    }
    return "";
}

function firstTaskId(value: unknown, depth = 0): string {
    if (depth > 4 || value == null) return "";
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = firstTaskId(item, depth + 1);
            if (found) return found;
        }
        return "";
    }
    if (typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    const direct = firstString(record.id, record.request_id, record.task_id, record.video_id);
    if (direct) return direct;
    for (const key of ["data", "result", "output", "video"]) {
        const found = firstTaskId(record[key], depth + 1);
        if (found) return found;
    }
    return "";
}
