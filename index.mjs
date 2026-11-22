/**
 * AStudio（星辰 Agent Studio）插件入口。
 *
 * 宿主的 entries.mjs:30 会把**每个导出函数**都当候选调用一次（candidate(input, options)），
 * 任何一个抛错都会让整个包加载失败，所以工具函数一律放在 lib/ 下，这里只导出插件工厂。
 *
 * 账号形态：oauth 型。access = modelBearerToken（对话用），session = 账号面 Cookie 会话
 * （余额/签到/目录/换凭据用）。凭据到期由 hooks.auth.refresh 用会话重铸，不必重新扫码。
 */
import { ICON } from "./icon.mjs";
import { API_BASE, PROVIDER_ID } from "./lib/endpoints.mjs";
import { describe } from "./lib/http.mjs";
import { checkinReport } from "./lib/checkin.mjs";
import { desktopHeaders } from "./lib/http.mjs";
import { upgradeLegacy } from "./lib/legacy.mjs";
import {
  authorizeCredential, authorizeLocal, authorizeScan, authorizeSms, authorizeToken, useLoginLogger,
} from "./lib/login.mjs";
import { modelCatalog, pluginConfig } from "./lib/provider.mjs";
import { keyOf, renew } from "./lib/session.mjs";
import { usageReport } from "./lib/usage.mjs";

const METHODS = [
  {
    type: "oauth",
    label: "微信扫码登录",
    instructions: "界面会显示一张二维码图片：用微信扫码并在手机上确认即可。二维码 60 秒内有效，过期请取消这次登录再重新发起。",
    prompts: [],
    browserMode: "plugin",
    embeddedOnly: true,
    localOnly: false,
    manualCallback: false,
    callbackInput: "url",
    authorize: authorizeScan,
  },
  {
    type: "oauth",
    label: "手机验证码登录",
    instructions: "用手机号 + 短信验证码登录。装了面板补丁（host-patch/astudio-sms-login.js）时全在面板里完成：点「登录并添加」→ 面板弹框确认手机号 → 点「获取验证码」→ 拖动滑块 → 短信到了把 4-8 位数字填进面板的输入框 → 完成。没有补丁时会打开 AStudio 网页（studio-portal/overview）：填手机号 → 勾选「已同意《服务协议》和《隐私协议》」→ 点「获取验证码」并拖动滑块 → 把验证码粘回面板（提示写着「粘贴授权令牌或 code」，填验证码就行，不用在网页上点登录）。上游发码强制极验滑块，滑块画在面板里还是网页里取决于补丁在不在，拿到码之后的登录都由插件完成。",
    prompts: [
      { key: "mobile", label: "手机号", placeholder: "18122032590", secret: false },
    ],
    browserMode: "external",
    embeddedOnly: false,
    localOnly: false,
    manualCallback: true,
    callbackInput: "code",
    // 为什么要有一个「什么都不问」的 ask：宿主 api/session.rs:405 只对「动态表单」方法放行
    // 未申报的字段，而动态表单的判定在 host/login.mjs:22 —— typeof method.ask === "function"。
    // 面板补丁会把极验滑块的三件套塞进 inputs.captcha，没有这个标记就会被 400
    // 「inputs 包含未申报的字段或非字符串值」挡回来。返回 null 时 resolvePrompts 不追加字段
    // （login-prompts.mjs:59），所以面板上仍然只有 prompts 里那一个手机号输入框。
    ask: () => null,
    authorize: authorizeSms,
  },
  {
    type: "api",
    label: "粘贴模型凭据",
    instructions: "从浏览器里复制 AStudio 的 modelBearerToken（Bearer Token）。这条只用于临时救急：没有网页会话，余额与签到读不到。",
    prompts: [
      { key: "key", label: "modelBearerToken", placeholder: "粘贴 modelBearerToken", secret: true },
    ],
    authorize: authorizeToken,
  },
  {
    type: "oauth",
    label: "导入凭据 JSON",
    instructions: "粘贴一段凭据：含 ssoSessionId / account_id 的 JSON（AStudio 客户端的登录态）、{\"modelBearerToken\": \"…\"}，或直接粘 Cookie 串（ssoSessionId=…; account_id=…）。有会话时会先换一次模型凭据来验证会话是否还有效。",
    prompts: [
      { key: "json", label: "凭据 JSON 或 Cookie", placeholder: '{"ssoSessionId":"…","account_id":"…"}', secret: false },
    ],
    browserMode: "none",
    embeddedOnly: false,
    localOnly: false,
    authorize: authorizeCredential,
  },
  {
    type: "oauth",
    label: "导入本机登录态",
    instructions: "填网关这台电脑上 AStudio 客户端的会话文件路径（填目录也行，插件会在两层内找出认得出的那个文件）。跨机部署时网关本机没有这个文件，请改用「导入凭据 JSON」粘贴。",
    prompts: [
      { key: "path", label: "本机会话文件或目录", placeholder: "C:\\Users\\Administrator\\AppData\\Roaming\\AStudio", secret: false },
    ],
    browserMode: "none",
    embeddedOnly: false,
    localOnly: false,
    authorize: authorizeLocal,
  },
];

export async function AStudioPlugin({ client } = {}) {
  const log = (message, level = "info") => {
    Promise.resolve(client?.app?.log?.({ message, level })).catch(() => {});
  };
  useLoginLogger(log);

  /** 对话出网时注入 Bearer 与 AStudio 的身份头（版本头参与服务端门控）。 */
  const loader = async (readAuth) => {
    const auth = await readAuth();
    return {
      apiKey: keyOf(auth),
      baseURL: API_BASE,
      headers: desktopHeaders(),
    };
  };

  /**
   * wasm 包时代落盘的凭据是 api 型（没有 refresh/expires），宿主的 401 自动续期只认
   * oauth 型，所以趁一次读数把它们补成 oauth 型：先用会话换一次新凭据（顺带验证会话
   * 还活着），换到了才改形状。失败不影响这次读数，也不再反复重试。
   */
  const upgrade = (auth) => {
    void upgradeLegacy(auth, {
      save: (next) => client?.auth?.set?.({ id: PROVIDER_ID, body: next }),
      log: (message) => log(message, "info"),
    }).catch((error) => log(`AStudio 凭据升级失败：${describe(error)}`, "warn"));
  };

  const usage = async (readAuth) => {
    try {
      const auth = await readAuth();
      upgrade(auth);
            return await usageReport(auth);
    } catch (error) {
      // reports.mjs:29 —— 只有 signIn 或「有 error 又读不到任何读数」才会抛错染红整列；
      // 带上 plan 就能把它降级成 warnings 里的一条提示。
      return { plan: "AStudio", windows: [], ...(error?.signIn ? { signIn: error.signIn } : {}), error: describe(error) };
    }
  };

  const checkin = async (readAuth) => {
    try {
      return await checkinReport(await readAuth());
    } catch (error) {
      if (error?.signIn) throw error;
      return { outcome: "failed", message: describe(error) };
    }
  };

  return {
    auth: {
      provider: PROVIDER_ID,
      icon: ICON,
      keepAlive: true,

      // 新镜像的宿主 models.mjs 从 hooks.auth.accountFeatures 取能力门：
      // credit_detail -> accountFeatures.astudio.credit_detail，credit_expiry 同理。
      // 两个门关着时，面板 ui.js 的 jM()/sx() 会跳过 credits[]，即使插件上报了明细也
      // 只会画老的 usage-window-cell；打开后走 WorkBuddy 同款「积分明细」弹层 +
      // 「7天 N」角标 + 每行「X 天后到期」（渲染函数 qOe / NAe / C_ / w7）。
      accountFeatures: { creditDetail: true, creditExpiry: true },
      loader,
      refresh: (auth) => renew(auth),
      usage,
      checkin,
      methods: METHODS,
    },
    config: pluginConfig,
    provider: {
      id: PROVIDER_ID,
      models: modelCatalog,
    },
  };
}
