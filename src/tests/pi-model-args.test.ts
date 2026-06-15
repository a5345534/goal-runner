import test from "node:test";
import assert from "node:assert/strict";
import { normalizePiModelArg } from "../adapters/pi/model-args.js";

test("normalizePiModelArg accepts Pi slash syntax unchanged", () => {
  assert.equal(normalizePiModelArg("openai-codex/gpt-5.5"), "openai-codex/gpt-5.5");
  assert.equal(normalizePiModelArg(" openai-codex/gpt-5.5 "), "openai-codex/gpt-5.5");
});

test("normalizePiModelArg converts known provider dot syntax to Pi slash syntax", () => {
  assert.equal(normalizePiModelArg("openai-codex.gpt-5.5"), "openai-codex/gpt-5.5");
  assert.equal(normalizePiModelArg("deepseek.deepseek-v4-pro"), "deepseek/deepseek-v4-pro");
  assert.equal(normalizePiModelArg("openai-codex.gpt-5.5:xhigh"), "openai-codex/gpt-5.5:xhigh");
});

test("normalizePiModelArg leaves unqualified dotted model ids alone", () => {
  assert.equal(normalizePiModelArg("gpt-5.5"), "gpt-5.5");
  assert.equal(normalizePiModelArg("claude-3.5-sonnet"), "claude-3.5-sonnet");
  assert.equal(normalizePiModelArg(undefined), undefined);
});
