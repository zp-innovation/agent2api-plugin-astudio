/**
 * 两份模型来源：
 *  - 账号目录（bot/models/configs）：这个账号能用哪些模型，带 api_key 与 is_current
 *  - 平台目录（model-manager）：模型元数据（上下文、输出上限、图片输入、思考档位、Free 标记）
 * 合并规则与官方实现一致：账号目录在前，平台目录按 slug / display_name 去重后追加。
 */
import { DEFAULT_MODEL } from "./endpoints.mjs";
import { scalar, text } from "./http.mjs";

export function directoryRows(payload) {
  const data = payload?.data ?? payload;
  if (Array.isArray(data)) return data;
  for (const key of ["list", "models", "configs", "items"]) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

export function catalogRows(payload) {
  const rows = payload?.data?.models;
  return Array.isArray(rows) ? rows : [];
}

export function catalogUsable(row) {
  if (!row || typeof row !== "object") return false;
  if (!text(row.slug)) return false;
  if (row.supported_in_api === false) return false;
  if (row.visibility === "hidden") return false;
  return true;
}

/** 平台目录行的元数据可能嵌在 metadata 里，摊平后再读。 */
function flatten(row) {
  const meta = row?.metadata;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return row ?? {};
  return { ...meta, ...row };
}

export function reasoningLevels(meta) {
  const levels = Array.isArray(meta?.supported_reasoning_levels) ? meta.supported_reasoning_levels : [];
  return levels.filter((level) => typeof level?.effort === "string" && level.effort && level.effort !== "none");
}

function modelRecord({ id, name, meta, entry, isDefault }) {
  const source = meta ? flatten(meta) : {};
  const context = Number.isFinite(source.context_window) && source.context_window > 0 ? source.context_window : 0;
  const output = Number.isFinite(source.max_output_tokens) && source.max_output_tokens > 0 ? source.max_output_tokens : 32_768;
  const levels = reasoningLevels(source);
  const modalities = Array.isArray(source.input_modalities) ? source.input_modalities : [];
  const record = {
    id,
    name: name || id,
    context,
    output,
    toolCall: true,
    reasoning: levels.length > 0,
    levels,
    images: modalities.some((item) => item === "image"),
    free: source?.badge?.text?.en === "Free",
    isDefault: isDefault === true,
  };
  const provider = text(entry?.provider) || text(source.provider);
  if (provider) record.provider = provider;
  const directoryId = text(entry?.id);
  if (directoryId) record.directoryId = directoryId;
  return record;
}

export function mergeModels({ directory = [], catalog = [] } = {}) {
  const usable = (Array.isArray(catalog) ? catalog : []).filter(catalogUsable);
  const bySlug = new Map();
  const byName = new Map();
  for (const row of usable) {
    const slug = text(row.slug).toLowerCase();
    if (!bySlug.has(slug)) bySlug.set(slug, row);
    const name = text(row.display_name).toLowerCase();
    if (name && !byName.has(name)) byName.set(name, row);
  }
  const records = [];
  const seenId = new Set();
  const seenName = new Set();
  for (const entry of Array.isArray(directory) ? directory : []) {
    if (!entry || typeof entry !== "object") continue;
    const slug = text(entry.model) || text(entry.name);
    if (!slug) continue;
    const lower = slug.toLowerCase();
    const name = text(entry.name) || slug;
    if (seenId.has(lower)) continue;
    const meta = bySlug.get(lower) ?? byName.get(name.toLowerCase()) ?? null;
    records.push(modelRecord({ id: slug, name, meta, entry, isDefault: entry.is_default === true || lower === DEFAULT_MODEL }));
    seenId.add(lower);
    seenName.add(name.toLowerCase());
  }
  for (const row of usable) {
    const slug = text(row.slug);
    const lower = slug.toLowerCase();
    const name = text(row.display_name) || slug;
    if (seenId.has(lower) || seenName.has(name.toLowerCase())) continue;
    records.push(modelRecord({ id: slug, name, meta: row, entry: null, isDefault: lower === DEFAULT_MODEL }));
    seenId.add(lower);
    seenName.add(name.toLowerCase());
  }
  return records;
}

/** 账号目录里挑一条模型的凭据：is_current → is_default → 第一条。 */
export function directoryKey(rows) {
  const list = Array.isArray(rows) ? rows.filter((row) => row && typeof row === "object") : [];
  const pick = list.find((row) => row.is_current === true)
    ?? list.find((row) => row.is_default === true)
    ?? list[0];
  return text(pick?.api_key);
}

export function resolveModel(records, requested) {
  const wanted = text(requested);
  if (!wanted) return DEFAULT_MODEL;
  const lower = wanted.toLowerCase();
  const byId = records.find((record) => record.id.toLowerCase() === lower);
  if (byId) return byId.id;
  const byName = records.find((record) => record.name.toLowerCase() === lower);
  if (byName) return byName.id;
  const byDirectory = records.find((record) => (record.directoryId ?? "").toLowerCase() === lower);
  if (byDirectory) return byDirectory.id;
  return wanted;
}

/** 上游目录拿不到时的兜底清单（与官方 fallback_models 一致）。 */
export function fallbackRecords() {
  return [
    ["astronclaw-auto", "Auto", 262_144, 32_768, false],
    ["spark-x2.6", "Spark-X2.6", 262_144, 32_768, false],
    ["spark-x2.6-4b", "Spark-X2.6-Lite", 1_048_576, 110_000, true],
    ["spark-x2.5", "Spark-X2.5", 262_144, 32_768, false],
    ["xopglm52", "GLM-5.2", 1_048_576, 32_768, false],
    ["xopdeepseekv4pro0813", "DeepSeek-V4-Pro", 1_048_576, 32_768, false],
    ["xopdsv4flash0731in", "DeepSeek-V4-Flash", 1_048_576, 32_768, false],
  ].map(([id, name, context, output, free]) => ({
    id, name, context, output, toolCall: true, reasoning: false, levels: [], images: false, free,
    isDefault: id === DEFAULT_MODEL,
  }));
}

/** 余额里的数字字段可能是字符串。 */
export function numberOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export { scalar, text };
