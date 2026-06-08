"use client";

export function promptImageUrl(value?: string) {
    const url = value?.trim() || "";
    if (!url) return "";
    if (url.startsWith("/") || url.startsWith("data:") || url.startsWith("blob:")) return url;
    if (/^https?:\/\//i.test(url)) return `/api/proxy-image?url=${encodeURIComponent(url)}`;
    return url;
}

export function promptPreviewImages(preview: string) {
    const images: string[] = [];
    const seen = new Set<string>();
    for (const pattern of [/<img[^>]+src=["']([^"']+)["']/gi, /!\[[^\]]*]\(([^)]+)\)/g]) {
        for (const match of preview.matchAll(pattern)) {
            const url = promptImageUrl(match[1]);
            if (url && !seen.has(url)) {
                seen.add(url);
                images.push(url);
            }
        }
    }
    return images;
}

export function promptPreviewText(preview: string) {
    return preview
        .replace(/<img[^>]+src=["'][^"']+["'][^>]*>/gi, "")
        .replace(/!\[[^\]]*]\([^)]+\)/g, "")
        .trim();
}
