export type ReferenceImageRole = "general" | "subject" | "style" | "composition" | "color" | "background" | "locked";

export type ReferenceImage = {
    id: string;
    name: string;
    type: string;
    dataUrl: string;
    url?: string;
    storageKey?: string;
    source?: "upload" | "clipboard" | "asset" | "result" | "library" | "workflow";
    assetId?: string;
    temporary?: boolean;
    role?: ReferenceImageRole;
};
