export interface OpencodeBodyModel {
    providerID: string;
    modelID: string;
}
/**
 * Convert the goal-runner canonical model id (`provider/model`) into
 * opencode's session.prompt body shape.
 */
export declare function toOpencodeBodyModel(modelArg: string | undefined): OpencodeBodyModel | undefined;
