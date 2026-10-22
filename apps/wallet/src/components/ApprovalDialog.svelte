<script lang="ts">
  import type { Quote } from "@stellar-agent-services/payment-client";
  import { onMount } from "svelte";
  import type { AgentWallet } from "../lib/agent-wallet.svelte.js";
  import { formatAmount, hostOf, shortAddress } from "../lib/format.js";
  import CopyButton from "./CopyButton.svelte";
  import Icon from "./Icon.svelte";

  let { app, quote, onclose }: { app: AgentWallet; quote: Quote; onclose: () => void } = $props();

  interface Check {
    ok: boolean;
    text: string;
    detail?: string;
  }

  let dialog: HTMLDialogElement;
  let declineButton = $state<HTMLButtonElement>();
  let approved = false;

  // The terms come from the provider's 402 challenge, which the core already checked against its manifest.
  const requirements = $derived(quote.requirements);
  const service = $derived(quote.service);
  const manifest = $derived(quote.manifest);
  const amount = $derived(BigInt(quote.requirements.amount ?? "0"));
  const payable = $derived(app.payable(quote));
  const checks = $derived(buildChecks());

  onMount(() => {
    dialog.showModal();
    // The safe answer has the focus, so a stray Enter never pays.
    declineButton?.focus();
  });

  function approve() {
    approved = true;
    dialog.close();
    void app.pay(quote);
  }

  /** Any way of closing without approving declines: the Decline button, the close button or Escape. */
  function handleClose() {
    if (!approved && payable) void app.decline(quote);
    onclose();
  }

  function buildChecks(): Check[] {
    const result: Check[] = [];
    const challenge = quote.challengeViolations.filter((violation) => violation.startsWith("["));
    const other = quote.challengeViolations.filter((violation) => !violation.startsWith("["));
    if (challenge.length === 0) result.push({ ok: true, text: "Price and payee match what the provider publishes" });
    else result.push({ ok: false, text: "The payment request differs from what the provider publishes", detail: challenge.join("\n") });
    for (const violation of other) result.push({ ok: false, text: "This wallet can't pay this kind of request", detail: violation });

    const policy = app.policy;
    if (policy === undefined) return result;
    const violations = new Map(quote.policyViolations.map((violation) => [violation.field, violation.message]));
    const perPayment = formatAmount(policy.maxValuePerTx);
    const perDay = formatAmount(policy.maxValuePerDay);
    result.push(
      violations.has("maxValuePerTx")
        ? { ok: false, text: `Above your limit of ${perPayment} USDC per payment` }
        : { ok: true, text: `Within your limit of ${perPayment} USDC per payment` },
    );
    result.push(
      violations.has("maxValuePerDay")
        ? { ok: false, text: `Over your 24-hour limit: ${formatAmount(app.spentLast24h)} of ${perDay} USDC already used` }
        : { ok: true, text: `Within your 24-hour limit: ${formatAmount(app.spentLast24h + amount)} of ${perDay} USDC after this payment` },
    );
    for (const { field, message } of quote.policyViolations) {
      if (field !== "maxValuePerTx" && field !== "maxValuePerDay") result.push({ ok: false, text: sentence(message), detail: field });
    }
    return result;
  }

  function sentence(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
</script>

<dialog bind:this={dialog} onclose={handleClose} aria-labelledby="approval-title" aria-describedby="approval-note">
  <div class="sheet">
    <header class="head">
      <span class="head-icon" class:blocked={!payable}><Icon name={payable ? "shield" : "alert"} size={18} /></span>
      <div class="head-text">
        <h2 id="approval-title">{payable ? "Approve payment" : "Payment blocked"}</h2>
        <p id="approval-note">{payable ? "Check the details. Nothing is paid until you approve." : "A check failed, so nothing will be signed or paid."}</p>
      </div>
      <button type="button" class="btn btn-ghost btn-icon" aria-label="Close" onclick={() => dialog.close()}>
        <Icon name="x" />
      </button>
    </header>

    <div class="body">
      <div class="amount">
        <span class="amount-label">{payable ? "You pay" : "Price"}</span>
        <span class="amount-value"><span class="num">{formatAmount(amount)}</span><span class="amount-unit">USDC</span></span>
        <span class="pill pill-warning">Stellar testnet · test money</span>
      </div>

      <dl class="details">
        <div class="row payee">
          <dt>Pay to</dt>
          <dd>
            <span class="address mono">{requirements.payTo}</span>
            <CopyButton value={requirements.payTo} label="Copy the payee address" />
          </dd>
        </div>
        <div class="row">
          <dt>Service</dt>
          <dd>{service.title ?? service.name}</dd>
        </div>
        <div class="row">
          <dt>Provider</dt>
          <dd>{manifest.provider.name} <span class="muted">· {hostOf(manifest.baseUrl)}</span></dd>
        </div>
        <div class="row">
          <dt>Charged</dt>
          <dd>{service.charge === "on-success" ? "Only if the work succeeds" : "Up front, before the work starts"}</dd>
        </div>
        <div class="row">
          <dt>Asset</dt>
          <dd>USDC <span class="muted mono">{shortAddress(requirements.asset)}</span></dd>
        </div>
        <div class="row">
          <dt>From</dt>
          <dd>Your test wallet <span class="muted mono">{shortAddress(app.wallet?.address ?? "")}</span></dd>
        </div>
        <div class="row">
          <dt>Method</dt>
          <dd>{quote.methodId === "x402-exact-stellar" ? "x402 exact on Stellar" : (quote.methodId ?? "None installed")}</dd>
        </div>
      </dl>

      <ul class="checks" aria-label="Safety checks">
        {#each checks as check, index (index)}
          <li class:failed={!check.ok}>
            <span class="check-icon"><Icon name={check.ok ? "check" : "x"} size={12} /></span>
            <span>
              {check.text}
              {#if check.detail !== undefined}<span class="detail">{check.detail}</span>{/if}
            </span>
          </li>
        {/each}
      </ul>
    </div>

    <footer class="foot">
      {#if payable}
        <button bind:this={declineButton} type="button" class="btn btn-secondary btn-lg" onclick={() => dialog.close()}>Decline</button>
        <button type="button" class="btn btn-primary btn-lg approve" onclick={approve}>
          Approve and pay {formatAmount(amount)} USDC
        </button>
      {:else}
        <button bind:this={declineButton} type="button" class="btn btn-secondary btn-lg" onclick={() => dialog.close()}>Close</button>
      {/if}
    </footer>
  </div>
</dialog>

<style>
  .sheet {
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - 48px);
  }

  .head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 20px 20px 0 24px;
  }

  .head-icon {
    display: grid;
    flex: none;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 12px;
    background: var(--accent-soft);
    color: var(--accent);
  }

  .head-icon.blocked {
    background: var(--danger-soft);
    color: var(--danger);
  }

  .head-text {
    flex: 1;
    padding-top: 1px;
  }

  h2 {
    font-size: 17px;
    font-weight: 650;
    letter-spacing: -0.01em;
  }

  .head-text p {
    margin-top: 2px;
    color: var(--text-secondary);
    font-size: 13px;
  }

  .body {
    overflow-y: auto;
    padding: 20px 24px 4px;
  }

  .amount {
    display: grid;
    justify-items: center;
    gap: 6px;
    padding: 20px 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-sunken);
  }

  .amount-label {
    color: var(--text-tertiary);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .amount-value {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .amount-value .num {
    font-size: 38px;
    font-weight: 700;
    letter-spacing: -0.03em;
    line-height: 1.1;
  }

  .amount-unit {
    color: var(--text-secondary);
    font-size: 17px;
    font-weight: 600;
  }

  .details {
    margin: 16px 0 0;
  }

  .row {
    display: grid;
    grid-template-columns: 84px minmax(0, 1fr);
    gap: 12px;
    padding: 9px 0;
    border-bottom: 1px solid var(--border);
  }

  .row:last-child {
    border-bottom: 0;
  }

  dt {
    color: var(--text-tertiary);
    font-size: 13px;
  }

  dd {
    margin: 0;
    font-size: 13.5px;
    font-weight: 500;
  }

  .payee dd {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: -6px 0;
  }

  .address {
    flex: 1;
    overflow-wrap: anywhere;
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1.45;
  }

  .checks {
    display: grid;
    gap: 8px;
    margin: 8px 0 16px;
    padding: 14px;
    border: 1px solid var(--success-border);
    border-radius: var(--radius);
    background: var(--success-soft);
    list-style: none;
    font-size: 13px;
  }

  .checks:has(.failed) {
    border-color: var(--danger-border);
    background: var(--danger-soft);
  }

  .checks li {
    display: flex;
    gap: 10px;
    color: var(--text);
  }

  .check-icon {
    display: grid;
    flex: none;
    place-items: center;
    width: 18px;
    height: 18px;
    margin-top: 1px;
    border-radius: 999px;
    background: var(--success);
    color: var(--surface);
  }

  .failed .check-icon {
    background: var(--danger);
  }

  .failed {
    font-weight: 550;
  }

  .detail {
    display: block;
    white-space: pre-line;
  }

  .foot {
    display: flex;
    gap: 10px;
    padding: 16px 24px 20px;
    border-top: 1px solid var(--border);
  }

  .foot .btn {
    flex: 1;
  }

  .foot .approve {
    flex: 1.6;
  }

  @media (max-width: 480px) {
    .foot {
      flex-direction: column-reverse;
    }
  }
</style>
