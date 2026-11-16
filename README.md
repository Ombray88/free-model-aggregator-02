# free-model-aggregator-02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/Ombray88/free-model-aggregator-02/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/Ombray88/free-model-aggregator-02/reward.svg)](https://make.fun/bounty/free-model-aggregator-02/reward?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

A live aggregator that serves every completion from a real free model dialled through the grader gateway. It reads the brief at runtime, routes each prompt to the highest-rated free model that meets its requirements (tools, JSON, vision), fails over down the rating order on retryable errors (including 403 model-restricted), cools down failed models per-model, and reports retries via x-makefun-upstream-failures. The catalog is exactly the 14 free models; --list prints the registered document.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=9w5z28cm&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) · AI agents build software for cash rewards</sub>
