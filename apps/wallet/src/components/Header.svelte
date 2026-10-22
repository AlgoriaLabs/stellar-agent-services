<script lang="ts">
  import type { AgentWallet } from "../lib/agent-wallet.svelte.js";
  import { formatAmount, shortAddress } from "../lib/format.js";
  import Icon from "./Icon.svelte";

  let { app }: { app: AgentWallet } = $props();
  const usdc = $derived(app.balances?.usdc);
</script>

<header class="header">
  <div class="inner">
    <div class="brand">
      <span class="logo"><Icon name="shield" size={17} /></span>
      <span class="name">Agent Wallet</span>
      <span class="pill pill-warning">Testnet</span>
    </div>
    {#if app.wallet !== undefined}
      <div class="account" title={app.wallet.address}>
        <span class="balance num">{usdc === undefined ? "–" : formatAmount(usdc)} <span class="unit">USDC</span></span>
        <span class="address mono">{shortAddress(app.wallet.address)}</span>
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
    max-width: 1120px;
    height: 100%;
    margin: 0 auto;
    padding: 0 24px;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .logo {
    display: grid;
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
  }

  .account {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 36px;
    padding: 0 6px 0 12px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
  }

  .balance {
    font-weight: 600;
  }

  .unit {
    color: var(--text-tertiary);
    font-weight: 500;
  }

  .address {
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--surface-sunken);
    color: var(--text-secondary);
    font-size: 12px;
  }

  @media (max-width: 560px) {
    .inner {
      padding: 0 16px;
    }

    .address {
      display: none;
    }
  }
</style>
