import { useEffect, useMemo, useState } from "react";
import { Button, Empty, Input, Modal, Pagination, Tag } from "antd";
import { Check, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";

export type InsertAssetPayload =
    | { kind: "text"; content: string; title: string }
    | { kind: "image"; dataUrl: string; title: string; storageKey?: string; width?: number; height?: number; bytes?: number; mimeType?: string }
    | { kind: "video"; url: string; title: string; storageKey?: string; width?: number; height?: number };
export type ImageAssetPayload = Extract<InsertAssetPayload, { kind: "image" }>;

type Props = {
    open: boolean;
    defaultTab?: string;
    onInsert: (payload: InsertAssetPayload) => void;
    mode?: "insert" | "select-images";
    onSelectImages?: (payloads: ImageAssetPayload[]) => void;
    onClose: () => void;
};

export function AssetPickerModal({ open, onInsert, mode = "insert", onSelectImages, onClose }: Props) {
    return (
        <Modal title={mode === "select-images" ? "添加参考图" : "选择资产"} open={open} onCancel={onClose} footer={null} width={860} destroyOnHidden styles={{ body: { padding: "0 24px 24px", minHeight: 480 } }}>
            <MyAssetsTab mode={mode} onInsert={onInsert} onSelectImages={onSelectImages} onClose={onClose} />
        </Modal>
    );
}

const PAGE_SIZE = 8;

const kindOptions = [
    { label: "全部", value: "all" },
    { label: "文本", value: "text" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
];

function PickerCard({ title, kind, cover, selected, selectable, onClick }: { title: string; kind: string; cover: string; selected?: boolean; selectable?: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            className={cn(
                "group relative cursor-pointer overflow-hidden rounded-lg border bg-white text-left transition hover:shadow-md dark:bg-stone-900",
                selected ? "border-blue-500 ring-2 ring-blue-500/20" : "border-stone-200 hover:border-stone-400 dark:border-stone-700 dark:hover:border-stone-500",
            )}
            onClick={onClick}
        >
            {cover ? (
                <img src={cover} alt={title} className="aspect-[4/3] w-full object-cover" />
            ) : (
                <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-3 text-center text-xs leading-5 text-stone-500 dark:bg-stone-800 dark:text-stone-400">{title}</div>
            )}
            <div className="p-2.5">
                <div className="flex items-center justify-between gap-2">
                    <span className="line-clamp-1 text-xs font-medium text-stone-800 dark:text-stone-200">{title}</span>
                    <Tag className="m-0 shrink-0 text-[10px]">{kind === "image" ? "图片" : kind === "video" ? "视频" : "文本"}</Tag>
                </div>
            </div>
            {selected ? (
                <span className="absolute right-2 top-2 grid size-6 place-items-center rounded-full bg-blue-500 text-white shadow-sm">
                    <Check className="size-3.5" />
                </span>
            ) : null}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-stone-950/0 text-sm font-medium text-white opacity-0 transition group-hover:bg-stone-950/55 group-hover:opacity-100">{selected ? "取消选择" : selectable ? "选择" : "插入"}</div>
        </button>
    );
}

function MyAssetsTab({ mode, onInsert, onSelectImages, onClose }: { mode: NonNullable<Props["mode"]>; onInsert: (payload: InsertAssetPayload) => void; onSelectImages?: (payloads: ImageAssetPayload[]) => void; onClose: () => void }) {
    const assets = useAssetStore((state) => state.assets);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState("all");
    const [page, setPage] = useState(1);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const selectingImages = mode === "select-images";

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return assets
            .filter((a) => a.kind === "text" || a.kind === "image" || a.kind === "video")
            .filter((a) => (selectingImages ? a.kind === "image" : kindFilter === "all" || a.kind === kindFilter))
            .filter((a) => !query || [a.title, ...(a.tags || [])].join(" ").toLowerCase().includes(query));
    }, [assets, keyword, kindFilter, selectingImages]);

    const visible = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page]);

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
        setPage((v) => Math.min(v, maxPage));
    }, [filtered.length]);

    const toPayload = (asset: Asset): InsertAssetPayload => {
        if (asset.kind === "text") {
            return { kind: "text", content: asset.data.content, title: asset.title };
        }
        return asset.kind === "video"
            ? { kind: "video", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height }
            : { kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height, bytes: asset.data.bytes, mimeType: asset.data.mimeType };
    };

    const handleInsert = (asset: Asset) => {
        if (!selectingImages) {
            onInsert(toPayload(asset));
            return;
        }
        setSelectedIds((value) => (value.includes(asset.id) ? value.filter((id) => id !== asset.id) : [...value, asset.id]));
    };

    const confirmSelection = () => {
        const payloads = selectedIds
            .map((id) => assets.find((asset) => asset.id === id))
            .filter((asset): asset is Extract<Asset, { kind: "image" }> => asset?.kind === "image")
            .map((asset) => toPayload(asset) as ImageAssetPayload);
        if (!payloads.length) return;
        onSelectImages?.(payloads);
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <Input
                    className="w-56"
                    size="small"
                    prefix={<Search className="size-3.5 text-stone-400" />}
                    placeholder="搜索资产"
                    value={keyword}
                    allowClear
                    onChange={(e) => {
                        setPage(1);
                        setKeyword(e.target.value);
                    }}
                />
                {!selectingImages ? <div className="flex gap-1.5">
                    {kindOptions.map((opt) => (
                        <Tag.CheckableTag
                            key={opt.value}
                            checked={kindFilter === opt.value}
                            className={cn("prompt-filter-tag", kindFilter === opt.value && "is-active")}
                            onChange={() => {
                                setPage(1);
                                setKindFilter(opt.value);
                            }}
                        >
                            {opt.label}
                        </Tag.CheckableTag>
                    ))}
                </div> : null}
            </div>

            {visible.length ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {visible.map((asset) => (
                        <PickerCard key={asset.id} title={asset.title} kind={asset.kind} cover={asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : "")} selected={selectingImages && selectedIds.includes(asset.id)} selectable={selectingImages} onClick={() => handleInsert(asset)} />
                    ))}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有资产" className="py-12" />
            )}

            {filtered.length > PAGE_SIZE && (
                <div className="flex justify-center">
                    <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} showSizeChanger={false} />
                </div>
            )}
            {selectingImages ? (
                <div className="flex items-center border-t border-stone-200 pt-4 dark:border-stone-700">
                    <span className="text-sm text-stone-500 dark:text-stone-400">已选择 {selectedIds.length} 张</span>
                    <div className="ml-auto flex gap-2">
                        <Button onClick={onClose}>取消</Button>
                        <Button type="primary" disabled={!selectedIds.length} onClick={confirmSelection}>添加参考图</Button>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
