/**
 * AStudio（星辰 Agent Studio）的上游地址与固定常量。
 *
 * 版本号参与服务端门控：模型目录在 3.4.4 只返回 7 条，3.6.0 起返回 8 条，
 * 更高的版本不再增加。所以请求头里的 studioVersion / User-Agent 必须与官方
 * 桌面端一致，否则目录会被裁掉。
 */
/**
 * 插件自己的 provider 身份。
 *
 * ── 为什么可以直接用 astudio ─────────────────────────────────
 * 脚本插件不能占用「已经有执行体申报过的 id」（script/runtime.rs:290-297 的 reserved
 * 集合来自 native_owners + 所有 Supported(wasm) 包的 declared_ids）。astudio 本来被
 * wasm 包 agent2api-wasm-astudio 占着，所以早先只能叫 astudio-zp；那个包卸载之后
 * astudio 就空了 —— 它既不在 core::providers::PROVIDERS 里，也不在
 * BUILTIN_SUBSCRIPTION_IDS 里，旧原生包 agent2api-providers 是 Legacy 状态、
 * 按 ownership.rs:59-61 直接跳过。于是插件可以正当地接管 astudio：
 * 库里 4 个老账号（provider=astudio）继续归这张卡，面板只剩一张。
 *
 * provider id 必须与申报的 id 完全一致，否则 loader.mjs:95 会给名字追加「 · Magpie」。
 */
export const PROVIDER_ID = "astudio";
export const PROVIDER_NAME = "AStudio · zp";

export const STUDIO_VERSION = "3.6.0";
export const USER_AGENT = `AStudio/${STUDIO_VERSION}`;

/** 账号面（Cookie 会话 + {flag, code, desc, data} 信封）。 */
export const STUDIO_BASE = "https://agent.xfyun.cn/xingchen-studio/";
export const AUTH_BEARER_TOKEN = "auth/bearer-token";
export const USER_INFO = "userInfo";
export const POINTS_BALANCE = "points/balance";
export const MEMBERSHIP_ME = "membership/me";
export const PLAN_CONFIG = "membership/plan-config";
export const INIT_APP = "tenant-app/v2/init-app";
export const MODEL_CONFIGS = "bot/models/configs";

/** 模型面（Bearer token）。 */
export const GATEWAY_BASE = "https://astronstudio-api-volces-prod.xf-yun.com";
export const API_BASE = `${GATEWAY_BASE}/model-gateway/v1`;
export const RESPONSES_URL = `${API_BASE}/responses`;
export const MODEL_MANAGER_URL = `${GATEWAY_BASE}/api/v1/model-manager/models`;
export const NPM = "@ai-sdk/openai";

/** 微信扫码登录（SSO）。 */
export const SSO_BASE = "https://sso.xfyun.cn";
export const SCAN_QRCODE = "/SSOService/wx/scanlogin/qrcode";
export const SCAN_UIDS = "/SSOService/wx/scanlogin/uids";
export const SCAN_SESSION_LEN = 8;
export const QR_TTL_MS = 60_000;
export const POLL_INTERVAL_MS = 2_000;

/** 模型凭据的本地有效期：到期由 hooks.auth.refresh 用 Cookie 会话重铸。 */
export const TOKEN_TTL_MS = 30 * 60_000;
/** 账号 secret 里的标记，说明 access 可以由会话重铸。 */
export const REFRESH_MARK = "astudio-sso";
/** 签到前后读余额的间隔（上游是异步发积分）。 */
export const CHECKIN_REWARD_WAIT_MS = 2_500;
/** 平台目录回落时使用的模型清单。 */
export const DEFAULT_MODEL = "astronclaw-auto";
