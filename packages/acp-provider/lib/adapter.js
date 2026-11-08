/**
 * The DSH `LlmAdapter` for the Antigravity route: catalog, exact-model
 * metadata (context window and the three efforts), and streaming through the
 * ACP runtime.
 * @module dsh-llm-antigravity-acp/adapter
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { EFFORT_NAMES, nearestEffort } from "./catalog.js";
/** Antigravity primary-model adapter. */
export class AntigravityAdapter extends LlmAdapter {
    runtime;
    displayName;
    imageInput;
    /**
     * @param runtime - process and session owner.
     * @param displayName - provider group name.
     * @param imageInput - whether request images can be read.
     */
    constructor(runtime, displayName, imageInput) {
        super();
        this.runtime = runtime;
        this.displayName = displayName;
        this.imageInput = imageInput;
    }
    providerInfo(provider) {
        return { id: provider, name: this.displayName };
    }
    providerRetryPolicy(_provider) {
        return undefined;
    }
    listModels(provider) {
        return Promise.resolve(this.runtime.catalog.list().map(model => ({
            provider,
            id: model.id,
            name: model.name,
            description: 'Antigravity via the official ACP server',
            inputModalities: this.imageInput() ? ['text', 'image'] : ['text'],
        })));
    }
    resolveModel(provider, model) {
        const entry = this.runtime.catalog.find(model);
        const efforts = this.runtime.catalog.effortsFor(model);
        const defaultEffort = efforts.length > 0 ? nearestEffort(this.runtime.defaultEffort(), efforts) : undefined;
        return Promise.resolve({
            provider,
            id: model,
            name: entry?.name ?? model,
            inputModalities: this.imageInput() ? ['text', 'image'] : ['text'],
            context: { contextWindow: this.runtime.contextWindowFor(model) },
            // A fixed-effort family (gpt-oss-120b-medium) has no selector; its
            // effort already lives in the model id.
            ...efforts.length > 0 ? {
                reasoning: {
                    efforts: efforts.map(id => ({ id: id, name: EFFORT_NAMES[id] })),
                    ...defaultEffort !== undefined ? { defaultEffort: defaultEffort } : {},
                },
            } : {},
            systemPromptUpdate: 'in-history',
        });
    }
    stream(options) {
        return this.runtime.stream(options);
    }
}
