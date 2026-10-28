<script lang="ts">
  import type { ApprovalDetail } from "../../../src/cli/approval-view.js";
  import CopyButton from "./CopyButton.svelte";
  import Icon from "./Icon.svelte";

  // Rows of label and value. Addresses, hashes and ids are shown in full, in monospace, and the long ones get a
  // copy button: the developer can compare them with what their wallet shows.
  let { rows }: { rows: ApprovalDetail[] } = $props();
</script>

<dl class="details">
  {#each rows as row, index (index)}
    <div class="row">
      <dt>{row.label}</dt>
      <dd class:mono-row={row.mono}>
        {#if row.href !== undefined}
          <a class="value" class:mono={row.mono} href={row.href} target="_blank" rel="noopener noreferrer">
            {row.value}<Icon name="external" size={12} />
          </a>
        {:else}
          <span class="value" class:mono={row.mono}>{row.value}</span>
        {/if}
        {#if row.mono && row.value.length > 24}<CopyButton value={row.value} label="Copy {row.label.toLowerCase()}" />{/if}
      </dd>
    </div>
  {/each}
</dl>

<style>
  .details {
    margin: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
  }

  .row {
    display: grid;
    grid-template-columns: 132px minmax(0, 1fr);
    gap: 16px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
  }

  .row:last-child {
    border-bottom: 0;
  }

  dt {
    padding-top: 1px;
    color: var(--text-tertiary);
    font-size: 13px;
  }

  dd {
    display: flex;
    align-items: flex-start;
    gap: 4px;
    min-width: 0;
    margin: 0;
    font-size: 13.5px;
    font-weight: 500;
  }

  .mono-row {
    margin: -6px 0;
    align-items: center;
  }

  .value {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .value.mono {
    font-size: 12.5px;
    line-height: 1.45;
  }

  a.value {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
  }

  a.value :global(svg) {
    align-self: center;
    opacity: 0.7;
  }

  @media (max-width: 560px) {
    .row {
      grid-template-columns: minmax(0, 1fr);
      gap: 2px;
    }

    .mono-row {
      margin: 0 0 -6px;
    }
  }
</style>
