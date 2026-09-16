/**
 * 隐私政策（`/privacy`）与服务条款（`/terms`）：**两页公开的法律文本**。
 *
 * 为什么单开两页，而不是塞进首页底下折叠一块：这两样是要被**单独指过来**的——注册
 * 表单底下那句「继续即表示同意」、应用商店的上架表单、合规问卷、客户法务发来的邮件，
 * 要的都是一条能直接打开的地址。折在首页里的一段文字给不出这个。
 *
 * 分工和首页那一屏一样（见 pages-landing.js）：
 *
 *   /privacy  隐私政策
 *   /terms    服务条款
 *
 * 两页都**不看登录状态**（见 render.js 的 render()）：没票的人、有票的人、桌面壳里，
 * 打开都是同一份文本。法律文本背后不该有一道登录墙——真要看它的人，多半正是还没
 * 有账号的那个。
 *
 * 版式借首页那套外壳（`.satu-lp-top` / `.satu-lp-wrap` / `.satu-lp-foot`），正文另起
 * 一套 `.satu-lg-*`。中英两版就地写（`t('中文', 'English')`），理由同 pages-landing.js：
 * 这一屏整个是渲染时才拼的字符串，就地写看得见上下文。
 */

/**
 * 「最后更新」那个日期。**改了正文就要动它**——这一行是外面唯一看得出「这份文本
 * 变过」的东西，法务问卷第一个问的也是它。
 */
const LEGAL_UPDATED = '2026-09-14'

/**
 * 落款主体、争议管辖、联系邮箱。**现在这三样是占位的，上线前必须换掉。**
 *
 * 和首页那个占位号码一个道理（见 pages-landing.js 的 LP_SALES_PLACEHOLDER）：编一个
 * 看着像真的公司名和管辖地，比留着空更坏——它会被人照着抄进合同里。所以留明确的
 * 方括号占位，再由 LEGAL_DRAFT 在页面上挂一条「还没过法务」的横条。
 *
 * 换完三个常量，把 LEGAL_DRAFT 关掉，横条跟着消失。
 */
const LEGAL_ENTITY = '[公司主体名称]'
const LEGAL_ENTITY_EN = '[Legal entity name]'
const LEGAL_LAW = '[适用法律与管辖地]'
const LEGAL_LAW_EN = '[Governing law and venue]'
const LEGAL_CONTACT = 'legal@satuwork.com'
const LEGAL_DRAFT = true

/**
 * 一节：`{ id, title, body }`。
 *
 * `body` 里一条字符串是一段话，一个数组是一串要点。写成数据而不是直接拼 HTML，是因为
 * 这两页要中英各一份、还要出一份目录（legalToc 拿的就是 id 和 title）——正文和目录
 * 从同一处长出来，才不会改了标题忘了改目录。
 */
function lgSec(id, title, body) {
  return { id, title, body }
}

/** 正文里的一节。目录靠 id 跳过来，所以 id 落在 `<section>` 上。 */
function lgSecHtml(sec, n) {
  const body = sec.body
    .map((b) =>
      Array.isArray(b)
        ? `<ul>${b.map((li) => `<li>${esc(li)}</li>`).join('')}</ul>`
        : `<p>${esc(b)}</p>`,
    )
    .join('')
  return `<section class="satu-lg-sec" id="${esc(sec.id)}">
    <h2><span class="satu-lg-secnum">${n}</span>${esc(sec.title)}</h2>
    ${body}
  </section>`
}

/**
 * 左边那列目录。**是一串真的 `<a href="#...">`**，不是 data-act 按钮——锚点跳转是
 * 浏览器自己的事（地址栏跟着变、后退键回得去、右键能复制这一节的地址），那几样都不是
 * 点击处理器里能补出来的。这两页上恰恰有人要复制「第 6 节的链接」发给别人。
 */
function legalToc(secs) {
  return `<nav class="satu-lg-toc" aria-label="${esc(t('本页目录', 'On this page'))}">
    ${secs
      .map(
        (s, i) => `<a href="#${esc(s.id)}"><span>${i + 1}</span>${esc(s.title)}</a>`,
      )
      .join('')}
  </nav>`
}

/** 隐私政策的正文。 */
function legalPrivacy() {
  return {
    kind: 'privacy',
    title: t('隐私政策', 'Privacy Policy'),
    lead: t(
      '这套系统会收哪些信息、拿来做什么、谁看得到、留多久。说人话，不绕。',
      'What this system collects, what it is used for, who can see it, and how long it is kept — in plain words.',
    ),
    secs: [
      lgSec('pv-scope', t('这份政策管什么', 'What this policy covers'), [
        t(
          'Satuwork 是一套给公司用的 AI 员工系统。账号由你所在公司的管理员开通，数据存放在这家公司的那台 Gateway 上。这份政策说的是这套系统怎么对待信息。',
          'Satuwork is a system of AI coworkers for companies. Your account is created by an admin at your company, and the data lives on that company’s Gateway. This policy describes how the system handles information.',
        ),
        t(
          '拿这套系统做什么、开通谁、连哪些外部系统，都由你所在的公司决定：在数据保护法的说法里，公司是数据控制者，我们作为软件提供方按公司的指示处理数据。所以关于你那份数据的问题，第一站是公司管理员。',
          'Your company decides what the system is used for, who gets an account, and which external systems it connects to. In data-protection terms your company is the controller and we act on its instructions as the software provider. So questions about your own data start with your company admin.',
        ),
        t(
          '这套软件也可以由公司自己部署在自己的机器上。那种情况下运行它的就是你们公司自己，能碰到数据的也只有你们自己的管理员。',
          'The software can also be self-hosted on your company’s own machines. In that case your company runs it, and only your own admins can reach the data.',
        ),
      ]),
      lgSec('pv-collect', t('收哪些信息', 'What is collected'), [
        [
          t(
            '账号信息：邮箱、姓名、所属公司和角色，以及界面语言、主题这类偏好。',
            'Account details: email, name, company and role, plus preferences such as interface language and theme.',
          ),
          t(
            '你交代的活：你在对话里写的话、你上传的文件，以及 AI 员工为你做的事。',
            'The work you hand over: what you type in a conversation, the files you upload, and what the AI coworker does for you.',
          ),
          t(
            '机器与工作区：席位机器上的工作区文件、命令执行记录、浏览器访问过的页面。',
            'Machine and workspace: workspace files on the seat machine, commands that were run, pages the browser visited.',
          ),
          t(
            '授权凭据：连接第三方系统时拿到的 OAuth 令牌，以及公司配置的供应商密钥。它们加密保存，存进去之后界面上不再回显，也不下发给 Bot 进程。',
            'Credentials: OAuth tokens obtained when connecting third-party systems, and provider keys configured by your company. These are stored encrypted, never shown again in the interface, and never handed to the bot process.',
          ),
          t(
            '用量与账单：每次模型调用的 token 数、连接器调用次数、搜索次数以及对应的金额。',
            'Usage and billing: tokens per model call, connector calls, searches, and the amounts they cost.',
          ),
          t(
            '审计派生物：会话的摘要、时间线、结果和评分（下一节说清楚它里面有什么、没有什么）。',
            'Audit derivatives: conversation summaries, timelines, outcomes and scores (the next section spells out what they do and do not contain).',
          ),
          t(
            '技术日志：请求时间、IP 地址、浏览器标识这类服务器日志。',
            'Technical logs: request times, IP addresses, user-agent strings and similar server logs.',
          ),
        ],
      ]),
      lgSec('pv-conversations', t('对话正文在哪儿', 'Where conversations live'), [
        t(
          '原始会话事件不进 Gateway 的数据库，它们留在你们公司那台席位机器上。Gateway 这边只有两样：一份会话索引（哪个 Bot、哪条会话、什么时候），和一份裁剪过的审计派生物。',
          'Raw conversation events are not stored in the Gateway database; they stay on your company’s seat machine. The Gateway holds two things: a session index (which bot, which session, when), and a trimmed set of audit derivatives.',
        ),
        t(
          '审计派生物里明确不许出现这些：原始完整消息和工具返回、密钥与令牌、文件正文、邮件正文、网页全文，以及被识别出来的证件号、银行卡号、手机号、邮箱等原值。',
          'Audit derivatives are explicitly not allowed to contain: full raw messages or tool output, keys and tokens, file contents, email bodies, full web pages, or detected ID numbers, card numbers, phone numbers and email addresses in the clear.',
        ),
        t(
          '但有一件事要说在明处：对话内容会发给模型供应商——那是这套系统能回答你的前提。见下面「会交给谁」。',
          'One thing must be said plainly, though: conversation content is sent to model providers — that is what makes an answer possible at all. See “Who it goes to” below.',
        ),
      ]),
      lgSec('pv-use', t('拿来做什么', 'What it is used for'), [
        [
          t('把你交代的活干完，并把过程和结果给你看。', 'To do the work you hand over, and to show you what happened.'),
          t('开通账号、登录、按角色决定谁能看到什么。', 'To provision accounts, sign you in, and decide what each role can see.'),
          t('计费与账单：按模型调用、连接器调用和搜索次数落账。', 'To meter and bill: per model call, per connector call, per search.'),
          t('安全：发现滥用、异常登录和故障，排查问题。', 'For security: spotting abuse, unusual sign-ins and failures, and debugging.'),
          t('公司管理员的审计与合规需要。', 'For the audit and compliance needs of your company admins.'),
        ],
        t(
          '我们自己不拿你们的对话内容去训练任何模型。第三方模型供应商会不会用于训练，取决于你们公司选了哪家、以及那家的条款——这一条请管理员在配置供应商时确认。',
          'We do not train any model on your conversations. Whether a third-party model provider does depends on which provider your company chose and on that provider’s terms — something for your admin to confirm when configuring it.',
        ),
      ]),
      lgSec('pv-share', t('会交给谁', 'Who it goes to'), [
        [
          t(
            '模型供应商：公司在平台里配置的那几家。对话内容和附件文本会发过去，才有回答。',
            'Model providers configured by your company. Conversation content and attachment text are sent to them in order to get an answer.',
          ),
          t(
            '连接器：你授权之后，AI 员工代你读写那些系统（邮箱、日历、工单等）。授权范围由你在授权时决定。',
            'Connectors: once you authorize one, the AI coworker reads and writes those systems on your behalf (mail, calendar, tickets). The scope is what you granted.',
          ),
          t(
            '搜索与网页抓取：搜索词和目标网址会发给所配置的搜索后端。',
            'Search and page fetching: queries and target URLs go to the configured search backend.',
          ),
          t(
            '外部渠道：绑定了 Telegram 这类渠道时，消息经该渠道中转，受它自己的隐私政策约束。',
            'External channels: when a channel such as Telegram is bound, messages pass through it and are subject to its own privacy policy.',
          ),
          t(
            '基础设施：Gateway 和数据库跑在哪儿由你们公司决定（自建机器或云平台），数据随之落在那儿。',
            'Infrastructure: your company decides where the Gateway and its database run (own machines or a cloud platform), and the data sits there.',
          ),
        ],
        t(
          '除此之外不卖、不换、不拿去投广告。法律要求时（法院命令、监管调查）才另说，且在法律允许的范围内会先告诉公司管理员。',
          'Beyond that, nothing is sold, traded or used for advertising. Legal demands (court orders, regulatory investigations) are the exception, and where the law allows it we tell your company admin first.',
        ),
      ]),
      lgSec('pv-keep', t('留多久', 'How long it is kept'), [
        [
          t('账号信息：账号在就一直在，账号删了随之删除。', 'Account details: for as long as the account exists, and deleted with it.'),
          t(
            '审计派生物：默认 180 天，公司可以在平台限定的范围内调整。Bot 删掉之后审计条目仍然保留——那正是审计的意义。',
            'Audit derivatives: 180 days by default, adjustable by your company within platform limits. They survive the deletion of a bot — that is the point of an audit trail.',
          ),
          t('用量与账单记录：按会计和税务要求保留。', 'Usage and billing records: kept as accounting and tax rules require.'),
          t(
            '工作区文件和原始会话记录：在席位机器上，由你们公司自己的保留策略决定。',
            'Workspace files and raw conversation records: on the seat machine, under your company’s own retention policy.',
          ),
          t('服务器日志：短期滚动保留，用于排障和安全。', 'Server logs: kept on a short rolling window for debugging and security.'),
        ],
      ]),
      lgSec('pv-rights', t('你的权利', 'Your rights'), [
        t(
          '你可以要求查看、更正、导出或删除关于你的信息，也可以随时撤回某个连接器的授权。',
          'You can ask to see, correct, export or delete information about you, and you can revoke a connector authorization at any time.',
        ),
        t(
          '路径是先找公司管理员：账号是他开的，数据也在公司名下，绝大多数请求他当场就能处理。他处理不了的，按最后一节联系我们。',
          'Start with your company admin: they created the account, the data sits under the company, and most requests they can handle on the spot. If they cannot, contact us as described in the last section.',
        ),
        t(
          '视你所在地的法律（例如 GDPR、个人信息保护法），你可能还有反对处理、限制处理以及向监管机构投诉的权利。',
          'Depending on where you live (GDPR, PIPL and similar laws), you may also have rights to object to or restrict processing, and to complain to a regulator.',
        ),
      ]),
      lgSec('pv-security', t('安全上做了什么', 'How it is protected'), [
        [
          t('登录票是有期限的令牌，过期要重新登录。', 'Sign-in tokens expire and require signing in again.'),
          t('密钥和连接器令牌加密保存，存进去之后不回显，也不下发给 Bot 进程。', 'Keys and connector tokens are stored encrypted, never displayed again, and never handed to the bot process.'),
          t('后台每读一次审计详情都会写进审计日志，谁看过什么有据可查。', 'Every read of an audit detail is itself written to the audit log, so who looked at what is on record.'),
          t('席位机器一席一个系统账号，工作区互不相通。', 'Each seat gets its own system account on the machine; workspaces do not see each other.'),
        ],
        t(
          '没有哪套系统是绝对安全的。发现可疑的事，按最后一节联系我们，越早越好。',
          'No system is perfectly secure. If you notice something suspicious, contact us as described in the last section — the sooner the better.',
        ),
      ]),
      lgSec('pv-local', t('浏览器里存了什么', 'What is stored in your browser'), [
        t(
          '没有第三方跟踪或广告 cookie，这套界面里一个都没有。',
          'There are no third-party tracking or advertising cookies anywhere in this interface.',
        ),
        [
          t(
            '登录票：网页版放在会话存储里，关掉标签页就没了；桌面端放在持久存储里，这样关窗重开不用再登一次。',
            'The sign-in token: in session storage on the web (gone when you close the tab), in persistent storage in the desktop app so reopening the window does not mean signing in again.',
          ),
          t('界面偏好：主题、语言、侧栏宽度这些。', 'Interface preferences: theme, language, sidebar width.'),
        ],
      ]),
      lgSec('pv-minors', t('未成年人', 'Minors'), [
        t(
          '这套系统面向企业内部使用，不面向 16 岁以下的个人。发现误开的账号会删掉。',
          'The system is meant for use inside companies and is not directed at anyone under 16. Accounts created for them in error will be deleted.',
        ),
      ]),
      lgSec('pv-changes', t('这份政策会变', 'This policy changes'), [
        t(
          '改了正文就会更新顶上那个「最后更新」的日期。有实质变化时，会通过公司管理员或界面上的通知告诉你。',
          'Whenever the text changes, the “last updated” date at the top changes with it. Material changes are announced through your company admin or a notice in the interface.',
        ),
      ]),
      lgSec('pv-contact', t('联系我们', 'Contact'), [
        t(
          `隐私相关的问题、请求和事故报告，发到 ${LEGAL_CONTACT}；落款主体是 ${LEGAL_ENTITY}。日常的账号问题仍然先找公司管理员，那条路比这条快。`,
          `For privacy questions, requests and incident reports, write to ${LEGAL_CONTACT}. The responsible entity is ${LEGAL_ENTITY_EN}. For everyday account matters your company admin is still the faster route.`,
        ),
      ]),
    ],
  }
}

/** 服务条款的正文。 */
function legalTerms() {
  return {
    kind: 'terms',
    title: t('服务条款', 'Terms of Service'),
    lead: t(
      '用这套系统的规矩：谁能用、能用来做什么、AI 做错了算谁的、钱怎么算。',
      'The rules for using this system: who may use it, what for, who answers when the AI gets it wrong, and how it is billed.',
    ),
    secs: [
      lgSec('tm-accept', t('同意这些条款', 'Accepting these terms'), [
        t(
          '登录并使用这套系统，就表示你同意这份条款。不同意的话，别用它——这没有别的转圜。',
          'Signing in and using the system means you accept these terms. If you do not accept them, do not use it — there is no middle path here.',
        ),
        t(
          '你代表公司使用时，你确认自己有权代表这家公司接受这份条款，并且这份条款对这家公司同样生效。',
          'If you use it on behalf of a company, you confirm you are authorized to accept these terms for that company, and they bind the company as well.',
        ),
      ]),
      lgSec('tm-account', t('账号与席位', 'Accounts and seats'), [
        [
          t('账号由公司管理员开通，一个账号对应一个人，不共享。', 'Accounts are created by a company admin, one account per person, not shared.'),
          t('口令自己保管。账号底下发生的事算在这个账号头上。', 'Keep your password to yourself. What happens under an account is attributed to that account.'),
          t('怀疑账号被人用了，立刻告诉公司管理员，他能当场停掉。', 'If you suspect someone else is using your account, tell your company admin — they can disable it immediately.'),
          t('公司管理员能看到这个席位的用量、账单和审计摘要。这不是监视，是公司为这个席位付钱、也为它的产出负责。', 'Company admins can see a seat’s usage, billing and audit summaries. That is not surveillance: the company pays for the seat and answers for what it produces.'),
        ],
      ]),
      lgSec('tm-use', t('怎么算合理使用', 'Acceptable use'), [
        t('别拿这套系统做这些事：', 'Do not use the system to:'),
        [
          t('违反法律，或者侵犯别人的知识产权、隐私和其它权利。', 'Break the law, or infringe anyone’s intellectual property, privacy or other rights.'),
          t('生成骚扰、欺诈、钓鱼内容或者恶意软件。', 'Produce harassment, fraud, phishing content or malware.'),
          t('绕过别人系统的访问控制、验证码或者抓取明确禁止抓取的数据。', 'Bypass another system’s access controls or CAPTCHAs, or scrape data you are told not to.'),
          t('把 AI 员工接到你本来无权访问的系统上。', 'Connect the AI coworker to systems you are not authorized to access.'),
          t('没有书面授权就对这套系统本身做压测或渗透测试。', 'Load-test or penetration-test the system itself without written authorization.'),
          t('把席位转给公司之外的人用，或者转售服务。', 'Pass a seat to someone outside your company, or resell the service.'),
        ],
      ]),
      lgSec('tm-content', t('你交代的内容归你', 'Your content stays yours'), [
        t(
          '你写的话、你上传的文件、AI 员工为你产出的结果，权利归你或你所在的公司，我们不因为它经过这套系统就取得什么。',
          'What you type, what you upload, and what the AI coworker produces for you belong to you or your company. Nothing becomes ours merely by passing through the system.',
        ),
        t(
          '为了把活干完，你授权这套系统处理、存储这些内容，并把必要的部分传给你选定的模型供应商和连接器——只为提供服务这一个目的。',
          'To do the work, you grant the system permission to process and store that content and to pass the necessary parts to the model providers and connectors you selected — for providing the service and nothing else.',
        ),
      ]),
      lgSec('tm-ai', t('AI 输出这件事说在前面', 'About what the AI produces'), [
        t(
          'AI 会出错，也会一本正经地编。重要的事在照着做之前自己核一遍——尤其是发出去的钱、发出去的邮件、和改动别人系统的操作。',
          'The AI makes mistakes, and it will state wrong things confidently. Check anything that matters before acting on it — especially money going out, messages going out, and changes to someone else’s systems.',
        ),
        t(
          '它的输出不构成法律、医疗、财务或投资建议。这类事情该问持牌的专业人士。',
          'Its output is not legal, medical, financial or investment advice. For those, ask a licensed professional.',
        ),
        t(
          '「拿不准就停下来等人拍板」是这套系统的一条设计原则，不是一句保证：它可能该停的时候没停。最终的判断责任在人。',
          '“Stop and wait for a human when unsure” is a design principle of this system, not a guarantee — it can fail to stop when it should have. The final judgment is a person’s responsibility.',
        ),
      ]),
      lgSec('tm-third', t('第三方那部分', 'Third-party parts'), [
        t(
          '模型、连接器、搜索后端和外部渠道由第三方提供，受它们各自的条款约束。它们的可用性、价格和策略我们控制不了，也不为它们的行为负责。',
          'Models, connectors, search backends and external channels are provided by third parties under their own terms. We do not control their availability, pricing or policies, and we are not responsible for what they do.',
        ),
      ]),
      lgSec('tm-billing', t('计费与账单', 'Billing'), [
        [
          t('按用量落账：模型调用、连接器调用、搜索次数各自计价。', 'Metered by usage: model calls, connector calls and searches are each priced.'),
          t('套餐和充值由公司管理员购买，席位数按套餐算。', 'Plans and top-ups are purchased by a company admin; seat counts follow the plan.'),
          t('账单以平台记录的用量为准。有异议在账单出具后 30 天内提出。', 'Invoices are based on the usage recorded by the platform. Raise a dispute within 30 days of the invoice.'),
          t('余额用尽或者逾期未付，服务会暂停，直到结清。', 'If the balance runs out or payment is overdue, service is suspended until it is settled.'),
        ],
      ]),
      lgSec('tm-availability', t('可用性与变更', 'Availability and changes'), [
        t(
          '我们不承诺这套系统永不中断。计划内的维护会尽量提前告知；功能和接口可能变化，破坏性的变化会提前通知公司管理员。',
          'We do not promise uninterrupted service. Planned maintenance is announced ahead of time where possible; features and APIs may change, and breaking changes are announced to company admins in advance.',
        ),
      ]),
      lgSec('tm-suspend', t('暂停与终止', 'Suspension and termination'), [
        t(
          '严重违反这份条款或者长期欠费的账号可能被暂停或终止。公司管理员也可以随时停用自己公司下的任何账号。',
          'Accounts that seriously breach these terms or remain unpaid may be suspended or terminated. A company admin may also disable any account under their company at any time.',
        ),
        t(
          '终止之后，数据按隐私政策里的保留规则处理。要导出的东西请在关停之前导出。',
          'After termination, data is handled under the retention rules in the Privacy Policy. Export what you need before the account is closed.',
        ),
      ]),
      lgSec('tm-warranty', t('免责声明', 'Disclaimer'), [
        t(
          '这套系统按「现状」提供。在法律允许的最大范围内，我们不作任何明示或默示的保证，包括适销性、特定用途适用性和不侵权。',
          'The system is provided “as is”. To the fullest extent permitted by law we disclaim all warranties, express or implied, including merchantability, fitness for a particular purpose and non-infringement.',
        ),
      ]),
      lgSec('tm-liability', t('责任限额', 'Limitation of liability'), [
        t(
          '在法律允许的最大范围内，我们不对间接、附带、特殊或后果性损失负责，包括利润损失和数据损失。',
          'To the fullest extent permitted by law we are not liable for indirect, incidental, special or consequential damages, including lost profits and lost data.',
        ),
        t(
          '我们在本条款项下的累计责任上限，为索赔发生前 12 个月内你所在公司为本服务实际支付的费用。',
          'Our aggregate liability under these terms is capped at the amount your company actually paid for the service in the 12 months before the claim arose.',
        ),
      ]),
      lgSec('tm-law', t('适用法律与争议', 'Governing law and disputes'), [
        t(
          `本条款适用 ${LEGAL_LAW} 的法律，争议提交该地有管辖权的法院。`,
          `These terms are governed by the laws of ${LEGAL_LAW_EN}, and disputes go to the courts with jurisdiction there.`,
        ),
      ]),
      lgSec('tm-changes', t('条款会变', 'These terms change'), [
        t(
          `条款改了会更新顶上那个日期；有实质变化时会提前通知公司管理员。问题发到 ${LEGAL_CONTACT}。`,
          `When these terms change, the date at the top changes with them, and material changes are announced to company admins in advance. Questions go to ${LEGAL_CONTACT}.`,
        ),
      ]),
    ],
  }
}

/**
 * 这两页共用的顶栏。
 *
 * 比首页那条短：只有回首页、切语言、去登录。**没有「联系销售」**——正在读隐私政策的
 * 人不是来买东西的，而那颗按钮会把一个弹窗连同它的状态一起拖进这两页。
 */
function legalTop() {
  return `<header class="satu-lp-top">
    <div class="satu-lp-wrap satu-lp-topin">
      <button type="button" class="satu-lp-brand" data-act="go" data-href="/">
        <img src="/assets/satuwork-logo.png" alt="Satuwork" width="28" height="28">
        <span>Satuwork</span>
      </button>
      <div class="satu-lp-topact">
        <div class="satu-lp-lang" role="group" aria-label="${esc(t('语言', 'Language'))}">
          <button type="button" data-act="landing-locale" data-locale="zh" aria-pressed="${localeMode !== 'en'}">中文</button>
          <button type="button" data-act="landing-locale" data-locale="en" aria-pressed="${localeMode === 'en'}">EN</button>
        </div>
        ${/* 顶栏末端那格。**不再挂 `btn btn-primary`**：首页那条横梁上每一样都是
              一格（见 app.css 的 .satu-lp-topact），药丸按钮摆进去会在格子里再浮
              出一颗圆头的钮。样式全由 .satu-lp-topsign 自己给。 */ ''}
        <button type="button" class="satu-lp-topsign" data-act="go" data-href="/login">${t('登录', 'Sign in')}</button>
      </div>
    </div>
  </header>`
}

/**
 * 两页共用的页脚：**互相指向对方**。
 *
 * 读完隐私政策的人下一步多半就是看条款（法务审的时候两份一起看），让他再回首页去找
 * 那个链接是白绕一圈。
 */
function legalFoot(kind) {
  const other =
    kind === 'terms'
      ? `<button type="button" data-act="go" data-href="/privacy">${t('隐私政策', 'Privacy Policy')}</button>`
      : `<button type="button" data-act="go" data-href="/terms">${t('服务条款', 'Terms of Service')}</button>`
  return `<footer class="satu-lp-foot">
    <div class="satu-lp-wrap satu-lp-footin">
      <span class="satu-lp-brand" data-static>
        <img src="/assets/satuwork-logo.png" alt="" width="20" height="20">
        <span>Satuwork</span>
      </span>
      <span class="satu-lg-links">
        <button type="button" data-act="go" data-href="/">${t('首页', 'Home')}</button>
        ${other}
        <span>© 2026 Satuwork</span>
      </span>
    </div>
  </footer>`
}

/**
 * 一页法律文本。`kind` 是 'privacy' 或 'terms'（见 render.js 的 render()）。
 *
 * 和首页一样不套 `.gw-page`：这一屏没有外壳，滚的是文档本身。外层带上 `.satu-lp`
 * 是为了借它那套底色和滚动方式，不是因为它是首页。
 */
function legalView(kind) {
  const doc = kind === 'terms' ? legalTerms() : legalPrivacy()
  return `
  <div class="satu-lp satu-lg">
    ${legalTop()}
    <div class="satu-lp-wrap satu-lg-head">
      <h1>${esc(doc.title)}</h1>
      <p class="satu-lg-lead">${esc(doc.lead)}</p>
      <p class="satu-lg-meta">${esc(t(`最后更新：${LEGAL_UPDATED}`, `Last updated: ${LEGAL_UPDATED}`))}</p>
      ${
        LEGAL_DRAFT
          ? `<p class="satu-lg-note">${esc(
              t(
                '这份文本还没有经过法务审阅，方括号里的落款主体、管辖地和联系邮箱都是占位的。上线前换掉它们，并把 pages-legal.js 里的 LEGAL_DRAFT 关掉。',
                'This text has not been reviewed by counsel. The entity name, venue and contact address in brackets are placeholders. Replace them and turn off LEGAL_DRAFT in pages-legal.js before launch.',
              ),
            )}</p>`
          : ''
      }
    </div>
    <div class="satu-lp-wrap satu-lg-grid">
      ${legalToc(doc.secs)}
      <article class="satu-lg-body">
        ${doc.secs.map((s, i) => lgSecHtml(s, i + 1)).join('')}
      </article>
    </div>
    ${legalFoot(doc.kind)}
  </div>`
}
