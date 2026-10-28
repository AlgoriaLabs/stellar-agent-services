<script lang="ts">
  import { onMount } from "svelte";
  import type { ApprovalStepView, ApprovalView } from "../../src/cli/approval-view.js";
  import ConnectPanel from "./components/ConnectPanel.svelte";
  import EndedPanel from "./components/EndedPanel.svelte";
  import Header from "./components/Header.svelte";
  import Icon from "./components/Icon.svelte";
  import ResultPanel from "./components/ResultPanel.svelte";
  import ReviewPanel from "./components/ReviewPanel.svelte";
  import Steps from "./components/Steps.svelte";
  import WorkingPanel from "./components/WorkingPanel.svelte";
  import { SessionEnded, sessionApi, sessionToken, type SessionApi } from "./lib/api.js";
  import { shortAddress, shortNetwork } from "./lib/format.js";
  import { connectWallet, signInWallet, startWallets, walletNetwork, walletProblem } from "./lib/wallet.js";

  type Pending = "" | "connecting" | "signing" | "sending" | "preparing" | "cancelling";

  let api: SessionApi | undefined;
  let view = $state<ApprovalView>();
  let ended = $state<{ title: string; message: string }>();
  let pending = $state<Pending>("");
  let notice = $state<{ title: string; message: string }>();
  let networkWarning = $state<string>();

  const final = $derived(view !== undefined && (view.state === "done" || view.state === "failed" || view.state === "cancelled"));
  const steps = $derived(view === undefined ? [] : [connectStep(view), ...view.steps]);
  const working = $derived(view !== undefined && !final && (view.state === "working" || pending === "sending" || pending === "preparing" || pending === "cancelling"));
  const activity = $derived(view === undefined ? { title: "", message: "" } : describeActivity(view, pending));

  onMount(() => {
    const token = sessionToken();
    if (token === undefined) {
      ended = {
        title: "Open this page from your terminal",
        message: "provider-kit prints a link with a one-time key when it needs your approval. Open that link to continue.",
      };
      return;
    }
    api = sessionApi(token);
    void load(api);
  });

  async function load(session: SessionApi) {
    try {
      view = await session.session();
      startWallets(view.network.passphrase);
    } catch (error) {
      lost(error);
    }
  }

  /** Sends a request to the terminal, and follows the session's progress until it answers. */
  async function run(request: (session: SessionApi) => Promise<ApprovalView>) {
    if (api === undefined) return;
    const session = api;
    let answered = false;
    const poll = setInterval(() => {
      session.session().then(
        (latest) => {
          if (!answered) view = latest;
        },
        () => {
          // The request itself reports a lost terminal.
        },
      );
    }, 1000);
    try {
      const next = await request(session);
      answered = true;
      view = next;
    } catch (error) {
      answered = true;
      lost(error);
    } finally {
      clearInterval(poll);
    }
  }

  function lost(error: unknown) {
    if (error instanceof SessionEnded) {
      if (!final) {
        ended = { title: "This page isn't connected to your terminal anymore", message: "The command finished or was stopped. Run it again for a new link." };
      }
      return;
    }
    notice = { title: "Something went wrong", message: error instanceof Error ? error.message : String(error) };
  }

  async function connect() {
    if (view === undefined) return;
    notice = undefined;
    networkWarning = undefined;
    pending = "connecting";
    try {
      const wallet = await connectWallet();
      if (wallet === undefined) return;
      const network = await walletNetwork();
      if (network !== undefined && network !== view.network.passphrase) {
        networkWarning = `${wallet.wallet} is set to another network. Switch it to ${shortNetwork(view.network.name)} before you approve.`;
      }
      await run((session) => session.connect(wallet.address, wallet.wallet));
    } catch (error) {
      notice = walletProblem(error);
    } finally {
      pending = "";
    }
  }

  async function approve() {
    const review = view?.review;
    const address = view?.connected?.address;
    if (view === undefined || review === undefined || address === undefined) return;
    notice = undefined;
    pending = "signing";
    let signed: string;
    try {
      signed = await signInWallet(review.xdr, address, view.network.passphrase);
    } catch (error) {
      notice = walletProblem(error);
      pending = "";
      return;
    }
    pending = "sending";
    await run((session) => session.submit(review.stepId, signed));
    pending = "";
  }

  async function rebuild(stepId: string) {
    notice = undefined;
    pending = "preparing";
    await run((session) => session.rebuild(stepId));
    pending = "";
  }

  async function cancel() {
    notice = undefined;
    pending = "cancelling";
    await run((session) => session.cancel());
    pending = "";
  }

  function connectStep(current: ApprovalView): ApprovalStepView {
    const { connected } = current;
    if (connected === undefined) return { id: "connect", title: "Connect wallet", status: current.state === "connect" || current.state === "working" ? "active" : "pending" };
    return { id: "connect", title: "Connect wallet", status: "done", note: `${shortAddress(connected.address)}${connected.wallet === undefined ? "" : ` · ${connected.wallet}`}` };
  }

  function describeActivity(current: ApprovalView, local: Pending): { title: string; message: string } {
    const network = current.network.name;
    if (local === "cancelling") return { title: "Cancelling", message: "Telling your terminal." };
    const text = current.state === "working" ? (current.activity ?? "") : local === "sending" ? `Sending to ${network}` : "Preparing the transaction";
    if (text.startsWith("Sending")) return { title: text, message: "Waiting for a ledger to include it, usually about 5 seconds. Keep this tab open." };
    if (text === "Get test XLM") return { title: "Getting test XLM", message: "Friendbot is funding your new testnet account. This takes a few seconds." };
    if (text === "Checking the account") return { title: "Checking your account", message: `Reading it from ${network}.` };
    return { title: "Preparing the transaction", message: `Simulating it on ${network} to set its exact resources and fee.` };
  }
</script>

<Header {view} />

<main class="page">
  {#if ended !== undefined}
    <section class="frame single">
      <EndedPanel title={ended.title} message={ended.message} />
    </section>
  {:else if view === undefined}
    <section class="frame single">
      <WorkingPanel title="Connecting to your terminal" message="One moment." />
    </section>
  {:else}
    <section class="frame" aria-labelledby="page-title">
      <aside class="side">
        <p class="eyebrow">Approve in your wallet</p>
        <h1 id="page-title">{view.title}</h1>
        <p class="intro">{view.intro}</p>
        <div class="steps-wrap"><Steps {steps} ended={view.state === "failed" ? "Stopped" : view.state === "cancelled" ? "Cancelled" : undefined} /></div>
        <p class="assurance">
          <Icon name="lock" size={14} />
          <span>Your keys stay in your wallet. This page runs on your computer and talks only to your wallet and your terminal.</span>
        </p>
      </aside>
      <div class="main">
        {#if final}
          <ResultPanel {view} />
        {:else if working}
          <WorkingPanel title={activity.title} message={activity.message} />
        {:else if view.state === "review"}
          <ReviewPanel {view} {notice} {networkWarning} signing={pending === "signing"} onapprove={approve} onrebuild={rebuild} oncancel={cancel} />
        {:else}
          <ConnectPanel {view} {notice} connecting={pending === "connecting"} onconnect={connect} oncancel={cancel} />
        {/if}
      </div>
    </section>
    <p class="footer">Served by provider-kit on this computer. Stopping the command in your terminal ends this page.</p>
  {/if}
</main>

<style>
  .page {
    max-width: 1040px;
    margin: 0 auto;
    padding: 40px 24px 48px;
  }

  .frame {
    display: grid;
    grid-template-columns: 340px minmax(0, 1fr);
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    background: var(--surface);
    box-shadow: var(--shadow-md);
  }

  .frame.single {
    grid-template-columns: minmax(0, 1fr);
    max-width: 560px;
    margin: 48px auto 0;
    padding: 44px 32px;
  }

  .side {
    display: flex;
    flex-direction: column;
    padding: 32px 28px 28px;
    border-right: 1px solid var(--border);
    background: var(--surface-sunken);
  }

  .eyebrow {
    color: var(--accent);
    font-size: 12px;
    font-weight: 650;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  h1 {
    margin-top: 8px;
    font-size: 22px;
    font-weight: 680;
    letter-spacing: -0.02em;
    line-height: 1.25;
  }

  .intro {
    margin-top: 8px;
    color: var(--text-secondary);
  }

  .steps-wrap {
    margin-top: 28px;
  }

  .assurance {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-top: auto;
    padding-top: 32px;
    color: var(--text-tertiary);
    font-size: 12.5px;
  }

  .assurance :global(svg) {
    margin-top: 2px;
  }

  .main {
    display: flex;
    flex-direction: column;
    min-height: 500px;
    padding: 32px 36px;
  }

  .footer {
    margin-top: 16px;
    color: var(--text-tertiary);
    font-size: 12px;
    text-align: center;
  }

  @media (max-width: 860px) {
    .page {
      padding: 20px 16px 32px;
    }

    .frame {
      grid-template-columns: minmax(0, 1fr);
    }

    .side {
      padding: 24px 20px;
      border-right: 0;
      border-bottom: 1px solid var(--border);
    }

    .assurance {
      padding-top: 24px;
    }

    .main {
      min-height: 0;
      padding: 24px 20px;
    }
  }
</style>
