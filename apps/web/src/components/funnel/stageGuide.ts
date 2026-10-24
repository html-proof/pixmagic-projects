import type { FunnelStep } from "@app/shared/journey";

// ---------------------------------------------------------------------------
// The Shopping Funnel page's words for each stage: its name, the line under it on the funnel, and
// the explanation panel's fixed parts (what it means, why it matters, how it is counted). The
// figures and what they show come from the report; nothing here is a measured fact.
// ---------------------------------------------------------------------------

export interface StageGuide {
  /** The stage's name on the page. */
  name: string;
  /** One line under it on the funnel. */
  short: string;
  /** "What this stage means". */
  meaning: string;
  /** "Why it matters". */
  why: string;
  /** How a visit gets counted here. */
  counted: string;
  /** What reaching this stage from the one before is called ("went on to view a product"). */
  wentOn: string;
  /** The visits at this stage as an adjective: "cart visits". */
  visitsAt: string;
  /** Why visits might stop before this stage: possible reasons, never claimed causes. */
  dropReasons: string[];
}

export const STAGES: Record<FunnelStep, StageGuide> = {
  visited: {
    name: "Store visits",
    short: "People who visited your online store during the selected date range.",
    meaning: "Every tracked visit to your online store: one shopper, on one browser, on one day of the dates you picked. It is where the funnel starts, so it is always 100%.",
    why: "Every sale starts with a visit. How many visits you get, and whether they are the right shoppers, sets the ceiling on everything below it.",
    counted: "A visit counts when the bizinsights pixel records any page of your store for a shopper who accepted analytics tracking. The same shopper on two days is two visits.",
    wentOn: "visited your store",
    visitsAt: "store",
    dropReasons: [],
  },
  viewed_product: {
    name: "Product discovery",
    short: "Visitors who explored your products and viewed product details.",
    meaning: "Visits that opened at least one product page. A visit that added something to cart straight from a collection page counts here too, because it saw the product.",
    why: "Shoppers can't buy what they don't find. Visits that never reach a product usually landed on the wrong page, couldn't find what they came for, or were only browsing.",
    counted: "A visit counts when the pixel records a product view (or any later step) during it.",
    wentOn: "went on to view a product",
    visitsAt: "product-viewing",
    dropReasons: [
      "The page shoppers landed on doesn't match what brought them (an ad or post about one product landing on the home page).",
      "Products are hard to find: navigation, search or collections don't lead to them quickly.",
      "Slow pages, especially on phones.",
      "Visits that were never going to buy (job seekers, existing customers checking an order, bots that run scripts).",
    ],
  },
  added_to_cart: {
    name: "Added to cart",
    short: "Visitors who showed interest in buying by adding one or more products to their cart.",
    meaning: "Visits that put at least one product in the cart. It shows real interest, but adding a product to the cart doesn't guarantee a purchase.",
    why: "This is the step where interest turns into intent. A low share here often points at the product page: price, photos, details, delivery information or stock.",
    counted: "A visit counts when the pixel records an add to cart (or a later step) during it.",
    wentOn: "went on to add to cart",
    visitsAt: "cart",
    dropReasons: [
      "Prices that look high for what the page shows, or shipping costs that aren't clear.",
      "Product descriptions or images that don't answer shoppers' questions.",
      "Sizes, colours or stock that aren't available.",
      "An Add to cart button that is hard to find or doesn't work well on phones.",
    ],
  },
  started_checkout: {
    name: "Checkout started",
    short: "Visitors who started the checkout process but may not have completed their order.",
    meaning: "Visits that opened checkout after filling their cart. Shoppers here are close to buying.",
    why: "Visits that add to cart but never start checkout are the classic abandoned carts. Each one is a sale the shopper already chose.",
    counted: "A visit counts when the pixel records the start of checkout (or a completed purchase) during it.",
    wentOn: "went on to start checkout",
    visitsAt: "checkout",
    dropReasons: [
      "Shipping costs or delivery times that appear only in the cart.",
      "Shoppers using the cart to compare prices or save items for later.",
      "A discount code that didn't work, or the cart being hard to change.",
      "Checkout buttons that are hard to find or don't work in some browsers.",
    ],
  },
  purchased: {
    name: "Purchase completed",
    short: "Visitors who completed a purchase successfully.",
    meaning: "Visits that finished checkout. This is the visit-level count of purchases; your Shopify orders (all of them, from every channel) are shown beside it.",
    why: "It is the result everything above works towards. The share of visits that reach it is your conversion rate.",
    counted: "A visit counts when the pixel records a completed checkout during it.",
    wentOn: "went on to complete their purchase",
    visitsAt: "buying",
    dropReasons: [
      "Unexpected costs at checkout: shipping, taxes or duties.",
      "A payment method the shopper wanted isn't offered, or a payment was declined.",
      "Having to create an account, or a long form.",
      "Errors or slowness during checkout.",
    ],
  },
};

/** The formula behind each figure, as the page's "How it's calculated" sections write it. */
export const FORMULAS = {
  share: "Visits that reached this stage (or a later one) ÷ all visits × 100",
  progression: "Visits that reached this stage ÷ visits that reached the stage before × 100",
  dropOff: "100% − progression rate (visits that reached the stage before and stopped there)",
  conversion: "Visits that completed a purchase ÷ all visits × 100",
  checkoutCompletion: "Visits that completed a purchase ÷ visits that started checkout × 100",
  viewToCart: "Visits that added the product to cart from its page ÷ visits that viewed its page × 100",
  aov: "Net sales ÷ orders (Shopify's average order value, before tax and shipping)",
} as const;
