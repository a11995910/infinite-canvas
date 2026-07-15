"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Input, Segmented, Tooltip } from "antd";
import { Brush, Check, ImagePlus, LoaderCircle, Lock, Palette, ScanSearch, Sparkles, Wand2, X } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ReferenceImageRole } from "@/types/image";
import type { ImageCropRect } from "@/lib/canvas/canvas-image-data";
import type { CanvasNodeData } from "@/types/canvas";

export type CanvasImageIterationAction = "variant" | "style" | "background" | "compose" | "inpaint";

export type CanvasImageIterationPayload = {
    action: CanvasImageIterationAction;
    prompt: string;
    role: ReferenceImageRole;
    crop?: ImageCropRect;
};

type DragMode = "move" | "resize";
type ResizeHandle = "n" | "e" | "s" | "w" | "ne" | "nw" | "se" | "sw";

type Preset = {
    key: CanvasImageIterationAction;
    label: string;
    icon: React.ReactNode;
    placeholder: string;
    prompt: string;
};

const handles: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const defaultCrop: ImageCropRect = { x: 0.28, y: 0.24, width: 0.44, height: 0.42 };
const minCropSize = 0.05;

const roleOptions: Array<{ label: string; value: ReferenceImageRole; title: string }> = [
    { label: "通用", value: "general", title: "作为普通参考图使用" },
    { label: "主体", value: "subject", title: "尽量保留主体身份、形状和关键特征" },
    { label: "风格", value: "style", title: "主要参考质感、画风和视觉语言" },
    { label: "构图", value: "composition", title: "主要参考镜头、布局和透视" },
    { label: "色彩", value: "color", title: "主要参考色调、光照和配色" },
    { label: "背景", value: "background", title: "主要参考环境和背景氛围" },
    { label: "锁定", value: "locked", title: "明确要求不要改变人物、产品或主体" },
];

const presets: Preset[] = [
    {
        key: "variant",
        label: "生成变体",
        icon: <Sparkles className="size-4" />,
        placeholder: "例如：保留主体，生成 3 个更商业摄影的变体",
        prompt: "以当前图片为主体参考，保留主体身份、比例和关键细节，生成更完整、更精致的同主题变体。不要照搬原图构图，允许优化光线、质感和画面完成度。",
    },
    {
        key: "style",
        label: "换风格",
        icon: <Palette className="size-4" />,
        placeholder: "例如：改成高级杂志大片、赛博朋克、极简电商主图",
        prompt: "以当前图片为主体参考，保留主体身份和主要结构，将整体视觉风格转换为更统一、更高级的风格。用户补充的风格要求优先。",
    },
    {
        key: "background",
        label: "换背景",
        icon: <ImagePlus className="size-4" />,
        placeholder: "例如：换成纯白棚拍背景、户外街景、科技展台",
        prompt: "以当前图片为主体参考，保留主体不变，重新设计背景和环境。主体边缘要自然，背景透视和光照需要匹配主体。",
    },
    {
        key: "compose",
        label: "重构图",
        icon: <ScanSearch className="size-4" />,
        placeholder: "例如：改成横版海报构图，主体居中，留出标题空间",
        prompt: "以当前图片为主体参考，保留主体核心特征，重新组织画面构图、留白、镜头距离和视觉重心，让图片更适合实际使用场景。",
    },
    {
        key: "inpaint",
        label: "局部重绘",
        icon: <Brush className="size-4" />,
        placeholder: "例如：只把选区里的衣服改成黑色西装",
        prompt: "只修改用户选择的局部区域，未选择区域必须尽量保持不变。局部修改需要自然融入原图光照、透视、材质和边缘。",
    },
];

export function CanvasImageIterationPanel({
    node,
    isRunning,
    onClose,
    onRoleChange,
    onGenerate,
}: {
    node: CanvasNodeData;
    isRunning: boolean;
    onClose: () => void;
    onRoleChange: (nodeId: string, role: ReferenceImageRole) => void;
    onGenerate: (node: CanvasNodeData, payload: CanvasImageIterationPayload) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const boxRef = useRef<HTMLDivElement>(null);
    const [action, setAction] = useState<CanvasImageIterationAction>("variant");
    const [role, setRole] = useState<ReferenceImageRole>(node.metadata?.referenceRole || "subject");
    const [prompt, setPrompt] = useState("");
    const [crop, setCrop] = useState<ImageCropRect>(defaultCrop);
    const activePreset = useMemo(() => presets.find((item) => item.key === action) || presets[0], [action]);
    const useCrop = action === "inpaint";

    useEffect(() => {
        setRole(node.metadata?.referenceRole || "subject");
        setPrompt("");
        setCrop(defaultCrop);
        setAction("variant");
    }, [node.id, node.metadata?.referenceRole]);

    const updateRole = (nextRole: ReferenceImageRole) => {
        setRole(nextRole);
        onRoleChange(node.id, nextRole);
    };

    const startDrag = (mode: DragMode, event: ReactPointerEvent, handle?: ResizeHandle) => {
        if (isRunning) return;
        const box = boxRef.current?.getBoundingClientRect();
        if (!box) return;
        event.preventDefault();
        event.stopPropagation();
        const start = { x: event.clientX, y: event.clientY, crop };
        const move = (event: PointerEvent) => {
            const dx = (event.clientX - start.x) / box.width;
            const dy = (event.clientY - start.y) / box.height;
            setCrop(mode === "move" ? moveCrop(start.crop, dx, dy) : resizeCrop(start.crop, dx, dy, handle || "se"));
        };
        const up = () => {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", up);
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
    };

    const submit = () => {
        if (isRunning) return;
        const userPrompt = prompt.trim();
        const finalPrompt = [activePreset.prompt, userPrompt ? `用户补充要求：${userPrompt}` : ""].filter(Boolean).join("\n");
        onGenerate(node, { action, prompt: finalPrompt, role, ...(useCrop ? { crop } : {}) });
    };

    return (
        <div
            className="w-[560px] rounded-2xl border p-3 shadow-2xl backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="grid size-8 shrink-0 place-items-center rounded-xl" style={{ background: theme.node.fill, color: theme.node.muted }}>
                        <Wand2 className="size-4" />
                    </span>
                    <div className="min-w-0">
                        <div className="text-sm font-semibold leading-5">图片迭代</div>
                        <div className="truncate text-xs opacity-50">基于当前图片继续生成新分支</div>
                    </div>
                </div>
                <Button size="small" type="text" className="!h-8 !w-8 !min-w-8 !p-0" icon={<X className="size-4" />} onClick={onClose} aria-label="关闭图片迭代" />
            </div>

            <div className="grid grid-cols-[180px_minmax(0,1fr)] gap-3">
                <div className="space-y-2">
                    {presets.map((item) => (
                        <button
                            key={item.key}
                            type="button"
                            className="flex h-11 w-full items-center gap-2 rounded-xl border px-3 text-left text-sm transition"
                            style={{
                                background: action === item.key ? theme.node.fill : "transparent",
                                borderColor: action === item.key ? theme.node.activeStroke : theme.node.stroke,
                                color: theme.node.text,
                            }}
                            onClick={() => setAction(item.key)}
                        >
                            {item.icon}
                            <span>{item.label}</span>
                        </button>
                    ))}
                </div>

                <div className="min-w-0 space-y-3">
                    <div className="rounded-xl border p-2.5" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                        <div className="mb-2 flex items-center justify-between gap-2">
                            <span className="text-xs font-medium opacity-60">参考角色</span>
                            <Tooltip title={roleOptions.find((item) => item.value === role)?.title}>
                                <span className="inline-flex items-center gap-1 text-xs opacity-50">
                                    {role === "locked" ? <Lock className="size-3" /> : null}
                                    {roleOptions.find((item) => item.value === role)?.label}
                                </span>
                            </Tooltip>
                        </div>
                        <Segmented
                            size="small"
                            block
                            value={role}
                            onChange={(value) => updateRole(value as ReferenceImageRole)}
                            options={roleOptions.map((item) => ({ label: item.label, value: item.value }))}
                        />
                    </div>

                    {useCrop ? (
                        <div className="space-y-2">
                            <div className="flex items-center justify-between text-xs opacity-60">
                                <span>局部区域</span>
                                <button type="button" className="hover:opacity-100" onClick={() => setCrop(defaultCrop)}>
                                    重置
                                </button>
                            </div>
                            <div ref={boxRef} className="relative inline-block max-h-[240px] max-w-full overflow-hidden rounded-xl bg-black">
                                <img src={node.metadata?.content || ""} alt="" className="block max-h-[240px] max-w-full opacity-90" draggable={false} />
                                <CropMask crop={crop} />
                                <div className="absolute cursor-move border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,.35),0_0_24px_rgba(0,0,0,.28)]" style={cropStyle(crop)} onPointerDown={(event) => startDrag("move", event)}>
                                    <div className="pointer-events-none absolute inset-x-0 top-1/3 border-t border-white/50" />
                                    <div className="pointer-events-none absolute inset-x-0 top-2/3 border-t border-white/50" />
                                    <div className="pointer-events-none absolute inset-y-0 left-1/3 border-l border-white/50" />
                                    <div className="pointer-events-none absolute inset-y-0 left-2/3 border-l border-white/50" />
                                    {handles.map((handle) => (
                                        <button key={handle} type="button" className="absolute size-3 rounded-full border border-black bg-white" style={handleStyle(handle)} onPointerDown={(event) => startDrag("resize", event, handle)} aria-label="调整局部区域" />
                                    ))}
                                </div>
                            </div>
                        </div>
                    ) : null}

                    <Input.TextArea
                        className="thin-scrollbar !resize-none !rounded-xl !text-sm !leading-5"
                        style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text }}
                        autoSize={{ minRows: 3, maxRows: 5 }}
                        value={prompt}
                        onChange={(event) => setPrompt(event.target.value)}
                        placeholder={activePreset.placeholder}
                    />

                    <div className="flex items-center justify-end gap-2">
                        <Button disabled={isRunning} onClick={onClose}>
                            取消
                        </Button>
                        <Button type="primary" disabled={isRunning} icon={isRunning ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />} onClick={submit}>
                            {isRunning ? "生成中" : "生成分支"}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}

function CropMask({ crop }: { crop: ImageCropRect }) {
    return (
        <>
            <div className="absolute inset-x-0 top-0 bg-black/55" style={{ height: `${crop.y * 100}%` }} />
            <div className="absolute inset-x-0 bottom-0 bg-black/55" style={{ height: `${(1 - crop.y - crop.height) * 100}%` }} />
            <div className="absolute bg-black/55" style={{ left: 0, top: `${crop.y * 100}%`, width: `${crop.x * 100}%`, height: `${crop.height * 100}%` }} />
            <div className="absolute bg-black/55" style={{ right: 0, top: `${crop.y * 100}%`, width: `${(1 - crop.x - crop.width) * 100}%`, height: `${crop.height * 100}%` }} />
        </>
    );
}

function moveCrop(crop: ImageCropRect, dx: number, dy: number): ImageCropRect {
    return { ...crop, x: clamp(crop.x + dx, 0, 1 - crop.width), y: clamp(crop.y + dy, 0, 1 - crop.height) };
}

function resizeCrop(crop: ImageCropRect, dx: number, dy: number, handle: ResizeHandle): ImageCropRect {
    let next = { ...crop };
    if (handle.includes("e")) next.width = crop.width + dx;
    if (handle.includes("s")) next.height = crop.height + dy;
    if (handle.includes("w")) {
        next.x = crop.x + dx;
        next.width = crop.width - dx;
    }
    if (handle.includes("n")) {
        next.y = crop.y + dy;
        next.height = crop.height - dy;
    }

    next.width = Math.max(minCropSize, next.width);
    next.height = Math.max(minCropSize, next.height);
    next.x = clamp(next.x, 0, 1 - next.width);
    next.y = clamp(next.y, 0, 1 - next.height);
    next.width = clamp(next.width, minCropSize, 1 - next.x);
    next.height = clamp(next.height, minCropSize, 1 - next.y);
    return next;
}

function cropStyle(crop: ImageCropRect) {
    return {
        left: `${crop.x * 100}%`,
        top: `${crop.y * 100}%`,
        width: `${crop.width * 100}%`,
        height: `${crop.height * 100}%`,
    };
}

function handleStyle(handle: ResizeHandle) {
    const top = handle.includes("n") ? "-6px" : handle.includes("s") ? "calc(100% - 6px)" : "calc(50% - 6px)";
    const left = handle.includes("w") ? "-6px" : handle.includes("e") ? "calc(100% - 6px)" : "calc(50% - 6px)";
    return { top, left, cursor: `${handle}-resize` };
}

function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value));
}
