<script lang="ts">
  import { messageOf, type AgentWallet } from "../lib/agent-wallet.svelte.js";
  import { formatAmount, shortAddress } from "../lib/format.js";
  import { accountExplorerUrl, type FundingStep } from "../lib/stellar.js";
  import CopyButton from "./CopyButton.svelte";
  import Icon from "./Icon.svelte";

  let { app }: { app: AgentWallet } = $props();

  let step = $state<FundingStep | "key">();
  let fundingNew = $state(false);
  let error = $state<string>();
  let refreshing = $state(false);

  const balances = $derived(app.balances);
  const empty = $derived(balances !== null && (balances === undefined || (balances.usdc ?? 0n) === 0n));

  async function create() {
    fundingNew = true;
    step = "key";
    try {
      app.createWallet();
    } catch (failure) {
      error = `This browser blocks site storage, which the wallet needs to keep its key. (${messageOf(failure)})`;
      step = undefined;
      return;
    }
    await fund();
  }

  async function fund() {
    error = undefined;
    try {
      await app.fund((next) => (step = next));
    } catch (failure) {
      error = messageOf(failure);
    }
    step = undefined;
    fundingNew = false;
  }

  async function refresh() {
    refreshing = true;
    await app.refreshBalances();
    refreshing = false;
  }

  const steps: { id: FundingStep | "key"; label: string }[] = [
    { id: "key", label: "Create a key in this browser" },
    { id: "xlm", label: "Get test XLM from Friendbot" },
    { id: "usdc", label: "Buy 5 test USDC on the testnet exchange" },
  ];
  const order = ["key", "xlm", "usdc"];
</script>

<section class="card wallet" aria-labelledby="wallet-title">
  <header class="head">
    <div>
      <h2 id="wallet-title" class="card-title">Test wallet</h2>
      <p class="card-subtitle">Stellar testnet · test money only</p>
    </div>
    {#if app.wallet !== undefined && step === undefined}
      <button type="button" class="btn btn-ghost btn-icon" aria-label="Refresh the balance" title="Refresh" onclick={refresh} disabled={refreshing}>
        <Icon name={refreshing ? "spinner" : "refresh"} size={15} />
      </button>
    {/if}
  </header>

  {#if step !== undefined}
    <ol class="funding" aria-live="polite">
      {#each steps.filter((item) => fundingNew || item.id !== "key") as item (item.id)}
        {@const position = order.indexOf(item.id) - order.indexOf(step)}
        <li class:done={position < 0} class:active={position === 0}>
          <span class="dot">
            {#if position < 0}<Icon name="check" size={11} />{:else if position === 0}<Icon name="spinner" size={13} />{/if}
          </span>
          {item.label}
        </li>
      {/each}
    </ol>
  {:else if app.wallet === undefined}
    <p class="intro">Create a wallet with 5 test USDC to try paying for services. The key stays in this browser.</p>
    <button type="button" class="btn btn-primary btn-block" onclick={create}><Icon name="wallet" /> Create test wallet</button>
  {:else}
    <div class="balance">
      {#if balances === null}
        <span class="skeleton"></span>
      {:else}
        <span class="num value">{formatAmount(balances?.usdc ?? 0n)}</span>
        <span class="unit">USDC</span>
      {/if}
    </div>
    {#if balances !== null && balances !== undefined}
      <p class="xlm num">{formatAmount(balances.xlm, 2)} XLM for the account reserve</p>
    {/if}

    <div class="address">
      <span class="mono" title={app.wallet.address}>{shortAddress(app.wallet.address)}</span>
      <CopyButton value={app.wallet.address} label="Copy the wallet address" />
      <a class="btn btn-ghost btn-icon" href={accountExplorerUrl(app.wallet.address)} target="_blank" rel="noreferrer" aria-label="Open on Stellar Expert" title="Open on Stellar Expert">
        <Icon name="external" size={15} />
      </a>
    </div>

    <button type="button" class="btn {empty ? 'btn-primary' : 'btn-secondary'} btn-sm btn-block" onclick={fund}>
      <Icon name="plus" size={14} /> Add 5 test USDC
    </button>
  {/if}

  {#if error !== undefined}
    <div class="alert alert-danger spaced" role="alert">
      <Icon name="alert" />
      <div>{error}</div>
    </div>
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

  .head .btn-icon {
    margin: -4px -8px 0 0;
  }

  .intro {
    margin-bottom: 14px;
    color: var(--text-secondary);
  }

  .balance {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-height: 40px;
  }

  .value {
    font-size: 32px;
    font-weight: 700;
    letter-spacing: -0.03em;
    line-height: 1.2;
  }

  .unit {
    color: var(--text-secondary);
    font-size: 14px;
    font-weight: 600;
  }

  .skeleton {
    width: 120px;
    height: 32px;
    border-radius: 8px;
    background: linear-gradient(90deg, var(--surface-sunken), var(--border), var(--surface-sunken));
    background-size: 200% 100%;
    animation: shimmer 1.2s ease-in-out infinite;
  }

  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
  }

  .xlm {
    color: var(--text-tertiary);
    font-size: 12.5px;
  }

  .address {
    display: flex;
    align-items: center;
    gap: 2px;
    margin: 12px 0 14px;
    padding: 4px 4px 4px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-sunken);
  }

  .address .mono {
    flex: 1;
    color: var(--text-secondary);
  }

  .address a:hover {
    text-decoration: none;
  }

  .funding {
    display: grid;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--text-tertiary);
  }

  .funding li {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .funding .done,
  .funding .active {
    color: var(--text);
  }

  .dot {
    display: grid;
    flex: none;
    place-items: center;
    width: 20px;
    height: 20px;
    border: 2px solid var(--border-strong);
    border-radius: 999px;
    color: var(--accent);
  }

  .done .dot {
    border-color: var(--success);
    background: var(--success);
    color: var(--surface);
  }

  .active .dot {
    border-color: var(--accent-border);
    background: var(--accent-soft);
  }

  .spaced {
    margin-top: 12px;
  }
</style>
