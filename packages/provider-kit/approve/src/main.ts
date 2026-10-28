// The approval page: where a provider's owner approves provider-kit's transactions in their own wallet.
// It renders the session the terminal sends (src/cli/approval-view.ts), and its only job besides is the
// wallet: connecting it and asking it to sign. Nothing here holds a key.

import "./polyfills.js";
import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";

mount(App, { target: document.getElementById("app")! });
