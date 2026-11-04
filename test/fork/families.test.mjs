/**
 * Family checks against the vault catalog (`yields list`, from the API).
 * Records carry first-class `family`, CAIP-2 `chainId`, and `contracts`, so
 * there are no classification heuristics here. The catalog comes from
 * YIELDS_BASE_URL (default: production), which must serve schemaVersion 1;
 * a failed discovery fails the suite instead of skipping it.
 *
 * Chain-aware: each case runs only when the forked chain matches the vault's
 * chain — start anvil against Ethereum for morpho/upshift_evm, or
 * against Ink (chain 57073) for boring:
 *
 *   anvil --fork-url https://rpc-gel.inkonchain.com --chain-id 57073
 *
 * Env overrides per family: MORPHO_VAULT / UPSHIFT_EVM_VAULT.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { cli, ensureAnvil, evmChain, pc, yieldsCatalog } from './helpers.mjs';

const HUGE = String(10n ** 24n); // larger than any plausible balance, small enough not to overflow previews
const DEAD = '0x000000000000000000000000000000000000dEaD';

// known before tests are defined; null ⇒ anvil down (ensureAnvil reports the fix)
const forkChain = await pc.getChainId().catch(() => null);

// cli() is spawnSync so this runs at module load
const catalog = yieldsCatalog();
const onFork = (v) => forkChain === null || evmChain(v.chainId) === String(forkChain);

const has = (v, k) => Boolean(k === 'depositToken' ? v.depositToken?.address : v.contracts?.[k]);

function pick(family, needs) {
  const all = (catalog.vaults ?? []).filter((v) => v.family === family);
  const usable = all.filter((v) => needs.every((k) => has(v, k)));
  return usable.find(onFork) ?? usable[0] ?? all.find(onFork) ?? all[0];
}

/**
 * Contract guard: any plan that carries expected values must also carry their
 * human-decimal twins — i.e. every family's plan context must include
 * assetDecimals/shareDecimals. Catches silently-degrading formatting.
 */
function assertHumanTwins(plan) {
  const keys = Object.keys(plan.expected ?? {});
  if (keys.length === 0) return;
  assert.ok(plan.expectedFormatted, `plan has expected ${JSON.stringify(keys)} but no expectedFormatted — context is missing decimals`);
}

function skipReason(record, family, needs) {
  if (catalog.error) return false;
  if (!record) return `catalog has no ${family} vault`;
  const missing = needs.filter((k) => !has(record, k));
  if (missing.length > 0) return `catalog ${family} vault ${record.name} lacks ${missing.join(', ')}`;
  if (forkChain !== null && String(forkChain) !== evmChain(record.chainId)) {
    return `vault is on chain ${record.chainId}, fork is chain ${forkChain}`;
  }
  return false;
}

const assertCatalog = () => { if (catalog.error) assert.fail(catalog.error); };

before(async () => { await ensureAnvil(); });

// ---------- single-contract families (vault == entry point) ----------

const CASES = [
  { family: 'morpho', amountFlag: 'assets' },
  { family: 'upshift_evm', amountFlag: 'amount' },
].map(({ family, amountFlag }) => {
  const envVault = process.env[`${family.toUpperCase()}_VAULT`];
  const record = pick(family, ['vault']);
  return {
    family,
    amountFlag,
    record,
    vault: envVault ?? record?.contracts?.vault,
    fromCatalog: !envVault,
    source: envVault ? 'env override' : record ? `api: ${record.name}` : 'unavailable',
    depositToken: envVault ? undefined : record?.depositToken?.address,
    skip: envVault ? false : skipReason(record, family, ['vault']),
  };
});

for (const c of CASES) {
  test(`${c.family}: detect + meta agree with the API record (${c.source})`, { skip: c.skip }, () => {
    if (c.fromCatalog) assertCatalog();
    const det = cli('detect', '--vault', c.vault);
    assert.equal(det.code, 0, det.stderr);
    assert.equal(det.json.family, c.family);

    const meta = cli(c.family, 'meta', '--vault', c.vault);
    assert.equal(meta.code, 0, meta.stderr);
    assert.match(meta.json.asset, /^0x[0-9a-fA-F]{40}$/);
    if (c.depositToken) {
      assert.equal(meta.json.asset.toLowerCase(), c.depositToken.toLowerCase(), 'SDK asset ≠ API depositToken');
    }
  });

  test(`${c.family}: impossible deposit ⇒ blocked plan, exit 7, no steps (${c.source})`, { skip: c.skip }, () => {
    if (c.fromCatalog) assertCatalog();
    const plan = cli(c.family, 'plan-deposit', '--vault', c.vault, `--${c.amountFlag}`, HUGE, '--owner', DEAD);
    assert.equal(plan.code, 7, plan.stderr || plan.stdout);
    assert.equal(plan.json.steps.length, 0);
    assert.ok(plan.json.blockers.length > 0);
    assertHumanTwins(plan.json);
  });
}

// ---------- boring (multi-contract topology from the catalog) ----------

{
  const needs = ['vault', 'teller', 'accountant', 'queue', 'rolesAuthority', 'depositToken'];
  const record = pick('boring', needs);
  const skip = skipReason(record, 'boring', needs);
  const c = record?.contracts ?? {};

  test(`boring: detect + discover agree with catalog contracts (${record ? `api: ${record.name}` : 'unavailable'})`, { skip }, () => {
    assertCatalog();
    const det = cli('detect', '--vault', c.vault);
    assert.equal(det.code, 0, det.stderr);
    assert.equal(det.json.family, 'boring');

    // point-read discovery must reproduce the catalog's topology
    const disc = cli('boring', 'discover', '--vault', c.vault, '--queue', c.queue);
    assert.equal(disc.code, 0, disc.stderr);
    assert.equal(disc.json.config.teller.toLowerCase(), c.teller.toLowerCase());
    assert.equal(disc.json.config.accountant.toLowerCase(), c.accountant.toLowerCase());
    assert.equal(disc.json.config.rolesAuthority.toLowerCase(), c.rolesAuthority.toLowerCase());
  });

  test('boring: position reads through teller/accountant/queue', { skip }, () => {
    assertCatalog();
    const pos = cli(
      'boring', 'position', '--vault', c.vault, '--asset', record?.depositToken?.address,
      '--owner', DEAD, '--queue', c.queue,
    );
    assert.equal(pos.code, 0, pos.stderr);
    for (const key of ['shares', 'assets', 'assetBalance', 'vaultAllowance', 'queueShareAllowance']) {
      assert.match(String(pos.json[key]), /^\d+$/, `${key} must be a base-unit integer`);
    }
  });

  test('boring: impossible deposit ⇒ blocked plan, exit 7, no steps', { skip }, () => {
    assertCatalog();
    const plan = cli(
      'boring', 'plan-deposit', '--vault', c.vault, '--asset', record?.depositToken?.address,
      '--amount', HUGE, '--owner', DEAD, '--queue', c.queue,
    );
    assert.equal(plan.code, 7, plan.stderr || plan.stdout);
    assert.equal(plan.json.steps.length, 0);
    assert.ok(plan.json.blockers.length > 0);
  });

  test('boring: queued withdrawal preflight reads the live queue config', { skip }, () => {
    assertCatalog();
    const plan = cli(
      'boring', 'plan-withdraw', '--vault', c.vault, '--asset-out', record?.depositToken?.address,
      '--shares', HUGE, '--owner', DEAD, '--queue', c.queue,
    );
    assert.equal(plan.code, 7, plan.stderr || plan.stdout);
    assert.ok(plan.json.blockers.some((b) => ['INSUFFICIENT_SHARES', 'BELOW_MINIMUM', 'DISCOUNT_OUT_OF_RANGE', 'PAUSED', 'ASSET_NOT_ALLOWED'].includes(b.code)));
  });
}

// ---------- boring: queue migrated on Ink at block 34236279, old queue kept boringVault() ----------

{
  const VAULT = '0xDbD87325D7b1189Dcc9255c4926076fF4a96A271';
  const ASSET = '0x2D270e6886d130D724215A266106e6832161EAEd';
  const OLD_QUEUE = '0x359db9a866c1276a571b3a9fbbbc47ed1f945e71';
  const CURRENT_QUEUE = '0x406e63323ef5d39d41c6fd895ef9665af926184c';
  const skip = forkChain !== null && forkChain !== 57073 ? `needs an Ink fork (57073), fork is chain ${forkChain}` : false;
  const planWithdraw = (queue) => cli(
    'boring', 'plan-withdraw', '--vault', VAULT, '--asset-out', ASSET, '--shares', HUGE, '--owner', DEAD, '--queue', queue,
  );

  test('boring: discover flags an explicit deprecated queue without failing', { skip }, () => {
    const r = cli('boring', 'discover', '--vault', VAULT, '--queue', OLD_QUEUE);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.queueDeprecated, true);
    assert.match(r.json.warnings.join(' '), /is deprecated/);
  });

  test('boring: plan-withdraw on the deprecated queue is blocked with QUEUE_DEPRECATED', { skip }, () => {
    const plan = planWithdraw(OLD_QUEUE);
    assert.equal(plan.code, 7, plan.stderr || plan.stdout);
    assert.ok(plan.json.blockers.some((b) => b.code === 'QUEUE_DEPRECATED'));
  });

  test('boring: the current queue is not deprecated and has no permission blocker', { skip }, () => {
    const r = cli('boring', 'discover', '--vault', VAULT, '--queue', CURRENT_QUEUE);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.queueDeprecated, false);
    const plan = planWithdraw(CURRENT_QUEUE);
    assert.ok(!plan.json.blockers.some((b) => b.code === 'QUEUE_DEPRECATED' || b.code === 'ROLE_DENIED'));
  });
}
