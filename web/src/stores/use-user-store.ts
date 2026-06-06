"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { AUTH_TOKEN_KEY, fetchCurrentUser, login, register, type AuthPayload, type AuthUser } from "@/services/api/auth";

type UserStore = {
    token: string;
    user: AuthUser | null;
    isReady: boolean;
    isLoading: boolean;
    isEmbedLoginFailed: boolean;
    embedLoginError: string;
    setSession: (token: string, user: AuthUser) => void;
    clearSession: () => void;
    beginEmbedLogin: () => void;
    failEmbedLogin: (error?: string) => void;
    hydrateUser: () => Promise<void>;
    login: (payload: AuthPayload) => Promise<AuthUser>;
    register: (payload: AuthPayload) => Promise<AuthUser>;
};

export const useUserStore = create<UserStore>()(
    persist(
        (set, get) => ({
            token: "",
            user: null,
            isReady: false,
            isLoading: false,
            isEmbedLoginFailed: false,
            embedLoginError: "",
            setSession: (token, user) => set({ token, user, isReady: true, isLoading: false, isEmbedLoginFailed: false, embedLoginError: "" }),
            clearSession: () => set({ token: "", user: null, isReady: true, isLoading: false, isEmbedLoginFailed: false, embedLoginError: "" }),
            beginEmbedLogin: () => set({ token: "", user: null, isReady: false, isLoading: true, isEmbedLoginFailed: false, embedLoginError: "" }),
            failEmbedLogin: (error) => set({ isReady: true, isLoading: false, isEmbedLoginFailed: true, embedLoginError: error || "Sub2API 登录状态无效，请刷新 Sub2API 页面后重试" }),
            hydrateUser: async () => {
                const token = get().token;
                if (!token) {
                    set({ user: null, isReady: true });
                    return;
                }
                set({ isLoading: true });
                try {
                    const user = await fetchCurrentUser(token);
                    if (user.role === "guest") {
                        set({ token: "", user: null, isReady: true, isLoading: false });
                        return;
                    }
                    set({ user, isReady: true, isLoading: false });
                } catch {
                    set({ token: "", user: null, isReady: true, isLoading: false });
                }
            },
            login: async (payload) => {
                set({ isLoading: true });
                try {
                    const session = await login(payload);
                    set({ token: session.token, user: session.user, isReady: true, isLoading: false });
                    return session.user;
                } catch (error) {
                    set({ isLoading: false });
                    throw error;
                }
            },
            register: async (payload) => {
                set({ isLoading: true });
                try {
                    const session = await register(payload);
                    set({ token: session.token, user: session.user, isReady: true, isLoading: false });
                    return session.user;
                } catch (error) {
                    set({ isLoading: false });
                    throw error;
                }
            },
        }),
        {
            name: AUTH_TOKEN_KEY,
            partialize: (state) => ({ token: state.token }),
            onRehydrateStorage: () => (state) => {
                if (state) state.isReady = false;
            },
        },
    ),
);
