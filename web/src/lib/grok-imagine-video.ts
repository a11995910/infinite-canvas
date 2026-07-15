import { modelOptionName, resolveVideoModel, type AiConfig } from "@/stores/use-config-store";

const grokImagineVideoModels = new Set(["grok-imagine-video", "grok-imagine-video-1.5"]);
const grokVideoAspectRatios = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;

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
