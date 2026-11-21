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
import { checkinReport } from "./lib/checkin.mjs";
import { desktopHeaders, describe } from "./lib/http.mjs";
import { upgradeLegacy } from "./lib/legacy.mjs";
import { authorizeScan, authorizeToken } from "./lib/login.mjs";
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
    type: "api",
    label: "粘贴模型凭据",
    instructions: "从浏览器里复制 AStudio 的 modelBearerToken（Bearer Token）。这条只用于临时救急：没有网页会话，余额与签到读不到。",
    prompts: [
      { key: "key", label: "modelBearerToken", placeholder: "粘贴 modelBearerToken", secret: true },
    ],
    authorize: authorizeToken,
  },
];

export async function AStudioPlugin({ client } = {}) {
  const log = (message, level = "info") => {
    Promise.resolve(client?.app?.log?.({ message, level })).catch(() => {});
  };

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
