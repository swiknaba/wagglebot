# Examples and Evaluation Cases

Use source facts for the review. Do not judge by banned words alone. Do not
explain a standard engineering mechanism unless it changes a decision.

## Concise engineering concept

**Before:** "The artifact cache is a critical performance optimization that
ensures a resilient deployment experience across a range of conditions."

**After:** "Add caching to Artifactory for resilience."

**Check:** The decision and intended outcome are clear. It does not explain
ordinary cache behavior to an engineering reader.

## Voice-preserving edit

**Source:** "I think the rollback was the right call. It was ugly, but we did
not lose data."

**Candidate:** "I think the rollback was the right call. It was ugly, but we
did not lose data."

**Check:** The self-assessment and blunt description carry useful meaning. Do
not smooth them into generic corporate language.

## Specific evidence

**Before:** "Studies show that the migration improved reliability."

**Source:** The import dashboard recorded 18 failed imports per day before the
migration and two after it.

**After:** "The import dashboard recorded 18 failed imports per day before the
migration and two after it."

**Check:** A named source and concrete fact support the claim. Do not use vague
attribution or commentary that labels the result important.

## Quoted requirement

**Source:** An engineer wrote, "No test run locally. It's just documentation."

**Candidate:** > No test run locally. It's just documentation.

**Check:** The quote preserves the person's exact wording and punctuation.

## Verified link

**Source:** The release API returned
`https://artifacts.example.test/releases/7f3c`.

**Candidate:** [Release artifact](https://artifacts.example.test/releases/7f3c)

**Check:** The link uses the returned value. Do not infer a URL from a release
name, identifier, or repository convention.

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
survive? Does the abstraction match the reader? Does it omit explanations the
reader already knows? Does the edit retain useful voice and repeat the precise
term where it helps? Does the ending stop on a concrete point or next action?
