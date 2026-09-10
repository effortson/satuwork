#!/usr/bin/env node
// 席位工人的启动器。和管家同一个包、同一份 tsx 运行时，只是另一个 systemd 单元、另一个
// 用户（非 root）。它做的事见 src/worker/index.ts 文件头。
import './../src/worker/index.ts'
