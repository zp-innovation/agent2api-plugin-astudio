/**
 * 模型目录与 provider 配置。
 *
 * 目录由两份来源合并：账号目录（这个账号能用什么）+ 平台目录（模型元数据）。
 * 两份都拿不到时用官方 fallback 清单兜底，并打上 magpie.fellBack 标记，
 * 让宿主保留已有模型清单而不是把目录清空。
 */
import { API_BASE, MODEL_CONFIGS, NPM, PROVIDER_ID, PROVIDER_NAME } from "./endpoints.mjs";
import {
  catalogRows, directoryRows, fallbackRecords, mergeModels,
} from "./catalog.mjs";
import { fetchCatalog, studioJson } from "./http.mjs";
import { keyOf, sessionOf } from "./session.mjs";

function runtimeModel(record) {
  const images = record.images === true;
  const input = images ? ["text", "image"] : ["text"];
  return {
    id: record.id,
    providerID: PROVIDER_ID,
    name: record.name,
    api: { id: record.id, url: API_BASE, npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: record.context || 0, output: record.output || 32_768 },
    tool_call: record.toolCall !== false,
    reasoning: record.reasoning === true,
    modalities: { input, output: ["text"] },
    capabilities: {
      temperature: true,
      toolcall: record.toolCall !== false,
      reasoning: record.reasoning === true,
      attachment: images,
      input: { text: true, image: images, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    free: record.free === true,
    release_date: "",
  };
}

function configModel(record) {
  const images = record.images === true;
  return {
    name: record.name,
    limit: { context: record.context || 0, output: record.output || 32_768 },
    tool_call: record.toolCall !== false,
    reasoning: record.reasoning === true,
    modalities: { input: images ? ["text", "image"] : ["text"], output: ["text"] },
    capabilities: {
      temperature: true,
      toolcall: record.toolCall !== false,
      reasoning: record.reasoning === true,
      attachment: images,
      input: { text: true, image: images, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
  };
}

async function collect(auth, { signal } = {}) {
  const key = keyOf(auth);
  const session = sessionOf(auth);
  let directory = [];
  let catalog = [];
  let confirmed = false;
  if (session && session.accountId) {
    try {
      directory = directoryRows(await studioJson(session, MODEL_CONFIGS, { operation: "读取 AStudio 账号模型目录", signal }));
      confirmed = true;
    } catch {
      /* 账号目录读不到时用平台目录补齐 */
    }
  }
  if (key) {
    try {
      catalog = catalogRows(await fetchCatalog(key, { signal }));
      confirmed = true;
    } catch {
      /* 平台目录读不到时保留账号目录 */
    }
  }
  const records = mergeModels({ directory, catalog });
  if (records.length) return { records, confirmed };
  return { records: fallbackRecords(), confirmed: false };
}

export async function modelCatalog(_info, { auth, signal } = {}) {
  const { records, confirmed } = await collect(auth, { signal });
  const models = {};
  for (const record of records) models[record.id] = runtimeModel(record);
  if (!confirmed) models[Symbol.for("magpie.fellBack")] = true;
  return models;
}

/** 兜底清单同时写进 provider 配置，保证任何时刻面板都有模型可选。 */
export function pluginConfig(configuration) {
  if (!configuration || typeof configuration !== "object") return;
  if (!configuration.provider || typeof configuration.provider !== "object") configuration.provider = {};
  const current = configuration.provider[PROVIDER_ID];
  const was = current && typeof current === "object" ? current : {};
  const models = { ...(was.models && typeof was.models === "object" ? was.models : {}) };
  for (const record of fallbackRecords()) {
    if (!models[record.id]) models[record.id] = configModel(record);
  }
  configuration.provider[PROVIDER_ID] = {
    name: PROVIDER_NAME,
    npm: NPM,
    api: API_BASE,
    ...was,
    models,
  };
}

export { runtimeModel, configModel };
