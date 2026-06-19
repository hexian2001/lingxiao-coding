/**
 * MCP Forge 错误码与错误类
 *
 * 契约: contract:mcp-forge-core v1 §4
 */

export const ForgeErrorCode = {
  FORGE_INVALID_REQUEST: 'FORGE_INVALID_REQUEST',
  FORGE_TEMPLATE_NOT_FOUND: 'FORGE_TEMPLATE_NOT_FOUND',
  FORGE_ANALYSIS_FAILED: 'FORGE_ANALYSIS_FAILED',
  FORGE_GENERATION_FAILED: 'FORGE_GENERATION_FAILED',
  FORGE_SANDBOX_TIMEOUT: 'FORGE_SANDBOX_TIMEOUT',
  FORGE_SANDBOX_CRASH: 'FORGE_SANDBOX_CRASH',
  FORGE_SANDBOX_STARTUP_FAILED: 'FORGE_SANDBOX_STARTUP_FAILED',
  FORGE_INSPECTOR_CONNECT_FAILED: 'FORGE_INSPECTOR_CONNECT_FAILED',
  FORGE_VALIDATION_MISMATCH: 'FORGE_VALIDATION_MISMATCH',
  FORGE_REGISTRATION_FAILED: 'FORGE_REGISTRATION_FAILED',
  FORGE_SERVER_ID_CONFLICT: 'FORGE_SERVER_ID_CONFLICT',
  FORGE_STATE_VIOLATION: 'FORGE_STATE_VIOLATION',
  FORGE_LLM_UNAVAILABLE: 'FORGE_LLM_UNAVAILABLE',
  FORGE_INTERNAL_ERROR: 'FORGE_INTERNAL_ERROR',
} as const;

export type ForgeErrorCodeValue = typeof ForgeErrorCode[keyof typeof ForgeErrorCode];

/** HTTP 状态码映射 */
export const FORGE_ERROR_HTTP_STATUS: Record<string, number> = {
  [ForgeErrorCode.FORGE_INVALID_REQUEST]: 400,
  [ForgeErrorCode.FORGE_TEMPLATE_NOT_FOUND]: 400,
  [ForgeErrorCode.FORGE_ANALYSIS_FAILED]: 422,
  [ForgeErrorCode.FORGE_GENERATION_FAILED]: 422,
  [ForgeErrorCode.FORGE_SANDBOX_TIMEOUT]: 408,
  [ForgeErrorCode.FORGE_SANDBOX_CRASH]: 500,
  [ForgeErrorCode.FORGE_SANDBOX_STARTUP_FAILED]: 422,
  [ForgeErrorCode.FORGE_INSPECTOR_CONNECT_FAILED]: 502,
  [ForgeErrorCode.FORGE_VALIDATION_MISMATCH]: 422,
  [ForgeErrorCode.FORGE_REGISTRATION_FAILED]: 500,
  [ForgeErrorCode.FORGE_SERVER_ID_CONFLICT]: 409,
  [ForgeErrorCode.FORGE_STATE_VIOLATION]: 409,
  [ForgeErrorCode.FORGE_LLM_UNAVAILABLE]: 503,
  [ForgeErrorCode.FORGE_INTERNAL_ERROR]: 500,
};

/** 是否可重试 */
export const FORGE_ERROR_RETRYABLE: Record<string, boolean> = {
  [ForgeErrorCode.FORGE_INVALID_REQUEST]: false,
  [ForgeErrorCode.FORGE_TEMPLATE_NOT_FOUND]: false,
  [ForgeErrorCode.FORGE_ANALYSIS_FAILED]: true,
  [ForgeErrorCode.FORGE_GENERATION_FAILED]: true,
  [ForgeErrorCode.FORGE_SANDBOX_TIMEOUT]: true,
  [ForgeErrorCode.FORGE_SANDBOX_CRASH]: true,
  [ForgeErrorCode.FORGE_SANDBOX_STARTUP_FAILED]: true,
  [ForgeErrorCode.FORGE_INSPECTOR_CONNECT_FAILED]: true,
  [ForgeErrorCode.FORGE_VALIDATION_MISMATCH]: true,
  [ForgeErrorCode.FORGE_REGISTRATION_FAILED]: true,
  [ForgeErrorCode.FORGE_SERVER_ID_CONFLICT]: false,
  [ForgeErrorCode.FORGE_STATE_VIOLATION]: false,
  [ForgeErrorCode.FORGE_LLM_UNAVAILABLE]: true,
  [ForgeErrorCode.FORGE_INTERNAL_ERROR]: true,
};

export class ForgeError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly phase?: string;
  readonly detail?: string;

  constructor(
    code: string,
    message: string,
    options?: {
      phase?: string;
      detail?: string;
      retryable?: boolean;
    },
  ) {
    super(message);
    this.name = 'ForgeError';
    this.code = code;
    this.httpStatus = FORGE_ERROR_HTTP_STATUS[code] ?? 500;
    this.retryable = options?.retryable ?? FORGE_ERROR_RETRYABLE[code] ?? true;
    this.phase = options?.phase;
    this.detail = options?.detail;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      phase: this.phase,
      detail: this.detail,
      retryable: this.retryable,
    };
  }
}
