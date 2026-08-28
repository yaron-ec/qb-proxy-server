/**
 * Standalone exit-build stub for @base44/sdk.
 *
 * The Base44 platform requires AuthContext.jsx to import `base44` from
 * @/api/base44Client, which in turn imports { createClient } from '@base44/sdk'.
 * In the standalone exit build this alias replaces @base44/sdk with this stub,
 * so ZERO @base44/sdk code reaches the production bundle.
 *
 * The real SDK is never called at runtime in exit mode (AuthContext uses
 * railwayApi exclusively). This stub satisfies the module graph.
 */
export function createClient() {
  return {};
}

export default { createClient };