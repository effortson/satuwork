# @satuwork/core

界面里**不碰 DOM** 的那一层。边界只有一条：不引用 `window` / `document` / `localStorage` /
`history`，外部依赖（fetch、票的存取、语言）由宿主注入。来龙去脉见
[docs/adr-core-package-mobile.md](../docs/adr-core-package-mobile.md)。

两个消费方：

- **gateway/ui**：仍是一串普通脚本。`node gateway/scripts/build-core.mjs` 把这里打成
  [gateway/ui/core.js](../gateway/ui/core.js)（IIFE，全局 `SatuCore`），**产物提交进仓库**，
  CI 会重新打一遍核对没漂。改了 `src/` 就重打。
- **mobile/**：直接 `import { … } from '@satuwork/core'`（`exports` 指向 TS 源码，由打包器处理）。

```bash
pnpm --filter @satuwork/core test        # node:test，Node 24 直接跑 .ts
pnpm --filter @satuwork/core typecheck
node gateway/scripts/build-core.mjs      # 重打 gateway/ui/core.js
```
