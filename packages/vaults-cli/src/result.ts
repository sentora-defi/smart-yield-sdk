import { formatUnits } from 'viem';
import { SCHEMA_VERSION } from './version';

export function asPlan(result: unknown): { steps: unknown[]; blockers: unknown[] } | undefined {
  const r = result as { steps?: unknown; blockers?: unknown } | null;
  return !!r && typeof r === 'object' && Array.isArray(r.steps) && Array.isArray(r.blockers)
    ? (r as { steps: unknown[]; blockers: unknown[] })
    : undefined;
}

/**
 * Add human-decimal twins next to base-unit outputs so agents never do unit
 * arithmetic in-context: plans gain `expectedFormatted`, meta-shaped results
 * gain `formatted`. Purely additive — base units stay canonical.
 */
export function humanTwins(result: unknown): unknown {
  const r = result as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return result;

  if (asPlan(r)) {
    const ctx = (r.context ?? {}) as Record<string, unknown>;
    const ad = typeof ctx.assetDecimals === 'number' ? ctx.assetDecimals : undefined;
    const sd = typeof ctx.shareDecimals === 'number' ? ctx.shareDecimals : undefined;
    const roles: Record<string, number | undefined> = {
      assets: ad, assetsAfterFee: ad, amountInReferenceTokens: ad,
      shares: sd, minimumMint: sd,
    };
    const formatted: Record<string, string> = {};
    for (const [k, v] of Object.entries((r.expected ?? {}) as Record<string, string>)) {
      const d = roles[k];
      if (d !== undefined && /^\d+$/.test(String(v))) formatted[k] = formatUnits(BigInt(v), d);
    }
    return Object.keys(formatted).length ? { ...r, expectedFormatted: formatted } : result;
  }

  if (typeof r.assetDecimals === 'number' && typeof r.totalAssets === 'bigint') {
    const ad = r.assetDecimals;
    const formatted: Record<string, string> = {};
    for (const k of ['totalAssets', 'sharePrice', 'depositCap', 'maxDepositAmount', 'maxWithdrawalAmount']) {
      if (typeof r[k] === 'bigint') formatted[k] = formatUnits(r[k] as bigint, ad);
    }
    if (typeof r.shareDecimals === 'number' && typeof r.totalSupply === 'bigint') {
      formatted.totalSupply = formatUnits(r.totalSupply as bigint, r.shareDecimals);
    }
    return Object.keys(formatted).length ? { ...r, formatted } : result;
  }
  return result;
}

/** shared final shaping for every entry point (CLI, MCP): human twins + plan schemaVersion stamp */
export function finalizeResult(raw: unknown): { payload: unknown; blocked: boolean } {
  const result = humanTwins(raw);
  const plan = asPlan(result);
  return {
    payload: plan ? { schemaVersion: SCHEMA_VERSION, ...plan } : result,
    blocked: plan !== undefined && plan.blockers.length > 0,
  };
}
