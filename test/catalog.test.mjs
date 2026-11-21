import assert from "node:assert/strict";
import test from "node:test";

import {
  catalogRows, directoryKey, directoryRows, fallbackRecords, mergeModels, resolveModel,
} from "../lib/catalog.mjs";

const catalog = {
  data: {
    models: [
      {
        slug: "spark-x2.6", display_name: "Spark-X2.6", supported_in_api: true,
        metadata: { context_window: 262144, max_output_tokens: 32768, input_modalities: ["text", "image"],
          supported_reasoning_levels: [{ effort: "none" }, { effort: "high" }], badge: { text: { en: "Free" } } },
      },
      { slug: "xopglm52", display_name: "GLM-5.2", metadata: { context_window: 1048576 } },
      { slug: "hidden-model", display_name: "Hidden", visibility: "hidden" },
      { slug: "web-only", display_name: "WebOnly", supported_in_api: false },
      { slug: "astronclaw-auto", display_name: "Auto" },
    ],
  },
};

test("directory rows tolerate the shapes the api returns", () => {
  assert.deepEqual(directoryRows({ data: [{ model: "a" }] }), [{ model: "a" }]);
  assert.deepEqual(directoryRows({ data: { list: [{ model: "a" }] } }), [{ model: "a" }]);
  assert.deepEqual(directoryRows({ data: { configs: [{ model: "a" }] } }), [{ model: "a" }]);
  assert.deepEqual(directoryRows({ [0]: 1 }), []);
  assert.equal(catalogRows(catalog).length, 5);
  assert.deepEqual(catalogRows({}), []);
});

test("merge keeps the account directory first and borrows platform metadata", () => {
  const records = mergeModels({
    directory: [
      { id: "lm_1", model: "spark-x2.6", name: "Spark-X2.6", api_key: "k1", is_current: true },
      { id: "lm_2", name: "GLM-5.2" },
    ],
    catalog: catalog.data.models,
  });
  assert.deepEqual(records.map((record) => record.id), ["spark-x2.6", "GLM-5.2", "astronclaw-auto"]);
  const spark = records[0];
  assert.equal(spark.context, 262144);
  assert.equal(spark.output, 32768);
  assert.equal(spark.images, true);
  assert.equal(spark.reasoning, true);
  assert.deepEqual(spark.levels, [{ effort: "high" }]);
  assert.equal(spark.free, true);
  assert.equal(spark.directoryId, "lm_1");
  assert.equal(spark.isDefault, false);
  assert.equal(records[2].isDefault, true);
});

test("merge skips hidden and non api models", () => {
  const ids = mergeModels({ catalog: catalog.data.models }).map((record) => record.id);
  assert.ok(!ids.includes("hidden-model"));
  assert.ok(!ids.includes("web-only"));
});

test("merge dedupes by slug and by display name", () => {
  const records = mergeModels({
    directory: [{ model: "glm-5.2", name: "GLM-5.2" }],
    catalog: catalog.data.models,
  });
  assert.deepEqual(records.map((record) => record.id), ["glm-5.2", "spark-x2.6", "astronclaw-auto"]);
});

test("directory key prefers current then default then first", () => {
  assert.equal(directoryKey([{ api_key: "a" }, { api_key: "b", is_default: true }, { api_key: "c", is_current: true }]), "c");
  assert.equal(directoryKey([{ api_key: "a" }, { api_key: "b", is_default: true }]), "b");
  assert.equal(directoryKey([{ api_key: "a" }]), "a");
  assert.equal(directoryKey([]), "");
  assert.equal(directoryKey(null), "");
});

test("resolve model matches id, name and directory id", () => {
  const records = mergeModels({ directory: [{ id: "lm_9", model: "spark-x2.6", name: "Spark-X2.6" }], catalog: catalog.data.models });
  assert.equal(resolveModel(records, ""), "astronclaw-auto");
  assert.equal(resolveModel(records, "SPARK-X2.6"), "spark-x2.6");
  assert.equal(resolveModel(records, "spark-x2.6"), "spark-x2.6");
  assert.equal(resolveModel(records, "lm_9"), "spark-x2.6");
  assert.equal(resolveModel(records, "unknown-model"), "unknown-model");
});

test("fallback list mirrors the official catalog", () => {
  const records = fallbackRecords();
  assert.equal(records.length, 7);
  assert.deepEqual(records.map((record) => record.id), [
    "astronclaw-auto", "spark-x2.6", "spark-x2.6-4b", "spark-x2.5",
    "xopglm52", "xopdeepseekv4pro0813", "xopdsv4flash0731in",
  ]);
  const free = records.find((record) => record.id === "spark-x2.6-4b");
  assert.equal(free.free, true);
  assert.equal(free.output, 110000);
});
