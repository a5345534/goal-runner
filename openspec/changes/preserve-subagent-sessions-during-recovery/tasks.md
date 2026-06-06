## 1. Planning
- [x] Confirm scope and affected capabilities
- [x] Confirm project policy overlay assumptions

## 2. Implementation
- [x] Add quota/provider-limit error classification
- [x] Prefer same-session recovery prompts for transient subagent errors
- [x] Prefer same-session diagnostic recovery for unknown subagent errors
- [x] Convert quota/provider-limit errors to blocked resource diagnostics instead of failed nodes
- [x] Preserve context fallback as last-resort larger-model replacement only

## 3. Validation
- [x] Add controller tests for same-session transient recovery
- [x] Add controller tests for unknown-error diagnostic recovery
- [x] Add controller tests for quota blocked classification
- [x] Run `npm run check`
- [x] Rebuild `source-manifest.json`
- [x] Generate and validate explainer
- [x] Run archive preflight

## 4. Follow-up backlog
- [ ] [BACKLOG] Add model-catalog fallback chains for quota/provider outage recovery
- [ ] [BACKLOG] Add explicit attempt/error records so `failed` can be retired from DAG node terminal semantics
