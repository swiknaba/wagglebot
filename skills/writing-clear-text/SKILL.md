---
name: writing-clear-text
description: Use when drafting or revising an important explanation, summary, update, or reader-facing prose where attention, factual precision, and natural voice matter.
---

# Writing Clear Text

## Aim

Help a reader act or understand with the least avoidable effort. Preserve the
author's facts, uncertainty, and necessary engineering detail. Plain language
must not become flat or telegraphic language.

`AI slop` is a cultural label for low-value or repetitive synthetic content. It
is not a diagnosis. Judge text by its reader, purpose, and evidence.

## Method

1. Name the reader's job and the point they need first.
2. List facts that must survive: quantities, conditions, decisions, uncertainty,
   and source limits.
3. Lead with the useful answer. Use concrete nouns, active verbs, and source
   examples.
4. Use plain English when it stays accurate. Keep necessary terms and explain an
   unfamiliar one once.
5. Choose the shape for the reader's task: prose for a connected explanation,
   a list for scanning, and a diagram only when it clarifies a relationship.
6. Read it aloud. Cut filler, repeated conclusions, and empty praise.

Do not open with a rhetorical question. Do not use `not X but Y` unless the
contrast carries a fact. Do not force threes. Vary sentence length and shape
naturally; a technical claim can need a longer condition or consequence.

## One-page concepts

For an engineering reader: state why it matters, show `[input] --> [decision]
--> [observable effect]` only if useful, then give the few constraints or
failure modes that change a decision. Name an alternative only when its rejected
tradeoff matters. Do not turn an explanation into a tutorial for an experienced
engineer.

For a business reader: state capabilities, responsibilities, and the user
workflow. Keep technology and product names out of prose and diagrams. Put
technical wiring on a separate page for engineers. Shortening jargon is not
enough; match the abstraction to the reader's decision.

## Verify

Use the [examples and evaluation cases](evaluations.md) for a rewrite or review.
Compare the candidate with the source. Reject it if it drops a condition,
changes confidence, hides a tradeoff, or makes the reader infer the main point.
Do not use a banned-word test as the quality test.

## Evidence limits

Cognitive-load research and a randomized plain-language trial support reducing
avoidable reader effort. Research also finds that AI editing can change meaning,
and that responses to disclosed AI authorship vary by context. This supports
fact checks and context-sensitive warmth; it does not prove a clinical "AI slop
fatigue" syndrome.

- [Sweller (1988)](https://doi.org/10.1207/s15516709cog1202_4)
- [Sayfi et al. (2024)](https://doi.org/10.1016/j.jclinepi.2023.11.009)
- [Abdulhai et al. (2026)](https://arxiv.org/abs/2603.18161)
- [Nakano et al. (2026)](https://doi.org/10.1145/3742413.3789076)
- [Columbia IGP (2026)](https://igp.sipa.columbia.edu/sites/igp/files/2026-06/AI%20Slop%20and%20the%20Information%20Ecosystem_IGP%20Report.pdf)
