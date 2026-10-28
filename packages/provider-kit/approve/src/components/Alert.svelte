<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";

  let { tone, title, message, children }: { tone: "warning" | "danger"; title: string; message?: string; children?: Snippet } = $props();
</script>

<div class="alert alert-{tone}" role={tone === "danger" ? "alert" : "status"}>
  <Icon name={tone === "danger" ? "alert" : "info"} size={16} />
  <div class="body">
    <p class="alert-title">{title}</p>
    {#if message !== undefined}<p class="message">{message}</p>{/if}
    {@render children?.()}
  </div>
</div>

<style>
  .body {
    min-width: 0;
  }

  .message {
    margin-top: 2px;
    overflow-wrap: anywhere;
  }
</style>
