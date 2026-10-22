<script lang="ts">
  import Icon from "./Icon.svelte";
</script>

<main class="other-tab">
  <div class="card">
    <span class="icon"><Icon name="info" size={20} /></span>
    <h1 class="card-title">Agent Wallet is open in another tab</h1>
    <p class="card-subtitle">
      Your payment journal can only be written from one tab at a time, so no payment is ever recorded twice. Close the other tab,
      then reload this one.
    </p>
    <button class="btn btn-secondary" type="button" onclick={() => location.reload()}>Reload</button>
  </div>
</main>

<style>
  .other-tab {
    display: grid;
    place-items: center;
    min-height: 100vh;
    padding: 24px;
  }

  .card {
    display: grid;
    justify-items: start;
    gap: 8px;
    max-width: 440px;
    padding: 28px;
  }

  .icon {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    margin-bottom: 4px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
  }

  .card-subtitle {
    margin-bottom: 12px;
  }
</style>
