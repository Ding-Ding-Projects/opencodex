/**
 * Support Tickets — the joke recovery desk behind every toy lock's "Forgotten
 * your password?" link.
 *
 * The bit is a bit, and this module is where the bit stops and the honesty
 * starts. Everything in here — the ticket number, the severity nobody will
 * honour, the status that "advances" — is theatre: a locally generated
 * illusion of a helpdesk that plays the part properly before doing the only
 * thing that actually works, which is handing the user their own
 * application-data folder (see `app-data-path.ts`) so they can delete it
 * themselves. See `SupportTickets.tsx` for the one plain, unstyled line this
 * module exists to make true — nothing here is ever sent anywhere.
 *
 * Tickets live in the same isolated `localStorage` bucket as everything else
 * this app keeps locally, which is also what makes the joke land: the same
 * folder deletion (or, in a browser context, the same "clear this site's
 * storage") that resets every toy lock resets the ticket queue too. There is
 * no separate "clear tickets" action, deliberately — see the test suite for
 * the proof that wiping the storage key is the whole story.
 */

const TICKETS_KEY = "ocx-m3:support-tickets";
const CAP = 200;

export type TicketStatus = "open" | "underReview" | "resolved";
export type TicketSeverity = "low" | "medium" | "high" | "critical";
export type TicketCategory = "lockedOut" | "somethingElse";

export interface SupportTicket {
  id: string;
  /** A small, locally sequential number — "SUP-000042" territory, never anything that looks like it left this machine. */
  number: number;
  category: TicketCategory;
  description: string;
  /** Assigned at random and never acted on by anything — the whole point. */
  severity: TicketSeverity;
  status: TicketStatus;
  createdAt: number;
  /** The lock's label, when this ticket was opened from a specific lock's unlock prompt. */
  lockLabel?: string;
}

const SEVERITIES: TicketSeverity[] = ["low", "medium", "high", "critical"];
const STATUS_ORDER: TicketStatus[] = ["open", "underReview", "resolved"];

function readAll(): SupportTicket[] {
  try {
    const raw = JSON.parse(localStorage.getItem(TICKETS_KEY) || "[]");
    return Array.isArray(raw) ? raw as SupportTicket[] : [];
  } catch {
    return [];
  }
}

function writeAll(next: SupportTicket[]): void {
  try {
    localStorage.setItem(TICKETS_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent("ocx-support-tickets"));
  } catch { /* quota — the caller's own action still completed */ }
}

/** Every ticket, newest first. */
export function readTickets(): SupportTicket[] {
  return readAll().slice().sort((a, b) => b.createdAt - a.createdAt);
}

function nextNumber(): number {
  const all = readAll();
  return all.reduce((max, ticket) => Math.max(max, ticket.number), 1000) + 1;
}

export interface CreateTicketInput {
  category: TicketCategory;
  description: string;
  lockLabel?: string;
}

export function createTicket(input: CreateTicketInput): SupportTicket {
  const ticket: SupportTicket = {
    id: `tk${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    number: nextNumber(),
    category: input.category,
    description: input.description,
    severity: SEVERITIES[Math.floor(Math.random() * SEVERITIES.length)]!,
    status: "open",
    createdAt: Date.now(),
    lockLabel: input.lockLabel,
  };
  writeAll([ticket, ...readAll()].slice(0, CAP));
  return ticket;
}

/** Moves a ticket one step through the status theatre. Idempotent once it reaches "resolved" — the resolution never regresses. */
export function advanceTicket(id: string): SupportTicket | undefined {
  const all = readAll();
  const index = all.findIndex(ticket => ticket.id === id);
  if (index === -1) return undefined;
  const current = all[index]!;
  const at = STATUS_ORDER.indexOf(current.status);
  const next: SupportTicket = { ...current, status: STATUS_ORDER[Math.min(at + 1, STATUS_ORDER.length - 1)]! };
  all[index] = next;
  writeAll(all);
  return next;
}

export function findTicket(id: string): SupportTicket | undefined {
  return readAll().find(ticket => ticket.id === id);
}

export function subscribeTickets(listener: () => void): () => void {
  window.addEventListener("ocx-support-tickets", listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener("ocx-support-tickets", listener);
    window.removeEventListener("storage", listener);
  };
}
