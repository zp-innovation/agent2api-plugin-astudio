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

/**
 * 桌面端推广位（面板左下角「限时每日福利 · 今日可领 100 积分 · 领取」）。
 *
 * ── 为什么签到必须调这两个 ──────────────────────────────────
 * tenant-app/v2/init-app 只记录「今天登录过」，**不发积分**。真正的发放在
 * 推广服务里：待领取列表里有 componentType=DAILY_REWARD_DIALOG 的项（popupCode
 * 实测 DAILY_LOGIN_REWARD_V1，instanceKey 是当天 20261121），对它 POST
 * client-popups/complete {popupId, instanceKey, completed:true} 才会到账。
 * 实测 18122032590：只调 init-app，余额 1300 不变；补一次 complete，2 秒后 1400。
 *
 * 两个接口都要求 clientType + studioVersion 身份头，缺了回
 * {"code":11001001,"desc":"客户端平台、版本或构建号无效"}。
 */
export const CLIENT_POPUPS_PENDING = "client-popups/pending";
export const CLIENT_POPUPS_COMPLETE = "client-popups/complete";

/**
 * 登录接口。
 *
 * ── 发短信为什么要靠面板 ───────────────────────────────────
 * 上游 login/mobile/send-verify-code 与 login/check-account（账号密码）都强制要极验
 * 滑块三件（geetest_challenge / geetest_validate / geetest_seccode），实测不带就回
 * {code:19901001,"参数无效"}、带假值回 {code:20009,"geetest verify failed"}，连 geetest
 * 的离线兜底公式（md5(md5(challenge))+"|jordan"）也被拒。脚本宿主既没有
 * login.captcha.geetest 能力、也不允许在面板里画滑块（宿主只接受 oauth/api 两种 type）。
 *
 * 但滑块**可以在面板自己的页面里画**：AStudio 的接口 CORS 全开（access-control-allow-origin: *），
 * chat/gee-captcha 可以直连；极验 v4 只按 document.referrer 判定来源，页内伪造即可通过。
 * 于是宿主侧补丁（host-patch/astudio-qr-modal.js）在面板里渲染滑块，把极验三件作为
 * inputs.captcha 交进来，插件再用它们发短信 —— 见 lib/sms.mjs。
 *
 * 补丁没装时退回老路：宿主打开 LOGIN_PAGE_URL 让用户自己取码，插件只做 phone-quick-login。
 */
export const GEE_CAPTCHA = "chat/gee-captcha";
export const SEND_VERIFY_CODE = "login/mobile/send-verify-code";
export const QUICK_LOGIN = "login/phone-quick-login";

/**
 * 网页登录页（手机号 + 极验滑块 + 获取验证码都在这里）。
 *
 * ── 为什么是 /studio-portal/overview ────────────────────────
 * 门户是挂在 /studio-portal 下的 SPA（index.html 的入口是 /studio-portal/assets/index-*.js），
 * 路由表里只有 / /overview /studio-price /studio-download … 和一个 "*" 兜底。登录不是一个
 * 独立路由，而是未登录时自动弹出的模态框。所以：
 *   - https://agent.xfyun.cn/login          → 命中 "*" 兜底，渲染「404 页面不存在」+ 官方交流群二维码
 *   - https://agent.xfyun.cn/studio-portal/login → 同上（404）
 *   - https://agent.xfyun.cn/studio-portal/ → 302 → /studio-portal/overview
 *   - https://agent.xfyun.cn/xingchen-studio(/login) → 不是页面，是接口命名空间，直接回
 *     {"code":80000,"desc":"登录异常，请重新登录"}
 * 只有 overview 会把「手机号登录 / 账号登录」模态框弹出来（实测无头渲染出
 * 「请输入手机号」「请输入验证码」「获取验证码」「登录」）。
 *
 * 弹窗里还有一道前置条件：要先勾选「未注册手机号将自动注册账号、勾选代表已同意《服务协议》
 * 和《隐私协议》」，点「获取验证码」才会弹极验滑块；不勾只会显示红字「登录即表示同意相关协议」。
 */
export const LOGIN_PAGE_URL = "https://agent.xfyun.cn/studio-portal/overview";

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
