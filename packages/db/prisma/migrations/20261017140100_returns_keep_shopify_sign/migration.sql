-- Data only. A sale now keeps the sign Shopify gave it (saleValue in packages/shared/src/kpi.ts);
-- before, every line of a return was forced negative (-ABS). A refund that differs from the items'
-- value carries adjustment lines of both signs (+225.10 and -225.10 on one PixMagic refund), so
-- those pairs were counted twice as returns: net and total sales were short by as much.
--
-- Re-total the days that hold a return, a cancellation or an edit, with the arithmetic of
-- dayTotals in packages/core/src/persist.ts. Only refunds, shipping, taxes and total sales change:
-- gross sales, discounts and units come from the order lines, whose sign was never forced. Other
-- days are left as they are.
WITH v AS (
  SELECT store_id, local_day AS day, action_type, line_type, discount, amount - tax AS value, tax
  FROM order_sales
  WHERE line_type NOT IN ('gift_card', 'tip')
),
affected AS (
  SELECT DISTINCT store_id, day FROM v WHERE action_type <> 'order'
),
s AS (
  SELECT v.store_id, v.day,
         COALESCE(SUM(v.value + v.discount) FILTER (WHERE v.line_type IN ('product', 'adjustment') AND v.action_type = 'order'), 0) AS gross,
         COALESCE(SUM(v.discount) FILTER (WHERE v.line_type IN ('product', 'adjustment') AND v.action_type = 'order'), 0) AS disc,
         COALESCE(-SUM(v.value) FILTER (WHERE v.line_type IN ('product', 'adjustment') AND v.action_type <> 'order'), 0) AS returns,
         COALESCE(SUM(v.value) FILTER (WHERE v.line_type = 'shipping'), 0) AS shipping,
         COALESCE(SUM(v.tax), 0) AS taxes,
         COALESCE(SUM(v.value) FILTER (WHERE v.line_type <> 'shipping' AND v.line_type NOT IN ('product', 'adjustment')), 0) AS other
  FROM v
  JOIN affected a ON a.store_id = v.store_id AND a.day = v.day
  GROUP BY v.store_id, v.day
)
UPDATE daily_store_metrics m
SET refunds = s.returns,
    shipping = s.shipping,
    taxes = s.taxes,
    total_sales = s.gross - s.disc - s.returns + s.shipping + s.taxes + s.other
FROM s
WHERE m.store_id = s.store_id AND m.day = s.day;
