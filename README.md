# Satuwork

English | [简体中文](README.zh-CN.md)

**AI coworkers for companies.** Give everyone in your company a few AI coworkers. Each has its own machine, works
your existing systems, and stops for you when it isn't sure. You hand off work the way you would to a colleague —
say what you need, then go do something else.

## About

### Two kinds of coworker

- **Remote coworker**: runs on your company's own seat machine (Debian), with its own workspace, terminal, browser
  and desktop. It starts on schedule and keeps working after the browser is closed and everyone has gone home.
- **Local coworker**: installed with the desktop app (Windows / macOS) on your own computer. It works your folders
  directly, and files never leave that machine.

### It isn't just a chat box

- **It really has a machine**: reads and writes files, runs commands, drives a browser, searches and fetches the web,
  handles Office documents, generates images.
- **Unsure? It stops**: the step that needs your sign-off waits for you; what it can't handle goes into a human
  handoff queue for a person to pick up.
- **Routines**: write the instruction and the time, and it's sent into the session when due, with the result logged.
- **Skills and memory**: your company's written-down ways of working attach to a bot (always-on or on-demand), and a
  bot can write down a method that worked for later. It remembers facts across conversations (how to address someone,
  where the reports live, who a client's contact is).
- **Works your existing systems**: connectors over OAuth, plus MCP; when there are too many tools it falls back to
  "search, inspect, then call".
- **Channels**: besides the web and desktop apps, you can hand work off from Telegram.
- **Delegation**: a subtask can be handed whole to a fresh sub-agent that reports back only its conclusion, keeping
  the main session's context lean.
- **One ledger**: models (including cache reads/writes), connectors and web search are recorded per call and deducted
  in real time from "plan allowance → account balance".
- **Audit**: company-level audit of operations, plus redacted conversation audits (task summary, timeline, scoring) —
  Gateway never stores full chat transcripts.

### How it's organized

Platform → company (tenant: plan, seats, run machines) → account (one person) → bot (one AI coworker in the sidebar).
Models, Skills and MCP come in two layers, **global** and **company**; each company keeps a versioned **bot
template** that employees build their own bots on. Seats are counted per account, so running several bots does
**not** take extra seats.

### How it's built

```
Browser / desktop app ──► Gateway (control plane + the only chat UI)
                             │  proxies chat streams, serves the catalog, schedules, bills
                             ▼
                       Machine manager (one per seat machine, the only inbound port)
                             │  deploys / upgrades
                             ▼
                       Bot process (one per account × bot, headless)
                             │
                             └──► model calls go through Gateway's /v1; full transcripts stay on the machine
```

| Directory | What it is |
|---|---|
| [`gateway/`](gateway) | Control plane + the only chat UI: accounts, companies, catalog, billing, audit, scheduling; proxies chat to seats; model calls go through its `/v1`. Runs as a long-lived service on Debian, and also has a Vercel + Neon function form |
| [`bot/`](bot) | Runtime: the headless AI coworker runtime (built on Cordis). One process is exactly one bot, deployed per (account, botId); serves no UI |
| [`manager/`](manager) | Machine manager: a root service on each seat machine. Once paired with Gateway it deploys and upgrades bots, and it's the only port exposed |
| [`desktop/`](desktop) | Tauri desktop app: UI bundled in the package, connects to a remote Gateway, and can run a local bot on this computer |
| [`e2e/`](e2e) | End-to-end tests |
| [`docs/`](docs) | Design docs; the master spec is [docs/gateway-runtime.md](docs/gateway-runtime.md) |
| [`searxng/`](searxng) | Optional self-hosted search |

## Getting started

```bash
pnpm install
docker compose up -d postgres
cd gateway && pnpm dev
```

Open <http://127.0.0.1:3080>. The first visit shows the "create system administrator" screen; once that's done you're signed in.

After that, `/` is the **landing page** (the screen for people who don't have an account yet, `gateway/ui/pages-landing.js`), and sign-in lives at `/login`.
With a valid session, `/` goes straight to chat / overview as before. The desktop shell skips the landing page — there `/` is the sign-in page.

`/privacy` and `/terms` are the privacy policy and terms of service (`gateway/ui/pages-legal.js`). They **don't depend on sign-in state**,
and the footers of both the landing page and the sign-in page link to them. The legal entity, jurisdiction and contact email in them are placeholders
and must be replaced before launch (see `LEGAL_DRAFT` at the top of that file).

Desktop downloads live in two places that render the same card (`dlGrid` in `gateway/ui/pages-landing.js`):

- **Signed out**: a section of the landing page, right after "Getting started" (`lpDownload`). `/#download` jumps straight to it,
  and the sign-in, setup and invite screens link there too (in a new tab).
- **Signed in**: an in-app `/download` page (`downloadPage`), linked from Preferences.

The old `/download` address still serves the UI and is routed by sign-in state: signed out it is rewritten to `/#download`, signed
in it is that page (`foldDownload` in `gateway/ui/app.js`). Neither is offered inside the desktop shell. The card picks Windows /
macOS from the platform the browser reports, and the row at the top lets people switch manually.

Files point at a fixed `desktop-latest` Release, so shipping a new version needs no page change: desktop release CI copies the
installers there under version-less names (`Satuwork_x64-setup.exe`, `Satuwork_aarch64.dmg`, `Satuwork_x64.dmg`), always mirroring the newest
**stable** `desktop-v*` (plain `X.Y.Z`; pre-releases don't count, and re-publishing an old tag never rolls it back). Those names are pinned against `dlBuilds` by an e2e check. It deliberately **doesn't use GitHub's
`releases/latest`**: every release line shares one Release list, and all of them create Releases with `--latest=false`, so the
repo's "Latest" badge doesn't track any one line.

To run everything in containers: `docker compose up -d` (Gateway + PostgreSQL).
The Bot isn't in compose — it's deployed per (account, botId) by the machine manager on the seat machine, not orchestrated as a container.

Compose also has an **optional** self-hosted SearXNG. It doesn't start by default; ask for it by name:
`docker compose --profile searxng up -d`. See [searxng/README.md](searxng/README.md).

Gateway's business data lives in PostgreSQL; the host port is **5434** (5432 is usually taken by another instance).
`SATUWORK_GATEWAY_HOME` only holds the JWT key pair and Bot release packages.

## Roadmap

Gateway is moving fully onto Vercel + Neon: anything stateful or holding long-lived connections moves down to seat workers
(per machine) or to the desktop app (per person), leaving Gateway with only stateless endpoints, static UI and `/v1`. The decision,
where each piece goes, and the rollout order are in [docs/adr-gateway-vercel-neon.md](docs/adr-gateway-vercel-neon.md).

## Deploying to Vercel + Neon

Gateway has a function form (`gateway/src/serverless.ts`): no listener, no timers, no migrations, keys come from environment variables,
and the per-minute sweep is driven by Cron hitting `/cron/tick`. The `vercel.json` at the repo root is for it. Environment variables,
prerequisites and what hasn't moved over yet are in [docs/vercel-deploy.md](docs/vercel-deploy.md). On Debian it's still `pnpm dev` / compose.

## Desktop

`desktop/` is a Tauri shell with the **UI bundled in the package** (the `gateway/ui` parts are copied in as-is and served over the shell's own
`satu://` protocol). The shell remembers which Gateway to connect to and injects that into the page. Local Bot sessions don't go through Gateway;
routines are picked up by the Bot process itself. Why it's shaped this way, and which self-check to run first when switching OS, is in
[desktop/README.md](desktop/README.md).

## Packaging

Local test packages (built as Linux packages through Docker and uploaded to a local Gateway): see
[docs/local-release.md](docs/local-release.md). Production goes through CI: push a `bot-v*` / `manager-v*` / `local-bot-v*` /
`desktop-v*` tag. A `desktop-v*` tag also refreshes the `desktop-latest` Release that the landing page downloads from (see above).

## Billing

Models (including cache reads/writes), connectors and web search are all recorded per call in one ledger, deducted in real time from
"plan allowance → account balance". When both buckets are empty, every paid call for that company is cut off. Accounting rules, ledger tables
and rollout order are in [docs/billing.md](docs/billing.md).

After upgrading to a version with the ledger, run a backfill **immediately**, otherwise historical spend won't exist in the balance.
**Start Gateway once first** (migrations run at process start), then backfill:

```bash
GATEWAY_DATABASE_URL=... node gateway/scripts/backfill-charges.mjs --dry-run
```

Check that the counts look right, then drop `--dry-run` and run it for real. The script is safe to re-run.

## Routines

In the right-hand panel of a chat, a Bot can have several "things to do on schedule": write the instruction and the time, and Gateway's scheduler
sends it into that seat's session when it's due, recording the result as a log entry once it finishes. It runs even with the browser closed.

The model, timezone rules, and why the scheduler lives in Gateway rather than on the seat are in [docs/routines.md](docs/routines.md).

## Skills

A company's written-down ways of doing things are attached to a Bot. Previously every skill's full body sat in the system prompt on every turn;
now there are two tiers: **always-on** skills stay as before (rules that must hold every time, like conventions and tone), while **on-demand**
skills leave only a "name + one sentence" line in the prompt, and the Bot expands one with `skill_view` when it decides to use it — reference
material and scripts in the ZIP package are only pulled onto the seat at that point.

After finishing a task, the Bot can also write the method down (`skill_manage`). Such skills are usable only by that Bot; they show up in the
"Written by the Bot" column on the Skill page, where they can be deleted or promoted to a company Skill with one click.

Tier rules, why the private tier lives in Gateway, boundaries and billing are in [docs/skills.md](docs/skills.md).

## Context

One Bot has one long session that only grows, and every turn rebuilds the history into a model request. When it hits 70% of the window,
the older portion is replaced with a summary at the end of the turn — no original message is deleted, and the model can still pull them back.

The assembly path (prompt, tool table, message rebuild, compaction, and the places that can break it) is in
[docs/context-assembly.md](docs/context-assembly.md).

## Memory

A Bot remembers facts across conversations: how to address this employee, where the reports live, who this client's contact is.
It records them itself during chat (`memory_write`); they're stored in Gateway and placed at the very end of the system prompt on every turn.

**Memory holds facts, not methods** — a procedure with steps goes the Skill route (`skill_manage`); the test is "does it need
expanding". Of the four layers (this Bot / this person / group / whole company), the model can only write the lower two; the upper two
must be promoted by an administrator in the UI, because they enter every prompt in the company verbatim.

The policy lives in the Bot template (which kinds to record, how long to keep them, how many to place per turn, whether to confirm before writing,
whether to record sensitive information). The rules and why it looks like this are in [docs/memory.md](docs/memory.md).

## Checks

```bash
node e2e/run.mjs          # full end-to-end suite; start postgres first
cd gateway && pnpm typecheck
```

The schema names and `/tmp` directories used by e2e are suffixed by checkout path (see
[e2e/isolate.mjs](e2e/isolate.mjs)), so **multiple worktrees can run at the same time** without wiping each other's databases
or deleting each other's data directories. The one shared resource that can't be avoided is port 3200 — it's fixed by Gateway's slot formula,
so two sets of manager cases on the same machine will collide, and the affected case will say so.
