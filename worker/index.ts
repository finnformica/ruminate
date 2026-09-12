/**
 * Ruminate Cloudflare Worker.
 *
 * Serves the built SPA via the ASSETS binding and handles the same API routes
 * that were previously Vercel serverless functions. Which routes reach this
 * Worker is controlled by `assets.run_worker_first` in wrangler.jsonc; anything
 * else is served straight from static assets (with SPA fallback to index.html).
 */
import type { Env } from "./types"
import { githubAuth } from "./handlers/github-auth"
import { githubRefresh } from "./handlers/github-refresh"
import { images } from "./handlers/images"
import { mcp, MCP_PATH } from "./handlers/mcp"
import { mcpTokens, MCP_TOKENS_PREFIX } from "./handlers/mcp-tokens"
import { replica } from "./handlers/replica"

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url)

    if (pathname === "/github-auth") return githubAuth(request, env)
    if (pathname === "/github-refresh") return githubRefresh(request, env)
    if (pathname.startsWith("/api/replica/")) return replica(request, env)
    if (pathname === MCP_PATH) return mcp(request, env)
    if (pathname === MCP_TOKENS_PREFIX || pathname.startsWith(`${MCP_TOKENS_PREFIX}/`)) {
      return mcpTokens(request, env)
    }
    if (pathname === "/api/images" || pathname.startsWith("/api/images/")) {
      return images(request, env)
    }

    // Everything else: static assets (index.html fallback for SPA routes).
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
