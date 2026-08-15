/**
 * Shared CLOB market-resolution cache, used by both the trader (risk gate)
 * and the dashboard server (win/loss display).
 *
 * Wraps GET {host}/markets/{condition_id}. A market is resolved once it is
 * closed AND a winning token is flagged (closed alone isn't enough).
 * Resolved markets are cached forever; unresolved ones are re-checked after
 * recheckMs. Lookup failures conservatively leave the market unresolved.
 */
function createResolutionCache({ host, fetchJson, recheckMs = 60000, maxLookups = 10 }) {
  const cache = new Map(); // conditionId -> { resolved, tokens, checkedAt }

  async function check(conditionId) {
    const now = Date.now();
    try {
      const m = await fetchJson(`${host}/markets/${conditionId}`);
      const tokens = (m.tokens || []).map((t) => ({
        tokenId: t.token_id,
        outcome: t.outcome,
        winner: Boolean(t.winner),
      }));
      cache.set(conditionId, {
        resolved: Boolean(m.closed) && tokens.some((t) => t.winner),
        tokens,
        checkedAt: now,
      });
    } catch {
      // offline/blocked/unknown market -> stays unresolved, re-checked later
      if (!cache.get(conditionId)?.resolved) {
        cache.set(conditionId, { resolved: false, tokens: [], checkedAt: now });
      }
    }
  }

  /** Re-check the ids that are unknown or stale-unresolved (capped per call). */
  async function refresh(conditionIds) {
    const now = Date.now();
    const need = [...new Set(conditionIds)]
      .filter(Boolean)
      .filter((id) => {
        const c = cache.get(id);
        return !c || (!c.resolved && now - c.checkedAt >= recheckMs);
      })
      .slice(0, maxLookups);
    if (need.length > 0) await Promise.all(need.map(check));
  }

  return { cache, get: (id) => cache.get(id), refresh };
}

module.exports = { createResolutionCache };
