/**
 * Re-export from canonical location.
 * The implementation now lives in src/core/git/GitPlatformApi.ts.
 */
export {
  GitPlatformApi,
  GitPlatformUnavailableError,
  type CreateMRParams,
  type GitPlatformConfig,
  type GitPlatformUnavailableReason,
  type MergeRequest,
  type RepoInfo,
} from '../core/git/GitPlatformApi.js';
