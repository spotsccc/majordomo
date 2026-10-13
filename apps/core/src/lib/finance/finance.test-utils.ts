import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";

const Mismatch = z.object({
  wallet_id: z.string(),
  currency: z.string(),
  amount: z.string(),
  expected: z.string(),
});

export async function balanceMismatches(): Promise<z.infer<typeof Mismatch>[]> {
  const result = await db.execute(sql`
    with effects as (
      select to_wallet_id as wallet_id, to_currency as currency, to_amount as amount
        from finance.transactions where deleted_at is null and to_wallet_id is not null
      union all
      select from_wallet_id, from_currency, -from_amount
        from finance.transactions where deleted_at is null and from_wallet_id is not null
      union all
      select from_wallet_id, fee_currency, -fee_amount
        from finance.transactions where deleted_at is null and fee_currency is not null
    )
    select b.wallet_id, b.currency, b.amount::text as amount,
           coalesce(sum(e.amount), 0)::text as expected
      from finance.balances b
      left join effects e on e.wallet_id = b.wallet_id and e.currency = b.currency
     group by b.wallet_id, b.currency, b.amount
    having b.amount <> coalesce(sum(e.amount), 0)
  `);
  return z.array(Mismatch).parse(result.rows);
}
