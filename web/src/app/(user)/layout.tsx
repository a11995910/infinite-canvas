"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

import { AppTopNav } from "@/components/layout/app-top-nav";
import { isSub2APIEmbedded } from "@/lib/sub2api-embed";
import { useUserStore } from "@/stores/use-user-store";

const protectedPrefixes = ["/image", "/workflows", "/video", "/canvas", "/assets", "/asset-library"];

export default function UserLayout({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const router = useRouter();
    const user = useUserStore((state) => state.user);
    const isReady = useUserStore((state) => state.isReady);
    const isEmbedLoginFailed = useUserStore((state) => state.isEmbedLoginFailed);
    const embedLoginError = useUserStore((state) => state.embedLoginError);
    const isProtectedPage = protectedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
    const sub2apiEmbedded = isSub2APIEmbedded();
    const waitingForEmbedSession = isProtectedPage && sub2apiEmbedded && !user && !isEmbedLoginFailed;
    const showEmbedLoginError = isProtectedPage && sub2apiEmbedded && !user && isEmbedLoginFailed;

    useEffect(() => {
        if (!isReady || !isProtectedPage || user || sub2apiEmbedded) return;
        router.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
    }, [isProtectedPage, isReady, pathname, router, sub2apiEmbedded, user]);

    return (
        <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
            <AppTopNav />
            <div className="min-h-0 flex-1 overflow-hidden">
                {showEmbedLoginError ? <Sub2APIEmbedLoginError message={embedLoginError} /> : isProtectedPage && (!isReady || !user || waitingForEmbedSession) ? null : children}
            </div>
        </div>
    );
}

function Sub2APIEmbedLoginError({ message }: { message: string }) {
    return (
        <main className="flex h-full min-h-0 items-center justify-center overflow-y-auto bg-background px-6 py-10 text-stone-950 dark:text-stone-100">
            <section className="w-full max-w-md text-center">
                <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-lg border border-stone-200 text-lg font-semibold dark:border-stone-800">!</div>
                <h1 className="text-2xl font-semibold tracking-normal">Sub2API 登录状态无效</h1>
                <p className="mt-3 text-sm leading-6 text-stone-500 dark:text-stone-400">{message || "请刷新 Sub2API 页面后重试。"}</p>
            </section>
        </main>
    );
}
