<script lang="ts">
  import Icon from "./Icon.svelte";

  let { value, label = "Copy" }: { value: string; label?: string } = $props();
  let copied = $state(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // The clipboard is blocked: the value is still on screen to select by hand.
    }
  }
</script>

<button type="button" class="btn btn-ghost btn-icon" onclick={copy} title={copied ? "Copied" : label} aria-label={copied ? "Copied" : label}>
  <Icon name={copied ? "check" : "copy"} size={15} />
</button>
