import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { App, Button, Form, Input, Segmented, Space } from "antd";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { readSub2APIEmbedParams, withSub2APIEmbedParams } from "@/lib/sub2api-embed";
import { fetchCurrentUser } from "@/services/api/auth";
import { useUserStore } from "@/stores/use-user-store";

type LoginFormValues = {
    username: string;
    password: string;
    confirmPassword?: string;
};

export default function LoginPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const login = useUserStore((state) => state.login);
    const register = useUserStore((state) => state.register);
    const setSession = useUserStore((state) => state.setSession);
    const user = useUserStore((state) => state.user);
    const isReady = useUserStore((state) => state.isReady);
    const isLoading = useUserStore((state) => state.isLoading);
    const isEmbedLoginFailed = useUserStore((state) => state.isEmbedLoginFailed);
    const embedLoginError = useUserStore((state) => state.embedLoginError);
    const [mode, setMode] = useState<"login" | "register">("login");
    const redirect = searchParams.get("redirect") || "/";
    const embed = readSub2APIEmbedParams();
    const sub2apiEmbedded = embed.embedded && Boolean(embed.token && embed.srcHost);

    useEffect(() => {
        if (sub2apiEmbedded) return;
        const token = searchParams.get("token");
        const error = searchParams.get("error");
        if (error) message.error(error);
        if (!token) return;
        void fetchCurrentUser(token)
            .then((nextUser) => {
                setSession(token, nextUser);
                message.success("登录成功");
                navigate(redirect.startsWith("/") ? redirect : "/", { replace: true });
            })
            .catch((error) => message.error(error instanceof Error ? error.message : "登录失败"));
    }, [message, navigate, redirect, searchParams, setSession, sub2apiEmbedded]);

    useEffect(() => {
        if (sub2apiEmbedded && user) navigate(withSub2APIEmbedParams("/canvas"), { replace: true });
    }, [navigate, sub2apiEmbedded, user]);

    const submit = async (values: LoginFormValues) => {
        if (mode === "register" && values.password !== values.confirmPassword) {
            message.error("两次输入的密码不一致");
            return;
        }
        try {
            await (mode === "register" ? register : login)({ username: values.username, password: values.password });
            message.success(mode === "register" ? "注册成功" : "登录成功");
            navigate(redirect.startsWith("/") ? withSub2APIEmbedParams(redirect) : "/", { replace: true });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "登录失败");
        }
    };

    if (sub2apiEmbedded) {
        return (
            <main className="flex h-full min-h-0 items-center justify-center overflow-y-auto bg-background px-6 py-10 text-stone-950 dark:text-stone-100">
                <section className="w-full max-w-md text-center">
                    <span className="mx-auto mb-5 block size-12 bg-stone-950 dark:bg-stone-100" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} aria-label="无限画布" />
                    <h1 className="text-2xl font-semibold">{isEmbedLoginFailed ? "Sub2API 登录状态无效" : "正在进入无限画布"}</h1>
                    <p className="mt-3 text-sm leading-6 text-stone-500 dark:text-stone-400">{isEmbedLoginFailed ? embedLoginError || "请刷新 Sub2API 页面后重试。" : isReady && user ? "正在打开画布..." : "正在使用 Sub2API 当前登录状态进入，无需再次登录。"}</p>
                </section>
            </main>
        );
    }

    return (
        <main className="flex h-full min-h-0 items-center justify-center overflow-y-auto bg-background bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-6 py-10 [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.16)_1px,transparent_1px)]">
            <section className="w-full max-w-[420px]">
                <div className="mb-7 text-center">
                    <span className="mx-auto mb-4 block size-12 bg-stone-950 dark:bg-stone-100" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} aria-label="无限画布" />
                    <h1 className="text-3xl font-semibold text-stone-950 dark:text-stone-100">账号登录</h1>
                    <p className="mt-3 text-base leading-7 text-stone-500 dark:text-stone-400">使用账号密码登录或注册。</p>
                </div>
                <Form<LoginFormValues> layout="vertical" size="large" requiredMark={false} onFinish={submit}>
                    <Form.Item>
                        <Segmented block value={mode} onChange={(value) => setMode(value as "login" | "register")} options={[{ label: "登录", value: "login" }, { label: "注册", value: "register" }]} />
                    </Form.Item>
                    <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
                        <Input prefix={<UserOutlined />} autoComplete="username" />
                    </Form.Item>
                    <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
                        <Input.Password prefix={<LockOutlined />} autoComplete={mode === "login" ? "current-password" : "new-password"} />
                    </Form.Item>
                    {mode === "register" ? (
                        <Form.Item name="confirmPassword" label="确认密码" rules={[{ required: true, message: "请再次输入密码" }]}>
                            <Input.Password prefix={<LockOutlined />} autoComplete="new-password" />
                        </Form.Item>
                    ) : null}
                    <Space orientation="vertical" size={12} className="w-full">
                        <Button block type="primary" htmlType="submit" loading={isLoading}>
                            {mode === "register" ? "注册" : "登录"}
                        </Button>
                        <Button block href={`/api/auth/linux-do/authorize?redirect=${encodeURIComponent(redirect)}`} icon={<img src="/icons/linuxdo.svg" alt="" width={18} height={18} />}>
                            使用 Linux.do 登录
                        </Button>
                    </Space>
                </Form>
            </section>
        </main>
    );
}
