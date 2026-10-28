<script lang="ts">
  import Icon from "./Icon.svelte";

  let { title, message }: { title: string; message: string } = $props();
</script>

<div class="panel" role="status">
  <span class="badge"><Icon name="terminal" size={24} /></span>
  <h1 class="panel-title">{title}</h1>
  <p class="panel-lead">{message}</p>
</div>

<style>
  .panel {
    display: grid;
    justify-items: center;
    gap: 8px;
    text-align: center;
    animation: rise 180ms ease-out;
  }

  .badge {
    display: grid;
    place-items: center;
    width: 52px;
    height: 52px;
    margin-bottom: 8px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--surface-sunken);
    color: var(--text-secondary);
  }

  .panel-lead {
    max-width: 400px;
  }
</style>
