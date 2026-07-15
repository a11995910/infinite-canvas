import { modelOptionName, resolveVideoModel, type AiConfig } from "@/stores/use-config-store";
import { getDataUrlByteSize } from "@/lib/image-utils";

const grokImagineVideoModels = new Set(["grok-imagine-video", "grok-imagine-video-1.5"]);
const grokVideoAspectRatios = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
const GROK_VIDEO_REFERENCE_MAX_BYTES = 1024 * 1024;
const GROK_VIDEO_REFERENCE_TARGET_BYTES = 900 * 1024;
const GROK_VIDEO_REFERENCE_MAX_EDGE = 2048;
const GROK_VIDEO_REFERENCE_MIN_QUALITY = 0.45;
const GROK_VIDEO_REFERENCE_MAX_QUALITY = 0.92;
const GROK_VIDEO_REFERENCE_RESIZE_STEPS = 5;

export const grokVideoResolutionOptions = [
    { value: "480", label: "480p" },
    { value: "720", label: "720p" },
    { value: "1080", label: "1080p" },
];

export const grokVideoDurationOptions = [1, 5, 8, 10, 15];

export function isGrokImagineVideoModel(model: string) {
    return grokImagineVideoModels.has(modelOptionName(model).trim().toLowerCase());
}

export function isGrokImagineVideo15Model(model: string) {
    return modelOptionName(model).trim().toLowerCase() === "grok-imagine-video-1.5";
}

export function isGrokImagineVideoConfig(config: Pick<AiConfig, "model" | "videoModel">) {
    return isGrokImagineVideoModel(resolveVideoModel(config));
}

export function normalizeGrokVideoDuration(value: string) {
    const duration = Math.floor(Number(value) || 8);
    return Math.max(1, Math.min(15, duration));
}

export function normalizeGrokVideoResolution(value: string) {
    const resolution = value.trim().toLowerCase();
    if (resolution === "480" || resolution === "480p" || resolution === "low") return "480p";
    if (resolution === "1080" || resolution === "1080p") return "1080p";
    return "720p";
}

export function normalizeGrokVideoAspectRatio(value: string) {
    const size = value.trim();
    if (!size || size === "auto") return undefined;
    if ((grokVideoAspectRatios as readonly string[]).includes(size)) return size;

    const match = size.match(/^(\d+)x(\d+)$/);
    if (!match) return "16:9";
    const targetRatio = Number(match[1]) / Number(match[2]);
    if (!Number.isFinite(targetRatio) || targetRatio <= 0) return "16:9";

    // xAI 只接受固定比例，像素预设按最接近的合法比例转换。
    return grokVideoAspectRatios.reduce((closest, ratio) => {
        const [width, height] = ratio.split(":").map(Number);
        const [closestWidth, closestHeight] = closest.split(":").map(Number);
        return Math.abs(Math.log(targetRatio / (width / height))) < Math.abs(Math.log(targetRatio / (closestWidth / closestHeight))) ? ratio : closest;
    });
}

export async function prepareGrokVideoReferenceImage(dataUrl: string) {
    if (getDataUrlByteSize(dataUrl) <= GROK_VIDEO_REFERENCE_MAX_BYTES) return dataUrl;

    const image = await loadDataUrlImage(dataUrl);
    let { width, height } = fitImageSize(image.naturalWidth, image.naturalHeight);
    for (let attempt = 0; attempt < GROK_VIDEO_REFERENCE_RESIZE_STEPS; attempt += 1) {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("浏览器不支持参考图压缩，请换用较小的图片");

        // JPEG 不保留透明通道，先铺白色以避免透明区域变成黑色。
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        const compressed = await compressCanvasToTarget(canvas);
        if (compressed) return blobToDataUrl(compressed);

        if (width === 1 && height === 1) break;
        width = Math.max(1, Math.round(width * 0.75));
        height = Math.max(1, Math.round(height * 0.75));
    }
    throw new Error("Grok 视频参考图压缩后仍超过 1MB，请换用更小的图片");
}

function fitImageSize(width: number, height: number) {
    const scale = Math.min(1, GROK_VIDEO_REFERENCE_MAX_EDGE / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function compressCanvasToTarget(canvas: HTMLCanvasElement) {
    const highestQuality = await canvasToJpeg(canvas, GROK_VIDEO_REFERENCE_MAX_QUALITY);
    if (highestQuality.size <= GROK_VIDEO_REFERENCE_TARGET_BYTES) return highestQuality;

    const lowestQuality = await canvasToJpeg(canvas, GROK_VIDEO_REFERENCE_MIN_QUALITY);
    if (lowestQuality.size > GROK_VIDEO_REFERENCE_TARGET_BYTES) return null;

    let best = lowestQuality;
    let minQuality = GROK_VIDEO_REFERENCE_MIN_QUALITY;
    let maxQuality = GROK_VIDEO_REFERENCE_MAX_QUALITY;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const quality = (minQuality + maxQuality) / 2;
        const candidate = await canvasToJpeg(canvas, quality);
        if (candidate.size <= GROK_VIDEO_REFERENCE_TARGET_BYTES) {
            best = candidate;
            minQuality = quality;
        } else {
            maxQuality = quality;
        }
    }
    return best;
}

function loadDataUrlImage(dataUrl: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => (image.naturalWidth && image.naturalHeight ? resolve(image) : reject(new Error("参考图尺寸无效")));
        image.onerror = () => reject(new Error("参考图无法解码，请换用常见图片格式"));
        image.src = dataUrl;
    });
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number) {
    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("参考图压缩失败"))), "image/jpeg", quality);
    });
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("参考图压缩失败"));
        reader.readAsDataURL(blob);
    });
}
