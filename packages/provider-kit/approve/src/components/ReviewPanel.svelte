<script lang="ts">
  import { onDestroy } from "svelte";
  import type { ApprovalDetail, ApprovalView } from "../../../src/cli/approval-view.js";
  import { countdown, shortNetwork } from "../lib/format.js";
  import Alert from "./Alert.svelte";
  import CopyButton from "./CopyButton.svelte";
  import Details from "./Details.svelte";
  import Icon from "./Icon.svelte";

  let {
    view,
    signing,
    notice,
    networkWarning,
    onapprove,
    onrebuild,
    oncancel,
  }: {
    view: ApprovalView;
    signing: boolean;
    notice: { title: string; message: string } | undefined;
    networkWarning: string | undefined;
    onapprove: () => void;
    onrebuild: (stepId: string) => void;
    oncancel: () => void;
  } = $props();

  let now = $state(Date.now());
  const timer = setInterval(() => (now = Date.now()), 1000);
  onDestroy(() => clearInterval(timer));

  const review = $derived(view.review);
  const wallet = $derived(view.connected?.wallet ?? "your wallet");
  const remaining = $derived(review === undefined ? 0 : review.expiresAt - now);
  const expired = $derived(review !== undefined && remaining <= 0);
  const activeStep = $derived(view.steps.find((step) => step.status === "active"));
  const mainnet = $derived(view.network.id === "stellar:pubnet");
  const rows = $derived<ApprovalDetail[]>(
    review === undefined
      ? []
      : [
          { label: "Network", value: view.network.name },
          { label: "Signed by", value: view.connected?.address ?? "", mono: true },
          ...review.details,
          { label: "Network fee", value: `Up to ${review.maxFee}` },
        ],
  );
</script>

<div class="panel">
  {#if review !== undefined}
    <div class="head">
      <span class="head-icon"><Icon name="shield" size={18} /></span>
      <div>
        <h2 class="panel-title">{review.title}</h2>
        <p class="panel-lead">{review.summary}</p>
      </div>
    </div>

    {#if mainnet}
      <Alert tone="warning" title="This is Stellar Mainnet" message="The transaction is real, and its fee is paid in XLM from this account." />
    {/if}
    {#if networkWarning !== undefined}
      <Alert tone="warning" title="Check your wallet's network" message={networkWarning} />
    {/if}

    <Details {rows} />

    <details class="raw">
      <summary><Icon name="chevron" size={14} /> Transaction details</summary>
      <div class="raw-body">
        <div class="raw-field">
          <span class="raw-label">Hash</span>
          <div class="raw-value">
            <code class="mono">{review.hash}</code>
            <CopyButton value={review.hash} label="Copy the transaction hash" />
          </div>
        </div>
        <div class="raw-field">
          <span class="raw-label">XDR</span>
          <div class="raw-value">
            <code class="mono xdr">{review.xdr}</code>
            <CopyButton value={review.xdr} label="Copy the transaction XDR" />
          </div>
        </div>
      </div>
    </details>
  {:else}
    <div class="head">
      <span class="head-icon blocked"><Icon name="alert" size={18} /></span>
      <div>
        <h2 class="panel-title">{activeStep?.title ?? "Review"}</h2>
        <p class="panel-lead">The transaction needs to be prepared again.</p>
      </div>
    </div>
  {/if}

  {#if view.error !== undefined}
    <Alert tone="danger" title={view.error.title} message={view.error.message} />
  {:else if notice !== undefined}
    <Alert tone="danger" title={notice.title} message={notice.message} />
  {/if}

  <div class="foot">
    <div class="actions">
      <button type="button" class="btn btn-secondary btn-lg" onclick={oncancel} disabled={signing}>Cancel</button>
      {#if review === undefined || expired}
        <button type="button" class="btn btn-primary btn-lg grow" onclick={() => activeStep && onrebuild(activeStep.id)} disabled={activeStep === undefined}>
          <Icon name="refresh" size={16} /> Prepare it again
        </button>
      {:else}
        <button type="button" class="btn btn-primary btn-lg grow" onclick={onapprove} disabled={signing}>
          {#if signing}
            <span class="spinner" aria-hidden="true"></span> Confirm in {wallet}…
          {:else}
            Approve in {wallet} <Icon name="arrow" size={16} />
          {/if}
        </button>
      {/if}
    </div>
    {#if review !== undefined}
      <p class="hint" class:expired>
        <Icon name="clock" size={13} />
        {#if expired}
          This transaction expired before it was signed. Prepare it again: nothing was sent.
        {:else}
          Valid for {countdown(remaining)}. Your wallet shows the same transaction on {shortNetwork(view.network.name)}: check it there too.
        {/if}
      </p>
    {/if}
  </div>
</div>

<style>
  .panel {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 18px;
    animation: rise 180ms ease-out;
  }

  .head {
    display: flex;
    align-items: flex-start;
    gap: 14px;
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

  .raw {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-sunken);
  }

  .raw summary {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 12px;
    color: var(--text-secondary);
    font-size: 13px;
    font-weight: 550;
    list-style: none;
    cursor: pointer;
    border-radius: var(--radius);
  }

  .raw summary::-webkit-details-marker {
    display: none;
  }

  .raw summary :global(svg) {
    transition: transform 140ms ease;
  }

  .raw[open] summary :global(svg) {
    transform: rotate(90deg);
  }

  .raw-body {
    display: grid;
    gap: 12px;
    padding: 2px 12px 12px;
  }

  .raw-label {
    color: var(--text-tertiary);
    font-size: 12px;
    font-weight: 600;
  }

  .raw-value {
    display: flex;
    align-items: flex-start;
    gap: 4px;
    margin-top: 4px;
  }

  code {
    flex: 1;
    min-width: 0;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text-secondary);
    font-size: 11.5px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .xdr {
    display: block;
    max-height: 112px;
    overflow-y: auto;
  }

  .foot {
    display: grid;
    gap: 12px;
    margin-top: auto;
    padding-top: 4px;
  }

  .actions {
    display: flex;
    gap: 10px;
  }

  .grow {
    flex: 1;
  }

  .hint {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    color: var(--text-tertiary);
    font-size: 12.5px;
    text-align: center;
  }

  .hint.expired {
    color: var(--warning);
  }

  @media (max-width: 520px) {
    .actions {
      flex-direction: column-reverse;
    }

    .actions .btn {
      flex: none;
      width: 100%;
    }

    .hint {
      align-items: flex-start;
      text-align: left;
    }
  }
</style>
