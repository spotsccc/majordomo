import { conversations, messages } from "@repo/db";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { messageText } from "../chat-store";
import { db } from "../db";
import { ownerDayRange, ownerIsoDateTime, type Range } from "../owner-time";
import { anyWordQuery } from "./memory-store";

const FOUND_MAX = 5;

const MATCHES_MAX = 3;

const SUMMARY_MAX = 300;

const FRAGMENT_MAX = 200;

const READ_MESSAGES = 20;

const READ_MAX = 8000;

export type FoundConversation = {
  id: string;
  from: string;
  to: string;
  title: string | null;
  summary: string | null;
  matches: { seq: number; at: string; text: string }[];
};

const FoundRow = z.object({
  id: z.string(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  first_at: z.coerce.date(),
  last_at: z.coerce.date(),
  matches: z.array(
    z.object({ seq: z.number(), at: z.coerce.date(), text: z.string() }),
  ),
});

/** The owner may name the wrong day, so an empty range is searched again without days (П13). */
export async function searchHistory({
  query,
  from,
  to,
}: {
  query: string;
  from?: string;
  to?: string;
}): Promise<
  Error | { conversations: FoundConversation[]; outsideRange: boolean }
> {
  const first = from ?? to;
  const last = to ?? from;
  if (first !== undefined && last !== undefined) {
    const inRange = await findConversations(query, {
      from: ownerDayRange(first).from,
      to: ownerDayRange(last).to,
    });
    if (inRange instanceof Error) return inRange;
    if (inRange.length > 0) {
      return { conversations: inRange, outsideRange: false };
    }
  }
  const anyDay = await findConversations(query);
  if (anyDay instanceof Error) return anyDay;
  return { conversations: anyDay, outsideRange: first !== undefined };
}

/** A summary has no day, so with days it counts only for a conversation with a message in them. */
async function findConversations(
  query: string,
  range?: Range,
): Promise<Error | FoundConversation[]> {
  const inRange = range
    ? sql`${messages.createdAt} >= ${range.from} and ${messages.createdAt} < ${range.to}`
    : sql`true`;
  const result = await db
    .execute(
      sql`
      with q as (select ${anyWordQuery(query)} as query)
      select ${conversations.id} as id, ${conversations.title} as title,
        ${conversations.summary} as summary, span.first_at, span.last_at,
        coalesce(hits.matches, '[]'::json) as matches
      from ${conversations}
      cross join q
      cross join lateral (
        select min(${messages.createdAt}) as first_at, max(${messages.createdAt}) as last_at
        from ${messages}
        where ${messages.conversationId} = ${conversations.id}
      ) span
      left join lateral (
        select
          json_agg(json_build_object('seq', hit.seq, 'at', hit.created_at, 'text', hit.fragment) order by hit.seq) as matches,
          sum(hit.rank) as rank
        from (
          select ${messages.seq} as seq, ${messages.createdAt} as created_at,
            ts_rank(${messages.search}, q.query) as rank,
            ts_headline('russian', ${messageText}, q.query, 'MaxFragments=1, MaxWords=30, MinWords=10, StartSel="", StopSel=""') as fragment
          from ${messages}
          where ${messages.conversationId} = ${conversations.id}
            and ${messages.search} @@ q.query
            and ${inRange}
          order by rank desc, ${messages.seq}
          limit ${MATCHES_MAX}
        ) hit
      ) hits on true
      where span.first_at is not null
        and (${conversations.summarySearch} @@ q.query or hits.matches is not null)
        and exists (
          select 1 from ${messages}
          where ${messages.conversationId} = ${conversations.id}
            and ${inRange}
        )
      order by coalesce(ts_rank(${conversations.summarySearch}, q.query), 0) + coalesce(hits.rank, 0) desc,
        span.last_at desc
      limit ${FOUND_MAX}`,
    )
    .catch(
      (cause: unknown) =>
        new Error("Не удалось найти прошлые разговоры", { cause }),
    );
  if (result instanceof Error) return result;
  const rows = z.array(FoundRow).safeParse(result.rows);
  if (!rows.success) {
    return new Error("Неожиданные строки поиска по истории", {
      cause: rows.error,
    });
  }
  return rows.data.map((row) => ({
    id: row.id,
    from: ownerDay(row.first_at),
    to: ownerDay(row.last_at),
    title: row.title,
    summary: row.summary === null ? null : cut(row.summary, SUMMARY_MAX),
    matches: row.matches.map((match) => ({
      seq: match.seq,
      at: ownerIsoDateTime(match.at),
      text: cut(match.text, FRAGMENT_MAX),
    })),
  }));
}

export async function readConversation(
  id: string,
  aroundSeq?: number,
): Promise<
  | Error
  | {
      id: string;
      title: string | null;
      summary: string | null;
      messages: { seq: number; role: string; at: string; text: string }[];
    }
  | null
> {
  const found = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      summary: conversations.summary,
    })
    .from(conversations)
    .where(eq(conversations.id, id))
    .catch(
      (cause: unknown) => new Error("Не удалось прочитать разговор", { cause }),
    );
  if (found instanceof Error) return found;
  const [conversation] = found;
  if (!conversation) return null;

  const center =
    aroundSeq ??
    sql`(select max(${messages.seq}) from ${messages} where ${messages.conversationId} = ${id})`;
  const nearest = await db
    .select({
      seq: messages.seq,
      role: sql<string>`${messages.uiMessage}->>'role'`,
      createdAt: messages.createdAt,
      text: messageText,
    })
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(sql`abs(${messages.seq} - ${center})`, messages.seq)
    .limit(READ_MESSAGES)
    .catch(
      (cause: unknown) =>
        new Error("Не удалось прочитать сообщения разговора", { cause }),
    );
  if (nearest instanceof Error) return nearest;

  let left =
    READ_MAX -
    length(conversation.title ?? "") -
    length(conversation.summary ?? "");
  const read: { seq: number; role: string; at: string; text: string }[] = [];
  for (const message of nearest) {
    if (left <= 0) break;
    if (!message.text) continue;
    const text = cut(message.text, left);
    read.push({
      seq: message.seq,
      role: message.role,
      at: ownerIsoDateTime(message.createdAt),
      text,
    });
    left -= length(text);
  }
  return {
    ...conversation,
    messages: read.sort((a, b) => a.seq - b.seq),
  };
}

function ownerDay(instant: Date): string {
  return ownerIsoDateTime(instant).slice(0, 10);
}

/** Postgres and the limits count code points, not UTF-16 units. */
function cut(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
}

function length(text: string): number {
  return [...text].length;
}
