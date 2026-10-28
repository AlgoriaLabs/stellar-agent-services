<script lang="ts">
  import type { ApprovalView } from "../../../src/cli/approval-view.js";
  import Alert from "./Alert.svelte";
  import CopyButton from "./CopyButton.svelte";
  import Icon from "./Icon.svelte";

  let {
    view,
    connecting,
    notice,
    onconnect,
    oncancel,
  }: {
    view: ApprovalView;
    connecting: boolean;
    notice: { title: string; message: string } | undefined;
    onconnect: () => void;
    oncancel: () => void;
  } = $props();
</script>

<div class="panel">
  <div class="head">
    <h2 class="panel-title">Connect your wallet</h2>
    <p class="panel-lead">
      {view.account === undefined
        ? "Use the wallet you already have. provider-kit asks it to sign, and never sees your key."
        : "Use the wallet that holds this account. provider-kit asks it to sign, and never sees your key."}
    </p>
  </div>

  {#if view.account !== undefined}
    <div class="account">
      <span class="account-label">{view.account.label}</span>
      <div class="address-line">
        <span class="address mono">{view.account.address}</span>
        <CopyButton value={view.account.address} label="Copy the address" />
      </div>
      <p class="reason">{view.account.reason}</p>
    </div>
  {/if}

  {#if view.error !== undefined}
    <Alert tone="danger" title={view.error.title} message={view.error.message} />
  {:else if notice !== undefined}
    <Alert tone="danger" title={notice.title} message={notice.message} />
  {/if}

  <div class="actions">
    <button type="button" class="btn btn-primary btn-lg btn-block" onclick={onconnect} disabled={connecting}>
      {#if connecting}
        <span class="spinner" aria-hidden="true"></span> Waiting for your wallet…
      {:else}
        <Icon name="wallet" size={18} /> Connect wallet
      {/if}
    </button>
    <p class="wallets">Freighter, xBull, Albedo, Rabet, Hana, MetaMask, Ledger and more.</p>
    <button type="button" class="link-button cancel" onclick={oncancel} disabled={connecting}>Cancel and return to the terminal</button>
  </div>
</div>

<style>
  .panel {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 20px;
    animation: rise 180ms ease-out;
  }

  .account {
    padding: 14px 16px 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-sunken);
  }

  .account-label {
    color: var(--text-tertiary);
    font-size: 11.5px;
    font-weight: 650;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .address-line {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
  }

  .address {
    flex: 1;
    min-width: 0;
    font-size: 13.5px;
    font-weight: 550;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }

  .reason {
    margin-top: 8px;
    color: var(--text-secondary);
    font-size: 13px;
  }

  .actions {
    display: grid;
    justify-items: center;
    gap: 12px;
    margin-top: auto;
    padding-top: 4px;
  }

  .wallets {
    color: var(--text-tertiary);
    font-size: 12.5px;
    text-align: center;
  }

  .cancel {
    color: var(--text-secondary);
    font-size: 13px;
  }
</style>
