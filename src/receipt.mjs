const summaryLimit = 1200;
const recentReplyLimit = 1200;
const summaryStart = "AGY_SUMMARY_BEGIN";
const summaryEnd = "AGY_SUMMARY_END";

export const receiptInstruction = `\n\nBridge receipt: begin your final reply with a short ${summaryStart} / ${summaryEnd} block (markers on separate lines). List actual results, verification evidence, and anything unfinished or requiring the user. Put details after the block.`;

export function excerpt(text, limit) {
  if (text.length <= limit) return text;
  const head = Math.floor((limit - 3) * 0.65);
  return `${text.slice(0, head)}\n…\n${text.slice(-(limit - 3 - head))}`;
}

function summaryBlock(text) {
  return /^AGY_SUMMARY_BEGIN[ \t]*\r?\n([\s\S]*?)^AGY_SUMMARY_END[ \t]*\r?$/m.exec(text)?.[1].trim();
}

export function reportFields(report, mode) {
  if (!report || mode === "none") return { has_report: Boolean(report) };
  if (mode === "full") return { has_report: true, report, report_kind: "full", report_truncated: false };
  const summary = summaryBlock(report);
  const source = summary || report;
  return {
    has_report: true,
    report: excerpt(source, summaryLimit),
    report_kind: summary ? "summary" : source.length > summaryLimit ? "excerpt" : "full",
    report_truncated: source.length > summaryLimit,
  };
}

export function finalMessage(turn) {
  const messages = turn.items.filter(item => item.type === "agentMessage" && item.text?.trim());
  return messages.findLast(item => item.phase === "final_answer") ?? messages.findLast(item => item.phase == null);
}

export async function recentReplies(reader, threadId, limit, signal) {
  const replies = [];
  let cursor;
  for (let page = 0; page < 2; page++) {
    signal.throwIfAborted();
    const response = await reader.read("thread/turns/list", {
      threadId, limit: 8, sortDirection: "desc", itemsView: "summary", ...(cursor && { cursor }),
    });
    for (const turn of response.data) {
      if (turn.status !== "completed") continue;
      const answer = finalMessage(turn)?.text.trim();
      if (!answer) continue;
      const user = turn.items.find(item => item.type === "userMessage")?.content
        ?.filter(item => item.type === "text").map(item => item.text).join("\n") ?? "";
      const cleanUser = user.replaceAll("\r\n", "\n").replace(/^\[AGY Codex task: [a-f0-9-]+\]\n/i, "")
        .replace(receiptInstruction, "").trim();
      const budgeted = summaryBlock(answer) || answer;
      replies.push({ turn_id: turn.id, user: excerpt(cleanUser, 240), reply: excerpt(budgeted, recentReplyLimit),
        reply_truncated: budgeted.length > recentReplyLimit, reply_is_summary: budgeted !== answer });
      if (replies.length >= limit) return replies;
    }
    if (!response.nextCursor || response.nextCursor === cursor) break;
    cursor = response.nextCursor;
  }
  return replies;
}
