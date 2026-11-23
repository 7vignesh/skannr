# Benchmarks

Measured results for `skannr benchmark`, with the exact repositories, commits, queries and machine, so you can rerun them.

Raw data: [`benchmarks/results.json`](./benchmarks/results.json). Scenario files: [`benchmarks/`](./benchmarks).

## What is measured

For each scenario skannr is asked one question about one directory of a repository, and returns its top 10 files as skeletons. The benchmark then compares:

- **Reduction vs module:** the tokens in the skeletons it returned, against the tokens in every `.ts`/`.tsx` file in that directory. This is "what you would send if you pasted the whole module".
- **Reduction vs top files raw:** the skeleton tokens against the raw source of the same 10 files. This isolates what skeleton generation alone saves, without the benefit of ranking.
- **Keyword coverage:** how many of the query's words appear in the top-ranked file's path or skeleton (top-1), and on average across the top 5.
- **Path intent match:** the share of the top 5 files whose path contains a query word.

Tokens are counted by skannr's own approximate counter (it splits text on whitespace and punctuation), so they are not model tokens. Use the numbers to compare skeletons with source, not to estimate a bill. For directories over 200 files the module baseline is estimated from a 200-file sample and extrapolated.

Keyword coverage and path match measure whether the returned files mention the query's words. They do not measure whether the files answer the question.

## Results

Windows x64, Intel Core i5-1135G7 (8 threads), 16 GB RAM, Node v22.21.1. skannr at `eddbfc8` plus the `--scenarios` option. Times are cold-cache runs.

| Repo (commit) | Directory | Query | Files | Module tokens | Top 10 raw | Skeletons | vs module | vs top 10 raw | Top-1 coverage | Time |
|---|---|---|---|---|---|---|---|---|---|---|
| nestjs/nest (`fed38a7`) | `packages/core` | dependency injection and module resolution | 318 | 103,867* | 24,370 | 7,643 | 92.6% | 68.6% | 100% | 77.3 s |
| nestjs/nest | `packages/common` | exception handling and http errors | 294 | 74,876* | 10,615 | 6,770 | 91.0% | 36.2% | 60% | 71.6 s |
| typeorm/typeorm (`911177c`) | `packages/typeorm/src` | query builder and SQL generation | 496 | 527,129* | 61,358 | 17,991 | 96.6% | 70.7% | 80% | 63.8 s |
| typeorm/typeorm | `packages/typeorm/src/driver` | database connection management | 90 | 181,702 | 48,546 | 50,620 | 72.1% | -4.3% | 100% | 12.8 s |
| trpc/trpc (`8405090`) | `packages/server` | router procedure and middleware | 105 | 50,539 | 10,718 | 7,568 | 85.0% | 29.4% | 100% | 14.4 s |
| trpc/trpc | `packages/client` | http link batching | 52 | 21,263 | 5,281 | 2,343 | 89.0% | 55.6% | 67% | 7.3 s |

\* Extrapolated from a 200-file sample.

| | vs module | vs top 10 raw |
|---|---|---|
| Mean of 6 | **87.7%** | **42.7%** |
| Range | 72.1% to 96.6% | -4.3% to 70.7% |

Mean top-1 keyword coverage 84.5%, mean top-5 coverage 70.8%, mean path-intent match 73.3%.

## What these numbers say

- **Against pasting a whole module, the typical saving is about 88%** (72% to 97%). The 96.5% figure that earlier versions of the README and landing page gave as a headline is about the top of this range (96.6%), reached on one of six scenarios. It is not the typical result.
- **Skeleton generation alone saves less: 43% on average, and it can be negative.** In the TypeORM `driver` scenario the skeletons (50,620 tokens) are larger than the raw files (48,546). Skeletons keep every signature and type, and add a header and line comments, so for files that are mostly declarations they do not shrink. Most of the saving in the headline number comes from returning 10 files instead of the whole directory.
- **Cold queries are slow on large modules.** 52 to 105 files took 7 to 14 seconds; 294 to 496 files took 64 to 77 seconds. A warm rerun of the `packages/core` query took 104 ms. A `skannr risk` run with one file touched in the full NestJS repo (2,277 TypeScript files) took 19.9 to 23.6 seconds. On this repository (66 files) a cold query takes about 2 seconds (0.6 s warm) and `risk` about 1.4 seconds. Tracked in [#16](https://github.com/7vignesh/skannr/issues/16).

## Reproduce

`--scenarios` is not in the published 0.2.4 package yet, so build skannr from a checkout and run the benchmark with the repository being measured as the working directory:

```bash
git clone https://github.com/7vignesh/skannr.git && cd skannr && npm install && npm run build && cd ..

git clone https://github.com/trpc/trpc.git && cd trpc
git checkout 8405090580983cc54b9fe4b062f6fc39e4e9549c
node ../skannr/dist/benchmark.js --scenarios ../skannr/docs/benchmarks/trpc.json
```

The scenario file is a JSON array of `{ "moduleKey": "<directory under the repo root>", "query": "<question>", "limit": 10 }`. Results print to the terminal and are also written to `benchmark-results.json` in the skannr checkout (the file is gitignored). On large modules expect minutes, not seconds (see the Time column).

The repository's own benchmark test (`tests/benchmark.test.ts`) checks that scenario files load and that module paths resolve. It does not check the figures above.

## Limits

- One machine. Each scenario was run once, except the two TypeORM scenarios, which were run twice: every token count matched, and the times differed by 0.8% and 3.9%.
- Six scenarios across three TypeScript repositories. No Python, Go, Rust or Java repositories were measured.
- The queries are mine, written before looking at results, and they are not a labelled relevance set. There is no measurement of whether the returned files contain the answer.
- A reduction in tokens is not a reduction in cost or an improvement in answers. The benchmark does not call a model.
