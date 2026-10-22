<script lang="ts">
  import { explorerUrl } from "@stellar-agent-services/payment-client";
  import type { JsonValue } from "@stellar-agent-services/protocol";
  import type { AgentWallet, Payment } from "../lib/agent-wallet.svelte.js";
  import { formatAmount, formatDuration, humanize, shortHash } from "../lib/format.js";
  import CopyButton from "./CopyButton.svelte";
  import Icon, { type IconName } from "./Icon.svelte";

  let { app, payment }: { app: AgentWallet; payment: Payment } = $props();

  type StepState = "done" | "active" | "pending" | "warning" | "failed" | "skipped";
  interface Step {
    label: string;
    detail?: string;
    state: StepState;
  }
  type Tone = "success" | "warning" | "danger" | "neutral";

  const finished = $derived(payment.phase === "finished");
  const job = $derived(payment.result?.job);
  const charged = $derived(job?.charged === true);
  const confirmed = $derived(payment.result?.confirmed === true);
  const running = $derived(job !== undefined && job.status !== "succeeded" && job.status !== "failed");

  const steps = $derived.by((): Step[] => {
    const provider = providerStep();
    const chain = chainStep();
    if (payment.recovering) {
      return [
        { label: "Found the job in your journal", detail: "Recovery never signs or pays again.", state: "done" },
        { ...provider, label: "Asked the provider for the result" },
        chain,
      ];
    }
    return [
      { label: "Approved by you", state: "done" },
      {
        label: "Signed and sent to the provider",
        state: payment.sent ? "done" : finished ? "failed" : "active",
        ...(payment.sent ? {} : { detail: finished ? "Nothing was sent." : "Signing with your test wallet…" }),
      },
      provider,
      chain,
    ];
  });

  function providerStep(): Step {
    const step = (state: StepState, detail?: string): Step => ({
      label: state === "done" ? "The provider did the work" : state === "active" ? "The provider is doing the work" : "The provider does the work",
      state,
      ...(detail === undefined ? {} : { detail }),
    });
    if (!payment.sent) return step(finished ? "skipped" : "pending");
    if (payment.phase === "working") {
      return step("active", payment.expectedSeconds === undefined ? undefined : `Usually takes ${formatDuration(payment.expectedSeconds)}.`);
    }
    if (payment.phase === "confirming" || job?.status === "succeeded") return step("done");
    if (job?.status === "failed") return step("failed", job.error?.code ?? "The work failed.");
    if (job?.status === "payment_uncertain") return step("warning", "Waiting for the provider to confirm your payment.");
    return step("warning", running ? "Still working." : "No answer yet.");
  }

  function chainStep(): Step {
    const label = "Payment confirmed on Stellar";
    if (payment.phase === "confirming") return { label, state: "active", detail: "Checking the transfer on chain…" };
    // Unknown is not skipped: an uncertain payment may still show up on chain.
    if (!finished || job === undefined) return { label, state: finished && payment.problem?.kind !== "uncertain" ? "skipped" : "pending" };
    // "unknown" while the provider can't confirm its settlement: never say "not charged" then.
    if (job.charged === "unknown") return { label, state: "pending", detail: "Not known yet." };
    if (!charged) return { label, state: "skipped", detail: "You were not charged." };
    if (confirmed) return { label, state: "done", detail: "The transfer matches what you approved." };
    return { label, state: "warning", detail: payment.result?.unconfirmedReason ?? "Not confirmed yet." };
  }

  const outcome = $derived.by((): { tone: Tone; icon: IconName; title: string; text: string } | undefined => {
    if (!finished) return undefined;
    const problem = payment.problem;
    if (problem?.kind === "uncertain") {
      return {
        tone: "warning",
        icon: "alert",
        title: "We can't tell yet whether this went through",
        text: "Don't pay again. Recover the job: recovery only asks the provider for the result and never pays twice.",
      };
    }
    if (problem?.kind === "refused") return { tone: "neutral", icon: "info", title: "Not paid", text: `${sentence(problem.message)}. Nothing was charged.` };
    if (problem !== undefined) return { tone: "danger", icon: "alert", title: "Something went wrong", text: sentence(problem.message) };
    if (job === undefined) return undefined;
    if (job.status === "payment_uncertain") {
      return {
        tone: "warning",
        icon: "clock",
        title: "The provider is still confirming your payment",
        text: "Its payment check didn't finish, so the work hasn't started. You won't be charged twice. Check again later to collect the result.",
      };
    }
    if (running) return { tone: "warning", icon: "clock", title: "Still working", text: "You paid once. Check again in a moment to collect the result." };
    if (job.status === "failed") {
      return charged
        ? { tone: "danger", icon: "alert", title: "The service failed after the payment", text: job.error?.detail ?? "Contact the provider about this job." }
        : { tone: "neutral", icon: "info", title: "The service failed, and you were not charged", text: job.error?.detail ?? job.error?.code ?? "" };
    }
    if (!charged) return { tone: "success", icon: "check", title: "Done", text: "You were not charged for this request." };
    if (!confirmed) {
      return {
        tone: "warning",
        icon: "alert",
        title: "Paid, but not confirmed on chain yet",
        text: `${sentence(payment.result?.unconfirmedReason ?? "the transfer was not found yet")}. Check again in a moment.`,
      };
    }
    return {
      tone: "success",
      icon: "check",
      title: `Paid ${formatAmount(job.payment?.amount ?? payment.amount ?? "0")} USDC`,
      text: payment.recovering ? "Recovered with no second payment. The transfer is confirmed on Stellar." : "The transfer is confirmed on Stellar testnet.",
    };
  });

  const canRecover = $derived(finished && (payment.problem?.kind === "uncertain" || running || (charged && !confirmed)));
  const output = $derived(job?.output);

  function sentence(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  type Flat = Record<string, string | number | boolean | null>;
  const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

  function isFlat(value: JsonValue | undefined): value is Flat {
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.values(value).every((member) => member === null || typeof member !== "object")
    );
  }

  function display(value: string | number | boolean | null): string {
    if (typeof value === "number") return value.toLocaleString("en-US");
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (value === null) return "—";
    if (ISO_TIME.test(value)) return new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "medium" });
    return value;
  }
</script>

<section class="card payment" aria-labelledby="payment-title">
  <header class="head">
    <div>
      <p class="eyebrow">{payment.recovering ? "Recovering a paid job" : "Payment"}</p>
      <h2 id="payment-title">{payment.service}</h2>
    </div>
    {#if payment.amount !== undefined}
      <div class="amount"><span class="num">{formatAmount(payment.amount)}</span> <span class="unit">USDC</span></div>
    {/if}
  </header>

  <ol class="timeline" aria-live="polite">
    {#each steps as step (step.label)}
      <li class="step {step.state}">
        <span class="marker">
          {#if step.state === "active"}<Icon name="spinner" size={14} />
          {:else if step.state === "done"}<Icon name="check" size={12} />
          {:else if step.state === "failed"}<Icon name="x" size={12} />
          {:else if step.state === "warning"}<Icon name="alert" size={12} />{/if}
        </span>
        <div class="step-text">
          <span class="step-label">{step.label}</span>
          {#if step.detail !== undefined}<span class="step-detail">{step.detail}</span>{/if}
        </div>
      </li>
    {/each}
  </ol>

  {#if outcome !== undefined}
    <div class="outcome {outcome.tone}" role="status">
      <span class="outcome-icon"><Icon name={outcome.icon} size={16} /></span>
      <div>
        <p class="outcome-title">{outcome.title}</p>
        {#if outcome.text !== ""}<p class="outcome-text">{outcome.text}</p>{/if}
        {#if payment.problem !== undefined && payment.problem.kind !== "refused"}<p class="detail">{payment.problem.message}</p>{/if}
      </div>
    </div>
  {/if}

  {#if output !== undefined}
    <div class="output">
      <p class="section-label">Result</p>
      {#if isFlat(output) && Object.values(output).every((value) => typeof value === "number")}
        <dl class="stats">
          {#each Object.entries(output) as [key, value] (key)}
            <div class="stat">
              <dt>{humanize(key)}</dt>
              <dd class="num">{display(value)}</dd>
            </div>
          {/each}
        </dl>
      {:else if isFlat(output)}
        <dl class="fields">
          {#each Object.entries(output) as [key, value] (key)}
            <div class="field-row">
              <dt>{humanize(key)}</dt>
              <dd>{display(value)}</dd>
            </div>
          {/each}
        </dl>
      {:else}
        <pre class="json">{JSON.stringify(output, null, 2)}</pre>
      {/if}
    </div>
  {/if}

  {#if finished}
    <dl class="facts">
      {#if job?.payment !== undefined}
        <div>
          <dt>Transaction</dt>
          <dd>
            <a href={explorerUrl(job.payment.network, job.payment.transaction)} target="_blank" rel="noreferrer" class="mono">
              {shortHash(job.payment.transaction)} <Icon name="external" size={12} />
            </a>
          </dd>
        </div>
      {/if}
      <div>
        <dt>Job</dt>
        <dd class="job-id"><span class="mono">{payment.jobId}</span><CopyButton value={payment.jobId} label="Copy the job id" /></dd>
      </div>
    </dl>

    <div class="actions">
      {#if canRecover}
        <button type="button" class="btn btn-primary" onclick={() => app.recover(payment.jobId)}>
          <Icon name="refresh" /> {payment.problem?.kind === "uncertain" ? "Recover job" : "Check again"}
        </button>
      {/if}
      <button type="button" class="btn {canRecover ? 'btn-secondary' : 'btn-primary'}" onclick={() => app.closePayment()}>
        {#if !canRecover}<Icon name="plus" />{/if} New request
      </button>
    </div>
  {/if}
</section>

<style>
  .payment {
    padding: 24px;
  }

  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 20px;
  }

  .eyebrow {
    color: var(--text-tertiary);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  h2 {
    margin-top: 2px;
    font-size: 20px;
    font-weight: 650;
    letter-spacing: -0.015em;
  }

  .amount .num {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .unit {
    color: var(--text-tertiary);
    font-weight: 500;
  }

  .timeline {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .step {
    position: relative;
    display: flex;
    gap: 12px;
    padding-bottom: 16px;
  }

  .step:last-child {
    padding-bottom: 0;
  }

  .step:not(:last-child)::before {
    content: "";
    position: absolute;
    top: 24px;
    bottom: 2px;
    left: 11px;
    width: 2px;
    border-radius: 2px;
    background: var(--border);
  }

  .step.done:not(:last-child)::before {
    background: var(--success-border);
  }

  .marker {
    display: grid;
    flex: none;
    place-items: center;
    width: 24px;
    height: 24px;
    border: 2px solid var(--border-strong);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-tertiary);
  }

  .done .marker {
    border-color: var(--success);
    background: var(--success);
    color: var(--surface);
  }

  .active .marker {
    border-color: var(--accent-border);
    background: var(--accent-soft);
    color: var(--accent);
  }

  .warning .marker {
    border-color: var(--warning);
    background: var(--warning-soft);
    color: var(--warning);
  }

  .failed .marker {
    border-color: var(--danger);
    background: var(--danger);
    color: var(--surface);
  }

  .skipped .marker {
    border-style: dashed;
  }

  .step-text {
    display: grid;
    padding-top: 2px;
  }

  .step-label {
    font-weight: 550;
  }

  .pending .step-label,
  .skipped .step-label {
    color: var(--text-tertiary);
    font-weight: 500;
  }

  .step-detail {
    color: var(--text-tertiary);
    font-size: 13px;
  }

  .outcome {
    display: flex;
    gap: 12px;
    margin-top: 20px;
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-sunken);
  }

  .outcome-icon {
    display: grid;
    flex: none;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-secondary);
  }

  .outcome.success {
    border-color: var(--success-border);
    background: var(--success-soft);
  }

  .outcome.success .outcome-icon {
    background: var(--success);
    color: var(--surface);
  }

  .outcome.warning {
    border-color: var(--warning-border);
    background: var(--warning-soft);
  }

  .outcome.warning .outcome-icon {
    background: var(--warning);
    color: var(--surface);
  }

  .outcome.danger {
    border-color: var(--danger-border);
    background: var(--danger-soft);
  }

  .outcome.danger .outcome-icon {
    background: var(--danger);
    color: var(--surface);
  }

  .outcome-title {
    font-size: 15px;
    font-weight: 650;
  }

  .outcome-text {
    margin-top: 2px;
    color: var(--text-secondary);
  }

  .output {
    margin-top: 20px;
  }

  .section-label {
    margin-bottom: 8px;
    color: var(--text-tertiary);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 10px;
    margin: 0;
  }

  .stat {
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-sunken);
  }

  .stat dt {
    color: var(--text-tertiary);
    font-size: 12.5px;
  }

  .stat dd {
    margin: 2px 0 0;
    font-size: 22px;
    font-weight: 650;
    letter-spacing: -0.02em;
  }

  .fields {
    margin: 0;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-sunken);
  }

  .field-row {
    display: grid;
    grid-template-columns: 140px minmax(0, 1fr);
    gap: 16px;
    padding: 11px 14px;
  }

  .field-row + .field-row {
    border-top: 1px solid var(--border);
  }

  .field-row dt {
    color: var(--text-tertiary);
    font-size: 13px;
  }

  .field-row dd {
    margin: 0;
    font-weight: 500;
    line-height: 1.55;
    overflow-wrap: anywhere;
  }

  @media (max-width: 560px) {
    .field-row {
      grid-template-columns: minmax(0, 1fr);
      gap: 2px;
    }
  }

  .json {
    max-height: 320px;
    margin: 0;
    padding: 14px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-sunken);
    font-family: var(--font-mono);
    font-size: 12.5px;
  }

  .facts {
    display: grid;
    gap: 8px;
    margin: 20px 0 0;
    padding-top: 16px;
    border-top: 1px solid var(--border);
    font-size: 13px;
  }

  .facts div {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    align-items: center;
    gap: 12px;
  }

  .facts dt {
    color: var(--text-tertiary);
  }

  .facts dd {
    margin: 0;
    min-width: 0;
  }

  .facts a {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .job-id {
    display: flex;
    align-items: center;
    gap: 2px;
    margin: -6px 0 !important;
  }

  .job-id .mono {
    overflow: hidden;
    color: var(--text-secondary);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 20px;
  }
</style>
