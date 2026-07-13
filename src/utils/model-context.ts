interface ModelContextConfig {
    maxTokens: number;
    usableTokens: number;
}

interface ModelIdentifier {
    id?: string;
    display_name?: string;
}

const DEFAULT_CONTEXT_WINDOW_SIZE = 200000;
const DEFAULT_USABLE_CONTEXT_RATIO = 0.8;
const CONTEXT_SIZE_FALLBACK_ENV_VAR = 'CCSTATUSLINE_CONTEXT_SIZE_FALLBACK';

/**
 * Gets the usable context ratio from environment variable or settings.
 * Priority: CLAUDE_AUTOCOMPACT_PCT_OVERRIDE env var > autoCompactWindow setting > default 0.8
 * The ratio is expressed as a percentage (e.g., 80 = 80% = 0.8)
 */
function getUsableContextRatio(): number {
    // First check environment variable override
    const envValue = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
    if (envValue !== undefined) {
        const parsed = Number.parseFloat(envValue);
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= 100) {
            return parsed / 100;
        }
    }

    // Settings are loaded lazily to avoid circular dependencies
    // The autoCompactWindow setting stores the percentage directly
    try {
        const settingsPath = require('path').join(
            require('os').homedir(),
            '.config',
            'ccstatusline',
            'settings.json'
        );
        const fs = require('fs');
        if (fs.existsSync(settingsPath)) {
            const content = fs.readFileSync(settingsPath, 'utf-8');
            const settings = JSON.parse(content);
            if (settings.autoCompactWindow !== undefined) {
                const parsed = Number.parseFloat(String(settings.autoCompactWindow));
                if (Number.isFinite(parsed) && parsed > 0 && parsed <= 100) {
                    return parsed / 100;
                }
            }
        }
    } catch {
        // Ignore errors loading settings, fall back to default
    }

    return DEFAULT_USABLE_CONTEXT_RATIO;
}

// Cache the ratio so we don't re-read settings on every call
let cachedUsableContextRatio: number | null = null;

function getCachedUsableContextRatio(): number {
    if (cachedUsableContextRatio === null) {
        cachedUsableContextRatio = getUsableContextRatio();
    }
    return cachedUsableContextRatio;
}

// User-configurable last-resort fallback window size. Mirrors CCSTATUSLINE_WIDTH:
// a positive integer read from the environment, ignored when unset or invalid.
// Defaults to 200k so behavior is unchanged unless the user opts in.
function getFallbackContextWindowSize(): number {
    const raw = process.env[CONTEXT_SIZE_FALLBACK_ENV_VAR];
    if (raw) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }

    return DEFAULT_CONTEXT_WINDOW_SIZE;
}

function toValidWindowSize(value: number | null | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return null;
    }

    return value;
}

function parseContextWindowSize(modelIdentifier: string): number | null {
    const delimitedMatch = /(?:\(|\[)\s*(\d+(?:[,_]\d+)*(?:\.\d+)?)\s*([km])\s*(?:\)|\])/i.exec(modelIdentifier);
    if (delimitedMatch) {
        const delimitedValue = delimitedMatch[1];
        const delimitedUnit = delimitedMatch[2];
        if (!delimitedValue || !delimitedUnit) {
            return null;
        }

        const parsed = Number.parseFloat(delimitedValue.replace(/[,_]/g, ''));
        if (Number.isFinite(parsed) && parsed > 0) {
            return Math.round(parsed * (delimitedUnit.toLowerCase() === 'm' ? 1000000 : 1000));
        }
    }

    const contextMatch = /\b(\d+(?:[,_]\d+)*(?:\.\d+)?)\s*([km])(?:\s*(?:token\s*)?context)?\b/i.exec(modelIdentifier);
    if (!contextMatch) {
        return null;
    }

    const contextValue = contextMatch[1];
    const contextUnit = contextMatch[2];
    if (!contextValue || !contextUnit) {
        return null;
    }

    const parsed = Number.parseFloat(contextValue.replace(/[,_]/g, ''));
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }

    return Math.round(parsed * (contextUnit.toLowerCase() === 'm' ? 1000000 : 1000));
}

export function getModelContextIdentifier(model?: string | ModelIdentifier): string | undefined {
    if (typeof model === 'string') {
        const trimmed = model.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }

    if (!model) {
        return undefined;
    }

    const id = model.id?.trim();
    const displayName = model.display_name?.trim();

    if (id && displayName) {
        return `${id} ${displayName}`;
    }

    return id ?? displayName;
}

export function getContextConfig(modelIdentifier?: string, contextWindowSize?: number | null): ModelContextConfig {
    const usableRatio = getCachedUsableContextRatio();
    const statusWindowSize = toValidWindowSize(contextWindowSize);
    if (statusWindowSize !== null) {
        return {
            maxTokens: statusWindowSize,
            usableTokens: Math.floor(statusWindowSize * usableRatio)
        };
    }

    // Last-resort fallback when neither the live status window size nor a
    // model-name hint is available. Defaults to 200k, overridable via
    // CCSTATUSLINE_CONTEXT_SIZE_FALLBACK.
    const fallbackWindowSize = getFallbackContextWindowSize();
    const defaultConfig = {
        maxTokens: fallbackWindowSize,
        usableTokens: Math.floor(fallbackWindowSize * usableRatio)
    };

    if (!modelIdentifier) {
        return defaultConfig;
    }

    const inferredWindowSize = parseContextWindowSize(modelIdentifier);
    if (inferredWindowSize !== null) {
        return {
            maxTokens: inferredWindowSize,
            usableTokens: Math.floor(inferredWindowSize * usableRatio)
        };
    }

    return defaultConfig;
}
