import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { App } from "antd";
import { useLocation } from "react-router-dom";

import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";
import { buildSub2APIEmbedConfig, clearSub2APIEmbedConfig, hasSub2APIEmbedChannel, readSub2APIEmbedParams } from "@/lib/sub2api-embed";
import { fetchSub2APIEmbedConfig, fetchSub2APIEmbedSession } from "@/services/api/sub2api-embed";
import { fetchUserConfig } from "@/services/api/user-config";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { createModelChannel, type AiConfig, useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const { pathname } = useLocation();
    const hydrateUser = useUserStore((state) => state.hydrateUser);
    const setSession = useUserStore((state) => state.setSession);
    const beginEmbedLogin = useUserStore((state) => state.beginEmbedLogin);
    const failEmbedLogin = useUserStore((state) => state.failEmbedLogin);
    const token = useUserStore((state) => state.token);
    const userId = useUserStore((state) => state.user?.id || "");
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const config = useConfigStore((state) => state.config);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const handledConfigParams = useRef(false);
    const embedSessionKeyRef = useRef("");
    const isLoginPage = pathname === "/login" || pathname === "/admin/login";

    usePromptSourceScheduler();

    useEffect(() => {
        if (handledConfigParams.current) return;
        const searchParams = new URLSearchParams(window.location.search);
        const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl");
        const apiKey = searchParams.get("apiKey") || searchParams.get("apikey");
        if (!baseUrl && !apiKey) return;
        handledConfigParams.current = true;
        ["baseUrl", "baseurl", "apiKey", "apikey"].forEach((key) => searchParams.delete(key));
        window.history.replaceState(null, "", `${window.location.pathname}${searchParams.size ? `?${searchParams}` : ""}${window.location.hash}`);
        const firstChannel = config.channels[0];
        updateConfig(
            "channels",
            firstChannel
                ? config.channels.map((channel, index) => (index === 0 ? { ...channel, ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}) } : channel))
                : [createModelChannel({ id: "default", name: "默认渠道", baseUrl: baseUrl || undefined, apiKey: apiKey || "" })],
        );
        if (baseUrl) updateConfig("baseUrl", baseUrl);
        if (apiKey) updateConfig("apiKey", apiKey);
        openConfigDialog(false);
        message.success("已导入本地直连配置");
    }, [config.channels, message, openConfigDialog, updateConfig]);

    useEffect(() => {
        const embed = readSub2APIEmbedParams();
        if (!isLoginPage && (!embed.embedded || !embed.token || !embed.srcHost)) void hydrateUser();
    }, [hydrateUser, isLoginPage]);

    useEffect(() => {
        const embed = readSub2APIEmbedParams();
        if (!embed.embedded || !embed.token || !embed.srcHost) return;
        const sessionKey = `${embed.srcHost}|${embed.token}`;
        if (embedSessionKeyRef.current === sessionKey) return;
        embedSessionKeyRef.current = sessionKey;

        applyConfig(clearSub2APIEmbedConfig(useConfigStore.getState().config), updateConfig);
        beginEmbedLogin();
        void fetchSub2APIEmbedSession({ token: embed.token, srcHost: embed.srcHost })
            .then((session) => {
                setSession(session.token, session.user);
                return fetchSub2APIEmbedConfig({ token: embed.token, srcHost: embed.srcHost });
            })
            .then((payload) => {
                if (hasSub2APIEmbedChannel(useConfigStore.getState().config, payload)) return;
                applyConfig(buildSub2APIEmbedConfig(useConfigStore.getState().config, payload), updateConfig);
            })
            .catch((error) => {
                failEmbedLogin(error instanceof Error ? error.message : undefined);
                console.warn("Sub2API 嵌入初始化失败", error);
            });
    }, [beginEmbedLogin, failEmbedLogin, setSession, updateConfig]);

    useEffect(() => {
        if (!token || !userId) {
            useCanvasStore.getState().setSyncEnabled(false);
            return;
        }
        void fetchUserConfig(token)
            .then((payload) => useCanvasStore.getState().syncWithRemote(token, payload.canvasData, payload.syncCapabilities?.userData === true))
            .catch(() => useCanvasStore.getState().setSyncEnabled(false));
    }, [token, userId]);

    return <>{children}</>;
}

function applyConfig(config: AiConfig, updateConfig: ReturnType<typeof useConfigStore.getState>["updateConfig"]) {
    (Object.entries(config) as Array<[keyof AiConfig, AiConfig[keyof AiConfig]]>).forEach(([key, value]) => updateConfig(key, value as never));
}
