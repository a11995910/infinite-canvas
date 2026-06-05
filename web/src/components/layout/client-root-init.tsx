"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { usePathname } from "next/navigation";

import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";
import { fetchUserConfig } from "@/services/api/user-config";
import { fetchSub2APIEmbedConfig } from "@/services/api/sub2api-embed";
import { defaultUserStorageProvider, saveUserStorageProvider } from "@/services/image-storage";
import { buildSub2APIEmbedConfig, hasSub2APIEmbedChannel, readSub2APIEmbedParams } from "@/lib/sub2api-embed";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const hydrateUser = useUserStore((state) => state.hydrateUser);
    const token = useUserStore((state) => state.token);
    const user = useUserStore((state) => state.user);
    const loadPublicSettings = useConfigStore((state) => state.loadPublicSettings);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const hydrateAccountAssets = useAssetStore((state) => state.hydrateAccountAssets);
    const stopAccountAssetSync = useAssetStore((state) => state.stopAccountAssetSync);
    const isLoginPage = pathname === "/login" || pathname === "/admin/login";

    useEffect(() => {
        void loadPublicSettings();
    }, [loadPublicSettings]);

    useEffect(() => {
        if (!isLoginPage) void hydrateUser();
    }, [hydrateUser, isLoginPage]);

    useEffect(() => {
        const embed = readSub2APIEmbedParams();
        if (!embed.embedded || !embed.token || !embed.srcHost) return;
        void fetchSub2APIEmbedConfig({ token: embed.token, srcHost: embed.srcHost })
            .then((payload) => {
                if (hasSub2APIEmbedChannel(useConfigStore.getState().config, payload)) return;
                const nextConfig = buildSub2APIEmbedConfig(useConfigStore.getState().config, payload);
                Object.entries(nextConfig).forEach(([key, value]) => updateConfig(key as keyof AiConfig, value as never));
            })
            .catch((error) => console.warn("Sub2API 嵌入配置失败", error));
    }, [updateConfig]);

    useEffect(() => {
        if (token && user?.id) {
            void fetchUserConfig(token)
                .then((payload) => {
                    const syncAssets = payload.syncCapabilities?.assets === true;
                    void hydrateAccountAssets(token, syncAssets);

                    const syncUserData = payload.syncCapabilities?.userData === true;
                    void import("@/app/(user)/canvas/stores/use-canvas-store").then(({ useCanvasStore }) => {
                        void useCanvasStore.getState().syncWithRemote(token, payload.canvasData, syncUserData);
                    });

                    let syncModel = false;
                    let syncStorage = false;
                    if (payload.modelConfig) {
                        syncModel = !!payload.modelConfig.syncModelConfig;
                        syncStorage = !!payload.modelConfig.syncStorageConfig;

                        if (syncModel) {
                            Object.entries(payload.modelConfig).forEach(([key, value]) => updateConfig(key as keyof AiConfig, value as never));
                        } else {
                            updateConfig("syncModelConfig", false);
                        }

                        if (syncStorage) {
                            updateConfig("syncStorageConfig", true);
                        } else {
                            updateConfig("syncStorageConfig", false);
                        }
                    } else {
                        updateConfig("syncModelConfig", false);
                        updateConfig("syncStorageConfig", false);
                    }

                    if (syncStorage && payload.storageProvider) {
                        const next = {
                            ...defaultUserStorageProvider(),
                            ...payload.storageProvider,
                            enabled: payload.storageProvider.enabled !== undefined ? payload.storageProvider.enabled : true
                        };
                        saveUserStorageProvider(next);
                    }
                })
                .catch(() => {
                    void hydrateAccountAssets(token, false);
                    void import("@/app/(user)/canvas/stores/use-canvas-store").then(({ useCanvasStore }) => {
                        useCanvasStore.getState().setSyncEnabled(false);
                    });
                });
            return;
        }
        stopAccountAssetSync();
        void import("@/app/(user)/canvas/stores/use-canvas-store").then(({ useCanvasStore }) => {
            useCanvasStore.getState().setSyncEnabled(false);
        });
    }, [hydrateAccountAssets, stopAccountAssetSync, token, user?.id, updateConfig]);

    return <>{children}</>;
}
