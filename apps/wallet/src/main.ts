import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import OtherTab from "./components/OtherTab.svelte";

const target = document.getElementById("app")!;

// A journal has one writer (payment-client/browser), so the wallet runs in one tab at a time.
if ("locks" in navigator) {
  void navigator.locks.request("agent-wallet", { ifAvailable: true }, async (lock) => {
    if (lock === null) {
      mount(OtherTab, { target });
      return;
    }
    mount(App, { target });
    // Held for as long as this tab is open.
    await new Promise(() => {});
  });
} else {
  mount(App, { target });
}
