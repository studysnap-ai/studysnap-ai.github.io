# StudySnap — Plan to Win

> Our competitive strategy and roadmap. Read this before adding features or
> spending on growth. Last updated: 2026-06-14.

---

## 1. The honest market read

The category (screenshot → AI answer for students) is real and growing, but
crowded. The leading competitor, **Quizard AI**, is a mature, multi-platform
product (Chrome + iOS + Android) with heavy marketing.

**Their "20% more accurate than ChatGPT" claim is marketing puffery**, not a
measurement — they almost certainly call the same OpenAI models we do, so the
claim is unverifiable. We will **not** copy dishonest accuracy claims. Trust is
our weapon, not invented benchmarks.

**We will not out-spend Quizard.** We are a solo founder on a small budget.
Winning means a sharp niche, better UX on specific axes, honesty, and
word-of-mouth — not a broadside against an established US-funded player.

---

## 2. Where we win (our superpowers — market these hard)

1. **Whole-quiz answering** — we detect *all* unanswered questions on screen and
   answer them in one shot, **skipping ones already answered**. Competitors are
   one-question-at-a-time. This is our headline feature and nobody else sells it.
2. **Transparency** — confidence score + 👍/👎 feedback on every answer. "We
   show how sure we are" beats "trust us, we're 20% better."
3. **Region capture** — draw a box for precision.
4. **Privacy** — we never store screenshots. A real trust differentiator.

## 3. Our unfair advantage: the LatAm / Spanish-speaking market 🌎

- The codebase already detects Spanish answer states (`correcto`, `incorrecto`,
  `verdadero`, `falso`, ...).
- The founder is Peruvian — native language, native market understanding,
  cheaper marketing, weaker competition than the US college market.
- Canvas / Moodle / Blackboard are widely used across LatAm universities.

**Decision: position StudySnap as the #1 study assistant for Spanish-speaking /
LatAm students first, then expand.** Don't fight Quizard for US college kids on
day one.

---

## 4. Feature roadmap

### Phase A — Reach parity on cheap, high-value wins (do now)
- [ ] **Keyboard shortcut** to trigger capture (manifest `commands`).
- [ ] **Type-your-own-question** box in the popup.
- [ ] **Highlight-text-to-solve** (select text → answer).
- [x] **Copy button** for free-text answers (done, pending ship).
- [x] **All-frames text extraction + screenshot-authoritative** (shipped v2.0.1).

### Phase B — Lean into the superpowers
- [ ] Polish multi-question UX; make "answers your whole quiz" the core pitch.
- [ ] Spanish-first onboarding + Spanish marketing copy.
- [ ] Math emphasis (vision handles symbols that can't be copy-pasted).

### Phase C — Platform expansion (only after A/B prove traction)
- [ ] Follow-up / chat on an answer.
- [ ] "Related resources" (web links to verify an answer).
- [ ] Mobile (big lift — defer until revenue justifies it).

---

## 5. Trust & honesty positioning

- Always show confidence + reasoning. Let students verify.
- No fabricated accuracy claims.
- Frame as a **study/learning aid** ("understand and succeed"), not a cheating
  tool. This protects the brand, app-store standing, and long-term defensibility.

---

## 6. Growth tactics (lean)

- TikTok / Instagram aimed at LatAm students (short demos of "whole quiz" magic).
- Use the **built-in referral + share system** already in the product.
- Spanish-language SEO / app-store keywords (far less contested).
- Campus / student-group word-of-mouth.

---

## 7. Monetization — PARKED (important constraint)

**The founder is on an F-1 student visa.** Earning active income from a product
you run may require work authorization (CPT / OPT / STEM OPT) — confirm with the
DSO and an immigration attorney **before** charging anyone.

Until then:
- Ship and grow the **free** version (no income exposure).
- Keep the payment code dormant and ready.

When cleared:
- **Stripe is not available for Peru payouts.** Use a **merchant-of-record**
  (Lemon Squeezy preferred — Apple Pay, handles tax, pays out to Peru via Wise).
- Recommended tiers: Free (5/day) · Pro $4.99 (~300/mo) · Ultra $9.99
  ("unlimited" with a fair-use cap + cheaper model routing so power users can't
  cost more than they pay).

---

## 8. Guardrails / constraints

- Solo founder, small budget → favor cheap, high-leverage moves.
- F-1 status → no active monetization until authorized.
- Per-capture OpenAI cost is real → protect margins with caps + model routing.
- Don't chase feature parity for its own sake; win the niche first.
