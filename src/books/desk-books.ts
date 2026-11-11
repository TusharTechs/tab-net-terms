import { BUYERS, T0_BUYERS } from "../desk/northwind.js";
import { type Books, resolveT0Customers, RoutedBooks, StandinBooks, T0Books, type T0Mcp } from "./books.js";

/**
 * The books the desk reads, per buyer: Acme from its existing T:0 customer, Initech and Globex from
 * the customers we submitted to the T:0 sandbox. Initech is read from T:0 once T:0 returns it (its
 * invoices are there); until then, or with no T:0 key, the labelled stand-in answers for it.
 * Globex has no invoices anywhere: T:0 returns a customer only once a transaction links to it, so
 * T:0's answer for Globex is "no history" and it carries no T:0 customer id.
 */
export async function deskBooks(t0: T0Mcp | undefined, standinPath = "fixtures/standin-books.json"): Promise<{ books: Books; t0Customers: Record<string, string> }> {
  const standin = new StandinBooks(standinPath);
  if (!t0) return { books: standin, t0Customers: {} };
  const resolved = await resolveT0Customers(t0, { initech: T0_BUYERS.initech, globex: T0_BUYERS.globex });
  const t0Customers: Record<string, string> = { acme: BUYERS.acme.t0Customer, ...resolved };
  const t0Books = new T0Books(t0, t0Customers);
  await t0Books.refresh();
  const routes: Record<string, Books> = { acme: t0Books, globex: t0Books };
  if (resolved.initech) routes.initech = t0Books;
  return { books: new RoutedBooks(routes, standin), t0Customers };
}
