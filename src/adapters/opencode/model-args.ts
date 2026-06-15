export interface OpencodeBodyModel {
  providerID: string;
  modelID: string;
}

/**
 * Convert the goal-runner canonical model id (`provider/model`) into
 * opencode's session.prompt body shape.
 */
export function toOpencodeBodyModel(modelArg: string | undefined): OpencodeBodyModel | undefined {
  const trimmed = modelArg?.trim();
  if (!trimmed) return undefined;
  const [providerID, ...rest] = trimmed.split("/");
  const modelID = rest.join("/");
  if (!providerID || !modelID) return { providerID: trimmed, modelID: trimmed };
  return { providerID, modelID };
}
