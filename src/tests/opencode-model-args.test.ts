import test from "node:test";
import assert from "node:assert/strict";
import { toOpencodeBodyModel } from "../adapters/opencode/model-args.js";

test("toOpencodeBodyModel converts canonical provider/model to opencode body model", () => {
  assert.deepEqual(toOpencodeBodyModel("openai-codex/gpt-5.5"), {
    providerID: "openai-codex",
    modelID: "gpt-5.5",
  });
  assert.deepEqual(toOpencodeBodyModel("custom/provider/model"), {
    providerID: "custom",
    modelID: "provider/model",
  });
});

test("toOpencodeBodyModel trims empty values and preserves legacy unqualified ids", () => {
  assert.equal(toOpencodeBodyModel(undefined), undefined);
  assert.equal(toOpencodeBodyModel("   "), undefined);
  assert.deepEqual(toOpencodeBodyModel("gpt-5.5"), {
    providerID: "gpt-5.5",
    modelID: "gpt-5.5",
  });
});
