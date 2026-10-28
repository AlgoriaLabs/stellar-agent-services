<script lang="ts">
  let { title, message }: { title: string; message: string } = $props();
</script>

<div class="panel" role="status" aria-live="polite">
  <span class="ring" aria-hidden="true"></span>
  <h2 class="panel-title">{title}…</h2>
  <p class="panel-lead">{message}</p>
</div>

<style>
  .panel {
    display: grid;
    flex: 1;
    place-content: center;
    justify-items: center;
    gap: 8px;
    min-height: 280px;
    text-align: center;
    animation: rise 180ms ease-out;
  }

  .ring {
    width: 44px;
    height: 44px;
    margin-bottom: 12px;
    border: 3px solid var(--accent-soft);
    border-top-color: var(--accent);
    border-radius: 999px;
    animation: spin 0.9s linear infinite;
  }

  .panel-lead {
    max-width: 360px;
  }
</style>
