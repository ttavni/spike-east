import { z } from "zod";

/** Roundnet scoring: first to `to`, win by 2 (so the winner can go above it in a deuce). What a
 *  game is played to is its season's rule (`targetAt`): 21 in Season 1, 17 from Season 2. */
export function validWinBy2(a: number, b: number, to = 21): boolean {
  return a !== b && Math.max(a, b) >= to && Math.abs(a - b) >= 2;
}

export const logMatchSchema = z
  .object({
    team1: z.array(z.string().uuid()).length(2),
    team2: z.array(z.string().uuid()).length(2),
    score1: z.number().int().min(0).max(99),
    score2: z.number().int().min(0).max(99),
    clientMatchId: z.string().max(100).optional(),
    notes: z.string().max(500).optional(),
    // The slot in tonight's session plan this score belongs to, so logging it crosses
    // that game off. Optional — scores can still be logged with no plan in play.
    planGameId: z.string().uuid().optional(),
  })
  // Reaching the target and winning by 2 is checked in logMatch, which knows the season.
  .refine((d) => d.score1 !== d.score2, { message: "A match can't end in a draw." })
  .refine(
    (d) => new Set([...d.team1, ...d.team2]).size === 4,
    { message: "All four players must be different." },
  );

export type LogMatchInput = z.infer<typeof logMatchSchema>;
