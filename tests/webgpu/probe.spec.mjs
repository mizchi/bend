import { test, expect } from "@playwright/test";

const MASK32 = (1n << 32n) - 1n;
const MASK40 = (1n << 40n) - 1n;
const MASK64 = (1n << 64n) - 1n;
const words = (n) => [Number(n & MASK32), Number((n >> 32n) & MASK32)];

function cases() {
  const edges = [
    0n,
    1n,
    MASK32,
    1n << 32n,
    MASK40,
    (1n << 48n) - 1n,
    1n << 63n,
    MASK64,
    0x85abcd9876543210n,
  ];
  let seed = 123456789n;
  const next = () => (seed = (seed * 6364136223846793005n + 1n) & MASK64);
  return Array.from({ length: 4099 }, (_, i) => {
    const a = i < edges.length ? edges[i] : next();
    const b = i < edges.length ? 1n : next();
    return { a, b, input: [...words(a), ...words(b)] };
  });
}

async function probe(page, inputs, options = {}) {
  await page.goto("/");
  return page.evaluate(
    async ({ inputs, options }) => {
      const { runProbe } = await import("/probe.mjs");
      return runProbe(inputs, options);
    },
    { inputs, options },
  );
}

test("64-bit Term layout and addition survive cross-workgroup queue publication", async ({
  page,
}, info) => {
  const data = cases();
  const result = await probe(
    page,
    data.map((item) => item.input),
  );
  expect(result.reservations).toBe(data.length);
  expect(result.overflows).toBe(0);
  for (const [i, { a, b }] of data.entries()) {
    expect(result.records[i], `case ${i}`).toEqual([
      ...words(a),
      ...words((a + b) & MASK64),
      Number((a >> 56n) & 127n),
      Number((a >> 40n) & 65535n),
      ...words(a & MASK40),
      Number(a >> 63n),
      1,
      0,
      0,
    ]);
  }
  await info.attach("adapter-and-limits", {
    body: JSON.stringify(result.environment, null, 2),
    contentType: "application/json",
  });
  console.log(JSON.stringify(result.environment));
});

test("queue overflow is reported without consuming unpublished entries", async ({
  page,
}) => {
  const data = cases().slice(0, 67);
  const result = await probe(
    page,
    data.map((item) => item.input),
    { queueCapacity: 64 },
  );
  expect(result.reservations).toBe(67);
  expect(result.overflows).toBe(3);
  const published = result.records
    .map((record, i) => ({ record, i }))
    .filter(({ record }) => record[9] === 1);
  expect(published).toHaveLength(64);
  for (const { record, i } of published) {
    expect(record.slice(0, 4)).toEqual([
      ...words(data[i].a),
      ...words((data[i].a + data[i].b) & MASK64),
    ]);
  }
});
