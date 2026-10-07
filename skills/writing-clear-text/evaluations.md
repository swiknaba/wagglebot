# Examples and Evaluation Cases

Use source facts for the review. Do not judge by banned words alone.

## Concise engineering concept

**Before:** "The artifact cache is a critical performance optimization that
ensures a resilient deployment experience across a range of conditions."

**After:** "The cache keeps a verified artifact for 24 hours. It reduces
registry calls during an outage. A signature failure bypasses the cache and
stops the deployment."

**Check:** A 24-hour cache, signature bypass, and outage behavior remain. The
effect is clear before implementation detail.

## Business concept

**Source facts:** A person submits a change; policy decides; an owner handles
exceptions; the person receives the decision.

**Check:** **Audience and abstraction:** capabilities, responsibilities, and
workflow are clear without technology or product names. Technical wiring is
separate.

## Research summary

**Before:** "The study provides compelling and important insights with broad
implications for clear communication."

**After:** "In a randomized trial of 488 adults, one plain-language health
recommendation improved correct-answer rates by 19.8 percentage points. The
other comparison was not statistically significant."

**Check:** **Factual preservation:** population, comparison, and uncertainty
remain. **Reader effort:** no claim exceeds the evidence.

## Status update

**Before:** "We are pleased to share that the migration is progressing well,
although there are a few items to keep in mind."

**After:** "The migration copied 92% of records. Two tenants still fail on a
legacy timestamp. We will retry after the parser fix tomorrow; no data is lost."

**Check:** **Factual preservation:** progress, blocker, next action, and risk
remain. **Reader effort:** the reader can tell whether to act.

## Pleasant nontechnical prose

**Before:** "Are you ready to embark on an exciting journey to a more seamless
experience?"

**After:** "Your weekly summary is ready. It groups the changes that need your
attention and leaves the rest out."

**Check:** **Factual preservation:** scope and benefit remain. **Reader effort:**
the text feels considerate without pretending to be intimate.

## Review questions

Can the intended reader state the decision, evidence, or next action after one
reading? Did every source condition, value, uncertainty, and necessary tradeoff
survive? Does the abstraction match the reader instead of merely shortening
jargon?
