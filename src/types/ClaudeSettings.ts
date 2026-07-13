import type { TranscriptThinkingEffort } from '../utils/jsonl-metadata';

export interface ClaudeSettings {
    effortLevel?: TranscriptThinkingEffort;
    permissions?: {
        allow?: string[];
        deny?: string[];
        additionalDirectories?: string[];
    };
    statusLine?: {
        type: string;
        command: string;
        padding?: number;
        refreshInterval?: number;
    };
    [key: string]: unknown;
}
