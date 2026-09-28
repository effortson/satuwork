/** 维护节拍的逐步兜错探针。由 e2e/maintenance.mjs 调用，不连库。 */
import { MAINTENANCE_STEPS, maintenanceTick, runMaintenanceSteps } from './src/routines.ts'

const out = { 逐步兜错: {}, 真节拍: {} }
const names = MAINTENANCE_STEPS.map((s) => s.name)

// 第一步、中间一步各抛一次（一个同步抛、一个异步拒绝），其余照记：后面的每一步都得跑到，顺序不变。
const ran = []
const steps = MAINTENANCE_STEPS.map((s, i) => ({
  name: s.name,
  run:
    i === 0
      ? () => {
          throw new Error('探针：第一步同步抛')
        }
      : i === 3
        ? async () => {
            throw new Error('探针：中间一步异步拒绝')
          }
        : async () => {
            ran.push(s.name)
          },
}))
const r = await runMaintenanceSteps(null, steps)
out.逐步兜错 = {
  失败的步骤如实报回: r.failed.join(',') === [names[0], names[3]].join(','),
  其余每一步都跑到: ran.join(',') === names.filter((_, i) => i !== 0 && i !== 3).join(','),
  删除与部署对账没被跳过: ran.includes('删除 Bot') && ran.includes('部署对账') && ran.includes('推部署队列'),
}

/**
 * 真的那份节拍，喂一个「每个方法都报错」的库：不抛出来，而且排在后面的删除终审、部署对账
 * 也都被尝试过（各自报了失败）。以前是一条 .then 链加一个 .catch，第一步一错后面全跳过。
 */
const broken = new Proxy(
  {},
  {
    get: (_, key) =>
      key === 'then'
        ? undefined
        : async () => {
            throw new Error(`探针：库坏了（${String(key)}）`)
          },
  },
)
let threw = false
let tick = { failed: [] }
try {
  tick = await maintenanceTick(broken)
} catch {
  threw = true
}
out.真节拍 = {
  整拍不抛: !threw,
  第一步报了失败: tick.failed.includes('日常任务调度'),
  删除终审照样尝试: tick.failed.includes('删除 Bot'),
  部署对账照样尝试: tick.failed.includes('部署对账'),
}

console.log('__RESULT__' + JSON.stringify(out))
// 推部署队列那一步挂在 afterResponse 上，不等它；给它一拍把拒绝落完再退。
setTimeout(() => process.exit(0), 200)
