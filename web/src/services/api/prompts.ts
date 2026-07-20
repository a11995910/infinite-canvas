import localforage from "localforage";

import { runPromptSource, type RawPrompt } from "./prompt-source-runtime";
import { usePromptSourceStore } from "@/stores/use-prompt-source-store";
import type { PromptSource } from "./prompt-source-presets";

export type Prompt = RawPrompt & {
    category: string;
    githubUrl: string;
};

export const ALL_PROMPTS_OPTION = "全部";

export type PromptListResponse = {
    items: Prompt[];
    tags: string[];
    categories: string[];
    total: number;
};

const cacheTtlMs = 1000 * 60 * 60;
const promptSourceRuntimeVersion = 2;
const promptCacheStore = localforage.createInstance({ name: "infinite-canvas", storeName: "prompt_cache" });

type SourceCache = { items: Prompt[]; fetchedAt: number; signature: string };

const loadingSources = new Map<string, Promise<Prompt[]>>();

function enabledSources() {
    return usePromptSourceStore.getState().sources.filter((source) => source.enabled);
}

function cacheKey(sourceId: string) {
    return `prompt-source:${sourceId}`;
}

/** 来源或公共解析能力变化时更新签名，确保旧缓存不会掩盖解析修复。 */
function sourceSignature(source: PromptSource) {
    const value = `${promptSourceRuntimeVersion}\n${source.name}\n${source.githubUrl}\n${source.script}`;
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
        hash = (hash * 31 + value.charCodeAt(i)) | 0;
    }
    return `${value.length}:${hash}`;
}

function withSourceMeta(source: PromptSource, items: RawPrompt[]): Prompt[] {
    return items.map((item) => ({ ...item, category: source.name, githubUrl: source.githubUrl }));
}

async function runSource(source: PromptSource): Promise<Prompt[]> {
    const items = await runPromptSource(source.script);
    const prompts = withSourceMeta(source, items);
    await promptCacheStore.setItem<SourceCache>(cacheKey(source.id), { items: prompts, fetchedAt: Date.now(), signature: sourceSignature(source) });
    return prompts;
}

async function getSourcePrompts(source: PromptSource, force = false): Promise<Prompt[]> {
    const signature = sourceSignature(source);
    if (!force) {
        const cached = await promptCacheStore.getItem<SourceCache>(cacheKey(source.id));
        if (cached?.items?.length && cached.signature === signature && Date.now() - cached.fetchedAt < cacheTtlMs) return cached.items;
    }
    if (!force && loadingSources.has(source.id)) return loadingSources.get(source.id)!;
    const loading = runSource(source).finally(() => loadingSources.delete(source.id));
    loadingSources.set(source.id, loading);
    return loading;
}

/** 汇总全部启用来源，单个来源失败时跳过，不影响其他来源展示。 */
async function getAllPrompts(): Promise<Prompt[]> {
    const settled = await Promise.all(
        enabledSources().map(async (source) => {
            try {
                return await getSourcePrompts(source);
            } catch {
                return [];
            }
        }),
    );
    return settled.flat();
}

export async function fetchPrompts({ keyword = "", tag = [], category = ALL_PROMPTS_OPTION, page = 1, pageSize = 20 }: { keyword?: string; tag?: string[]; category?: string; page?: number; pageSize?: number } = {}) {
    const items = await getAllPrompts();
    const normalizedKeyword = keyword.trim().toLowerCase();
    const normalizedPage = Math.max(1, page);
    const normalizedPageSize = Math.max(1, Math.min(100, pageSize));
    const withoutTagFilter = filterPrompts(items, { keyword: normalizedKeyword, category, tags: [] });
    const filtered = filterPrompts(items, { keyword: normalizedKeyword, category, tags: tag });

    return {
        items: filtered.slice((normalizedPage - 1) * normalizedPageSize, normalizedPage * normalizedPageSize),
        tags: collectTags(withoutTagFilter),
        categories: enabledSources().map((source) => source.name),
        total: filtered.length,
    };
}

/** 读取单个来源，错误继续抛给调用方显示。 */
export async function fetchSourcePrompts(sourceId: string, force = false): Promise<Prompt[]> {
    const source = usePromptSourceStore.getState().sources.find((item) => item.id === sourceId);
    if (!source) throw new Error("提示词来源不存在");
    return getSourcePrompts(source, force);
}

/** 强制刷新单个来源并返回读取数量。 */
export async function refreshSource(sourceId: string): Promise<number> {
    const items = await fetchSourcePrompts(sourceId, true);
    return items.length;
}

/** 强制刷新全部启用来源并返回总数量。 */
export async function refreshAllSources(): Promise<number> {
    const settled = await Promise.all(
        enabledSources().map(async (source) => {
            try {
                return await getSourcePrompts(source, true);
            } catch {
                return [];
            }
        }),
    );
    return settled.reduce((total, items) => total + items.length, 0);
}

function filterPrompts(items: Prompt[], options: { keyword: string; category: string; tags: string[] }) {
    return items.filter((item) => {
        if (isActiveOption(options.category) && item.category !== options.category) return false;
        if (options.tags.length && !options.tags.some((tag) => item.tags.includes(tag))) return false;
        if (!options.keyword) return true;
        return [item.title, item.prompt, item.category, ...item.tags].join(" ").toLowerCase().includes(options.keyword);
    });
}

function collectTags(items: Prompt[]) {
    return Array.from(new Set(items.flatMap((item) => item.tags).filter(Boolean)));
}

function isActiveOption(value: string) {
    return value && value !== "全部" && value !== "all";
}

export function formatPromptDate(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
