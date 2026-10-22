<script lang="ts">
  import type { AgentWallet } from "../lib/agent-wallet.svelte.js";
  import { formatAmount, formatDate, parseAmount } from "../lib/format.js";
  import Icon from "./Icon.svelte";

  let { app }: { app: AgentWallet } = $props();

  let editing = $state(false);
  let perPayment = $state("");
  let perDay = $state("");
  let formError = $state<string>();

  const policy = $derived(app.policy);
  const perDayLimit = $derived(policy === undefined ? 0n : BigInt(policy.maxValuePerDay));
  const used = $derived(app.spentLast24h);
  const share = $derived(perDayLimit === 0n ? 0 : Math.min(100, Number((used * 1000n) / perDayLimit) / 10));
  const expired = $derived(policy !== undefined && policy.validUntil <= Date.now() / 1000);

  function edit() {
    if (policy === undefined) return;
    perPayment = formatAmount(policy.maxValuePerTx);
    perDay = formatAmount(policy.maxValuePerDay);
    formError = undefined;
    editing = true;
  }

  function save(event: SubmitEvent) {
    event.preventDefault();
    const tx = parseAmount(perPayment);
    const day = parseAmount(perDay);
    if (tx === undefined || day === undefined || tx === 0n || day === 0n) {
      formError = "Enter amounts above zero, such as 0.10";
      return;
    }
    if (tx > day) {
      formError = "The limit per payment can't be above the limit per 24 hours.";
      return;
    }
    app.setLimits(tx, day);
    editing = false;
  }
</script>

<section class="card" aria-labelledby="limits-title">
  <header class="head">
    <div>
      <h2 id="limits-title" class="card-title">Spending limits</h2>
      <p class="card-subtitle">Every payment also asks for your approval.</p>
    </div>
    {#if !editing && policy !== undefined}
      <button type="button" class="btn btn-ghost btn-sm" onclick={edit}><Icon name="edit" size={13} /> Edit</button>
    {/if}
  </header>

  {#if policy !== undefined}
    {#if editing}
      <form onsubmit={save} novalidate>
        <div class="field">
          <label class="label" for="limit-tx">Per payment (USDC)</label>
          <input id="limit-tx" class="input num" inputmode="decimal" bind:value={perPayment} />
        </div>
        <div class="field">
          <label class="label" for="limit-day">Per 24 hours (USDC)</label>
          <input id="limit-day" class="input num" inputmode="decimal" bind:value={perDay} />
        </div>
        {#if formError !== undefined}<p class="field-error">{formError}</p>{/if}
        <div class="edit-actions">
          <button type="button" class="btn btn-secondary btn-sm" onclick={() => (editing = false)}>Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm">Save limits</button>
        </div>
      </form>
    {:else}
      <dl class="limits">
        <div>
          <dt>Per payment</dt>
          <dd class="num">{formatAmount(policy.maxValuePerTx)} <span class="unit">USDC</span></dd>
        </div>
        <div>
          <dt>Per 24 hours</dt>
          <dd class="num">{formatAmount(policy.maxValuePerDay)} <span class="unit">USDC</span></dd>
        </div>
      </dl>

      <div class="usage">
        <div class="bar" role="progressbar" aria-label="Used in the last 24 hours" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share)}>
          <span style:width="{share}%" class:full={share >= 100}></span>
        </div>
        <p class="usage-text num">{formatAmount(used)} of {formatAmount(perDayLimit)} USDC used in the last 24 hours</p>
      </div>

      {#if expired}
        <div class="alert alert-warning" role="alert">
          <Icon name="alert" />
          <div>
            <p class="alert-title">Your limits expired on {formatDate(policy.validUntil)}</p>
            <p>Payments are blocked until you renew them.</p>
            <button type="button" class="link-button" onclick={() => app.renewPolicy()}>Renew for 30 days</button>
          </div>
        </div>
      {:else}
        <p class="valid"><Icon name="clock" size={12} /> Valid until {formatDate(policy.validUntil)}</p>
      {/if}
    {/if}
  {/if}
</section>

<style>
  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 14px;
  }

  .head .btn {
    margin: -4px -8px 0 0;
  }

  .limits {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin: 0;
  }

  .limits div {
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-sunken);
  }

  dt {
    color: var(--text-tertiary);
    font-size: 12.5px;
  }

  dd {
    margin: 2px 0 0;
    font-size: 17px;
    font-weight: 650;
  }

  .unit {
    color: var(--text-tertiary);
    font-size: 12px;
    font-weight: 500;
  }

  .usage {
    margin-top: 14px;
  }

  .bar {
    height: 6px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--surface-sunken);
    box-shadow: inset 0 0 0 1px var(--border);
  }

  .bar span {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: var(--accent-solid);
    transition: width 300ms ease;
  }

  .bar span.full {
    background: var(--danger);
  }

  .usage-text {
    margin-top: 6px;
    color: var(--text-secondary);
    font-size: 12.5px;
  }

  .valid {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 10px;
    color: var(--text-tertiary);
    font-size: 12.5px;
  }

  .alert {
    margin-top: 12px;
  }

  .edit-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 14px;
  }
</style>
