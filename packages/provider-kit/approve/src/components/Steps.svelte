<script lang="ts">
  import type { ApprovalStepView } from "../../../src/cli/approval-view.js";
  import Icon from "./Icon.svelte";

  // `ended` names how a session that stopped early ended, for the step it stopped at.
  let { steps, ended }: { steps: ApprovalStepView[]; ended?: string | undefined } = $props();
</script>

<ol class="steps">
  {#each steps as step, index (step.id)}
    <li class="step {step.status}" class:halted={ended !== undefined && step.status === "active"} aria-current={step.status === "active" ? "step" : undefined}>
      <span class="marker">
        {#if step.status === "done"}<Icon name="check" size={14} />{:else}{index + 1}{/if}
      </span>
      <div class="text">
        <span class="title">{step.title}</span>
        {#if step.note !== undefined}
          <span class="note">
            {step.note}
            {#if step.transaction !== undefined}
              · <a href={step.transaction.url} target="_blank" rel="noopener noreferrer">View transaction</a>
            {/if}
          </span>
        {:else if step.status === "active"}
          <span class="note" class:current={ended === undefined}>{ended ?? "In progress"}</span>
        {/if}
      </div>
      <span class="visually-hidden">{step.status === "done" ? "Done" : step.status === "active" ? "Current step" : "Not started"}</span>
    </li>
  {/each}
</ol>

<style>
  .steps {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .step {
    position: relative;
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr);
    gap: 12px;
    padding-bottom: 22px;
  }

  .step:last-child {
    padding-bottom: 0;
  }

  /* The line to the next step. */
  .step:not(:last-child)::before {
    content: "";
    position: absolute;
    top: 32px;
    bottom: 4px;
    left: 13.5px;
    width: 1px;
    background: var(--border-strong);
  }

  .step.done:not(:last-child)::before {
    background: var(--success-border);
  }

  .marker {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-tertiary);
    font-size: 12.5px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    transition:
      background-color 160ms ease,
      border-color 160ms ease,
      color 160ms ease;
  }

  .active .marker {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    box-shadow: 0 0 0 4px var(--accent-soft);
  }

  .done .marker {
    border-color: var(--success);
    background: var(--success);
    color: var(--surface);
  }

  /* The step a stopped or cancelled session ended at. */
  .halted .marker {
    border-color: var(--border-strong);
    background: var(--surface);
    color: var(--text-tertiary);
    box-shadow: none;
  }

  .text {
    display: grid;
    gap: 1px;
    padding-top: 4px;
    min-width: 0;
  }

  .title {
    color: var(--text-tertiary);
    font-weight: 550;
  }

  .active .title,
  .done .title {
    color: var(--text);
  }

  .note {
    color: var(--text-tertiary);
    font-size: 12.5px;
    overflow-wrap: anywhere;
  }

  .note.current {
    color: var(--accent);
    font-weight: 500;
  }
</style>
