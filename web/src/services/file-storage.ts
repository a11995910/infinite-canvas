import localforage from "localforage";
import { nanoid } from "nanoid";

import { apiGet } from "@/services/api/request";
import { loadUserStorageProvider, toUserStorageProviderPayload } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };
type MediaUploadOptions = { signal?: AbortSignal };

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const videoLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });
const objectUrls = new Map<string, string>();
const serverUrls = new Map<string, string>();
const SERVER_MEDIA_MAX_BYTES = 90 * 1024 * 1024;
const MEDIA_METADATA_TIMEOUT_MS = 10_000;

export async function uploadMediaFile(input: string | Blob, prefix = "file", options?: MediaUploadOptions): Promise<UploadedFile> {
    let blob: Blob;
    if (typeof input === "string") {
        const response = await fetch(input, { signal: options?.signal });
        if (!response.ok) throw new Error(`媒体下载失败：${response.status}`);
        blob = await response.blob();
    } else {
        blob = input;
    }
    return uploadMediaBlob(blob, `${prefix}-${nanoid()}.${mediaExtension(blob.type)}`, prefix, options);
}

export async function uploadMediaBlob(blob: Blob, filename: string, prefix = "file", options?: MediaUploadOptions): Promise<UploadedFile> {
    const serverUpload = await maybeUploadMediaToServer(blob, filename, options);
    if (serverUpload) return serverUpload;
    const storageKey = `${prefix}:${nanoid()}`;
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    let meta: Awaited<ReturnType<typeof readMediaMeta>>;
    try {
        meta = await readMediaMeta(url, blob.type, options?.signal);
    } catch (error) {
        URL.revokeObjectURL(url);
        objectUrls.delete(storageKey);
        await store.removeItem(storageKey);
        throw error;
    }
    return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    if (storageKey.startsWith("server:")) {
        const id = storageKey.slice("server:".length);
        if (fallback && !fallback.startsWith("blob:")) return fallback;
        const cachedUrl = serverUrls.get(id);
        if (cachedUrl) return cachedUrl;
        const info = await apiGet<{ publicUrl?: string }>(`/api/files/${encodeURIComponent(id)}`).catch(() => null);
        if (!info) return fallback;
        const url = info.publicUrl || `/api/files/${encodeURIComponent(id)}/content`;
        serverUrls.set(id, url);
        return url;
    }
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getMediaBlob(storageKey: string) {
    const local = await store.getItem<Blob>(storageKey);
    if (local || !storageKey.startsWith("server:")) return local;
    const id = storageKey.slice("server:".length);
    const response = await fetch(`/api/files/${encodeURIComponent(id)}/content`);
    return response.ok ? response.blob() : null;
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    const [{ useAssetStore }, { useCanvasStore }] = await Promise.all([import("@/stores/use-asset-store"), import("@/stores/canvas/use-canvas-store")]);
    const usedKeys = collectMediaStorageKeys({ assets: useAssetStore.getState().assets, projects: useCanvasStore.getState().projects });
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            if (usedKeys.has(key)) return;
            if (key.startsWith("server:")) {
                await deleteServerMedia(key);
                return;
            }
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedMedia(usedData: unknown) {
    const usedKeys = collectMediaStorageKeys(usedData);
    await videoLogStore.iterate((value) => {
        collectMediaStorageKeys(value, usedKeys);
    });
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await Promise.all(unused.map((key) => store.removeItem(key)));
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

async function maybeUploadMediaToServer(blob: Blob, filename: string, options?: MediaUploadOptions): Promise<UploadedFile | null> {
    let config: { mode: string; allowUserProvider: boolean } | null = null;
    try {
        config = await loadMediaStorageConfig(options?.signal);
    } catch (error) {
        if (isAbortError(error, options?.signal)) throw error;
    }
    const userProvider = config?.allowUserProvider ? loadUserStorageProvider() : null;
    const useServerStorage = config && (config.mode === "server_sqlite_s3" || (config.mode === "hybrid" && userProvider));
    if (!config || !useServerStorage) return null;
    if (blob.size > SERVER_MEDIA_MAX_BYTES) {
        if (config.mode === "hybrid") return null;
        throw new Error("媒体文件超过 90MB，无法通过当前服务端上传限制保存");
    }
    const token = useUserStore.getState().token;
    if (!token) {
        if (config.mode === "server_sqlite_s3") throw new Error("服务端存储需要先登录");
        return null;
    }
    const formData = new FormData();
    formData.append("file", blob, filename);
    if (userProvider) formData.append("provider", JSON.stringify(toUserStorageProviderPayload(userProvider)));
    let response: Response;
    try {
        response = await fetch("/api/v1/files", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: formData, signal: options?.signal });
    } catch (error) {
        if (isAbortError(error, options?.signal)) throw error;
        if (config.mode === "hybrid") return null;
        throw new Error(error instanceof Error ? `服务端视频上传失败：${error.message}` : "服务端视频上传失败");
    }
    const payload = (await response.json().catch(() => null)) as { code?: number; msg?: string; data?: UploadedFile } | null;
    if (!response.ok || payload?.code !== 0 || !payload.data) {
        if (config.mode === "hybrid") return null;
        throw new Error(payload?.msg || "服务端视频上传失败");
    }
    let meta: Awaited<ReturnType<typeof readMediaMeta>>;
    try {
        meta = await readMediaMeta(payload.data.url, payload.data.mimeType || blob.type, options?.signal);
    } catch (error) {
        if (isAbortError(error, options?.signal) && payload.data.storageKey?.startsWith("server:")) await deleteServerMedia(payload.data.storageKey).catch(() => undefined);
        throw error;
    }
    if (payload.data.storageKey?.startsWith("server:")) serverUrls.set(payload.data.storageKey.slice("server:".length), payload.data.url);
    return { ...meta, ...payload.data, bytes: payload.data.bytes || blob.size, mimeType: payload.data.mimeType || blob.type || "application/octet-stream" };
}

async function deleteServerMedia(storageKey: string) {
    const id = storageKey.slice("server:".length);
    if (!id) return;
    const token = useUserStore.getState().token;
    serverUrls.delete(id);
    if (!token) return;
    const provider = loadUserStorageProvider();
    const response = await fetch(`/api/v1/files/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(provider ? { provider: toUserStorageProviderPayload(provider) } : {}),
    });
    const payload = (await response.json().catch(() => null)) as { code?: number; msg?: string } | null;
    if (!response.ok || payload?.code !== 0) throw new Error(payload?.msg || "删除服务端视频失败");
}

async function loadMediaStorageConfig(signal?: AbortSignal) {
    const response = await fetch("/api/storage/config", { signal });
    const payload = (await response.json().catch(() => null)) as { code?: number; msg?: string; data?: { mode: string; allowUserProvider: boolean } } | null;
    if (!response.ok || payload?.code !== 0 || !payload.data) throw new Error(payload?.msg || "读取服务端存储配置失败");
    return payload.data;
}

function readMediaMeta(url: string, mimeType: string, signal?: AbortSignal) {
    return mimeType.startsWith("video/") ? readVideoMeta(url, signal) : mimeType.startsWith("audio/") ? readAudioMeta(url, signal) : {};
}

function mediaExtension(mimeType: string) {
    if (mimeType.includes("quicktime")) return "mov";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
    return "mp4";
}

function readVideoMeta(url: string, signal?: AbortSignal) {
    const video = document.createElement("video");
    return readMediaElementMeta(video, url, () => ({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined }), signal);
}

function readAudioMeta(url: string, signal?: AbortSignal) {
    const audio = document.createElement("audio");
    return readMediaElementMeta(audio, url, () => ({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined }), signal);
}

function readMediaElementMeta<T>(element: HTMLMediaElement, url: string, read: () => T, signal?: AbortSignal) {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            window.clearTimeout(timer);
            element.onloadedmetadata = null;
            element.onerror = null;
            signal?.removeEventListener("abort", cancel);
        };
        const done = () => {
            if (settled) return;
            settled = true;
            const result = read();
            cleanup();
            resolve(result);
        };
        const cancel = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new DOMException("Aborted", "AbortError"));
        };
        const timer = window.setTimeout(done, MEDIA_METADATA_TIMEOUT_MS);
        element.onloadedmetadata = done;
        element.onerror = done;
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) {
            cancel();
            return;
        }
        element.src = url;
    });
}

function isAbortError(error: unknown, signal?: AbortSignal) {
    return signal?.aborted || (error instanceof DOMException && error.name === "AbortError");
}
