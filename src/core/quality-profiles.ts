export const SUPPORTED_QUALITY_PROFILES = [
  "incremental-implementation",
  "test-driven-change",
  "code-review-required",
  "api-boundary-review",
  "frontend-runtime-review",
  "security-sensitive-review",
  "performance-sensitive-review",
  "observability-required",
  "docs-adr-required",
  "ship-preflight",
] as const;

export type GoalQualityProfile = (typeof SUPPORTED_QUALITY_PROFILES)[number];

const SUPPORTED_QUALITY_PROFILE_SET = new Set<string>(SUPPORTED_QUALITY_PROFILES);

export function isSupportedQualityProfile(value: string): value is GoalQualityProfile {
  return SUPPORTED_QUALITY_PROFILE_SET.has(value);
}

export function qualityProfilesOf(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const profiles = (value as { qualityProfiles?: unknown }).qualityProfiles;
  return Array.isArray(profiles) ? profiles.filter((item): item is string => typeof item === "string") : [];
}

export function cloneQualityProfiles(value: readonly GoalQualityProfile[] | undefined): GoalQualityProfile[] | undefined {
  return value ? [...value] : undefined;
}
