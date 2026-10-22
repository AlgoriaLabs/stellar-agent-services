<script lang="ts">
  import { ManifestError, ProviderError, type Quote } from "@stellar-agent-services/payment-client";
  import type { ProviderManifest } from "@stellar-agent-services/protocol";
  import { messageOf, type AgentWallet } from "../lib/agent-wallet.svelte.js";
  import { formatAmount, formatDuration, hostOf } from "../lib/format.js";
  import { formFields, initialValues, readForm, readJson, type FormValues } from "../lib/schema-form.js";
  import ApprovalDialog from "./ApprovalDialog.svelte";
  import Icon from "./Icon.svelte";

  let { app }: { app: AgentWallet } = $props();

  const SAMPLE_MANIFEST = "http://localhost:8787/.well-known/stellar-agent-services.json";

  let manifestUrl = $state("");
  let manifest = $state.raw<ProviderManifest>();
  /** The URL the shown manifest came from: quotes use it, not whatever is typed now. */
  let loadedUrl = $state("");
  let loading = $state(false);
  let loadError = $state<string>();

  let serviceName = $state<string>();
  const service = $derived(manifest?.services.find((candidate) => candidate.name === serviceName));
  const fields = $derived(service === undefined ? undefined : formFields(service.inputSchema));
  let values = $state<FormValues>({});
  let jsonText = $state("");
  let errors = $state<Record<string, string>>({});

  let quoting = $state(false);
  let quoteError = $state<string>();
  let quote = $state.raw<Quote>();

  async function load(url: string) {
    loading = true;
    loadError = undefined;
    try {
      const loaded = await app.fetchManifest(url.trim());
      manifest = loaded;
      loadedUrl = manifestUrl = url.trim();
      selectService(loaded.services[0]!.name);
    } catch (error) {
      manifest = undefined;
      loadError = explainLoadError(error);
    }
    loading = false;
  }

  function selectService(name: string) {
    const selected = manifest?.services.find((candidate) => candidate.name === name);
    if (selected === undefined) return;
    serviceName = name;
    const example = selected.examples?.[0]?.input;
    const selectedFields = formFields(selected.inputSchema);
    values = selectedFields === undefined ? {} : initialValues(selectedFields, example);
    jsonText = JSON.stringify(example ?? {}, null, 2);
    errors = {};
    quoteError = undefined;
  }

  async function review(event: SubmitEvent) {
    event.preventDefault();
    if (service === undefined) return;
    const read = fields === undefined ? readJson(jsonText) : readForm(fields, $state.snapshot(values));
    if ("errors" in read) return void (errors = read.errors);
    if ("error" in read) return void (errors = { json: read.error });
    errors = {};
    quoting = true;
    quoteError = undefined;
    try {
      quote = await app.quote(loadedUrl, service.name, read.input);
    } catch (error) {
      quoteError = explainQuoteError(error);
    }
    quoting = false;
  }

  function explainLoadError(error: unknown): string {
    if (error instanceof ManifestError) return `This is not a valid provider manifest: ${error.message}`;
    if (error instanceof TypeError && /fetch|network|load/i.test(error.message)) {
      return "The provider could not be reached. Check the address, and that the provider allows requests from web pages (CORS).";
    }
    if (error instanceof TypeError) return "Enter the full address, starting with https://";
    return messageOf(error);
  }

  function explainQuoteError(error: unknown): string {
    if (error instanceof ProviderError && error.status === 400) {
      return `The provider did not accept this request${error.problem?.detail ? `: ${error.problem.detail}` : "."}`;
    }
    if (error instanceof TypeError && /fetch|network|load/i.test(error.message)) return "The provider could not be reached. Nothing was paid.";
    return `${messageOf(error)}. Nothing was paid.`;
  }

  function networkName(network: string): string {
    return network === "stellar:testnet" ? "Stellar testnet" : network === "stellar:pubnet" ? "Stellar mainnet" : network;
  }

  function textValue(name: string): string {
    const value = values[name];
    return typeof value === "string" ? value : "";
  }
</script>

<div class="intro">
  <h1>Pay for an AI service</h1>
  <p>Choose a provider and a service. You see the exact price and who gets paid before anything is paid.</p>
</div>

<div class="steps">
  <section class="card" aria-labelledby="provider-title">
    <header class="step-head">
      <span class="step-number" class:done={manifest !== undefined}>
        {#if manifest !== undefined}<Icon name="check" size={13} />{:else}1{/if}
      </span>
      <div>
        <h2 id="provider-title" class="card-title">Provider</h2>
        <p class="card-subtitle">Paste the address of a provider's manifest.</p>
      </div>
    </header>

    <form class="provider-form" onsubmit={(event) => (event.preventDefault(), load(manifestUrl))}>
      <label class="visually-hidden" for="manifest-url">Manifest URL</label>
      <input
        id="manifest-url"
        class="input mono"
        type="url"
        placeholder="https://provider.example/.well-known/stellar-agent-services.json"
        spellcheck="false"
        autocomplete="off"
        bind:value={manifestUrl}
      />
      <button class="btn btn-secondary" type="submit" disabled={loading || manifestUrl.trim() === ""}>
        {#if loading}<Icon name="spinner" /> Loading{:else}Load{/if}
      </button>
    </form>
    {#if app.allowLocalhost && manifest === undefined && !loading}
      <p class="hint">
        Running the sample provider?
        <button type="button" class="link-button" onclick={() => load(SAMPLE_MANIFEST)}>Use localhost:8787</button>
      </p>
    {/if}

    {#if loadError !== undefined}
      <div class="alert alert-danger spaced" role="alert">
        <Icon name="alert" />
        <div>{loadError}</div>
      </div>
    {/if}

    {#if manifest !== undefined}
      <div class="provider">
        <span class="provider-icon"><Icon name="server" size={18} /></span>
        <div class="provider-text">
          <div class="provider-name">{manifest.provider.name}</div>
          <div class="provider-meta">{hostOf(manifest.baseUrl)} · {networkName(manifest.payment.accepts[0].network)}</div>
        </div>
        <span class="pill pill-success"><Icon name="check" size={12} /> Provider Standard v1</span>
      </div>
    {/if}
  </section>

  {#if manifest !== undefined}
    <section class="card" aria-labelledby="service-title">
      <header class="step-head">
        <span class="step-number" class:done={service !== undefined}>
          {#if service !== undefined}<Icon name="check" size={13} />{:else}2{/if}
        </span>
        <div>
          <h2 id="service-title" class="card-title">Service</h2>
          <p class="card-subtitle">Prices are per request, in USDC.</p>
        </div>
      </header>

      <div class="services" role="radiogroup" aria-labelledby="service-title">
        {#each manifest.services as candidate (candidate.name)}
          <label class="service" class:selected={candidate.name === serviceName}>
            <input
              class="visually-hidden"
              type="radio"
              name="service"
              value={candidate.name}
              checked={candidate.name === serviceName}
              onchange={() => selectService(candidate.name)}
            />
            <span class="radio" aria-hidden="true"></span>
            <span class="service-body">
              <span class="service-title">{candidate.title ?? candidate.name}</span>
              <span class="service-description">{candidate.description}</span>
              <span class="service-meta">
                <span class="pill">{candidate.charge === "on-success" ? "Charged only if it works" : "Charged up front"}</span>
                {#if candidate.expectedDurationSeconds !== undefined}
                  <span class="pill"><Icon name="clock" size={12} /> {formatDuration(candidate.expectedDurationSeconds)}</span>
                {/if}
              </span>
            </span>
            <span class="service-price">
              <span class="num">{formatAmount(candidate.price.amount)}</span>
              <span class="unit">USDC</span>
            </span>
          </label>
        {/each}
      </div>
    </section>
  {/if}

  {#if service !== undefined}
    <section class="card" aria-labelledby="request-title">
      <header class="step-head">
        <span class="step-number">3</span>
        <div>
          <h2 id="request-title" class="card-title">Request</h2>
          <p class="card-subtitle">What {service.title ?? service.name} should work on.</p>
        </div>
      </header>

      <form onsubmit={review} novalidate>
        {#if fields === undefined}
          <div class="field">
            <label class="label" for="input-json">Input (JSON)</label>
            <textarea id="input-json" class="input mono" rows="8" spellcheck="false" aria-invalid={errors["json"] !== undefined} bind:value={jsonText}
            ></textarea>
            {#if errors["json"] !== undefined}<p class="field-error">{errors["json"]}</p>{/if}
          </div>
        {:else}
          {#each fields as field (field.name)}
            <div class="field">
              {#if field.kind === "boolean"}
                <label class="checkbox">
                  <input
                    type="checkbox"
                    checked={values[field.name] === true}
                    onchange={(event) => (values[field.name] = event.currentTarget.checked)}
                  />
                  <span>{field.label}</span>
                </label>
              {:else}
                <label class="label" for="field-{field.name}">
                  {field.label}{#if !field.required}<span class="optional"> · optional</span>{/if}
                </label>
                {#if field.kind === "text" && field.multiline}
                  <textarea
                    id="field-{field.name}"
                    class="input"
                    rows="4"
                    maxlength={field.maxLength}
                    aria-invalid={errors[field.name] !== undefined}
                    value={textValue(field.name)}
                    oninput={(event) => (values[field.name] = event.currentTarget.value)}
                  ></textarea>
                {:else if field.kind === "choice"}
                  <select
                    id="field-{field.name}"
                    class="input"
                    aria-invalid={errors[field.name] !== undefined}
                    value={textValue(field.name)}
                    onchange={(event) => (values[field.name] = event.currentTarget.value)}
                  >
                    {#if !field.required}<option value="">None</option>{/if}
                    {#each field.options as option (option)}<option value={String(option)}>{option}</option>{/each}
                  </select>
                {:else}
                  <input
                    id="field-{field.name}"
                    class="input"
                    type={field.kind === "number" ? "number" : "text"}
                    step={field.kind === "number" ? (field.integer ? 1 : "any") : undefined}
                    maxlength={field.kind === "text" ? field.maxLength : undefined}
                    aria-invalid={errors[field.name] !== undefined}
                    value={textValue(field.name)}
                    oninput={(event) => (values[field.name] = event.currentTarget.value)}
                  />
                {/if}
                <div class="field-foot">
                  {#if errors[field.name] !== undefined}
                    <p class="field-error">{errors[field.name]}</p>
                  {:else if field.description !== undefined}
                    <p class="help">{field.description}</p>
                  {/if}
                  {#if field.kind === "text" && field.maxLength !== undefined}
                    <p class="help counter num">{textValue(field.name).length.toLocaleString("en-US")} / {field.maxLength.toLocaleString("en-US")}</p>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        {/if}

        {#if quoteError !== undefined}
          <div class="alert alert-danger spaced" role="alert">
            <Icon name="alert" />
            <div>{quoteError}</div>
          </div>
        {/if}

        <div class="form-actions">
          <button class="btn btn-primary btn-lg" type="submit" disabled={quoting || app.wallet === undefined}>
            {#if quoting}<Icon name="spinner" /> Getting the exact price{:else}Review payment <Icon name="arrow" />{/if}
          </button>
          <span class="reassurance"><Icon name="lock" size={13} /> Nothing is paid until you approve.</span>
        </div>
        {#if app.wallet === undefined}
          <p class="help">Create a test wallet first. It takes a few seconds.</p>
        {/if}
      </form>
    </section>
  {/if}
</div>

{#if quote !== undefined}
  <ApprovalDialog {app} {quote} onclose={() => (quote = undefined)} />
{/if}

<style>
  .intro {
    margin-bottom: 20px;
  }

  h1 {
    font-size: 26px;
    font-weight: 680;
    letter-spacing: -0.02em;
    line-height: 1.2;
  }

  .intro p {
    max-width: 560px;
    margin-top: 6px;
    color: var(--text-secondary);
    font-size: 15px;
  }

  .steps {
    display: grid;
    gap: 16px;
  }

  .step-head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 16px;
  }

  .step-number {
    display: grid;
    flex: none;
    place-items: center;
    width: 26px;
    height: 26px;
    margin-top: 1px;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 650;
  }

  .step-number.done {
    border-color: var(--success-border);
    background: var(--success-soft);
    color: var(--success);
  }

  .provider-form {
    display: flex;
    gap: 8px;
  }

  .provider-form .input {
    font-size: 13px;
  }

  .hint {
    margin-top: 10px;
    color: var(--text-tertiary);
    font-size: 13px;
  }

  .spaced {
    margin-top: 12px;
  }

  .provider {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 14px;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-sunken);
  }

  .provider-icon {
    display: grid;
    flex: none;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 9px;
    background: var(--accent-soft);
    color: var(--accent);
  }

  .provider-text {
    flex: 1;
    min-width: 0;
  }

  .provider-name {
    font-weight: 600;
  }

  .provider-meta {
    color: var(--text-tertiary);
    font-size: 13px;
  }

  .services {
    display: grid;
    gap: 10px;
  }

  .service {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    cursor: pointer;
    transition:
      border-color 120ms ease,
      background-color 120ms ease,
      box-shadow 120ms ease;
  }

  .service:hover {
    border-color: var(--border-strong);
  }

  .service.selected {
    border-color: var(--accent);
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .service:has(input:focus-visible) {
    box-shadow: var(--ring);
  }

  .radio {
    flex: none;
    width: 18px;
    height: 18px;
    margin-top: 2px;
    border: 1.5px solid var(--border-strong);
    border-radius: 999px;
    background: var(--surface);
  }

  .selected .radio {
    border: 5px solid var(--accent-solid);
  }

  .service-body {
    display: grid;
    flex: 1;
    gap: 4px;
    min-width: 0;
  }

  .service-title {
    font-weight: 600;
  }

  .service-description {
    color: var(--text-secondary);
    font-size: 13px;
  }

  .service-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 4px;
  }

  .service-price {
    flex: none;
    text-align: right;
  }

  .service-price .num {
    font-size: 17px;
    font-weight: 650;
  }

  .unit {
    margin-left: 2px;
    color: var(--text-tertiary);
    font-size: 12px;
    font-weight: 500;
  }

  .checkbox {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-weight: 500;
    cursor: pointer;
  }

  .checkbox input {
    width: 16px;
    height: 16px;
    accent-color: var(--accent-solid);
  }

  .field-foot {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }

  .counter {
    margin-left: auto;
  }

  .form-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 14px;
    margin-top: 20px;
  }

  .reassurance {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-tertiary);
    font-size: 13px;
  }

  @media (max-width: 560px) {
    .provider-form {
      flex-direction: column;
    }

    .provider {
      flex-wrap: wrap;
    }

    .form-actions .btn {
      width: 100%;
    }
  }
</style>
