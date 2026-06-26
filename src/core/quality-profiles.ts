import {
  GOAL_QUALITY_PROFILES,
  isGoalQualityProfile,
  type GoalQualityProfile,
} from "goal-contract";

export { GOAL_QUALITY_PROFILES, isGoalQualityProfile, type GoalQualityProfile };

const QUALITY_PROFILE_DISCIPLINE: Record<GoalQualityProfile, string> = {
  "incremental-implementation": "implement the smallest independently verifiable slice; avoid unrelated cleanup or broad refactors",
  "test-driven-change": "treat tests/validators as first-class evidence; run or explain declared validators before reporting completion",
  "code-review-required": "prepare a reviewable diff with verification notes, risks, and reviewer-relevant context",
  "independent-audit": "preserve auditability: document evidence, unresolved risks, and any assumptions that need independent verification",
  "security-sensitive-review": "treat security impact as in scope; call out threat/risk considerations and avoid weakening safeguards",
  "api-contract-change": "keep public API/contract compatibility explicit; update related schemas/docs/tests or explain why not needed",
  "database-migration": "handle migration safety explicitly: reversibility, data compatibility, rollout/rollback notes, and validation",
  "docs-required": "update or identify required documentation/ADR/operator notes for the change",
  "observability-required": "preserve or add operational visibility; mention logs, metrics, traces, or monitorability evidence",
  "ship-preflight": "include release-readiness notes such as validation, rollback/safety plan, and known risks",
};

export function qualityProfilesOf(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const profiles = (value as { qualityProfiles?: unknown }).qualityProfiles;
  return Array.isArray(profiles) ? profiles.filter((item): item is string => typeof item === "string") : [];
}

export function cloneQualityProfiles(value: readonly GoalQualityProfile[] | undefined): GoalQualityProfile[] | undefined {
  return value ? [...value] : undefined;
}

export function unsupportedQualityProfilesOf(value: unknown): string[] {
  return qualityProfilesOf(value).filter((profile) => !isGoalQualityProfile(profile));
}

export function renderQualityProfileGuardrailLines(value: unknown): string[] {
  const profiles = qualityProfilesOf(value).filter(isGoalQualityProfile);
  if (profiles.length === 0) return [];
  return [
    "[QUALITY PROFILE EXECUTION DISCIPLINE]",
    `Active quality profiles: ${profiles.join(", ")}`,
    "These profiles are controller-owned quality constraints. They guide execution, evidence, and completion reporting; deterministic controller validation remains authoritative.",
    ...profiles.map((profile) => `- ${profile}: ${QUALITY_PROFILE_DISCIPLINE[profile]}.`),
  ];
}
