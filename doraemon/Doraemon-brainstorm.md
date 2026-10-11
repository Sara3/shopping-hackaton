# Doraemon — Rework Brainstorm (PM / Designer / Engineer)

## 1. The opportunity, as it stands

**Product:** Doraemon — a WhatsApp-native AI commerce agent built for Arcade AI's "Shopping 3.0" hackathon (SF Tech Week, Oct 11, 2026).

**Flow today:** judge scans a QR code → pre-filled WhatsApp join message to a Twilio sandbox → describes a product in chat → agent calls Arcade's API for a single best-match product + merchant + instant price (confirm) → agent calls Grail's (withsavvy.ai) MCP server for a card-benefit recommendation (confirm) → agent mints a scoped, single-use Stripe Issuing (test mode) virtual card as the concrete form of an authorization credential → order placed through Arcade.

**Target segment (hackathon framing):** judges evaluating AI-agent commerce demos (Forerunner Ventures, Mariam Naficy/Arcade, Ash Herr). Beyond the hackathon, the underlying segment is consumers who want to go from a described idea to a real, delivered physical product inside a single chat thread, without separately worrying about payment safety or leaving rewards on the table.

**Outcome wanted:** describe a product → get a real, priced option instantly → buy it safely, with spend scoped and authorized → get the best card benefit — all without leaving the chat.

**Known constraints feeding this brainstorm:** Arcade's hackathon API isn't documented yet (Discord, no docs as of this writing); Stripe Issuing test-mode mechanics are assumed but unverified; Grail's MCP server is real and already confirmed reachable; timeline is ~2 days.

---

## 2. Ideas by perspective

### Product Manager — market fit, value creation, competitive advantage

1. **Gift mode.** A one-tap flow for "find X for [person/occasion] under $Y" that packages product + card + authorization into a single confirm. Positions Doraemon as the fastest idea-to-purchase path in the Arcade ecosystem.
2. **Trust receipt.** After every purchase, send a human-readable receipt: what was authorized, for how much, expiring when, under which credential. Turns an invisible security mechanism into a visible trust artifact — directly supports the agent-identity angle.
3. **Bring-your-own-agent mode.** Let an external agent (not just Doraemon's own chat UI) request a scoped credential from the same authorization service to place one Arcade order. Turns the internal auth plumbing into a real instance of the "agents transacting with agents" thesis.
4. **Creator/affiliate loop.** A finished product can be forwarded as a WhatsApp message; the recipient taps "make one for me too." Gives the demo a shareable, viral mechanic — matches Arcade's own suggested "creator merch" angle.
5. **Price-lock window.** Since Arcade's pricing is instant and guaranteed (not actually negotiable), reframe "negotiation" honestly as a time-boxed decision window: "I'll hold this spec and price for 10 minutes." Real feature, not fake haggling.

### Product Designer — UX, onboarding, engagement

1. **Zero-typing onboarding.** Extend the QR → pre-filled WhatsApp pattern throughout: every non-free-text step (confirm, pick card, pick variant) uses WhatsApp quick-reply buttons, not "reply yes." The whole demo should read as tap-tap-tap.
2. **Visual spec confirmation.** Send the AI-rendered product image inline at checkpoint 1, so the judge confirms something they can see, not just a text description.
3. **"Show your work" card-pick explainer.** At checkpoint 2, show a small comparison — recommended card's benefit vs. next-best card's benefit — sourced from Grail's real numbers. Makes the rewards optimization legible in five seconds instead of asserted.
4. **Progress breadcrumbs.** A one-line status header on each agent message ("Step 3/5: confirming payment") so anyone glancing at the phone mid-conversation knows where they are.
5. **Graceful-failure persona.** A designed, in-character fallback message for when a live API call fails (real risk given current unknowns), rather than a raw error — keeps the demo's story intact even if a dependency hiccups.

### Software Engineer — technical innovation, integrations, platform capabilities

1. **Capability-token verifier as its own service.** Build the self-authorization check as a standalone, independently deployable/testable service rather than inline chat-handler logic — also makes the PM's "bring-your-own-agent" idea reachable later without a rebuild.
2. **Idempotency + replay protection.** Every signed capability carries a nonce and is single-use at the verifier, so a duplicate Twilio webhook delivery (common and expected) can never cause a double-authorization or double order.
3. **Stub/live adapter for Arcade.** Build the Arcade client behind a narrow interface with a stub implementation now, swapped for the live one the moment docs/keys arrive — directly addresses the project's single biggest open risk.
4. **Correlation-ID tracing per order.** Tag every hop (spec → Arcade → Grail → Stripe → Arcade order) with one ID logged at each step, so a live failure can be diagnosed from one timeline instead of guesswork.
5. **Explicit WhatsApp session state machine.** Model the conversation as states (intake → priced → card-chosen → authorized → ordered) enforced in code, not left to LLM memory — makes the "explicit confirmation is the hard boundary" rule unskippable rather than merely requested.

---

## 3. Top 5, prioritized

Weighted toward: core value delivery, speed to validate, differentiation potential.

| # | Idea | Perspective |
|---|------|-------------|
| 1 | Stub/live adapter for Arcade | Engineer |
| 2 | Explicit WhatsApp session state machine | Engineer |
| 3 | "Show your work" card-pick explainer | Designer |
| 4 | Trust receipt | PM |
| 5 | Graceful-failure persona | Designer |

### 1. Stub/live adapter for Arcade
**Reasoning:** the entire demo is currently blocked on an external unknown (undocumented Arcade API). This doesn't touch the user experience, but it's the one piece of work that de-risks everything else and can be built starting today, independent of Arcade.
**Key assumption to test:** the real Arcade API, once seen, will be close enough to the public description (generate + price, possibly order) that swapping stub → live won't force a redesign.
**Validate by:** keeping the stub interface narrow — scoped only to what's publicly confirmed — and re-checking it the moment real docs appear.

### 2. Explicit WhatsApp session state machine
**Reasoning:** this is what actually *enforces* the explicit-confirmation rule central to both the safety story and the project's constitution, rather than hoping the model remembers not to skip a step under conversational pressure.
**Key assumption to test:** a state-machine-constrained conversation can still feel natural rather than robotic to a judge typing freely.
**Validate by:** a full dry-run conversation script against mocked API responses before the event.

### 3. "Show your work" card-pick explainer
**Reasoning:** the single most legible proof that the Grail integration does something real — a judge can check the math in five seconds instead of taking "optimized" on faith.
**Key assumption to test:** Grail's MCP response actually includes a comparable second option, not just one recommendation with no baseline to contrast against.
**Validate by:** making a real test call to Grail's MCP server this week and inspecting the actual response shape.

### 4. Trust receipt
**Reasoning:** converts the invisible authorization/credential mechanism into something a judge can literally read and question — turns the project's stated differentiator (agent identity/authorization) into evidence inside the demo itself.
**Key assumption to test:** every field worth showing (credential scope, expiry, card-choice rationale) is already available at the end of the flow without extra calls.
**Validate by:** drafting the receipt template directly against the data the state machine already holds at each step.

### 5. Graceful-failure persona
**Reasoning:** given the real, already-flagged risk that Arcade/Grail/Stripe calls could fail live, this protects the single thing that matters most — a working end-to-end story — from technical risk that is otherwise likely.
**Key assumption to test:** failures surface early enough within a step that a fallback message never contradicts what already happened (e.g., offering to "try again" after a charge already went through).
**Validate by:** deliberately breaking each integration point in rehearsal and confirming the fallback message never misrepresents state.
