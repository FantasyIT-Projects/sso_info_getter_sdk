/**
 * @sso-info/sdk
 *
 * 浏览器端 OIDC 单点登录 SDK。
 *
 *   import { configureSSO, getUserInfoSSO } from '@sso-info/sdk'
 *   configureSSO({ serverUrl: 'https://sso.example.com', clientId: 'my-app' })
 *   const { username, preferName, avatar } = await getUserInfoSSO()
 *
 * 工作方式：在用户点击的同步调用栈里拉起一个新窗口，指向 SSO 服务器的 /authorize 页面；
 * 服务器完成 OIDC 登录后渲染一个结果页，通过 window.opener.postMessage 把用户信息回传给本页；
 * 本 SDK 校验 message 的 origin / source / nonce 后 resolve promise。
 */
/** 登录成功后返回的用户信息。 */
export interface UserInfo {
    readonly username: string;
    readonly preferName: string;
    readonly avatar: string;
}
/** SSO 客户端配置。 */
export interface SSOConfig {
    /** SSO 服务器地址（绝对地址，http/https），例如 https://sso.example.com */
    serverUrl: string;
    /** 在 SSO 服务器上注册的客户端 ID */
    clientId: string;
    /** 等待登录完成的最长时间，默认 5 分钟 */
    timeoutMs: number;
    /** window.open 的窗口特性字符串 */
    popupFeatures: string;
}
/** {@link getUserInfoSSO} 的可选参数。 */
export type SSOOptions = Partial<SSOConfig>;
/** SDK 错误码。 */
export type SSOErrorCode = 'unsupported' | 'config_invalid' | 'invalid_origin' | 'popup_blocked' | 'popup_closed' | 'timeout' | 'access_denied' | 'server_error';
/** SDK 抛出的错误，带稳定的错误码。 */
export declare class SSOError extends Error {
    readonly code: SSOErrorCode;
    constructor(code: SSOErrorCode, message: string);
}
/** 结果消息类型（与服务器约定一致）。 */
export declare const MESSAGE_TYPE_USER_INFO = "sso-info:user-info";
/** 失败消息类型（与服务器约定一致）。 */
export declare const MESSAGE_TYPE_ERROR = "sso-info:error";
/**
 * 设置全局默认配置；多次调用会合并，后设置的字段覆盖先设置的字段。
 * 调用时不需要等待，{@link getUserInfoSSO} 会同步读取该配置。
 */
export declare function configureSSO(options: SSOOptions): void;
/** 当前环境是否支持弹出窗口登录。 */
export declare function isSupported(): boolean;
/**
 * 拉起 OIDC 登录窗口，返回登录用户信息。
 *
 * 必须在用户手势的同步调用栈中触发（例如 click 处理器里直接调用），否则弹出窗口会被浏览器拦截。
 */
export declare function getUserInfoSSO(options?: SSOOptions): Promise<UserInfo>;
