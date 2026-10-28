<script lang="ts">
  import type { ApprovalView } from "../../../src/cli/approval-view.js";
  import { shortAddress, shortNetwork } from "../lib/format.js";
  import Icon from "./Icon.svelte";

  let { view }: { view: ApprovalView | undefined } = $props();
  const mainnet = $derived(view?.network.id === "stellar:pubnet");
</script>

<header class="header">
  <div class="inner">
    <div class="brand">
      <span class="logo"><Icon name="shield" size={17} /></span>
      <span class="name">Provider Kit</span>
      {#if view !== undefined}
        <span class="divider" aria-hidden="true"></span>
        <span class="command mono" title="The command that opened this page">{view.command}</span>
      {/if}
    </div>
    {#if view !== undefined}
      <div class="status">
        <span class="pill {mainnet ? 'pill-success' : 'pill-warning'}" title={view.network.name}>
          <span class="dot"></span>{shortNetwork(view.network.name)}
        </span>
        {#if view.connected !== undefined}
          <span class="account" title={view.connected.address}>
            <Icon name="wallet" size={14} />
            <span class="mono">{shortAddress(view.connected.address)}</span>
            {#if view.connected.wallet !== undefined}<span class="wallet">{view.connected.wallet}</span>{/if}
          </span>
        {/if}
      </div>
    {/if}
  </div>
</header>

<style>
  .header {
    position: sticky;
    top: 0;
    z-index: 10;
    height: var(--header-height);
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--surface) 86%, transparent);
    backdrop-filter: saturate(1.4) blur(10px);
  }

  .inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    max-width: 1040px;
    height: 100%;
    margin: 0 auto;
    padding: 0 24px;
  }

  .brand,
  .status {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .logo {
    display: grid;
    flex: none;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 9px;
    background: linear-gradient(135deg, #6366f1, #4338ca);
    color: #fff;
    box-shadow: 0 1px 2px rgba(67, 56, 202, 0.4);
  }

  .name {
    font-size: 15px;
    font-weight: 650;
    letter-spacing: -0.01em;
    white-space: nowrap;
  }

  .divider {
    width: 1px;
    height: 20px;
    background: var(--border-strong);
  }

  .command {
    overflow: hidden;
    color: var(--text-secondary);
    font-size: 12.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .account {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-secondary);
    font-size: 12.5px;
  }

  .account .mono {
    color: var(--text);
    font-weight: 550;
  }

  .wallet {
    padding-left: 8px;
    border-left: 1px solid var(--border);
  }

  @media (max-width: 640px) {
    .divider,
    .command,
    .wallet {
      display: none;
    }

    .inner {
      padding: 0 16px;
    }
  }
</style>
