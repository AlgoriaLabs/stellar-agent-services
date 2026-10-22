<script lang="ts">
  import { explorerUrl } from "@stellar-agent-services/payment-client";
  import type { AgentWallet } from "../lib/agent-wallet.svelte.js";
  import { formatAmount, hostOf, timeAgo } from "../lib/format.js";
  import { canRecover, type JobState } from "../lib/jobs.js";
  import Icon from "./Icon.svelte";

  let { app }: { app: AgentWallet } = $props();

  const LABELS: Record<JobState, { text: string; tone: string }> = {
    paid: { text: "Paid", tone: "pill-success" },
    unconfirmed: { text: "Not confirmed", tone: "pill-warning" },
    "not-charged": { text: "Not charged", tone: "" },
    failed: { text: "Failed", tone: "pill-danger" },
    unfinished: { text: "Unfinished", tone: "pill-warning" },
    declined: { text: "Declined", tone: "" },
    blocked: { text: "Blocked", tone: "pill-danger" },
    "not-paid": { text: "Not paid", tone: "" },
  };

  // Reviews that were never decided are left out: nothing happened to them.
  const jobs = $derived(app.jobs.filter((job) => job.state !== "not-paid").slice(0, 8));
  const busy = $derived(app.payment !== undefined && app.payment.phase !== "finished");
</script>

<section class="card" aria-labelledby="recent-title">
  <header class="head">
    <h2 id="recent-title" class="card-title">Recent payments</h2>
    <p class="card-subtitle">Recorded in a tamper-evident journal in this browser.</p>
  </header>

  {#if jobs.length === 0}
    <p class="empty">Payments you approve show up here, each with a link to its transfer on chain.</p>
  {:else}
    <ul class="list">
      {#each jobs as job (job.jobId)}
        <li class="item">
          <div class="main">
            <span class="service">{app.serviceTitle(job.baseUrl, job.service)}</span>
            <span class="meta">{[job.baseUrl === undefined ? undefined : hostOf(job.baseUrl), timeAgo(job.at)].filter(Boolean).join(" · ")}</span>
            {#if job.reason !== undefined && (job.state === "blocked" || job.state === "unconfirmed")}
              <span class="reason" title={job.reason}>{job.reason}</span>
            {/if}
          </div>
          <div class="side">
            {#if job.amount !== undefined}<span class="amount num">{formatAmount(job.amount)} USDC</span>{/if}
            <span class="status">
              {#if job.transaction !== undefined}
                <a href={explorerUrl("stellar:testnet", job.transaction)} target="_blank" rel="noreferrer" aria-label="Open the transfer on Stellar Expert" title="Open the transfer">
                  <Icon name="external" size={12} />
                </a>
              {/if}
              <span class="pill {LABELS[job.state].tone}">{LABELS[job.state].text}</span>
            </span>
            {#if canRecover(job.state)}
              <button type="button" class="link-button recover" disabled={busy} onclick={() => app.recover(job.jobId)}>
                {job.state === "unfinished" ? "Recover" : "Check again"}
              </button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .head {
    margin-bottom: 10px;
  }

  .empty {
    color: var(--text-tertiary);
    font-size: 13px;
  }

  .list {
    margin: 0 -8px;
    padding: 0;
    list-style: none;
  }

  .item {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 8px;
    border-radius: var(--radius-sm);
  }

  .item + .item {
    border-top: 1px solid var(--border);
  }

  .main,
  .side {
    display: grid;
    align-content: start;
    gap: 2px;
    min-width: 0;
  }

  .side {
    flex: none;
    justify-items: end;
  }

  .service {
    font-weight: 550;
  }

  .meta,
  .reason {
    color: var(--text-tertiary);
    font-size: 12.5px;
  }

  .reason {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .amount {
    font-weight: 600;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .status a {
    color: var(--text-tertiary);
  }

  .status a:hover {
    color: var(--accent);
  }

  .recover {
    font-size: 12.5px;
  }

  .recover:disabled {
    color: var(--text-tertiary);
    cursor: not-allowed;
    text-decoration: none;
  }
</style>
