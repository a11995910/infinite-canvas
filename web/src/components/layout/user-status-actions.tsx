import type { CSSProperties } from "react";
import { Avatar, Dropdown, Tooltip } from "antd";
import { BookOpen, Keyboard, LogOut, Settings2 } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { GitHubLink } from "@/components/layout/github-link";
import { VersionReleaseModal } from "@/components/layout/version-release-modal";
import { DOCS_URL } from "@/constant/env";
import { cn } from "@/lib/utils";
import { canvasThemes } from "@/lib/canvas-theme";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { isSub2APIEmbedded, withSub2APIEmbedParams } from "@/lib/sub2api-embed";

type UserStatusActionsProps = {
    showConfig?: boolean;
    variant?: "default" | "canvas";
    onOpenShortcuts?: () => void;
};

export function UserStatusActions({ showConfig = true, variant = "default", onOpenShortcuts }: UserStatusActionsProps) {
    const navigate = useNavigate();
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const user = useUserStore((state) => state.user);
    const isReady = useUserStore((state) => state.isReady);
    const clearSession = useUserStore((state) => state.clearSession);
    const canvasTheme = canvasThemes[theme];
    const naturalIconClass = "inline-flex size-7 shrink-0 items-center justify-center text-stone-600 transition hover:text-stone-950 dark:text-stone-300 dark:hover:text-white [&_svg]:size-4";
    const iconStyle: CSSProperties | undefined = variant === "canvas" ? { color: canvasTheme.node.text } : undefined;
    const versionStyle = iconStyle;
    const gitHubClassName = "size-7 text-base";
    const gitHubStyle = iconStyle;
    const userName = user?.displayName || user?.username || "";
    const avatarText = (userName.trim()[0] || "U").toUpperCase();

    const logout = () => {
        clearSession();
        navigate(withSub2APIEmbedParams("/login"), { replace: true });
    };

    return (
        <div className="inline-flex shrink-0 items-center gap-1">
            <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className={naturalIconClass} style={iconStyle} aria-label="文档" title="文档">
                <BookOpen className="size-4" />
            </a>
            {showConfig ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => openConfigDialog(false)} aria-label="配置" title="配置">
                    <Settings2 className="size-4" />
                </button>
            ) : null}
            <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={naturalIconClass} style={iconStyle} aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} />
            <VersionReleaseModal style={versionStyle} />
            <GitHubLink className={cn("bg-transparent hover:bg-transparent dark:hover:bg-transparent", gitHubClassName)} style={gitHubStyle} />
            {onOpenShortcuts ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenShortcuts} aria-label="快捷键" title="快捷键">
                    <Keyboard className="size-4" />
                </button>
            ) : null}
            {isReady && !user && !isSub2APIEmbedded() ? (
                <button type="button" className="px-1.5 text-sm font-medium text-stone-600 underline-offset-4 transition hover:text-stone-950 hover:underline dark:text-stone-300 dark:hover:text-stone-100" style={iconStyle} onClick={() => navigate("/login")}>
                    登录
                </button>
            ) : null}
            {user ? (
                <Dropdown
                    trigger={["click"]}
                    placement="bottomRight"
                    menu={{
                        items: [
                            { key: "user", disabled: true, label: <span className="font-medium text-current">{userName}</span> },
                            ...(onOpenShortcuts ? [{ key: "shortcuts", icon: <Keyboard className="size-4" />, label: "快捷键", onClick: onOpenShortcuts }] : []),
                            { type: "divider" },
                            { key: "logout", icon: <LogOut className="size-4" />, label: "退出登录", onClick: logout },
                        ],
                    }}
                >
                    <Tooltip title={userName}>
                        <button type="button" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-transparent p-0 text-[0] leading-[0]" aria-label="账户菜单">
                            <Avatar size={26} src={user.avatarUrl || undefined} className="!flex !items-center !justify-center border border-stone-300 bg-transparent text-xs font-semibold text-stone-800 dark:border-stone-700 dark:text-stone-100">
                                {avatarText}
                            </Avatar>
                        </button>
                    </Tooltip>
                </Dropdown>
            ) : null}
        </div>
    );
}
