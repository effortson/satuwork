#!/usr/bin/env node
/**
 * Satuwork 端到端：真 HTTP，不 mock。
 *
 * Gateway 与 Bot 各自起子进程，隔离数据目录和端口，测完杀掉。
 * 不碰 ~/.satuwork-gateway / ~/.satuwork。
 *
 *   export PATH=/home/box/.local/node24/bin:$PATH
 *   node e2e/run.mjs
 */
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runRuntimePath } from './runtime-path.mjs'
import { runGatewayChat } from './gateway-chat.mjs'
import { runDeployErrors } from './deploy-errors.mjs'
import { runUpgradeDrain } from './upgrade-drain.mjs'
import { runProxyClose } from './proxy-close.mjs'
import { runPairing } from './pairing.mjs'
import { runMachineDeploy } from './machine-deploy.mjs'
import { runLlmUsage } from './llm-usage.mjs'
import { runMarkdown } from './markdown.mjs'
import { runChatFold } from './chat-fold.mjs'
import { runLlmProbeEffort } from './llm-probe-effort.mjs'
import { runDesktopUpdate } from './desktop-update.mjs'
import { runChatModelRefresh } from './chat-model-refresh.mjs'
import { runAvatarMotion } from './avatar-motion.mjs'
import { runToolNames } from './tool-names.mjs'
import { runSessionStore } from './session-store.mjs'
import { runLlmIdle } from './llm-idle.mjs'
import { runLlmRetry } from './llm-retry.mjs'
import { runReplaySlice } from './replay-slice.mjs'
import { runSearch } from './search.mjs'
import { runRosterStream } from './roster-stream.mjs'
import { runManagerDownload } from './manager-download.mjs'
import { runSeatWorkdir } from './seat-workdir.mjs'
import { runWorkspaceFiles } from './workspace-files.mjs'
import { runPatch } from './patch.mjs'
import { runProcess } from './process.mjs'
import { runDesktop } from './desktop.mjs'
import { runDocExtract } from './doc-extract.mjs'
import { runOfficeEdit } from './office-edit.mjs'
import { runOfficeLook } from './office-look.mjs'
import { runDocRender } from './doc-render.mjs'
import { runWebBot } from './web-bot.mjs'
import { runVision } from './vision.mjs'
import { runTurnImages } from './turn-images.mjs'
import { runMentions } from './mentions.mjs'
import { runRoutineModel } from './routine-model.mjs'
import { runModelChoice } from './model-choice.mjs'
import { runRoutineTools } from './routine-tools.mjs'
import { runHistoryTime } from './history-time.mjs'
import { runCompact } from './compact.mjs'
import { runReferences } from './references.mjs'
import { runGatewayUrl } from './gateway-url.mjs'
import { runSeatSecrets } from './seat-secrets.mjs'
import { runMaxSteps } from './max-steps.mjs'
import { runDelegate } from './delegate.mjs'
import { runToolCalls } from './toolcalls.mjs'
import { runAnthropicThinking } from './anthropic-thinking.mjs'
import { runResponses } from './responses.mjs'
import { runShutdown } from './shutdown.mjs'
import { runGuards } from './guards.mjs'
import { runHandoff } from './handoff.mjs'
import { runRoutineRetry } from './routine-retry.mjs'
import { runRoutineWorker } from './routine-worker.mjs'
import { runBotTasks } from './bot-tasks.mjs'
import { runWorker } from './worker.mjs'
import { runChannelWebhook } from './channel-webhook.mjs'
import { runServerless } from './serverless.mjs'
import { runLocalRoutines } from './local-routines.mjs'
import { runLocalTasks } from './local-tasks.mjs'
import { runTaskWorker } from './task-worker.mjs'
import { runTaskTurns } from './task-turns.mjs'
import { runAssign } from './assign.mjs'
import { runReleaseBlob } from './release-blob.mjs'
import { runBrowser } from './browser.mjs'
import { runMounted } from './mounted.mjs'
import { runSetup } from './setup.mjs'
import { runAuthThrottle } from './auth-throttle.mjs'
import { runPush } from './push.mjs'
import { runUiSmoke } from './ui-smoke.mjs'
import { runUiFiles } from './ui-files.mjs'
import { runCustomProvider } from './custom-provider.mjs'
import { runStats } from './stats.mjs'
import { runWebTools } from './web-tools.mjs'
import { runImageGen } from './image-gen.mjs'
import { runBilling } from './billing.mjs'
import { runMigrate } from './migrate.mjs'
import { runGlobalCatalog } from './global-catalog.mjs'
import { runConnectors } from './connectors.mjs'
import { runToolSearch } from './tool-search.mjs'
import { runSkills } from './skills.mjs'
import { runSkillsBot } from './skills-bot.mjs'
import { runMemoryBot } from './memory-bot.mjs'
import { runMemory } from './memory.mjs'
import { runConversationAudit } from './conversation-audit.mjs'
import { runMaintenance } from './maintenance.mjs'
import { runBotTemplate } from './bot-template.mjs'
import { runManager } from './manager.mjs'
import { runManagerConfirm } from './manager-confirm.mjs'
import { runChannels } from './channels.mjs'
import { runKnowledge } from './knowledge.mjs'
import { runTelegramRich } from './telegram-rich.mjs'
import { runTelegramChannel } from './telegram-channel.mjs'
import { runChannelQueue } from './channel-queue.mjs'
import { runLocalBootstrap } from './local-bootstrap.mjs'
import { requirePg } from './pg.mjs'
import { tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'
import { assert, failed, killAll, log, passed, req, skip, skips, start, suite, test, treeHas, waitHttp } from './harness.mjs'
import { runGateway } from './gateway-core.mjs'
import { runBot } from './bot-core.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const gwRoot = join(root, 'gateway')
const botRoot = join(root, 'bot')

const GW_HOME = process.env.E2E_GW_HOME || tmpOf('satuwork-e2e-gw')
const BOT_HOME = process.env.E2E_BOT_HOME || tmpOf('satuwork-e2e-bot')

/**
 * 端口在 main() 里向内核要（见 ports.mjs）。写死数字迟早会撞，而撞上之后的现象和
 * 真实原因毫无关系——探活会连到别人的残留进程上，然后报一个牛头不对马嘴的断言。
 * 环境变量仍然能钉死，本地调试时要固定地址还用得上。
 */
let GW_PORT = 0
let BOT_PORT = 0

async function main() {
  GW_PORT = Number(process.env.E2E_GW_PORT) || (await freePort())
  BOT_PORT = Number(process.env.E2E_BOT_PORT) || (await freePort())
  process.on('SIGINT', () => {
    killAll()
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    killAll()
    process.exit(143)
  })
  // 任何没接住的崩溃也得先收子进程再退：不然 Gateway / 管家 / detached 的 Chrome 探针
  // 会留在机器上，下一次跑 e2e 端口就被它们占着。
  const crash = (what) => (e) => {
    console.error(`[e2e] ${what}：${e?.stack ?? e}`)
    killAll()
    process.exit(1)
  }
  process.on('uncaughtException', crash('未捕获异常'))
  process.on('unhandledRejection', crash('未处理的 rejection'))
  try {
    await requirePg()
    await suite('gateway', () =>
      runGateway({ gwRoot, botRoot, gwHome: GW_HOME, gwPort: GW_PORT, test, req, start, waitHttp, assert, log }))
    await suite('bot', () =>
      runBot({ botRoot, botHome: BOT_HOME, botPort: BOT_PORT, test, req, start, waitHttp, assert, log }))
    await suite('runtime-path', () =>
      runRuntimePath({
        root,
        gwRoot,
        botRoot,
        test,
        req,
        start,
        waitHttp,
        assert,
        log,
      }))
    await suite('gateway-chat', () =>
      runGatewayChat({
        gwRoot,
        botRoot,
        test,
        req,
        start,
        waitHttp,
        assert,
        log,
        treeHas,
      }))
    await suite('deploy-errors', () => runDeployErrors({ root, test, assert, log }))
    await suite('upgrade-drain', () => runUpgradeDrain({ root, test, assert, log }))
    await suite('proxy-close', () => runProxyClose({ root, test, assert, log }))
    await suite('pairing', () => runPairing({ root, test, assert, log }))
    await suite('machine-deploy', () =>
      runMachineDeploy({
        gwRoot,
        test,
        req,
        start,
        waitHttp,
        assert,
        log,
      }))
    await suite('llm-usage', () =>
      runLlmUsage({
        gwRoot,
        test,
        req,
        start,
        waitHttp,
        assert,
        log,
      }))
    await suite('setup', () => runSetup({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('auth-throttle', () => runAuthThrottle({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('push', () => runPush({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('custom-provider', () => runCustomProvider({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('stats', () => runStats({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('web-tools', () => runWebTools({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('image-gen', () => runImageGen({ root, gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('billing', () => runBilling({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('migrate', () => runMigrate({ gwRoot, test, start, waitHttp, assert, log }))
    await suite('global-catalog', () => runGlobalCatalog({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('connectors', () => runConnectors({ root, gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('tool-search', () => runToolSearch({ root, gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('skills', () => runSkills({ root, gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('skills-bot', () => runSkillsBot({ root, test, assert, log }))
    await suite('memory-bot', () => runMemoryBot({ root, test, assert, log }))
    await suite('memory', () => runMemory({ root, gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('conversation-audit', () => runConversationAudit({ root, test, assert, log }))
    await suite('maintenance', () => runMaintenance({ root, test, assert, log }))
    await suite('bot-template', () => runBotTemplate({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('manager', () => runManager({ root, gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('manager-confirm', () => runManagerConfirm({ root, test, assert, log }))
    await suite('channels', () => runChannels({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('knowledge', () => runKnowledge({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('channel-webhook', () => runChannelWebhook({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('channel-queue', () => runChannelQueue({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('telegram-rich', () => runTelegramRich({ root, test, assert, log }))
    await suite('telegram-channel', () => runTelegramChannel({ root, test, assert, log }))
    await suite('ui-smoke', () => runUiSmoke({ root, gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('ui-files', () => runUiFiles({ root, test, assert, log }))
    await suite('markdown', () => runMarkdown({ root, test, assert, log }))
    await suite('chat-fold', () => runChatFold({ root, test, assert, log }))
    await suite('llm-probe-effort', () => runLlmProbeEffort({ root, test, assert, log }))
    await suite('desktop-update', () => runDesktopUpdate({ root, test, assert, log }))
    await suite('chat-model-refresh', () => runChatModelRefresh({ root, test, assert, log }))
    await suite('avatar-motion', () => runAvatarMotion({ root, test, assert, log }))
    await suite('tool-names', () => runToolNames({ root, test, assert, log }))
    await suite('session-store', () => runSessionStore({ root, test, assert, log }))
    await suite('llm-idle', () => runLlmIdle({ root, test, assert, log }))
    await suite('llm-retry', () => runLlmRetry({ root, test, assert, log }))
    await suite('replay-slice', () => runReplaySlice({ root, test, assert, log }))
    await suite('search', () => runSearch({ root, test, assert, log }))
    await suite('roster-stream', () => runRosterStream({ test, assert, log }))
    await suite('manager-download', () => runManagerDownload({ test, assert, log }))
    await suite('seat-workdir', () => runSeatWorkdir({ test, assert, log }))
    await suite('workspace-files', () => runWorkspaceFiles({ root, test, assert, log }))
    await suite('patch', () => runPatch({ root, test, assert, log }))
    await suite('process', () => runProcess({ root, test, assert, log }))
    await suite('desktop', () => runDesktop({ root, test, assert, log }))
    await suite('doc-extract', () => runDocExtract({ root, test, assert, log }))
    await suite('office-edit', () => runOfficeEdit({ root, test, assert, log }))
    await suite('office-look', () => runOfficeLook({ root, test, assert, log }))
    await suite('doc-render', () => runDocRender({ root, test, assert, log }))
    await suite('web-bot', () => runWebBot({ root, test, assert, log }))
    await suite('vision', () => runVision({ root, test, assert, log }))
    await suite('turn-images', () => runTurnImages({ root, test, assert, log }))
    await suite('mentions', () => runMentions({ root, test, assert, log }))
    await suite('routine-model', () => runRoutineModel({ root, test, assert, log }))
    await suite('model-choice', () => runModelChoice({ root, test, assert, log }))
    await suite('routine-tools', () => runRoutineTools({ root, test, assert, log }))
    await suite('history-time', () => runHistoryTime({ root, test, assert, log }))
    await suite('compact', () => runCompact({ root, test, assert, log }))
    await suite('references', () => runReferences({ root, test, assert, log }))
    await suite('gateway-url', () => runGatewayUrl({ root, test, assert, log }))
    await suite('seat-secrets', () => runSeatSecrets({ root, test, assert, log }))
    await suite('max-steps', () => runMaxSteps({ root, test, assert, log }))
    await suite('delegate', () => runDelegate({ root, test, assert, log }))
    await suite('toolcalls', () => runToolCalls({ root, test, assert, log }))
    await suite('anthropic-thinking', () => runAnthropicThinking({ root, test, assert, log }))
    await suite('responses', () => runResponses({ root, test, assert, log }))
    await suite('guards', () => runGuards({ root, test, assert, log }))
    await suite('handoff', () => runHandoff({ root, gwRoot, test, req, start, waitHttp, assert, log, skip }))
    await suite('routine-retry', () => runRoutineRetry({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('routine-worker', () => runRoutineWorker({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('bot-tasks', () => runBotTasks({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('worker', () => runWorker({ root, gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('serverless', () => runServerless({ root, gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('local-routines', () => runLocalRoutines({ root, test, assert, log }))
    await suite('local-tasks', () => runLocalTasks({ root, test, assert, log }))
    await suite('task-worker', () => runTaskWorker({ root, test, assert, log }))
    await suite('task-turns', () => runTaskTurns({ root, test, assert, log }))
    await suite('assign', () => runAssign({ root, test, assert, log }))
    await suite('local-bootstrap', () => runLocalBootstrap({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('release-blob', () => runReleaseBlob({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('browser', () => runBrowser({ root, test, assert, log }))
    await suite('mounted', () => runMounted({ root, test, assert, log }))
    // 关进程那条放在最后：它把 Gateway 起起来又掐掉，后面再挂用例只会跟它抢端口。
    await suite('shutdown', () => runShutdown({ gwRoot, test, start, waitHttp, assert, log }))
  } finally {
    killAll()
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
    try {
      rmSync(BOT_HOME, { recursive: true, force: true })
    } catch {}
  }

  log('')
  log(`# ${passed} passed, ${failed} failed`)
  if (skips.length) {
    for (const s of skips) log(`# skip  ${s}`)
  }
  if (!failed) log('E2E OK')
  /**
   * **全绿的那一轮以前根本回不到命令行。**
   *
   * `killAll()` 之后进程里仍然剩着没释放的句柄——machine-deploy 那个听 8443 的假管家、
   * undici 攒下的连接、探针留下的管道——事件循环空不掉，node 就一直挂在这儿。而失败那
   * 条路上一直有 `process.exit(1)` 兜着，所以这个坑只在「一条都不红」的时候露出来：
   * 屏幕上明明写着 E2E OK，人却等着它结束，一等一个多小时。
   *
   * 结论已经全部打完了，退出码也已经定了。跨五十个套件去追最后一个没关干净的句柄是场
   * 打不赢的仗，这里直接落闸——但要等这几行字先落地，见 `bye`。
   */
  bye(failed ? 1 : 0)
}

/**
 * 打完再走。
 *
 * `process.exit()` **不等** stdout / stderr 把队列写完，而这两条在管道上（CI 就是管道、
 * `| tee` 也是）是异步的。直接 exit 能把最后几行整段吞掉——实测两万行里丢了近四成，
 * 而丢的恰恰是 `# N passed, M failed`、skip 清单和那些 `not ok` 的堆栈：退出码是对的，
 * 日志里却看不出发生了什么。
 *
 * 两条都排空了才走；读的那头要是先撤了、回调永远不来，两秒后照样走。
 */
function bye(code) {
  let left = 2
  const go = () => {
    if (--left === 0) process.exit(code)
  }
  setTimeout(() => process.exit(code), 2000)
  process.stdout.write('', go)
  process.stderr.write('', go)
}

main().catch((e) => {
  console.error(e.stack || e.message)
  killAll()
  bye(1)
})
