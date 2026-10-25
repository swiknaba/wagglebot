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
6. Make the minimum effective edit. Preserve the writer's vocabulary, cadence,
   humor, uncertainty, and useful edge.
7. Read it aloud. Cut filler, repeated conclusions, and empty praise.

Do not open with a rhetorical question. Do not use `not X but Y` unless the
contrast carries a fact. Do not force threes. Vary sentence length and shape
naturally; a technical claim can need a longer condition or consequence.

Let facts, actions, examples, and consequences establish importance. Do not
add commentary that tells the reader what to notice. Name a source instead of
using vague attribution. Repeat the precise term when it is the right term;
do not rotate synonyms for style. End on the last concrete point, takeaway, or
next action instead of a recap or a manufactured aphorism.

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

Preserve direct quotes, stated requirements, identifiers, and literals exactly
when their wording is evidence. Label a paraphrase as a summary. Use a URL or
path only when a source or tool response provides the exact value. Do not guess
or reconstruct links.

For a review without a rewrite, name each observed pattern, quote its text, and
give a specific revision. Do not guess whether AI wrote it. Apply the
portability test: if a sentence could describe any company or product, replace
it with a fact, example, mechanism, consequence, or judgment specific to this
subject.
