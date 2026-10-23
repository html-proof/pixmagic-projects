import { z } from "zod";

/**
 * `schema.partial()` for an update request: a field the request leaves out stays out. Zod 4's own
 * `.partial()` still fills a field's `.default()` in, so an update would reset every field it
 * doesn't mention (renaming an automation would switch it off).
 */
export function partialUpdate<Shape extends z.ZodRawShape, Config extends z.core.$ZodObjectConfig>(
  schema: z.ZodObject<Shape, Config>,
): z.ZodObject<{ [K in keyof Shape]: z.ZodOptional<Shape[K]> }, Config> {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => [key, field instanceof z.ZodDefault || field instanceof z.ZodPrefault ? field.unwrap() : field]),
  );
  return schema.extend(shape).partial() as unknown as z.ZodObject<{ [K in keyof Shape]: z.ZodOptional<Shape[K]> }, Config>;
}
