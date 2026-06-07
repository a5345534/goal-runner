## 1. Implementation
- [x] Replace default whole-file Pi subagent session reads with incremental disk parsing
- [x] Skip runtime state mirror lines before JSON parsing where possible
- [x] Preserve `readFile` test override behavior

## 2. Tests
- [x] Add large session/state mirror regression test

## 3. Validation
- [x] Run project check
- [x] Build committed dist artifacts
- [x] Refresh and validate source manifest
