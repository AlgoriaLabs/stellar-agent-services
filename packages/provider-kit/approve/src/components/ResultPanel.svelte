<script lang="ts">
  import type { ApprovalDetail, ApprovalView } from "../../../src/cli/approval-view.js";
  import Details from "./Details.svelte";
  import Icon from "./Icon.svelte";

  let { view }: { view: ApprovalView } = $props();

  const tone = $derived(view.state === "done" ? "success" : view.state === "failed" ? "danger" : "neutral");
  const result = $derived(view.result ?? { title: "Finished", message: "", details: [] });
  // What each step did, with its transaction, after the command's own details.
  const rows = $derived<ApprovalDetail[]>([
    ...result.details,
    ...view.steps.flatMap((step) =>
      step.transaction === undefined ? [] : [{ label: step.title, value: step.transaction.hash, mono: true, href: step.transaction.url }],
    ),
  ]);
</script>

<div class="panel" role="status" aria-live="polite">
  <div class="hero">
    <span class="badge {tone}">
      <Icon name={tone === "success" ? "check" : tone === "danger" ? "alert" : "x"} size={26} />
    </span>
    <h2 class="title">{result.title}</h2>
    {#if result.message !== ""}<p class="panel-lead message">{result.message}</p>{/if}
  </div>

  {#if rows.length > 0}<Details {rows} />{/if}

  <div class="closing">
    <Icon name="terminal" size={16} />
    <span>You can close this tab. Your terminal shows what happened and what to do next.</span>
  </div>
</div>

<style>
  .panel {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 22px;
    animation: rise 180ms ease-out;
  }

  .hero {
    display: grid;
    justify-items: center;
    gap: 8px;
    padding: 12px 0 4px;
    text-align: center;
  }

  .badge {
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    margin-bottom: 6px;
    border-radius: 999px;
    background: var(--surface-sunken);
    color: var(--text-secondary);
  }

  .badge.success {
    background: var(--success-soft);
    box-shadow: 0 0 0 8px color-mix(in srgb, var(--success-soft) 55%, transparent);
    color: var(--success);
  }

  .badge.danger {
    background: var(--danger-soft);
    color: var(--danger);
  }

  .title {
    font-size: 21px;
    font-weight: 650;
    letter-spacing: -0.015em;
  }

  .message {
    max-width: 440px;
  }

  .closing {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: auto;
    padding: 12px 14px;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-secondary);
    font-size: 13px;
  }
</style>
