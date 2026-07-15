import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

import { buildSub2APIEmbedConfig, clearSub2APIEmbedConfig, hasSub2APIEmbedChannel, readSub2APIEmbedParams } from "@/lib/sub2api-embed";
import { fetchSub2APIEmbedConfig, fetchSub2APIEmbedSession } from "@/services/api/sub2api-embed";
import { fetchUserConfig } from "@/services/api/user-config";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { type AiConfig, useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { pathname } = useLocation();
    const hydrateUser = useUserStore((state) => state.hydrateUser);
    const setSession = useUserStore((state) => state.setSession);
    const beginEmbedLogin = useUserStore((state) => state.beginEmbedLogin);
    const failEmbedLogin = useUserStore((state) => state.failEmbedLogin);
    const token = useUserStore((state) => state.token);
    const userId = useUserStore((state) => state.user?.id || "");
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const embedSessionKeyRef = useRef("");
    const isLoginPage = pathname === "/login" || pathname === "/admin/login";

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
