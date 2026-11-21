/**
 * 手机验证码登录的「发短信」半步。
 *
 * ── 分工 ───────────────────────────────────────────────────
 * 极验滑块由**面板**渲染（宿主侧补丁 host-patch/astudio-qr-modal.js）：AStudio 的接口
 * CORS 全开，chat/gee-captcha 可以直连；极验 v4 只按 document.referrer 判定来源，
 * 页内伪造即可通过。用户拖完滑块，面板把极验三件作为 start 的 inputs.captcha 交进来，
 * 这里只负责带上它去发短信 —— 网络请求仍然由插件进程发出，和后面的
 * phone-quick-login 同一个出口 IP，不会出现「发码 IP 与登录 IP 不一致」。
 */
import { SEND_VERIFY_CODE } from "./endpoints.mjs";
import { describe, failed, studioUpload, text } from "./http.mjs";

/** 极验三件：面板拖完滑块拿到的那份 {geetest_challenge, geetest_validate, geetest_seccode}。 */
export function captchaOf(inputs) {
  const raw = inputs?.captcha;
  let source = raw;
  if (typeof raw === "string") {
    try {
      source = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const challenge = text(source.geetest_challenge);
  const validate = text(source.geetest_validate);
  const seccode = text(source.geetest_seccode);
  if (!challenge || !validate || !seccode) return null;
  return { challenge, validate, seccode };
}

/** 18122032590 → 181****2590（提示里不写全号）。 */
export function maskPhone(mobile) {
  const value = text(mobile);
  if (value.length < 7) return value;
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function base64(value) {
  if (typeof Buffer !== "undefined") return Buffer.from(value, "utf8").toString("base64");
  /* 兜底：运行环境没有 Buffer 时手搓 UTF-8 → base64（seccode 是 ASCII，够用） */
  return btoa(unescape(encodeURIComponent(value)));
}

/** 上游的拒绝理由翻成用户能动手改的话。 */
function sendFailure(error) {
  const message = describe(error);
  if (/geetest/i.test(message)) {
    return failed(`滑块校验没通过，请重新拖一次（${message}）`);
  }
  if (/参数无效/.test(message)) {
    return failed(`滑块结果已失效，请重新拖一次（${message}）`);
  }
  return error;
}

/**
 * 用面板交上来的极验结果给这个手机号发一条短信验证码。
 * 成功即「短信已发出」；失败抛 StudioError，由调用方转成 authorize 的 failed。
 */
export async function sendSmsCode(phone, captcha, { signal } = {}) {
  try {
    await studioUpload(SEND_VERIFY_CODE, {
      geetest_challenge: captcha.challenge,
      geetest_validate: captcha.validate,
      // 官方客户端对 seccode 先 base64 再发，这里保持一致
      geetest_seccode: base64(captcha.seccode),
      mobile: phone.mobile,
      countryCode: phone.countryCode,
    }, { operation: "发送短信验证码", signal, allowEmpty: true });
  } catch (error) {
    throw sendFailure(error);
  }
}
