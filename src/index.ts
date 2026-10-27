/**
 * @sso-info/sdk
 *
 * 浏览器端 OIDC 单点登录 SDK。
 *
 *   import { configureSSO, getUserInfoSSO } from '@sso-info/sdk'
 *   configureSSO({ serverUrl: 'https://sso.example.com' })
 *   const { username, preferName, avatar } = await getUserInfoSSO()
 *
 * 工作方式：在用户点击的同步调用栈里拉起一个新窗口，指向 SSO 服务器的 /authorize 页面；
 * 服务器完成 OIDC 登录后渲染一个结果页，通过 window.opener.postMessage 把用户信息回传给本页；
 * 本 SDK 校验 message 的 origin / source / nonce 后 resolve promise。
 */

/** 登录成功后返回的用户信息。 */
export interface UserInfo {
  readonly username: string
  readonly preferName: string
  readonly avatar: string
}

/** SSO 客户端配置。 */
export interface SSOConfig {
  /** SSO 服务器地址（绝对地址，http/https），例如 https://sso.example.com */
  serverUrl: string
  /** 等待登录完成的最长时间，默认 5 分钟 */
  timeoutMs: number
  /** window.open 的窗口特性字符串 */
  popupFeatures: string
}

/** {@link getUserInfoSSO} 的可选参数。 */
export type SSOOptions = Partial<SSOConfig>

/** SDK 错误码。 */
export type SSOErrorCode =
  | 'unsupported'
  | 'config_invalid'
  | 'invalid_origin'
  | 'popup_blocked'
  | 'popup_closed'
  | 'timeout'
  | 'access_denied'
  | 'server_error'

/** SDK 抛出的错误，带稳定的错误码。 */
export class SSOError extends Error {
  readonly code: SSOErrorCode

  constructor(code: SSOErrorCode, message: string) {
    super(message)
    this.name = 'SSOError'
    this.code = code
  }
}

/** 结果消息类型（与服务器约定一致）。 */
export const MESSAGE_TYPE_USER_INFO = 'sso-info:user-info'
/** 失败消息类型（与服务器约定一致）。 */
export const MESSAGE_TYPE_ERROR = 'sso-info:error'

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

const DEFAULT_POPUP_FEATURES =
  'popup=yes,width=520,height=720,left=240,top=80,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes'

interface SSOGlobal {
  __SSO_INFO_CONFIG__?: SSOOptions
}

/** 通过 configureSSO 设置的运行时配置。 */
let runtimeConfig: SSOOptions = {}

/**
 * 设置全局默认配置；多次调用会合并，后设置的字段覆盖先设置的字段。
 * 调用时不需要等待，{@link getUserInfoSSO} 会同步读取该配置。
 */
export function configureSSO(options: SSOOptions): void {
  runtimeConfig = { ...runtimeConfig, ...omitUndefined(options) }
}

/** 当前环境是否支持弹出窗口登录。 */
export function isSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.open === 'function' &&
    typeof window.addEventListener === 'function' &&
    typeof document !== 'undefined'
  )
}

/**
 * 拉起 OIDC 登录窗口，返回登录用户信息。
 *
 * 必须在用户手势的同步调用栈中触发（例如 click 处理器里直接调用），否则弹出窗口会被浏览器拦截。
 */
export function getUserInfoSSO(options: SSOOptions = {}): Promise<UserInfo> {
  try {
    return startSSO(options)
  } catch (error) {
    return Promise.reject(toSSOError(error))
  }
}

function startSSO(options: SSOOptions): Promise<UserInfo> {
  if (!isSupported()) {
    throw new SSOError('unsupported', '当前环境不支持 window.open / postMessage，无法使用 SSO 弹窗登录')
  }

  const config = resolveConfig(options)
  const origin = window.location.origin
  if (!origin || origin === 'null') {
    throw new SSOError('invalid_origin', '当前页面没有有效的 origin（file:// 或沙箱 iframe），SSO 弹窗不可用；请通过 http(s) 访问调用页面')
  }

  const serverOrigin = new URL(config.serverUrl).origin
  const nonce = randomToken()
  const authorizeUrl = buildAuthorizeUrl(config.serverUrl, { origin, nonce })

  let popup: Window | null
  try {
    // 注意：不能加 noopener，否则拿不到 window.opener，也就收不到回传消息。
    popup = window.open(authorizeUrl, `sso-info-${nonce}`, config.popupFeatures)
  } catch {
    throw new SSOError('popup_blocked', '无法打开登录窗口，请检查浏览器弹窗拦截设置')
  }

  if (!popup) {
    throw new SSOError(
      'popup_blocked',
      '登录窗口被浏览器拦截：getUserInfoSSO() 必须在用户点击事件的同步调用栈中调用'
    )
  }

  const loginWindow: Window = popup
  const timeoutMs = config.timeoutMs

  return new Promise<UserInfo>((resolve, reject) => {
    let settled = false
    let pollTimer = 0
    let timeoutTimer = 0

    function closePopup(): void {
      try {
        if (!loginWindow.closed) loginWindow.close()
      } catch {
        /* 关闭失败无需处理 */
      }
    }

    function cleanup(): void {
      window.removeEventListener('message', onMessage)
      if (pollTimer !== 0) {
        window.clearInterval(pollTimer)
        pollTimer = 0
      }
      if (timeoutTimer !== 0) {
        window.clearTimeout(timeoutTimer)
        timeoutTimer = 0
      }
    }

    function succeed(user: UserInfo): void {
      if (settled) return
      settled = true
      cleanup()
      closePopup()
      resolve(user)
    }

    function fail(error: SSOError): void {
      if (settled) return
      settled = true
      cleanup()
      closePopup()
      reject(error)
    }

    function onMessage(event: MessageEvent): void {
      // 只接受来自 SSO 服务器 origin 的消息
      if (event.origin !== serverOrigin) return
      // 只接受自己打开的那个窗口发来的消息
      if (toWindow(event.source) !== loginWindow) return

      const data: unknown = event.data
      if (!isRecord(data)) return
      if (data['nonce'] !== nonce) return

      const type = data['type']
      if (type === MESSAGE_TYPE_USER_INFO) {
        const user = parseUserInfo(data['user'])
        if (!user) {
          fail(new SSOError('server_error', 'SSO 服务器返回的用户信息格式不正确'))
          return
        }
        succeed(user)
        return
      }

      if (type === MESSAGE_TYPE_ERROR) {
        const code = typeof data['code'] === 'string' && data['code'] !== '' ? data['code'] : 'server_error'
        const message =
          typeof data['message'] === 'string' && data['message'] !== ''
            ? data['message']
            : `OIDC 登录失败（${code}）`
        fail(new SSOError(code === 'access_denied' ? 'access_denied' : 'server_error', message))
      }
    }

    window.addEventListener('message', onMessage)

    // 用户手动关闭窗口时尽快失败：留一点时间让已经发出但尚未派发的 message 先到达。
    pollTimer = window.setInterval(() => {
      if (!loginWindow.closed) return
      window.clearInterval(pollTimer)
      pollTimer = 0
      window.setTimeout(() => {
        fail(new SSOError('popup_closed', '登录窗口已被关闭，OIDC 登录未完成'))
      }, 500)
    }, 400)

    timeoutTimer = window.setTimeout(() => {
      fail(new SSOError('timeout', `OIDC 登录超时（${timeoutMs}ms）`))
    }, timeoutMs)
  })
}

function resolveConfig(options: SSOOptions): SSOConfig {
  const merged: SSOOptions = { ...readInlineConfig(), ...runtimeConfig, ...omitUndefined(options) }

  const serverUrl = typeof merged.serverUrl === 'string' ? merged.serverUrl.trim() : ''
  if (serverUrl === '') {
    throw new SSOError(
      'config_invalid',
      '缺少 serverUrl：请先调用 configureSSO({ serverUrl })，或在 <script data-sso-server="https://..."> 上声明'
    )
  }

  let parsed: URL
  try {
    parsed = new URL(serverUrl)
  } catch {
    throw new SSOError('config_invalid', `serverUrl 不是合法的绝对地址：${serverUrl}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SSOError('config_invalid', 'serverUrl 必须以 http:// 或 https:// 开头')
  }

  const timeoutMs =
    typeof merged.timeoutMs === 'number' && Number.isFinite(merged.timeoutMs) && merged.timeoutMs > 0
      ? merged.timeoutMs
      : DEFAULT_TIMEOUT_MS

  const popupFeatures =
    typeof merged.popupFeatures === 'string' && merged.popupFeatures !== ''
      ? merged.popupFeatures
      : DEFAULT_POPUP_FEATURES

  return { serverUrl: stripTrailingSlash(serverUrl), timeoutMs, popupFeatures }
}

/** 支持三种配置来源：data-* 属性、globalThis.__SSO_INFO_CONFIG__、configureSSO()。 */
function readInlineConfig(): SSOOptions {
  const config: SSOOptions = {}

  const globalConfig = (globalThis as unknown as SSOGlobal).__SSO_INFO_CONFIG__
  if (globalConfig !== undefined && globalConfig !== null) {
    Object.assign(config, omitUndefined(globalConfig))
  }

  if (typeof document !== 'undefined') {
    const element = document.querySelector('script[data-sso-server]')
    if (element !== null) {
      const serverUrl = element.getAttribute('data-sso-server')
      if (serverUrl !== null && serverUrl !== '') config.serverUrl = serverUrl
    }
  }

  return config
}

function buildAuthorizeUrl(serverUrl: string, params: { origin: string; nonce: string }): string {
  const url = new URL(`${serverUrl}/authorize`)
  url.searchParams.set('origin', params.origin)
  url.searchParams.set('nonce', params.nonce)
  return url.toString()
}

function parseUserInfo(value: unknown): UserInfo | null {
  if (!isRecord(value)) return null
  const username = typeof value['username'] === 'string' ? value['username'].trim() : ''
  if (username === '') return null
  const rawPreferName = typeof value['preferName'] === 'string' ? value['preferName'].trim() : ''
  const avatar = typeof value['avatar'] === 'string' ? value['avatar'] : ''
  return { username, preferName: rawPreferName === '' ? username : rawPreferName, avatar }
}

function omitUndefined(options: SSOOptions): SSOOptions {
  const result: SSOOptions = {}
  if (options.serverUrl !== undefined) result.serverUrl = options.serverUrl
  if (options.timeoutMs !== undefined) result.timeoutMs = options.timeoutMs
  if (options.popupFeatures !== undefined) result.popupFeatures = options.popupFeatures
  return result
}

function randomToken(): string {
  const bytes = new Uint8Array(16)
  const webCrypto = globalThis.crypto
  if (webCrypto !== undefined && typeof webCrypto.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  let token = ''
  for (const byte of bytes) token += byte.toString(16).padStart(2, '0')
  return `${Date.now().toString(36)}-${token}`
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toWindow(source: MessageEventSource | null): Window | null {
  if (source === null) return null
  if (typeof (source as Window).closed === 'boolean') return source as unknown as Window
  return null
}

function toSSOError(error: unknown): SSOError {
  if (error instanceof SSOError) return error
  if (error instanceof Error) return new SSOError('server_error', error.message)
  return new SSOError('server_error', String(error))
}
