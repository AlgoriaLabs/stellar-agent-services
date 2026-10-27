# Instawards SOW: Stellar Agent MCP

> Copied from the [Google Doc](https://docs.google.com/document/d/1kIJ5nkwIVaXqHqcNHwuI5JN0Ap6g86wzncMQya6Kv88/edit?tab=t.0) on 2026-10-27. The doc is the source of truth.

**1\. Project & Team Information**

| Project Name:  | Stellar Agent MCP |
| :---- | :---- |
| **Builder / Team Name:**  | Berkin Gürcan |
| **Primary Contact (Name \+ Email):**  | Berkin, berkingurcan@gmail.com |
| **Ambassador Chapter:**  | Stellar Turkiye |
| **Ambassador Chapter Lead:** | **İrem Koçi(Stellar Türkiye)** |
| **Date Submitted:**  | 29.09.2026 |
| **Suggested Sprint Start Date:** |  |

**2\. Instawards Overview & Intent**

**2.1 Instawards Purpose (for Builder Context)**  
Instawards are designed to support short, clearly scoped, execution-focused work that helps a project make tangible progress toward building on Stellar. Instawards are meant to fund specific, achievable outcomes that can be completed and demonstrated within 30 days or less.

This SOW represents a shared commitment between the Builder and the Ambassador Chapter Lead on what will be delivered, why it matters, and how success will be verified.

**3\. Problem Statement & Objective**

| Problem Being Addressed | What specific problem, gap, or blocker is this Instaward intended to solve? | Stellar Agent Search can help users find AI services, and the Algoria hackathon prototype showed that users can pay for and receive those services. The missing part is a simple standard and toolkit that allows independent developers to connect their services safely, receive payments, prove basic checks and recover delayed jobs.  |
| :---- | :---- | :---- |
| **Objective of This Instaward** | In one or two sentences, what will be true at the end of 30 days if this Instaward is successful? | Within 30 days, I will add a Provider Standard, Provider Kit, safe payment client, verification receipts, Stellar 8004 Validation Registry records and Job Recovery to Stellar Agent Search. I will demonstrate the completed flow with two independent providers, two users and public evidence. |

**4\. Scope of Work (30-Day Deliverables)**

**Important guidance:** This scope must be achievable within **30 calendar days**. If the work feels larger, it should be reduced or split into more achievable phases.

**4.1 In-Scope Deliverables**

| Deliverable | Description (What will be built or produced?) | Why this matters |
| ----- | ----- | ----- |
| Deliverable 1 | **Provider Standard and Safe Payment Client** I will publish Provider Standard v1, defining how a service describes its purpose, input, output, price, network, job status and result. I will also build a payment client that shows the payment details, applies spending controls and requires user approval. | Developers need one clear standard for connecting services. Users need to understand and control payments before money is sent. |
| Deliverable 2 | **Provider Kit, Verification and Job Recovery**I will publish an open-source Provider Kit, setup guide and sample service. It will include provider checks, clear verification receipts and badges, Stellar 8004 Validation Registry publishing, and Job Recovery for collecting delayed results without paying twice. | This makes provider integration easier, gives users understandable evidence and protects users when an external service takes longer than expected. |
| Deliverable 3  | **Independent Provider Pilot and Public Evidence** I will onboard three independent providers and run the complete flow with five users. Each provider will complete at least one paid service call. I will demonstrate Job Recovery and publish the demo, guide, receipts, payment references, validation records and pilot report. Provider and user pilot incentives are included. | Independent integrations and user testing will demonstrate that the system works outside my own sample service and provide verifiable evidence of completion. |
| **Out-of-Scope (Explicitly Not Included)** List anything that might be assumed but is not included in this Instaward scope. |  |  |
|  | Building a new blockchain registry or protocol; implementing the complete ERC-8126 specification; zero-knowledge proofs; a formal security audit; a full consumer marketplace; a custody service; more than two pilot providers or five pilot users; guaranteed long-term adoption, revenue or production availability. | These items require a larger scope and are not necessary to demonstrate the proposed 30-day provider flow. |

**4.2 Deliverable-Aligned Budget Request**

| Requested Budget Amount  | Rationale for Budget Request |
| ----- | ----- |
| \$4000  | \$4,000 will support a focused 30-day development sprint covering development, testing, documentation and public evidence for the Provider Standard, safe Payment Client, Provider Kit, verification system, Validation Registry integration and Job Recovery.  |

**5\. 30-Day Execution Plan & Timeline**

**5.1 Weekly Breakdown**

| Week | Planned Work | Expected Output |
| ----- | ----- | ----- |
| Week 1 | Finalize Provider Standard v1. Build the safe Payment Client with wallet separation, spending controls and explicit approval. Define the verification receipt format. | Published provider specification, working Payment Client and one successful sample payment flow. |
| Week 2 | Build and document the open-source Provider Kit. Add service setup, price display, payment request and result delivery. Create one sample provider and payment-safety tests. | A developer can install the kit from a clean setup, start the sample provider and complete an end-to-end paid request. |
| Week 3 | Add provider verification checks, receipts and badges. Publish verification summaries to the Stellar 8004 Validation Registry. Implement Job Recovery using create-job, check-status and get-result. | The sample provider produces a verification receipt and validation record. One interrupted job is recovered without a second payment. |
| Week 4 | Onboard two independent providers and run at least one paid service call with each. Complete the full flow with two users, fix pilot-blocking issues and prepare public evidence. | Three working provider integrations, five completed user flows, one Job Recovery demonstration, a public demo, documentation, payment references and pilot report. |

**6\. Evidence of Completion (Required)**

**Important guidance:** Evidence should be clear, verifiable, and easy to review by the Ambassador Chapter Lead **with minimal technical expertise**.

**6.1 Planned Evidence to Be Submitted**

| Deliverable | Evidence Type  (link, repo, demo, screenshot, doc, tx hash, etc.) | Description |
| ----- | ----- | ----- |
| Deliverable 1 | Public specification, short demo video, screenshots and payment transaction link | The specification will show the information every provider must supply. A short video will show the price, payment recipient, spending control and user approval before a successful test payment. |
| Deliverable 2 | Public repository, setup guide, verification receipt, Validation Registry record and recovery demo | The guide will show how a developer connects a service. A short demo will show the verification badges and receipt, the published Stellar 8004 record, and a delayed result being recovered without another payment. |
| Deliverable 3 | Provider links, payment references, screenshots, pilot report and public evidence page | The evidence page will show two independent provider integrations, at least one paid call for each provider, two completed user flows and the main findings and fixes from the pilot. |

**6.2 Evidence Verification Checklist (For Ambassador Use)**

For each deliverable, the Ambassador Chapter Lead will assess whether evidence is present and sufficient.

| Deliverable | Evidence Present | Evidence  Partial | Evidence Missing | Comments |
| ----- | :---: | :---: | :---: | ----- |
| Deliverable 1 | ☐ | ☐ | ☐ |  |
| Deliverable 2 | ☐ | ☐ | ☐ |  |
| Deliverable 3 | ☐ | ☐ | ☐ |  |

