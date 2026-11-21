# sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/miuoas47-gif/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/miuoas47-gif/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A Sokoban solver that answers a whole set of 5 levels in one run, in as few pushes as possible. It scores 1,000,000 on the practice set — every level solved in exactly its push-optimal count — and the same on 20 freshly drawn sets from the competition's generator.

## How it works

Each level is a 1-wide hallway with 1–4 independent rooms off it, and the level's push-optimal count is the sum of the rooms' optima. So the solver works room by room:

1. **Split** — the hallway is the row the player starts on; every connected component of floor off that row is one room, opening onto the hallway through a single door.
2. **Solve each room push-optimally** — A\* over box configurations, with the player canonicalised to the smallest cell of the region it can reach, a cheapest-assignment heuristic over lone-box push distances, and dead-square plus 2×2-block deadlock pruning. A room's boxes never leave the room.
3. **Stitch** — the room solutions are joined with walks along the hallway; finishing a room never shuts the player in, so it can always walk back out through its door.

If a level does not split that way, a whole-level push-space A\* is tried as a fallback. Every instance always gets an answer file, even if empty. The search is bounded by fixed expansion counts, never by the clock, so two runs write identical bytes.

## Run it

```sh
node main.ts
```

`main.ts` reads every level from `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`) and writes `/output/<id>/solution.txt` (or `$MAKEFUN_OUTPUT_DIR`) — the player's moves in `u`/`d`/`l`/`r`. Node 22, no dependencies, no network.

---

<sub>Entered on [make.fun](https://make.fun/?ref=6gvkzysc&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
