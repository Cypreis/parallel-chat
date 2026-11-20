# Study: an ultra-small model (under 500 MB) for card structure

Question: should a tiny model decide what goes into each card (how many cards, how long each is, how it is structured), instead of, or next to, a better prompt?

**Short answer: not yet.** Improve the prompt and the planner first (both done in this round), measure, and only distil a small model if the numbers below say a gap is left. This note says what such a model would do, what it could not do, what it would cost, and how to decide.

Model sizes, speeds and costs below are estimates to verify before relying on them; none of them was measured here.

## 1. What the data says today

From `.data/log.jsonl` (the only real data on this machine, read with the app's own projection):

| | |
| --- | --- |
| Questions with answers | 6 |
| Cards | 18 (2 to 5 per question) |
| Card length, words | 91 to 236, median 178 |
| Cards of one answer, spread | e.g. 152, 179, 184, 153, 91 or 163, 200, 189 |
| Shape recorded | all `parallel` |
| Links (22) | `feeds`, `depends_on`, `elaborates` |

Two readings:

- **There is no training set.** Six questions cannot teach anything. Any small model would be trained on labels written by a strong model (distillation), not on this log.
- **The log shows the problem, and the problem is the prompt.** Cards of one answer have almost the same length (within about 30 percent), and nearly every answer is "parallel". That is what the earlier prompt asked for ("match the length", "a few strong cards"). A model trained on this log would learn the same flatness. The prompt change in this round (use many small cards, mix sizes, sub-cards only for real parent and child) attacks the cause directly and costs nothing.

## 2. What a small model could and could not do

The job splits in two:

**Structure (a small model can learn this).** For a question, predict a skeleton:

- the number of cards (1 to 10);
- for each card a *form*: one-line fact, short list, table, steps, worked example, formula, diagram, chart;
- for each card a length class (for example S under 40 words, M 40 to 120, L 120 to 250) and, if it is a sub-card, its parent's position.

This is a small, closed output. It does not need much language ability: a classifier or a small sequence model reads the question and fills the slots. The signal is in the question's wording ("compare", "step by step", "why", a list, a formula, a dataset).

**Content (a small model cannot do this well).** The titles, the "intent" that tells each writer what to cover, and the card text need real understanding of the topic, in any language. A model of this size writes weak titles and misses what a question is really about. Keep this in a strong model.

So the realistic design is a **skeleton predictor** that constrains the planner: the planner (Haiku or GPT-5.4 Mini today) receives "5 cards: fact, table, steps, example, diagram; lengths S M L M M" and writes titles and intents to fit. It would not replace the planner.

## 3. Candidate designs

| Design | Size (estimate, verify) | Output | Notes |
| --- | --- | --- | --- |
| A. Frozen small encoder (MiniLM or similar sentence encoder) plus a few classification heads | about 25 to 130 MB with weights quantised | card count, form per slot, length class per slot | Fastest, runs on CPU in milliseconds. Fixed slots: needs an "end" class. No free text. |
| B. Small seq2seq or decoder (about 60 to 360M parameters, quantised to 4 or 8 bit) fine-tuned on skeleton strings | about 100 to 450 MB | the skeleton as a short string | Handles odd question shapes better than A; tens to a few hundred ms on CPU; needs a runtime (ONNX or llama.cpp). |
| C. Same as B but also writing titles and intents | about 350 to 500 MB and up | the full plan | Competes with the Haiku planner, which is already cheap and fast. Worst quality per MB. Not recommended. |

Where it would run: in the Node server (onnxruntime-node or llama.cpp bindings, adding 100 MB or more of runtime to the install) or in the page (transformers.js, with a first-load download of the whole model). The server is the better place for a local-first app.

## 4. Prompt versus model

| | Better prompt (done) | Skeleton model |
| --- | --- | --- |
| Cost to try | none | data generation plus training plus runtime in the app |
| Handles new topics and languages | yes, it is the big model | only what the training set covered |
| Consistent card counts and lengths | usually, not guaranteed | yes, by construction |
| Latency | unchanged (the planner call) | saves most of the planner time if it replaces planning, almost none if it only constrains it |
| Risk | the model drifts back to flat cards | the model freezes today's taste; every prompt change needs a retrain |
| Maintenance | edit a paragraph | dataset, training, evaluation, packaging |

The planning-model setting already gets most of the latency win: a small fast model plans, so the first card appears sooner. What a trained skeleton would add is *consistency*, and the prompt can get most of that more cheaply: length and form are already requested per card in the planner's `intent`.

## 5. When to build it: decision rule

Build only if, after running the new prompt on a real set of questions, **at least one** of these holds:

1. Card count or length is still off for a clear share of questions (for example more than 25 percent of answers where a reader would merge or split cards), and it is not fixed by a stricter schema (the planner states a word budget per card and the writer is checked against it).
2. The planner step is still the main wait before the first card (measure time to first card with and without the planning model).
3. Cost matters at volume: the planner is a large share of the bill.

If none holds, stop here.

## 6. If it is built: a plan

1. **Instrument first (a day).** Log, per answer: question text, number of cards, words per card, form per card, sub-card links, and what the reader did (cards expanded or deleted, follow-ups asked per card, cards pinned or noted). These are the quality labels the log lacks today.
2. **Build the evaluation before the model.** 150 to 300 real or realistic questions in the user's languages. For each, two or three skeletons judged acceptable by a person. Metrics: exact card count within one, form agreement per slot, length class agreement.
3. **Generate training data.** Ask a strong model for skeletons for several thousand to a few tens of thousands of varied questions (different domains, languages, lengths, with and without attachments), using the final prompt. Check a sample by hand. Keep the strong model's choices diverse (sample several per question), or the small model learns one template.
4. **Train design A or B.** Fine-tuning a model of this size on this dataset is an hours-scale job on one GPU (an estimate). Compare against two baselines: the new prompt alone, and the prompt plus a hand-written rule ("a table when the question says compare").
5. **Ship behind a setting,** like the planning model: off by default, falling back to the planner if the model is missing. Log both skeletons for a while before trusting it.
6. **Retrain trigger.** Whenever the prompt's idea of a good card changes.

## 7. Recommendation

1. Keep the new prompt and the optional planning model. Watch real answers for a week or two.
2. Add the logging in step 6.1 now; it is cheap and is needed either way.
3. Revisit with the decision rule in section 5. If a gap remains, start with **design A** (encoder plus heads): the smallest, fastest and easiest to evaluate, and it constrains a planner instead of replacing it.
