import { Product } from '../graphql.schema';

/**
 * What we sell.
 *
 * Prices live here, on the server, and are looked up by id — a client sends a
 * product id and a quantity, never an amount. Otherwise anyone could open
 * devtools and buy a tracker for one kopiyka.
 *
 * TODO(pricing): 4 900 ₴ is a placeholder — confirm the real pre-order price
 * before this goes live. `TSUTSYK_PRICE_KOPIYKAS` overrides it per environment
 * so staging can run at 1 ₴ without touching the code.
 */
const TRACKER_PRICE = Number(process.env.TSUTSYK_PRICE_KOPIYKAS ?? 490_000);

/** Absolute origin used to make the basket icons absolute for monobank. */
const STOREFRONT_URL = (
  process.env.STOREFRONT_URL ?? 'https://tsutsyk.live'
).replace(/\/+$/, '');

export const PRODUCTS: Record<string, Product> = {
  'tsutsyk-tracker': {
    id: 'tsutsyk-tracker',
    name: 'GPS-трекер «Цуцик»',
    description:
      'GPS/LTE-трекер на нашийник: живе відстеження, push-сповіщення, власна плата, зібрана вручну.',
    price: TRACKER_PRICE,
    unit: 'шт.',
    image: `${STOREFRONT_URL}/karemat.jpg`,
    // Upper bound per order — these are assembled by hand, one at a time.
    maxQuantity: 3,
  },
};

export function getProduct(id: string): Product | null {
  return Object.hasOwn(PRODUCTS, id) ? PRODUCTS[id] : null;
}

export function listProducts(): Product[] {
  return Object.values(PRODUCTS);
}
