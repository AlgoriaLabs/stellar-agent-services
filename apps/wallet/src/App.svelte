<script lang="ts">
  import { onMount } from "svelte";
  import Header from "./components/Header.svelte";
  import Icon from "./components/Icon.svelte";
  import LimitsCard from "./components/LimitsCard.svelte";
  import PayFlow from "./components/PayFlow.svelte";
  import PaymentCard from "./components/PaymentCard.svelte";
  import RecentPayments from "./components/RecentPayments.svelte";
  import WalletCard from "./components/WalletCard.svelte";
  import { AgentWallet } from "./lib/agent-wallet.svelte.js";

  const app = new AgentWallet();
  onMount(() => void app.start());

  // A payment or a recovery starts at the top of the page, where its progress is.
  $effect(() => {
    if (app.payment?.jobId === undefined) return;
    window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });
</script>

<Header {app} />

<main class="page">
  {#if app.startError !== undefined}
    <div class="card fatal" role="alert">
      <span class="fatal-icon"><Icon name="alert" size={20} /></span>
      <h1 class="card-title">The payment journal could not be opened</h1>
      <p class="card-subtitle">Nothing can be paid until it opens, so no payment goes unrecorded.</p>
      <p class="detail">{app.startError}</p>
    </div>
  {:else if app.ready}
    <div class="layout">
      <div class="main">
        {#if app.payment !== undefined}
          <PaymentCard {app} payment={app.payment} />
        {/if}
        <!-- Kept mounted so the chosen provider, service and input survive a payment. -->
        <div hidden={app.payment !== undefined}>
          <PayFlow {app} />
        </div>
      </div>
      <aside class="side" aria-label="Wallet">
        <WalletCard {app} />
        {#if app.wallet !== undefined}<LimitsCard {app} />{/if}
        <RecentPayments {app} />
      </aside>
    </div>
  {/if}
</main>

<footer class="footer">
  <span><Icon name="lock" size={12} /> Keys stay in this browser and never reach a server.</span>
  <span>Test money only · Provider Standard v1 · x402 on Stellar</span>
</footer>

<style>
  .page {
    max-width: 1120px;
    min-height: calc(100vh - var(--header-height) - 72px);
    margin: 0 auto;
    padding: 32px 24px 48px;
  }

  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 340px;
    align-items: start;
    gap: 24px;
  }

  .main {
    min-width: 0;
  }

  .side {
    position: sticky;
    top: calc(var(--header-height) + 24px);
    display: grid;
    gap: 16px;
  }

  .fatal {
    display: grid;
    justify-items: start;
    gap: 6px;
    max-width: 560px;
    margin: 48px auto;
  }

  .fatal-icon {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    margin-bottom: 6px;
    border-radius: 999px;
    background: var(--danger-soft);
    color: var(--danger);
  }

  .footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 8px 24px;
    max-width: 1120px;
    margin: 0 auto;
    padding: 24px 24px 32px;
    border-top: 1px solid var(--border);
    color: var(--text-tertiary);
    font-size: 12.5px;
  }

  .footer span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  @media (max-width: 960px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
    }

    .side {
      position: static;
    }
  }

  @media (max-width: 560px) {
    .page {
      padding: 20px 16px 40px;
    }

    .footer {
      padding: 20px 16px 28px;
    }
  }
</style>
