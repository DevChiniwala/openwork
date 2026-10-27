/**
 * Whose agent (feature `slackAgentIdentity`). Everyone who mentions OpenWork in a shared thread gets their own agent,
 * run as them in their own session. Shared replies say whose agent wrote them, and only an agent's owner can stop or
 * change it: someone else who tries is told whose agent it is and that they can ask their own.
 */

const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/

/** A Slack user id that's safe to put in a mention. */
export function isSlackUserId(value: string | null | undefined): value is string {
  return Boolean(value && SLACK_USER_ID.test(value))
}

/**
 * "<@U…>'s agent": the line at the top of each shared reply. Slack shows the mention as the owner's name, to each
 * viewer as Slack already shows it, so OpenWork never reads, stores or posts a name itself.
 */
export function agentLabel(slackUserId: string) {
  return `<@${slackUserId}>'s agent`
}

/** The streamed chunk that puts the owner line above a shared reply. */
export function agentLabelChunk(slackUserId: string) {
  return { type: "blocks", blocks: [{ type: "context", elements: [{ type: "mrkdwn", text: agentLabel(slackUserId) }] }] }
}

export type SteeringCommand = "stop" | "change"

const POLITE_START = /^(?:(?:hey|hi|ok|okay|please|pls|actually|wait|sorry|no)\s+)*(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?/
const POLITE_END = /(?:\s+(?:please|pls|thanks|thank you|now|right now|for now|asap))*$/
const STOP =
  /^(?:stop|cancel|abort|halt|kill)(?:\s+(?:it|that|this|everything|the task|this task|that task|your task|working|work|what you're doing|what you are doing))?(?:\s+(?:on|with)\s+(?:it|this|that|the task))?$|^(?:never\s?mind|forget (?:it|that|about it)|scratch that)$/
const CHANGE = /^(?:change|redo|undo|revise|rewrite|fix)\s+(?:it|that|this)$|^(?:do|try)\s+(?:it|that|this)\s+(?:again|differently)$|^try again$/

/**
 * A message that only steers work already running ("stop", "stop working on this", "never mind", "change that"), as
 * opposed to a request of its own ("stop the deploy", "change that to Friday"). Mentions and --private are ignored.
 */
export function steeringCommand(text: string): SteeringCommand | null {
  const plain = text
    .replace(/<[@#!][^>]*>/g, " ")
    .replace(/(^|\s)--private(?=\s|$)/g, " ")
    .toLowerCase()
    .replaceAll("\u2019", "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(POLITE_START, "")
    .replace(POLITE_END, "")
  if (!plain || plain.length > 60) return null
  if (STOP.test(plain)) return "stop"
  if (CHANGE.test(plain)) return "change"
  return null
}

/** A task running in the thread: whose it is, and whether its reply is in the thread. */
export type ThreadTask = { id: string; slackUserId: string; shared: boolean }

export type SteeringDecision =
  | { action: "run" }
  /** The sender's own task is running here: stop it, as Slack's Stop button would. */
  | { action: "stop_own"; eventIds: string[] }
  /** Someone else's agent is working here: tell the sender, privately, whose it is. */
  | { action: "not_yours"; text: string }

/**
 * What a steering message does. Your own agent: "stop" ends its running task, and anything else waits its turn as
 * before. Nothing of yours running but another person's agent working in the thread: you're told it's theirs. Otherwise
 * the message is an ordinary request for your own agent. Tasks replying privately are never named.
 */
export function decideSteering(input: {
  command: SteeringCommand | null
  sender: string
  directMessage: boolean
  tasks: ThreadTask[]
  botUserId?: string | null
}): SteeringDecision {
  if (!input.command) return { action: "run" }
  const own = input.tasks.filter((task) => task.slackUserId === input.sender)
  if (own.length) return input.command === "stop" ? { action: "stop_own", eventIds: own.map((task) => task.id) } : { action: "run" }
  if (input.directMessage) return { action: "run" }
  const theirs = input.tasks.find((task) => task.shared)
  return theirs ? { action: "not_yours", text: notYourAgentText(theirs, input.command, input.botUserId) } : { action: "run" }
}

/**
 * The private answer to someone steering another person's agent. Only the sender sees it, so mentioning the owner
 * names them without notifying them.
 */
export function notYourAgentText(task: Pick<ThreadTask, "slackUserId">, command: SteeringCommand, botUserId?: string | null) {
  const bot = isSlackUserId(botUserId) ? `<@${botUserId}>` : "me"
  const whose = isSlackUserId(task.slackUserId)
    ? `That's ${agentLabel(task.slackUserId)}, so only <@${task.slackUserId}>`
    : "That's another person's agent, so only they"
  return command === "stop"
    ? `${whose} can stop it. You can ask your own agent anytime: mention ${bot} with what you need.`
    : `${whose} can change what it's doing. You can ask your own agent: mention ${bot} with the whole request.`
}
