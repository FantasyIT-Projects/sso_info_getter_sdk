# @sso-info/sdk

OIDC 单点登录浏览器 SDK：在用户点击里拉起一个登录窗口，登录完成后通过 `postMessage` 取回用户信息。

- 产物：单个 ESM 文件 `dist/index.js`（约 11 KB），**零运行时依赖**、**无安装脚本**（`dist/` 随仓库发布）
- 导出：`getUserInfoSSO(): Promise<{ username: string; nickname: string; avatar: string }>`
- 自带 TypeScript 类型（`dist/index.d.ts`）

## 安装

    # 本地目录 / tgz
    npm i ../sso_info/packages/sdk
    npm i ./sso-info-sdk-0.2.0.tgz

    # GitHub（仓库里已带 dist，装的时候不需要构建）
    npm i github:you/sso-info-sdk
    npm i github:you/sso-info-sdk#v0.2.0

    # 不打 npm 也能直接用：跨域 ESM 直引（要求响应带 CORS 头）
    import { getUserInfoSSO } from "https://cdn.jsdelivr.net/gh/you/sso-info@v0.2.0/packages/sdk/dist/index.js"

## 用法

    import { configureSSO, getUserInfoSSO, SSOError } from "@sso-info/sdk"

    configureSSO({ serverUrl: "https://sso.example.com" })

    document.querySelector("#login").addEventListener("click", async () => {
      try {
        const { username, nickname, avatar } = await getUserInfoSSO()
        render({ username, nickname, avatar })
      } catch (error) {
        if (error instanceof SSOError) console.error(error.code, error.message)
      }
    })

React 里同样，只是把调用放进 `onClick`：

    const onClick = async () => {
      const user = await getUserInfoSSO()   // 必须是第一句，前面不能有 await
      setUser(user)
    }

## API

| 导出 | 说明 |
| --- | --- |
| `configureSSO(options)` | 设置并合并默认配置，同步生效 |
| `getUserInfoSSO(options?)` | 拉起登录窗口，resolve `{ username, nickname, avatar }` |
| `isSupported()` | 当前环境是否可用（SSR / 非浏览器返回 false） |
| `SSOError` | 带稳定 `code` 的错误类 |
| `UserInfo` / `SSOConfig` / `SSOOptions` / `SSOErrorCode` | TS 类型 |
| `MESSAGE_TYPE_USER_INFO` / `MESSAGE_TYPE_ERROR` | 自己接管 postMessage 时用的协议常量 |

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `serverUrl` | 必填 | SSO 服务端地址（绝对 http(s) 地址） |
| `timeoutMs` | 5 分钟 | 等待登录完成的最长时间 |
| `popupFeatures` | 见源码 | `window.open` 特性串（窗口大小 / 位置） |

配置优先级（低 → 高）：`<script data-sso-server>` → `globalThis.__SSO_INFO_CONFIG__` → `configureSSO()` → `getUserInfoSSO({...})`。

## 错误码

| code | 原因 |
| --- | --- |
| `config_invalid` | 缺 `serverUrl` 或地址不合法 |
| `popup_blocked` | 调用前有 await / setTimeout，丢了用户手势，或被浏览器拦截 |
| `invalid_origin` | 页面 origin 为 null（`file://` 或沙箱 iframe） |
| `popup_closed` | 用户中途关窗 |
| `timeout` | 超过 `timeoutMs` |
| `access_denied` | 用户在 OIDC 侧取消 |
| `server_error` | 服务端 / OIDC 报错，`message` 为具体原因 |
| `unsupported` | SSR 等无 DOM 环境 |

## 注意事项

1. **必须在用户点击的同步调用栈里调用**，否则弹窗被拦截（`popup_blocked`）。
2. 调用页面必须是 http(s)：`file://` 的 origin 是 `null`，直接报 `invalid_origin`。
3. 调用页面的 **origin 必须在服务端白名单里**（服务端 `data/origins.json` 或 `SSO_ORIGINS`），否则弹窗里显示错误页，promise 直到关窗或超时才 reject。
4. 不要给弹窗加 `noopener` —— SDK 依赖 `window.opener` 回传结果。
5. 跨域 ESM 直引（SSO 服务端的 `/sdk.js` 或 CDN）时响应必须带 `Access-Control-Allow-Origin`，因为 ES module 请求一定是 CORS 模式。
6. SDK 不做任何网络请求，因此不需要配 CORS；它只用 `window.open` + `addEventListener("message")`。

## postMessage 协议

成功：

    { "type": "sso-info:user-info", "nonce": "...",
      "user": { "username": "alice", "nickname": "张爱丽", "avatar": "https://.../avatars/alice.svg" },
      "issuedAt": 1730000000000 }

失败：

    { "type": "sso-info:error", "nonce": "...",
      "code": "access_denied", "message": "用户取消了登录" }

SDK 只接受同时满足 `event.origin === serverUrl 的 origin`、`event.source === 自己打开的窗口`、`nonce` 匹配的消息。

**失败时不会自动关窗**：弹窗会停在结果页显示错误码与原因，方便排查；只有登录成功才自动关闭（服务端下发 `autoClose` 控制）。

## 构建

    npm install     # 会顺带跑 prepare -> build
    npm run build
    npm run typecheck
